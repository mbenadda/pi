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

function runEntry(entry: string, experimental: boolean) {
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
			},
		},
	);
}

describe("stable and development CLI entrypoints", () => {
	// #9132 keeps remote-server dependencies out of upstream's published CLI. This fork
	// deliberately diverges: the standalone Workspace backend runs `pi server` from the
	// stable bundle/binary behind PI_EXPERIMENTAL=1, so the stable entrypoint dispatches
	// experimental commands when experiments are enabled. The published npm exports stay
	// source-only (see packages/coding-agent/package.json).
	it("dispatches experimental commands from the stable entrypoint when experiments are enabled", () => {
		const result = runEntry("cli.ts", true);
		expect(result.status, result.stderr).toBe(1);
		expect(result.stderr).toContain("Invalid --server-id");
		expect(result.stdout).not.toContain(VERSION);
	});

	it("falls back to the stable CLI when experiments are disabled", () => {
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

	it("falls back to the stable CLI when experiments are disabled", () => {
		const result = runEntry("experimental/cli.ts", false);
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout.trim()).toBe(VERSION);
	});
});
