import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ensureWorkspaceAttachAuth, probeWorkspaceDdtoolAuth } from "../src/experimental/workspace.ts";
import {
	buildDdtoolAuthProbeCommand,
	buildDdtoolDeviceLoginCommand,
	classifyDdtoolAuthProbe,
	createDdtoolLoginDisplay,
	type DdtoolAuthProbeResult,
	type DdtoolDeviceLoginDisplay,
	type DdtoolDeviceLoginOperations,
	type DdtoolDeviceLoginProcess,
	manualDdtoolLoginCommand,
	orchestrateDdtoolDeviceLogin,
	parseDdtoolDeviceLoginFlow,
	stripDdtoolStreamNoise,
	validateDdtoolDeviceLoginUrl,
	WorkspaceAuthError,
	WorkspaceUntrustedDeviceLoginUrlError,
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

function fakeDisplay(): DdtoolDeviceLoginDisplay & {
	readonly written: string[];
	readonly logged: string[];
	closeCalls(): number;
} {
	const written: string[] = [];
	const logged: string[] = [];
	let closeCalls = 0;
	return {
		close: () => {
			closeCalls += 1;
		},
		written,
		logged,
		write: (chunk) => written.push(chunk),
		log: (message) => logged.push(message),
		closeCalls: () => closeCalls,
	};
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
			const login: DdtoolDeviceLoginProcess = fakeDeviceLoginProcess(spec, () => {
				aborted = true;
			});
			for (const chunk of spec.chunks) setTimeout(() => handlers.onOutput(chunk), 1);
			return login;
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

	test("requires a newline terminator after the verification URL", () => {
		const unterminated = "Open the following link in your browser:\n\n    https://www.google.com/device";
		expect(parseDdtoolDeviceLoginFlow(unterminated)).toEqual({});
		expect(parseDdtoolDeviceLoginFlow(`${unterminated}\n`)).toEqual({ url: "https://www.google.com/device" });
	});

	test("requires a whitespace terminator after the user code", () => {
		const unterminated = "When prompted, enter code RFK-BJB-YSYD";
		expect(parseDdtoolDeviceLoginFlow(unterminated)).toEqual({});
		expect(parseDdtoolDeviceLoginFlow(`${unterminated}\n`)).toEqual({ userCode: "RFK-BJB-YSYD" });
	});

	test("strips nc: transport noise lines", () => {
		expect(stripDdtoolStreamNoise("nc: noise line\nreal line\n    nc: indented noise\ncode line\n")).toBe(
			"real line\ncode line\n",
		);
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
		expect(display.closeCalls()).toBe(1);
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
		const display = fakeDisplay();
		await expect(orchestrateDdtoolDeviceLogin(HOST, operations, display)).rejects.toThrow(
			WorkspaceUntrustedDeviceLoginUrlError,
		);
		expect(operations.openedUrls).toEqual([]);
		expect(operations.aborted()).toBe(true);
		expect(display.closeCalls()).toBe(1);
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

	test("opens the URL only after its terminator arrives across split chunks", async () => {
		const operations = fakeOperations({
			chunks: [
				"Complete the login via your OIDC provider. Open the following link in your browser:\n\n    https://www.goo",
				"gle.com/device\n\nWaiting for OIDC authentication to complete...\nWhen prompted, enter code RFK-BJB-YSYD\n",
			],
			exit: { code: 0, signal: null, stderr: "" },
			exitDelayMs: 5,
		});
		const display = fakeDisplay();
		const result = await orchestrateDdtoolDeviceLogin(HOST, operations, display);
		expect(result).toEqual({ outcome: "authenticated" });
		expect(operations.openedUrls).toEqual(["https://www.google.com/device"]);
		expect(display.logged).toContain("When the browser asks, enter this code: RFK-BJB-YSYD");
	});

	test("logs the user code only after its terminator arrives across split chunks", async () => {
		const operations = fakeOperations({
			chunks: [
				"Open the following link in your browser:\n\n    https://www.google.com/device\n\n" +
					"Waiting for OIDC authentication to complete...\n",
				"When prompted, enter code RFK-B",
				"JB-YSYD\n",
			],
			exit: { code: 0, signal: null, stderr: "" },
			exitDelayMs: 5,
		});
		const display = fakeDisplay();
		const result = await orchestrateDdtoolDeviceLogin(HOST, operations, display);
		expect(result).toEqual({ outcome: "authenticated" });
		expect(operations.openedUrls).toEqual(["https://www.google.com/device"]);
		expect(display.logged.filter((message) => message.startsWith("When the browser asks"))).toEqual([
			"When the browser asks, enter this code: RFK-BJB-YSYD",
		]);
	});

	test("parses the flow with interleaved nc: transport noise lines stripped", async () => {
		const operations = fakeOperations({
			chunks: [
				"Open the following link in your browser:\nnc: getaddrinfo: stream reset\n",
				"nc: further proxy noise\n    https://www.google.com/device\n",
				"When prompted, enter code RFK-BJB-YSYD\n",
			],
			exit: { code: 0, signal: null, stderr: "" },
			exitDelayMs: 5,
		});
		const display = fakeDisplay();
		const result = await orchestrateDdtoolDeviceLogin(HOST, operations, display);
		expect(result).toEqual({ outcome: "authenticated" });
		expect(operations.openedUrls).toEqual(["https://www.google.com/device"]);
		expect(display.logged).toContain("When the browser asks, enter this code: RFK-BJB-YSYD");
	});

	test.each([
		{ exit: { code: 0, signal: null, stderr: "" }, probeResults: ["expired"] as const },
		{ exit: { code: 7, signal: null, stderr: "vault exploded" }, probeResults: undefined },
	] as const)(
		"fails closed when the login exits immediately with code $exit.code and no URL",
		async ({ exit, probeResults }) => {
			const operations = fakeOperations({
				chunks: [],
				exit,
				exitDelayMs: 5,
				probeResults,
			});
			await expect(orchestrateDdtoolDeviceLogin(HOST, operations, fakeDisplay())).rejects.toThrow(
				/before printing a verification URL/,
			);
			expect(operations.openedUrls).toEqual([]);
		},
	);

	test("reports the probe failure when the clean-exit re-probe rejects", async () => {
		const operations: DdtoolDeviceLoginOperations = {
			probeAuth: () => Promise.reject(new Error("connection reset")),
			startDeviceLogin: () =>
				fakeDeviceLoginProcess(
					{ chunks: [], exit: { code: 0, signal: null, stderr: "" }, exitDelayMs: 5 },
					() => {},
				),
			openUrl: () => Promise.reject(new Error("url must not open")),
		};
		await expect(orchestrateDdtoolDeviceLogin(HOST, operations, fakeDisplay())).rejects.toThrow(
			/auth probe then failed: connection reset/,
		);
	});

	test("trusts a clean no-URL exit when a fresh probe confirms the session", async () => {
		const operations = fakeOperations({
			chunks: [],
			exit: { code: 0, signal: null, stderr: "" },
			exitDelayMs: 5,
		});
		const display = fakeDisplay();
		const result = await orchestrateDdtoolDeviceLogin(HOST, operations, display);
		expect(result).toEqual({ outcome: "authenticated" });
		expect(operations.openedUrls).toEqual([]);
		expect(operations.probeCalls()).toBe(1);
		expect(display.closeCalls()).toBe(1);
	});

	test("never opens a URL when transport noise splices into the URL line", async () => {
		const operations = fakeOperations({
			chunks: [
				"Open the following link in your browser:\n\n    https://www.gnc: proxy noise\n",
				"oogle.com/device\nWhen prompted, enter code RFK-BJB-YSYD\n",
			],
			exit: { code: 0, signal: null, stderr: "" },
			exitDelayMs: 30_000,
		});
		await expect(orchestrateDdtoolDeviceLogin(HOST, operations, fakeDisplay(), { urlWaitMs: 20 })).rejects.toThrow(
			/printed no verification URL/,
		);
		expect(operations.openedUrls).toEqual([]);
	});
});

function captureConsole(): { logs: string[]; warnings: string[]; restore(): void } {
	const logs: string[] = [];
	const warnings: string[] = [];
	const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
		logs.push(args.map(String).join(" "));
	});
	const error = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
		warnings.push(args.map(String).join(" "));
	});
	return {
		logs,
		warnings,
		restore: () => {
			log.mockRestore();
			error.mockRestore();
		},
	};
}

async function withFakeSsh(script: string, run: () => Promise<void>): Promise<void> {
	const fakeBin = await mkdtemp(join(tmpdir(), "pi-workspace-ssh-auth-"));
	const originalPath = process.env.PATH;
	try {
		await writeFile(join(fakeBin, "ssh"), script, { mode: 0o700 });
		process.env.PATH = `${fakeBin}:${originalPath ?? ""}`;
		await run();
	} finally {
		process.env.PATH = originalPath;
		await rm(fakeBin, { recursive: true, force: true });
	}
}

describe("ddtool login display filtering", () => {
	function captureStdout(): { readonly output: string[]; restore(): void } {
		const output: string[] = [];
		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
			output.push(String(chunk));
			return true;
		});
		const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			output.push(`${args.map(String).join(" ")}\n`);
		});
		return {
			output,
			restore: () => {
				writeSpy.mockRestore();
				logSpy.mockRestore();
			},
		};
	}

	test("hides split noise, keeps log messages clean, and flushes the remainder on close", () => {
		const console_ = captureStdout();
		try {
			const display = createDdtoolLoginDisplay();
			display.write("Complete the login via your OIDC provider.\n");
			display.write("n");
			display.write("c: proxy noise\n");
			expect(console_.output.join("")).toBe("Complete the login via your OIDC provider.\n");

			display.write("Waiting for OIDC authentication");
			display.log("enter code RFK-BJB-YSYD");
			const withMessage = console_.output.join("");
			expect(withMessage).toContain("enter code RFK-BJB-YSYD\n");
			expect(withMessage).not.toContain("Waiting for OIDC authenticationenter");

			console_.output.length = 0;
			display.write(" to complete...\n");
			display.write("tail without newline");
			display.close();
			expect(console_.output.join("")).toBe("Waiting for OIDC authentication to complete...\ntail without newline");
		} finally {
			console_.restore();
		}
	});
});

describe("workspace ddtool auth policy", () => {
	const unusedLoginOperations: DdtoolDeviceLoginOperations = {
		probeAuth: () => Promise.reject(new Error("probe must not run")),
		startDeviceLogin: () => {
			throw new Error("device login must not start");
		},
		openUrl: () => Promise.reject(new Error("url must not open")),
	};
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("treats ssh exit 255 as a transport failure with probe stderr detail", async () => {
		await withFakeSsh(
			"#!/bin/sh\nprintf 'ssh: connect to host workspace-bcli-10 port 22: Connection refused\\n' >&2\nexit 255\n",
			async () => {
				const probe = probeWorkspaceDdtoolAuth(HOST);
				await expect(probe).rejects.toThrow(WorkspaceAuthError);
				await expect(probe).rejects.toThrow(/\(exit 255\): ssh: connect to host workspace-bcli-10/u);
			},
		);
	});

	test("treats an ssh signal as a transport probe failure", async () => {
		await withFakeSsh("#!/bin/sh\nkill -TERM $$\n", async () => {
			const probe = probeWorkspaceDdtoolAuth(HOST);
			await expect(probe).rejects.toThrow(WorkspaceAuthError);
			await expect(probe).rejects.toThrow(/probe failed over SSH.*SIGTERM/su);
		});
	});

	test("attach warns and proceeds when the probe transport fails", async () => {
		const console_ = captureConsole();
		try {
			await ensureWorkspaceAttachAuth(
				HOST,
				Promise.reject(
					new WorkspaceAuthError(
						"Workspace ddtool auth probe failed over SSH (exit 255): Connection refused",
						manualDdtoolLoginCommand(HOST),
					),
				),
				{ loginOperations: unusedLoginOperations, loginDisplay: fakeDisplay() },
			);
		} finally {
			console_.restore();
		}
		expect(console_.warnings).toHaveLength(1);
		expect(console_.warnings[0]).toContain("--no-login");
		expect(console_.warnings[0]).toContain(manualDdtoolLoginCommand(HOST));
	});

	test("attach warns and proceeds when ddtool is unavailable", async () => {
		const console_ = captureConsole();
		try {
			await ensureWorkspaceAttachAuth(HOST, Promise.resolve<DdtoolAuthProbeResult>("unavailable"), {
				loginOperations: unusedLoginOperations,
				loginDisplay: fakeDisplay(),
			});
		} finally {
			console_.restore();
		}
		expect(console_.warnings).toHaveLength(1);
		expect(console_.warnings[0]).toContain("ddtool is missing or not executable on workspace-bcli-10");
		expect(console_.warnings[0]).toContain("--no-login");
		expect(console_.warnings[0]).toContain(manualDdtoolLoginCommand(HOST));
	});

	test("attach stays silent when the probe is authenticated", async () => {
		const console_ = captureConsole();
		try {
			await ensureWorkspaceAttachAuth(HOST, Promise.resolve<DdtoolAuthProbeResult>("authenticated"), {
				loginOperations: unusedLoginOperations,
				loginDisplay: fakeDisplay(),
			});
		} finally {
			console_.restore();
		}
		expect(console_.warnings).toEqual([]);
		expect(console_.logs).toEqual([]);
	});

	test("attach warns and proceeds on a declined login", async () => {
		const console_ = captureConsole();
		try {
			await ensureWorkspaceAttachAuth(HOST, Promise.resolve<DdtoolAuthProbeResult>("expired"), {
				loginOperations: fakeOperations({
					chunks: [DEVICE_LOGIN_OUTPUT],
					exit: { code: 1, signal: null, stderr: "vault is unreachable" },
					exitDelayMs: 5,
				}),
				loginDisplay: fakeDisplay(),
			});
		} finally {
			console_.restore();
		}
		expect(console_.warnings).toHaveLength(1);
		expect(console_.warnings[0]).toContain("device login exited with code 1: vault is unreachable");
		expect(console_.warnings[0]).toContain("--no-login");
		expect(console_.warnings[0]).toContain(manualDdtoolLoginCommand(HOST));
	});

	test("attach hard-aborts only on an untrusted verification URL", async () => {
		const console_ = captureConsole();
		try {
			await expect(
				ensureWorkspaceAttachAuth(HOST, Promise.resolve<DdtoolAuthProbeResult>("expired"), {
					loginOperations: fakeOperations({
						chunks: ["Open the following link in your browser:\n    https://evil.example.com/device\n"],
						exit: { code: 0, signal: null, stderr: "" },
						exitDelayMs: 30_000,
					}),
					loginDisplay: fakeDisplay(),
				}),
			).rejects.toThrow(WorkspaceUntrustedDeviceLoginUrlError);
		} finally {
			console_.restore();
		}
		expect(console_.warnings).toEqual([]);
	});
});
