#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { isAbsolute, join, relative, resolve } from "node:path";
import ts from "typescript";
import { getPublicWorkspacePackages } from "./release-packages.mjs";

const failures = [];

/**
 * The Workspace fork compiles the experimental client/server runtime into its standalone
 * binaries, so those source trees legitimately value-import the development-only workspace
 * packages. Upstream keeps those imports source-only; the standalone packaging carries them
 * instead of re-exposing them through the npm exports (see coding-agent package.json files).
 */
const STANDALONE_RUNTIME_TREES = new Map([
	[
		"@earendil-works/pi-coding-agent",
		{
			trees: ["client/", "experimental/", "cli/experimental/"],
			packages: ["@earendil-works/pi-client", "@earendil-works/pi-protocol", "@earendil-works/pi-server"],
		},
	],
]);

/** Workspace fork: coding-agent compiles the standalone-only trees through this extra config. */
const STANDALONE_BUILD_CONFIGS = new Map([["@earendil-works/pi-coding-agent", "tsconfig.standalone.json"]]);

function packageBase(specifier) {
	return specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/");
}

function allowsStandaloneRuntimeImport(manifest, sourcePath, specifier) {
	const policy = STANDALONE_RUNTIME_TREES.get(manifest.name);
	if (policy === undefined) return false;
	if (!policy.packages.includes(packageBase(specifier))) return false;
	return policy.trees.some((tree) => sourcePath.startsWith(tree));
}

function checkSource(source, manifest, sourcePath) {
	const file = source.fileName;
	const declared = new Set([
		manifest.name,
		...Object.keys(manifest.dependencies ?? {}),
		...Object.keys(manifest.optionalDependencies ?? {}),
		...Object.keys(manifest.peerDependencies ?? {}),
	]);

	function checkSpecifier(node) {
		if (!node || !ts.isStringLiteralLike(node)) return;
		const specifier = node.text;
		if (specifier.startsWith(".") || specifier.startsWith("/") || isBuiltin(specifier)) return;
		const name = packageBase(specifier);
		if (declared.has(name)) return;
		if (allowsStandaloneRuntimeImport(manifest, sourcePath, specifier)) return;
		const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
		failures.push(`${file}:${line + 1}: ${specifier} is not declared in ${manifest.name}'s runtime dependencies`);
	}

	function visit(node) {
		if (ts.isImportDeclaration(node)) {
			const clause = node.importClause;
			const bindings = clause?.namedBindings;
			if (
				!clause ||
				(!clause.isTypeOnly &&
					(clause.name || !bindings || !ts.isNamedImports(bindings) ||
						bindings.elements.length === 0 || bindings.elements.some((element) => !element.isTypeOnly)))
			) {
				checkSpecifier(node.moduleSpecifier);
			}
		} else if (ts.isExportDeclaration(node) && !node.isTypeOnly) {
			const clause = node.exportClause;
			if (!clause || !ts.isNamedExports(clause) || clause.elements.length === 0 || clause.elements.some((element) => !element.isTypeOnly)) {
				checkSpecifier(node.moduleSpecifier);
			}
		} else if (
			ts.isCallExpression(node) &&
			(node.expression.kind === ts.SyntaxKind.ImportKeyword ||
				(ts.isIdentifier(node.expression) && node.expression.text === "require") ||
				(ts.isPropertyAccessExpression(node.expression) && node.expression.getText(source) === "require.resolve"))
		) {
			checkSpecifier(node.arguments[0]);
		}
		ts.forEachChild(node, visit);
	}
	visit(source);
}

for (const { directory } of getPublicWorkspacePackages()) {
	const sourceDirectory = resolve(directory, "src");
	if (!existsSync(sourceDirectory)) continue;
	const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
	const buildConfig = join(directory, "tsconfig.build.json");
	const configs = [
		{ path: buildConfig, exists: existsSync(buildConfig), enforceRoots: true },
	];
	const standaloneConfig = STANDALONE_BUILD_CONFIGS.get(manifest.name);
	if (standaloneConfig !== undefined) {
		const path = join(directory, standaloneConfig);
		if (!existsSync(path)) {
			failures.push(`${manifest.name} is missing its standalone build config: ${standaloneConfig}`);
		} else {
			configs.push({ path, exists: true, enforceRoots: false });
		}
	}
	for (const config of configs) {
		const loaded = config.exists
			? ts.readConfigFile(config.path, ts.sys.readFile)
			: { config: { include: ["src/**/*"] } };
		if (loaded.error) throw new Error(ts.flattenDiagnosticMessageText(loaded.error.messageText, "\n"));
		const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, resolve(directory));
		if (parsed.errors.length > 0) {
			throw new Error(parsed.errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n")).join("\n"));
		}
		// TypeScript's exclude only filters roots: imports can pull excluded files
		// back into the build. Reject that for the published build, including type-only
		// imports. The standalone config intentionally roots only the standalone trees, so
		// every other program file is there by import, not exclusion violation.
		const roots = config.enforceRoots ? new Set(parsed.fileNames.map((file) => resolve(file))) : undefined;
		const program = ts.createProgram(parsed.fileNames, parsed.options);
		for (const source of program.getSourceFiles()) {
			if (source.isDeclarationFile || source.fileName.endsWith(".json")) continue;
			const path = relative(sourceDirectory, resolve(source.fileName));
			if (path.startsWith("..") || isAbsolute(path)) continue;
			if (roots !== undefined && !roots.has(resolve(source.fileName))) {
				failures.push(`${source.fileName} is excluded from ${manifest.name}'s build but imported by it`);
			}
			checkSource(source, manifest, path.replaceAll("\\", "/"));
		}
	}
}

if (failures.length > 0) {
	console.error("Undeclared runtime imports in public packages:");
	for (const failure of failures) console.error(`  ${failure}`);
	process.exit(1);
}
console.log("Public package runtime imports have declared dependencies.");
