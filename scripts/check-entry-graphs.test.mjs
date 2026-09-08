import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { walk } from "./check-entry-graphs.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

test("follows literal dynamic imports like a bundler would", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-entry-graphs-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await writeFile(join(root, "entry.ts"), 'export const lazy = import("./lazy.ts");\n');
	await writeFile(join(root, "lazy.ts"), "export const value = 1;\n");

	const graph = [...walk(join(root, "entry.ts"))];

	assert.ok(graph.includes(join(root, "entry.ts")), "the entry itself is part of the graph");
	assert.ok(graph.includes(join(root, "lazy.ts")), "literal dynamic imports must be followed");
});

test("keeps type-only and variable-specifier imports out of the graph", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-entry-graphs-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const specifier = "./variable.ts";
	await writeFile(
		join(root, "entry.ts"),
		[
			'export type Lazy = typeof import("./type-only.ts");',
			"export const value = import(specifier);",
		].join("\n"),
	);
	await writeFile(join(root, "type-only.ts"), "export const erased = 1;\n");
	await writeFile(join(root, "variable.ts"), "export const hidden = 1;\n");

	const graph = [...walk(join(root, "entry.ts"))];

	assert.equal(graph.length, 1, "only the entry itself is reachable");
});

test("guards the published bun/cli entry but not the standalone-only entries", () => {
	const standaloneTrees = ["src/client/", "src/experimental/", "src/cli/experimental/"];
	const publicEntries = ["src/index.ts", "src/cli.ts", "src/rpc-entry.ts", "src/bun/cli.ts"];
	for (const entry of publicEntries) {
		const graph = [...walk(join(repoRoot, "packages/coding-agent", entry))].map((file) =>
			file.replaceAll("\\", "/"),
		);
		for (const tree of standaloneTrees) {
			assert.equal(
				graph.filter((file) => file.includes(tree)).length,
				0,
				`${entry} must not reach ${tree}`,
			);
		}
	}

	// The standalone entrypoints are allowed to reach the standalone-only trees; this keeps
	// the guard direction meaningful (a regression would make the public-entry test above
	// vacuous rather than silent).
	const standaloneGraph = [...walk(join(repoRoot, "packages/coding-agent/src/experimental/bun-cli.ts"))].map(
		(file) => file.replaceAll("\\", "/"),
	);
	assert.ok(standaloneGraph.some((file) => file.includes("src/experimental/")));
});

test("the compiled Bun entry registers the runtime before every dispatch path", () => {
	// A compiled executable only bundles the static graph of its entrypoint, and the ai
	// package's variable-specifier dynamic imports cannot resolve inside one. Every dispatch
	// path of src/experimental/bun-cli.ts (roles, bridge, piw, experimental commands, stable CLI)
	// must therefore statically reach the sandbox environment setup, the Bun OAuth flow
	// registration, and the static Bedrock module.
	const graph = [...walk(join(repoRoot, "packages/coding-agent/src/experimental/bun-cli.ts"))]
		.map((file) => relative(repoRoot, file).replaceAll("\\", "/"));
	for (const target of [
		"packages/coding-agent/src/bun/sandbox-env-setup.ts",
		"packages/coding-agent/src/bun/runtime-setup.ts",
		"packages/ai/src/bun-oauth.ts",
		"packages/ai/src/bedrock-provider.ts",
		"packages/coding-agent/src/experimental/coordinator.ts",
		"packages/coding-agent/src/experimental/server.ts",
		"packages/coding-agent/src/experimental/session-worker.ts",
		"packages/coding-agent/src/experimental/piw.ts",
		"packages/coding-agent/src/experimental/commands.ts",
	]) {
		assert.ok(graph.includes(target), `src/experimental/bun-cli.ts must statically reach ${target}`);
	}
});
