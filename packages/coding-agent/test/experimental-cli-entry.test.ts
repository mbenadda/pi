import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VERSION } from "../src/config.ts";

const sourceResolverPath = resolve(__dirname, "../src/experimental/source-resolver.ts");
const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function runEntry(entry: string, experimental: boolean, env: NodeJS.ProcessEnv = {}) {
	const directory = mkdtempSync(join(tmpdir(), "pi-cli-boundary-"));
	tempDirs.push(directory);
	return spawnSync(
		process.execPath,
		[
			"--import",
			sourceResolverPath,
			resolve(__dirname, "../src", entry),
			"server",
			"--server-id",
			"invalid",
			"--version",
		],
		{
			cwd: directory,
			encoding: "utf8",
			timeout: 15_000,
			env: {
				...process.env,
				HOME: directory,
				USERPROFILE: directory,
				PI_CODING_AGENT_DIR: join(directory, "agent"),
				PI_OFFLINE: "1",
				PI_EXPERIMENTAL: experimental ? "1" : "0",
				...env,
			},
		},
	);
}

describe("stable and standalone CLI entrypoints", () => {
	// #9132: enabling experiments must not pull remote-server dependencies into the published CLI.
	// The stable entrypoint never dispatches experimental commands; the standalone Workspace
	// runtime dispatches them from its own unpublished entrypoints instead.
	it("does not dispatch experimental commands from the stable entrypoint", () => {
		const result = runEntry("cli.ts", true);
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout.trim()).toBe(VERSION);
	});

	it("keeps the stable CLI behavior with experiments disabled", () => {
		const result = runEntry("cli.ts", false);
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout.trim()).toBe(VERSION);
	});

	it("keeps experimental dispatch in the development entrypoint", () => {
		const result = runEntry("experimental/cli.ts", true);
		expect(result.status, result.stderr).toBe(1);
		expect(result.stderr).toContain("Invalid --server-id");
		expect(result.stdout).not.toContain(VERSION);
	});

	it("falls back to the stable CLI from the development entrypoint when experiments are disabled", () => {
		const result = runEntry("experimental/cli.ts", false);
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout.trim()).toBe(VERSION);
	});

	it("dispatches experimental commands from the standalone entrypoint", () => {
		const result = runEntry("experimental/standalone-cli.ts", true);
		expect(result.status, result.stderr).toBe(1);
		expect(result.stderr).toContain("Invalid --server-id");
		expect(result.stdout).not.toContain(VERSION);
	});

	it("falls back to the stable CLI from the standalone entrypoint when experiments are disabled", () => {
		const result = runEntry("experimental/standalone-cli.ts", false);
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout.trim()).toBe(VERSION);
	});

	it("routes internal process roles through the standalone entrypoint", () => {
		const result = runEntry("experimental/standalone-cli.ts", true, { __PI_INTERNAL_SPAWN: "server" });
		expect(result.status, result.stderr).not.toBe(0);
		expect(result.stderr).toContain("Internal server requires an absolute server directory");
	});

	it("rejects an unsupported internal process role", () => {
		const result = runEntry("experimental/standalone-cli.ts", true, { __PI_INTERNAL_SPAWN: "bogus" });
		expect(result.status, result.stderr).not.toBe(0);
		expect(result.stderr).toContain("Unsupported internal process role: bogus");
	});
});
