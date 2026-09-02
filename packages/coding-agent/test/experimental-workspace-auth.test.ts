import { describe, expect, test } from "vitest";
import {
	buildDdtoolAuthProbeCommand,
	buildDdtoolDeviceLoginCommand,
	classifyDdtoolAuthProbe,
	type DdtoolDeviceLoginDisplay,
	type DdtoolDeviceLoginOperations,
	type DdtoolDeviceLoginProcess,
	manualDdtoolLoginCommand,
	orchestrateDdtoolDeviceLogin,
	parseDdtoolDeviceLoginFlow,
	validateDdtoolDeviceLoginUrl,
	WorkspaceAuthError,
} from "../src/experimental/workspace-auth.ts";

const HOST = "workspace-bcli-10";

// Exact device-mode stdout captured live from ddtool v1.127.1 on workspace-bcli-10
// (expired vault session, aborted before completion).
const DEVICE_LOGIN_OUTPUT =
	"Complete the login via your OIDC provider. Open the following link in your browser:\n" +
	"\n" +
	"    https://www.google.com/device\n" +
	"\n" +
	"\n" +
	"Waiting for OIDC authentication to complete...\n" +
	"When prompted, enter code RFK-BJB-YSYD\n";

// Auth-code fallback stdout captured live from ddtool v1.101.0, which silently
// ignored `--mode device`. The localhost callback URL can never complete from a
// laptop browser, so it must never be opened automatically.
const AUTH_CODE_OUTPUT =
	'[ddtool] opening a browser tab to login to vault ("https://vault.us1.ddbuild.io") and retrieve a new token\n' +
	"Complete the login via your OIDC provider. Launching browser to:\n" +
	"\n" +
	"    https://accounts.google.com/o/oauth2/v2/auth?client_id=x&code_challenge=y" +
	"&redirect_uri=http%3A%2F%2Flocalhost%3A8253%2Foidc%2Fcallback&response_type=code&scope=openid\n" +
	"\n" +
	"Waiting for OIDC authentication to complete...\n";

function fakeDisplay(): DdtoolDeviceLoginDisplay & { readonly written: string[]; readonly logged: string[] } {
	const written: string[] = [];
	const logged: string[] = [];
	return { written, logged, write: (chunk) => written.push(chunk), log: (message) => logged.push(message) };
}

interface FakeDeviceLoginSpec {
	readonly chunks: readonly string[];
	readonly exit: { readonly code: number | null; readonly signal: NodeJS.Signals | null; readonly stderr: string };
	/** Delay before the login exits on its own; large when only abort() should end it. */
	readonly exitDelayMs?: number;
	readonly probeResults?: readonly ("authenticated" | "expired" | "unavailable")[];
	readonly openUrlResult?: boolean;
}

interface FakeOperations extends DdtoolDeviceLoginOperations {
	readonly openedUrls: string[];
	probeCalls(): number;
	aborted(): boolean;
}

function fakeOperations(spec: FakeDeviceLoginSpec): FakeOperations {
	const openedUrls: string[] = [];
	let probeCount = 0;
	let aborted = false;
	return {
		openedUrls,
		probeCalls: () => probeCount,
		aborted: () => aborted,
		probeAuth: async () => {
			const result = spec.probeResults?.[probeCount] ?? "authenticated";
			probeCount += 1;
			return result;
		},
		startDeviceLogin: (handlers) => {
			const process: DdtoolDeviceLoginProcess = fakeDeviceLoginProcess(spec, () => {
				aborted = true;
			});
			for (const chunk of spec.chunks) setTimeout(() => handlers.onOutput(chunk), 1);
			return process;
		},
		openUrl: async (url) => {
			openedUrls.push(url);
			return spec.openUrlResult ?? true;
		},
	};
}

function fakeDeviceLoginProcess(spec: FakeDeviceLoginSpec, onAbort: () => void): DdtoolDeviceLoginProcess {
	let abortRequested: (() => void) | undefined;
	const exit = new Promise<{
		readonly code: number | null;
		readonly signal: NodeJS.Signals | null;
		readonly stderr: string;
	}>((resolve) => {
		abortRequested = () => {
			onAbort();
			resolve({ code: null, signal: "SIGKILL", stderr: spec.exit.stderr });
		};
		const timer = setTimeout(() => resolve(spec.exit), spec.exitDelayMs ?? 1_000_000);
		timer.unref();
	});
	return {
		exit,
		abort: () => abortRequested?.(),
	};
}

describe("ddtool auth probe", () => {
	test("builds a bounded non-interactive probe with detached streams", () => {
		expect(buildDdtoolAuthProbeCommand()).toBe(
			"timeout -k 2s 12s ddtool auth token rapid-ai-platform --datacenter us1.ddbuild.io >/dev/null 2>&1 </dev/null",
		);
	});

	test("builds the device-mode login command", () => {
		expect(buildDdtoolDeviceLoginCommand()).toBe(
			"timeout -k 2s 600s ddtool auth login --mode device --datacenter us1.ddbuild.io",
		);
	});

	test("builds the exact manual login command for a valid host", () => {
		expect(manualDdtoolLoginCommand("workspace-bcli-10")).toBe(
			"ssh -t workspace-bcli-10 'ddtool auth login --mode device --datacenter us1.ddbuild.io'",
		);
		expect(() => manualDdtoolLoginCommand("bad host")).toThrow(/Invalid SSH host/);
	});

	test.each([
		[0, "authenticated"],
		[124, "expired"],
		[137, "expired"],
		[1, "expired"],
		[2, "expired"],
		[126, "unavailable"],
		[127, "unavailable"],
	] as const)("classifies probe exit %i as %s", (code, expected) => {
		expect(classifyDdtoolAuthProbe(code)).toBe(expected);
	});
});

describe("ddtool device login flow parsing", () => {
	test("parses the captured device-mode output into URL and user code", () => {
		expect(parseDdtoolDeviceLoginFlow(DEVICE_LOGIN_OUTPUT)).toEqual({
			url: "https://www.google.com/device",
			userCode: "RFK-BJB-YSYD",
		});
	});

	test("rejects the auth-code fallback output", () => {
		expect(parseDdtoolDeviceLoginFlow(AUTH_CODE_OUTPUT)).toEqual({});
	});
});

describe("ddtool device login URL validation", () => {
	test("accepts the captured device-flow URL", () => {
		expect(validateDdtoolDeviceLoginUrl("https://www.google.com/device")).toBe("https://www.google.com/device");
		expect(validateDdtoolDeviceLoginUrl("https://accounts.google.com/device")).toBe(
			"https://accounts.google.com/device",
		);
	});

	test.each([
		["http://www.google.com/device"],
		["https://user:pass@www.google.com/device"],
		["https://evil.example.com/device"],
		["https://evil-google.com/device"],
		["https://google.com.evil.example.com/device"],
		["https://www.google.com.evil.example.com/"],
		["https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=http%3A%2F%2Flocalhost%3A8253%2Foidc%2Fcallback"],
		["not a url"],
	])("rejects %s", (raw) => {
		expect(validateDdtoolDeviceLoginUrl(raw)).toBeUndefined();
	});
});

describe("ddtool device login orchestration", () => {
	test("opens the parsed URL, surfaces the code, and verifies with a fresh probe", async () => {
		const operations = fakeOperations({
			chunks: [DEVICE_LOGIN_OUTPUT],
			exit: { code: 0, signal: null, stderr: "" },
			exitDelayMs: 5,
		});
		const display = fakeDisplay();
		const result = await orchestrateDdtoolDeviceLogin(HOST, operations, display);
		expect(result).toEqual({ outcome: "authenticated" });
		expect(operations.openedUrls).toEqual(["https://www.google.com/device"]);
		expect(display.logged).toContain("When the browser asks, enter this code: RFK-BJB-YSYD");
		expect(display.written).toEqual([DEVICE_LOGIN_OUTPUT]);
		expect(operations.probeCalls()).toBe(1);
		expect(operations.aborted()).toBe(false);
	});

	test("prints the URL when no browser can be opened", async () => {
		const operations = fakeOperations({
			chunks: [DEVICE_LOGIN_OUTPUT],
			exit: { code: 0, signal: null, stderr: "" },
			exitDelayMs: 5,
			openUrlResult: false,
		});
		const display = fakeDisplay();
		await orchestrateDdtoolDeviceLogin(HOST, operations, display);
		expect(display.logged).toContain("Open the Workspace login page: https://www.google.com/device");
	});

	test("reports a declined login with exit detail and stderr", async () => {
		const operations = fakeOperations({
			chunks: [DEVICE_LOGIN_OUTPUT],
			exit: { code: 1, signal: null, stderr: "vault is unreachable" },
			exitDelayMs: 5,
		});
		const result = await orchestrateDdtoolDeviceLogin(HOST, operations, fakeDisplay());
		expect(result).toEqual({ outcome: "declined", detail: "device login exited with code 1: vault is unreachable" });
	});

	test("reports a failed login when the probe still reports expired", async () => {
		const operations = fakeOperations({
			chunks: [DEVICE_LOGIN_OUTPUT],
			exit: { code: 0, signal: null, stderr: "" },
			exitDelayMs: 5,
			probeResults: ["expired"],
		});
		const result = await orchestrateDdtoolDeviceLogin(HOST, operations, fakeDisplay());
		expect(result).toEqual({ outcome: "failed", detail: "auth probe still reports expired after login" });
	});

	test("aborts and errors on an untrusted verification URL without opening it", async () => {
		const operations = fakeOperations({
			chunks: ["Open the following link in your browser:\n    https://evil.example.com/device\n"],
			exit: { code: 0, signal: null, stderr: "" },
			exitDelayMs: 30_000,
		});
		await expect(orchestrateDdtoolDeviceLogin(HOST, operations, fakeDisplay())).rejects.toThrow(WorkspaceAuthError);
		expect(operations.openedUrls).toEqual([]);
		expect(operations.aborted()).toBe(true);
	});

	test("aborts and errors when no verification URL is printed within the wait", async () => {
		const operations = fakeOperations({
			chunks: ["Waiting for OIDC authentication to complete...\n"],
			exit: { code: 0, signal: null, stderr: "" },
			exitDelayMs: 30_000,
		});
		await expect(orchestrateDdtoolDeviceLogin(HOST, operations, fakeDisplay(), { urlWaitMs: 20 })).rejects.toThrow(
			/printed no verification URL/,
		);
		expect(operations.aborted()).toBe(true);
	});

	test("fails closed on the auth-code fallback output instead of opening the callback URL", async () => {
		const operations = fakeOperations({
			chunks: [AUTH_CODE_OUTPUT],
			exit: { code: 0, signal: null, stderr: "" },
			exitDelayMs: 30_000,
		});
		await expect(orchestrateDdtoolDeviceLogin(HOST, operations, fakeDisplay(), { urlWaitMs: 20 })).rejects.toThrow(
			/printed no verification URL/,
		);
		expect(operations.openedUrls).toEqual([]);
	});
});
