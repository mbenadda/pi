import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { walk } from "../../../scripts/check-entry-graphs.mjs";

interface CodingAgentPackageJson {
	bin: { pi: string };
	main: string;
	exports: {
		".": { import: string; types: string };
		"./client": { source: string };
		"./experimental/plugin": { source: string };
		"./rpc-entry": { import: string };
	};
	files: readonly string[];
}

interface TsConfig {
	readonly include?: readonly string[];
	readonly exclude?: readonly string[];
}

const packageJson = JSON.parse(
	readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as CodingAgentPackageJson;

const buildTsconfig = JSON.parse(readFileSync(new URL("../tsconfig.build.json", import.meta.url), "utf8")) as TsConfig;

const standaloneTsconfig = JSON.parse(
	readFileSync(new URL("../tsconfig.standalone.json", import.meta.url), "utf8"),
) as TsConfig;

// The standalone-only trees: compiled for the Workspace runtime, never published.
const STANDALONE_ONLY_TREES = ["src/experimental/", "src/client/", "src/cli/experimental/"];

describe("package distribution entrypoints", () => {
	test("uses the bundle for executables and modular output for libraries", () => {
		expect(packageJson.bin.pi).toBe("dist/bundle/cli.js");
		expect(packageJson.main).toBe("./dist/index.js");
		expect(packageJson.exports["."].import).toBe("./dist/index.js");
		expect(packageJson.exports["./rpc-entry"].import).toBe("./dist/bundle/rpc-entry.js");
	});

	// Regression for #9132: internal experimental entrypoints must not be published runtime exports.
	test("keeps experimental exports source-only", () => {
		expect(packageJson.exports["./client"]).toEqual({ source: "./src/client/index.ts" });
		expect(packageJson.exports["./experimental/plugin"]).toEqual({ source: "./src/experimental/plugin.ts" });
	});

	test("keeps development-only source trees out of the published build", () => {
		expect(buildTsconfig.exclude).toContain("src/client");
		expect(buildTsconfig.exclude).toContain("src/experimental");
		expect(buildTsconfig.exclude).toContain("src/cli/experimental");
	});

	// The published `pi` bin bundles dist/cli.js, which compiles from src/cli.ts.
	test("published entries never reach the standalone-only trees", () => {
		const sourceRoot = resolve(__dirname, "../src");
		for (const entry of ["index.ts", "cli.ts", "rpc-entry.ts"]) {
			const graph = [...walk(resolve(sourceRoot, entry))].map((file) => file.replaceAll("\\", "/"));
			for (const tree of STANDALONE_ONLY_TREES) {
				expect(
					graph.filter((file) => file.includes(tree)),
					`${entry} must not reach ${tree}`,
				).toEqual([]);
			}
		}
	});

	test("compiles the standalone runtime through a separate unpublished build config", () => {
		expect(standaloneTsconfig.include).toContain("src/client/**/*.ts");
		expect(standaloneTsconfig.include).toContain("src/experimental/**/*.ts");
		expect(standaloneTsconfig.include).toContain("src/cli/experimental/**/*.ts");
		// Same dist output as the published build: the tarball allowlist below keeps it unpublished.
		expect(packageJson.files).toContain("dist");
		expect(packageJson.files).toContain("!dist/client");
		expect(packageJson.files).toContain("!dist/experimental");
		expect(packageJson.files).toContain("!dist/cli/experimental");
	});
});
