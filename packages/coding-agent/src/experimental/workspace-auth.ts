import { spawn } from "node:child_process";
import { isValidSshHost } from "@earendil-works/pi-client/ssh";

/**
 * Workspace ddtool auth automation.
 *
 * Workspace-side ddtool vault sessions expire roughly every 12 hours, after
 * which every model turn fails until a human logs in again. This module owns
 * the laptop-side logic for that flow: a bounded non-interactive probe, the
 * ddtool device-mode login command, and parsing/validation of the device-flow
 * output that the laptop must open in a local browser.
 *
 * The final OIDC click-through is inherently human; everything around it is
 * automated. Credentials stay Workspace-side: the laptop only opens a URL and
 * renders the TUI.
 */

export const DDTOOL_DATACENTER = "us1.ddbuild.io";
export const DDTOOL_AUTH_PROVIDER = "rapid-ai-platform";
/**
 * Remote bound for the auth probe. An expired mint hangs inside ddtool's OIDC
 * refresh and ignores SIGTERM, so the bound uses `timeout -k` and the laptop
 * classifies the kill (124/137) as "expired". A healthy mint takes ~135 ms.
 */
export const DDTOOL_AUTH_PROBE_REMOTE_SECONDS = 12;
/** Local backstop for the probe SSH channel: remote bound plus kill grace and SSH overhead. */
export const DDTOOL_AUTH_PROBE_TIMEOUT_MS = 30_000;
/** Remote bound for one device login attempt; the human click-through must fit inside it. */
export const DDTOOL_DEVICE_LOGIN_REMOTE_WAIT_SECONDS = 600;
/** Local backstop for the login SSH channel. */
export const DDTOOL_DEVICE_LOGIN_TIMEOUT_MS = (DDTOOL_DEVICE_LOGIN_REMOTE_WAIT_SECONDS + 60) * 1_000;
/** A device login that never prints a verification URL is aborted after this long. */
export const DDTOOL_DEVICE_LOGIN_URL_WAIT_MS = 30_000;

/**
 * Builds the bounded non-interactive auth probe. Stdout/stderr/stdin are fully
 * detached so no lingering ddtool child can hold the SSH channel open.
 */
export function buildDdtoolAuthProbeCommand(): string {
	return (
		`timeout -k 2s ${DDTOOL_AUTH_PROBE_REMOTE_SECONDS}s ddtool auth token ${DDTOOL_AUTH_PROVIDER}` +
		` --datacenter ${DDTOOL_DATACENTER} >/dev/null 2>&1 </dev/null`
	);
}

/** Builds the device-mode login command run over SSH without a TTY. */
export function buildDdtoolDeviceLoginCommand(): string {
	return (
		`timeout -k 2s ${DDTOOL_DEVICE_LOGIN_REMOTE_WAIT_SECONDS}s ddtool auth login --mode device` +
		` --datacenter ${DDTOOL_DATACENTER}`
	);
}

/** Exact manual command surfaced whenever automation cannot complete the login. */
export function manualDdtoolLoginCommand(host: string): string {
	if (!isValidSshHost(host)) throw new Error(`Invalid SSH host: ${JSON.stringify(host)}`);
	return `ssh -t ${host} 'ddtool auth login --mode device --datacenter ${DDTOOL_DATACENTER}'`;
}

export class WorkspaceAuthError extends Error {
	readonly reason: string;
	readonly manualCommand: string;

	constructor(reason: string, manualCommand: string) {
		super(`${reason}\nRun the login manually:\n  ${manualCommand}`);
		this.name = "WorkspaceAuthError";
		this.reason = reason;
		this.manualCommand = manualCommand;
	}
}

/** The one hard-fail kind: a URL that must never be opened in a local browser. */
export class WorkspaceUntrustedDeviceLoginUrlError extends WorkspaceAuthError {
	constructor(url: string, manualCommand: string) {
		super(`Workspace device login printed an untrusted verification URL: ${url}`, manualCommand);
		this.name = "WorkspaceUntrustedDeviceLoginUrlError";
	}
}

export type DdtoolAuthProbeResult = "authenticated" | "expired" | "unavailable";

/**
 * Classifies one remote probe exit code. 124 (SIGTERM) and 137 (SIGKILL) are
 * the timeout kills of a mint hung in OIDC refresh: the session is expired.
 * 126/127 mean ddtool itself is missing or not executable, so no login is
 * possible. Any other nonzero remote exit is a quick auth failure with a dead
 * session; a device login is the remedy there too. OpenSSH-level failures
 * (exit 255) are transport errors and are rejected by the probe caller before
 * classification.
 */
export function classifyDdtoolAuthProbe(code: number): DdtoolAuthProbeResult {
	if (code === 0) return "authenticated";
	if (code === 126 || code === 127) return "unavailable";
	return "expired";
}

export interface DdtoolDeviceLoginFlow {
	readonly url?: string;
	readonly userCode?: string;
}

/**
 * Only the URL printed after ddtool's own "Open the following link" prompt is
 * treated as the verification URL, and only once a whitespace terminator has
 * arrived, so a URL split across stream chunks is never opened partially. An
 * older ddtool that falls back to the auth-code flow prints its URL after a
 * different prompt ("Launching browser to:"), which this parser deliberately
 * rejects so the laptop never opens a URL whose localhost callback could
 * never complete remotely.
 */
const DEVICE_LOGIN_URL_PATTERN = /Open the following link in your browser:[\s\S]{0,400}?(https:\/\/\S+)(?=\s)/u;
const DEVICE_LOGIN_CODE_PATTERN = /enter code ([A-Za-z0-9][A-Za-z0-9-]{3,63})(?=\s)/u;

/**
 * Workspace SSH transports can interleave `nc: ` proxy noise lines into the
 * login stream; they are stripped from the parse buffer and the display.
 */
export function stripDdtoolStreamNoise(text: string): string {
	return text
		.split("\n")
		.filter((line) => !line.startsWith("nc: "))
		.join("\n");
}

export function parseDdtoolDeviceLoginFlow(output: string): DdtoolDeviceLoginFlow {
	const url = DEVICE_LOGIN_URL_PATTERN.exec(output)?.[1];
	const userCode = DEVICE_LOGIN_CODE_PATTERN.exec(output)?.[1];
	return {
		...(url === undefined ? {} : { url }),
		...(userCode === undefined ? {} : { userCode }),
	};
}

/** Verification pages are served by Google's device-flow host shape. */
const DEVICE_LOGIN_HOST_PATTERN = /(^|\.)google\.com$/u;

/**
 * Validates one device-flow verification URL before it can be opened
 * locally: https scheme, no embedded credentials, the expected host shape,
 * and no redirect_uri query (the auth-code flow signature).
 */
export function validateDdtoolDeviceLoginUrl(raw: string): string | undefined {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return undefined;
	}
	if (url.protocol !== "https:") return undefined;
	if (url.username !== "" || url.password !== "") return undefined;
	if (!DEVICE_LOGIN_HOST_PATTERN.test(url.hostname)) return undefined;
	if (url.searchParams.has("redirect_uri")) return undefined;
	return url.href;
}

/** Opens the login page on the laptop; returns whether a browser was launched. */
export function openDdtoolLoginUrl(url: string): Promise<boolean> {
	if (process.platform !== "darwin") return Promise.resolve(false);
	return new Promise((resolve) => {
		const child = spawn("open", [url], { stdio: "ignore" });
		child.once("error", () => resolve(false));
		child.once("exit", (code) => resolve(code === 0));
	});
}

export interface DdtoolDeviceLoginProcess {
	readonly exit: Promise<{
		readonly code: number | null;
		readonly signal: NodeJS.Signals | null;
		readonly stderr: string;
	}>;
	abort(): void;
}

export interface DdtoolDeviceLoginOperations {
	/** Fresh auth probe; used to verify the login before continuing. */
	readonly probeAuth: () => Promise<DdtoolAuthProbeResult>;
	/** Spawns the device login over SSH and streams its stdout through onOutput. */
	readonly startDeviceLogin: (handlers: { readonly onOutput: (chunk: string) => void }) => DdtoolDeviceLoginProcess;
	/** Opens the validated URL locally; returns false when it must be printed. */
	readonly openUrl: (url: string) => Promise<boolean>;
}

export interface DdtoolDeviceLoginDisplay {
	readonly write: (chunk: string) => void;
	readonly log: (message: string) => void;
}

export type DdtoolDeviceLoginOutcome =
	| { readonly outcome: "authenticated" }
	| { readonly outcome: "declined"; readonly detail: string }
	| { readonly outcome: "failed"; readonly detail: string };

/**
 * Runs one device-mode login attempt to completion. Streams ddtool's output,
 * opens the validated verification URL in the laptop browser as soon as it
 * appears, surfaces the user code, waits for the human click-through, and
 * verifies the result with a fresh probe. Untrusted or missing URLs and an
 * exit before any URL abort the attempt with a typed WorkspaceAuthError; a
 * declined or failed attempt is reported back so the caller can decide
 * between warning and error.
 */
export async function orchestrateDdtoolDeviceLogin(
	host: string,
	operations: DdtoolDeviceLoginOperations,
	display: DdtoolDeviceLoginDisplay,
	options: { readonly urlWaitMs?: number } = {},
): Promise<DdtoolDeviceLoginOutcome> {
	const manualCommand = manualDdtoolLoginCommand(host);
	let output = "";
	let failure: WorkspaceAuthError | undefined;
	let abortLogin: (() => void) | undefined;
	let abortRequested = false;
	const requestAbort = () => {
		// Captured before the output handlers are wired: a startDeviceLogin
		// implementation that emits output synchronously must not hang on the
		// remote bound waiting for an abort handle that does not exist yet.
		abortRequested = true;
		abortLogin?.();
	};
	let urlOpened = false;
	let codeLogged = false;
	const loginProcess = operations.startDeviceLogin({
		onOutput: (chunk) => {
			output += chunk;
			display.write(chunk);
			const flow = parseDdtoolDeviceLoginFlow(stripDdtoolStreamNoise(output));
			if (!urlOpened && !abortRequested && flow.url !== undefined) {
				const url = validateDdtoolDeviceLoginUrl(flow.url);
				if (url === undefined) {
					failure = new WorkspaceUntrustedDeviceLoginUrlError(flow.url, manualCommand);
					requestAbort();
					return;
				}
				urlOpened = true;
				operations.openUrl(url).then(
					(opened) =>
						display.log(
							opened ? `Opened the Workspace login page: ${url}` : `Open the Workspace login page: ${url}`,
						),
					() => display.log(`Open the Workspace login page: ${url}`),
				);
			}
			if (!codeLogged && flow.userCode !== undefined) {
				codeLogged = true;
				display.log(`When the browser asks, enter this code: ${flow.userCode}`);
			}
		},
	});
	abortLogin = loginProcess.abort;
	if (abortRequested) loginProcess.abort();
	const urlTimer = setTimeout(() => {
		if (urlOpened || abortRequested) return;
		failure = new WorkspaceAuthError(
			"Workspace device login printed no verification URL; the remote ddtool may be outdated (v1.127.1+ supports device mode)",
			manualCommand,
		);
		requestAbort();
	}, options.urlWaitMs ?? DDTOOL_DEVICE_LOGIN_URL_WAIT_MS);
	urlTimer.unref();
	let exit: Awaited<DdtoolDeviceLoginProcess["exit"]>;
	try {
		exit = await loginProcess.exit;
	} finally {
		clearTimeout(urlTimer);
	}
	if (failure !== undefined) throw failure;
	// Fail closed before interpreting exit codes: an exit without a validated,
	// opened URL means the human never reached a login page, whatever the exit
	// code claims.
	if (!urlOpened) {
		const exitDetail =
			exit.code === null ? `was terminated by signal ${exit.signal ?? "unknown"}` : `exited with code ${exit.code}`;
		throw new WorkspaceAuthError(
			`Workspace device login ${exitDetail} before printing a verification URL; the remote ddtool may be ` +
				"outdated (v1.127.1+ supports device mode)",
			manualCommand,
		);
	}
	if (exit.code !== 0) {
		const reason =
			exit.code === null ? `terminated by signal ${exit.signal ?? "unknown"}` : `exited with code ${exit.code}`;
		const detail = exit.stderr.trim().length > 0 ? `${reason}: ${exit.stderr.trim().slice(-400)}` : reason;
		return { outcome: "declined", detail: `device login ${detail}` };
	}
	const probe = await operations.probeAuth();
	if (probe === "authenticated") return { outcome: "authenticated" };
	return { outcome: "failed", detail: `auth probe still reports ${probe} after login` };
}
