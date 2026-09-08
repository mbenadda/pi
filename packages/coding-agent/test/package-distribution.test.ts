import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

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

const packageJson = JSON.parse(
	readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as CodingAgentPackageJson;

const buildTsconfig = JSON.parse(readFileSync(new URL("../tsconfig.build.json", import.meta.url), "utf8"));

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

	// Workspace fork: the standalone runtime builds the development-only trees into dist so the
	// pinned backend can dispatch from the stable bundle, but the published tarball must still
	// exclude them to keep upstream's source-only npm policy intact.
	test("excludes development-only dist trees from the published file allowlist", () => {
		expect(packageJson.files).toContain("dist");
		expect(packageJson.files).toContain("!dist/client");
		expect(packageJson.files).toContain("!dist/experimental");
		expect(packageJson.files).toContain("!dist/cli/experimental");
	});

	// The stable bundle dispatches the experimental server command (see
	// experimental-cli-entry.test.ts), so the development-only trees must compile into dist.
	test("builds the standalone runtime trees into dist", () => {
		expect(buildTsconfig.exclude).toEqual(["node_modules", "dist"]);
	});
});
