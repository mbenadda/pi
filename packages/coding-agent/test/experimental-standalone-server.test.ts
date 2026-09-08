import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";

const sourceResolverPath = resolve(__dirname, "../src/experimental/source-resolver.ts");
const builtStandaloneEntry = resolve(__dirname, "../dist/experimental/standalone-cli.js");
const sourceStandaloneEntry = resolve(__dirname, "../src/experimental/standalone-cli.ts");
// PI_TEST_STANDALONE_ENTRY forces one entry deterministically: "built" requires the entry
// produced by `npm run build` and fails when it is missing, "source" runs the checkout sources.
// Unset, the test exercises the built entry when it exists and the source entry otherwise.
const requestedEntry = process.env.PI_TEST_STANDALONE_ENTRY;
if (requestedEntry !== undefined && requestedEntry !== "built" && requestedEntry !== "source") {
	throw new Error(`PI_TEST_STANDALONE_ENTRY must be "built" or "source", got: ${requestedEntry}`);
}
const standaloneEntry = (() => {
	if (requestedEntry === "source") return sourceStandaloneEntry;
	if (requestedEntry === "built") {
		if (!existsSync(builtStandaloneEntry)) {
			throw new Error(`Built standalone entry is missing: ${builtStandaloneEntry}`);
		}
		return builtStandaloneEntry;
	}
	return existsSync(builtStandaloneEntry) ? builtStandaloneEntry : sourceStandaloneEntry;
})();

function standaloneEntryArgs(): string[] {
	return standaloneEntry.endsWith(".ts") ? ["--import", sourceResolverPath, standaloneEntry] : [standaloneEntry];
}

function watchOutput(child: ChildProcess): () => string {
	let output = "";
	child.stdout?.on("data", (chunk) => {
		output += chunk;
	});
	child.stderr?.on("data", (chunk) => {
		output += chunk;
	});
	return () => output;
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<number | null> {
	const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
	const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
	try {
		return await exited;
	} finally {
		clearTimeout(timer);
	}
}

async function pollUntil(action: () => boolean, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (action()) return true;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return action();
}

describe.skipIf(process.platform === "win32")("standalone server startup", () => {
	test("starts a foreground server with private temp state through the standalone entry", async () => {
		const home = await mkdtemp(join(tmpdir(), "pi-standalone-server-"));
		// Unix socket paths under the server directory must stay below macOS's short sun_path
		// limit, so the private state root cannot nest inside the long default temp directory.
		const stateRoot = existsSync("/tmp") ? "/tmp" : tmpdir();
		const serverDir = await mkdtemp(join(stateRoot, "pi-ss-"));
		// mkdtemp already creates 0700; open the directory up so the assertion below proves the
		// server itself tightens an inherited permissive state directory to a private one.
		await chmod(serverDir, 0o755);
		const sessionDir = join(home, "sessions");
		const readyFile = join(home, "ready");
		const revision = "0123456789abcdef0123456789abcdef01234567";
		const generation = `${revision}:01234567-89ab-4cde-8fab-0123456789ab`;
		const serverId = "89abcdef-0123-4cde-8fab-0123456789ab";
		await mkdir(sessionDir);
		const child = spawn(
			process.execPath,
			[
				...standaloneEntryArgs(),
				"server",
				"--server-id",
				serverId,
				"--session-dir",
				sessionDir,
				"--ready-file",
				readyFile,
				"--generation",
				generation,
			],
			{
				cwd: home,
				stdio: ["ignore", "pipe", "pipe"],
				env: {
					...process.env,
					HOME: home,
					USERPROFILE: home,
					PI_CODING_AGENT_DIR: join(home, "agent"),
					PI_SERVER_DIR: serverDir,
					PI_EXPERIMENTAL: "1",
					PI_OFFLINE: "1",
				},
			},
		);
		const output = watchOutput(child);
		try {
			// The foreground server writes the exact generation token only after its private
			// server socket has started and its generation replaced the coordinator route.
			const ready = await pollUntil(() => existsSync(readyFile), 20_000);
			expect(ready, output()).toBe(true);
			expect(child.exitCode, output()).toBeNull();
			expect((await readFile(readyFile, "utf8")).trim()).toBe(generation);
			// Output is async; give the runtime banner a moment to flush before asserting it.
			expect(await pollUntil(() => output().includes(`Server: ${serverId}`), 5_000), output()).toBe(true);

			// The server must make an inherited permissive state directory private.
			expect((await stat(serverDir)).mode & 0o777).toBe(0o700);

			child.kill("SIGTERM");
			expect(await waitForExit(child, 15_000)).toBe(0);
		} finally {
			if (child.exitCode === null) {
				child.kill("SIGKILL");
				await waitForExit(child, 5_000);
			}
			await rm(home, { recursive: true, force: true });
			await rm(serverDir, { recursive: true, force: true });
		}
	});
});
