import { spawn, spawnSync } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, test } from "vitest";

const bunProbe = spawnSync("bun", ["--version"], { encoding: "utf8", timeout: 15_000 });
const bunAvailable = bunProbe.status === 0 && /^\d+\.\d+\.\d+/m.test(bunProbe.stdout);

interface ProcessResult {
	status: number | null;
	stdout: string;
	stderr: string;
}

/** Async spawn: the mock server lives in this process, so children must not block the event loop. */
function runProcess(
	command: string,
	args: string[],
	options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<ProcessResult> {
	return new Promise((resolveRun) => {
		const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk;
		});
		const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
		child.once("exit", (code) => {
			clearTimeout(timer);
			resolveRun({ status: code, stdout, stderr });
		});
		child.once("error", () => {
			clearTimeout(timer);
			resolveRun({ status: null, stdout, stderr });
		});
	});
}

// `bun build --compile` leaves its staging file (`.{hash}.bun-build`) in the working directory;
// the test snapshots them before building and removes only the ones its own build created.
const BUN_BUILD_STAGING = /^\.[0-9a-f]+-00000000\.bun-build$/;

function stagingFiles(root: string): Set<string> {
	return new Set(readdirSync(root).filter((name) => BUN_BUILD_STAGING.test(name)));
}

let mockServer: Server | undefined;
const mockRequests: { method: string | undefined; url: string | undefined }[] = [];

afterAll(async () => {
	if (!mockServer) return;
	mockServer.closeAllConnections();
	await new Promise<void>((resolveClose) => mockServer?.close(() => resolveClose()));
});

describe.skipIf(process.platform === "win32" || !bunAvailable)("compiled Bun binary model/auth smoke", () => {
	test("compiled binary registers Bun OAuth loaders and reaches a mock Bedrock endpoint offline", async () => {
		const root = resolve(__dirname, "../../..");
		const workDir = await mkdtemp(join(tmpdir(), "pi-compiled-smoke-"));
		const binaryPath = join(workDir, "pi-compiled-smoke");
		const stagingBefore = stagingFiles(root);
		try {
			// The entry is compiled from the checkout sources: building from the repository root
			// applies the root tsconfig paths, which map the workspace packages onto src, mirroring
			// how `bun build --compile` bundles src/experimental/bun-cli.ts in the real binary
			// build. Bun stages the compile temporary next to the outfile, so the scratch
			// directory collects it.
			const build = await runProcess(
				"bun",
				[
					"build",
					"--compile",
					"--no-compile-autoload-bunfig",
					join(root, "scripts", "compiled-binary-smoke-entry.ts"),
					"--outfile",
					binaryPath,
				],
				{ cwd: root, timeoutMs: 120_000 },
			);
			expect(build.status, build.stderr).toBe(0);

			// Plain HTTP/1.1 mock: the entry sets AWS_BEDROCK_FORCE_HTTP1=1, the supported
			// path for custom endpoints, so the request cannot leave the machine.
			const server = createServer((request, response) => {
				mockRequests.push({ method: request.method, url: request.url });
				response.writeHead(400, { "content-type": "application/json" });
				response.end(JSON.stringify({ message: "pi-compiled-smoke-bedrock-mock" }));
			});
			mockServer = server;
			await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
			const port = (server.address() as AddressInfo).port;

			const env: NodeJS.ProcessEnv = { ...process.env, PI_COMPILED_SMOKE_BEDROCK_URL: `http://127.0.0.1:${port}` };
			for (const name of Object.keys(env)) {
				if (name.startsWith("AWS_")) delete env[name];
			}
			const run = await runProcess(binaryPath, [], { env, timeoutMs: 60_000 });

			// The registered bundled OAuth loaders must return the statically embedded flows;
			// without registration the compiled binary would fail to resolve the ai
			// package's variable-specifier dynamic imports.
			expect(run.status, run.stderr).toBe(0);
			expect(run.stdout).toContain("oauth-anthropic Anthropic (Claude Pro/Max)");
			expect(run.stdout).toContain("oauth-copilot GitHub Copilot");

			// The Bedrock request must travel through the embedded module to the mock with
			// dummy credentials, and surface the mock's body in the stream error.
			expect(run.stdout).toContain("bedrock error ");
			expect(run.stdout).toContain("pi-compiled-smoke-bedrock-mock");
			expect(mockRequests).toHaveLength(1);
			expect(mockRequests[0]?.method).toBe("POST");
			expect(mockRequests[0]?.url).toContain("amazon.nova-2-lite-v1");
		} finally {
			for (const name of stagingFiles(root)) {
				if (!stagingBefore.has(name)) rmSync(join(root, name), { force: true });
			}
			await rm(workDir, { recursive: true, force: true });
		}
	}, 180_000);
});
