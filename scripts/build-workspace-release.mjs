#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { PROTOCOL_VERSION } from "@earendil-works/pi-protocol";

const REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const PLATFORM_PATTERN = /^(darwin|linux)-(arm64|x64)$/u;
const TAR_BLOCK_BYTES = 512;
const DEFAULT_PLUGIN_DIRECTORY = "packages/coding-agent/examples/plugins/pi-example-plugin";

export function sha256(data) {
	return createHash("sha256").update(data).digest("hex");
}

export function createWorkspaceTarGzip(files) {
	const blocks = [];
	const directories = new Set();
	for (const file of files) {
		const parts = file.path.split("/");
		for (let index = 1; index < parts.length; index += 1) directories.add(`${parts.slice(0, index).join("/")}/`);
	}
	for (const path of [...directories].sort()) blocks.push(createTarHeader(path, 0, 0o700, "5"));
	for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path))) {
		const data = Buffer.from(file.data);
		blocks.push(createTarHeader(file.path, data.length, file.executable ? 0o700 : 0o600, "0"), data);
		const padding = (TAR_BLOCK_BYTES - (data.length % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES;
		if (padding > 0) blocks.push(Buffer.alloc(padding));
	}
	blocks.push(Buffer.alloc(TAR_BLOCK_BYTES * 2));
	return gzipSync(Buffer.concat(blocks), { level: 9, mtime: 0 });
}

export function buildWorkspaceRelease(options) {
	if (!REVISION_PATTERN.test(options.revision)) throw new Error(`Invalid revision: ${options.revision}`);
	if (options.inputs.length === 0) throw new Error("At least one --client or --server binary is required");
	const inputs = [...options.inputs].sort(
		(left, right) => left.role.localeCompare(right.role) || left.platform.localeCompare(right.platform),
	);
	const seen = new Set();
	for (const input of inputs) {
		if (!PLATFORM_PATTERN.test(input.platform)) throw new Error(`Invalid platform: ${input.platform}`);
		const key = `${input.role}:${input.platform}`;
		if (seen.has(key)) throw new Error(`Duplicate artifact input: ${key}`);
		seen.add(key);
	}
	if (inputs.some((input) => input.role === "client") && !inputs.some((input) => input.role === "server")) {
		throw new Error("A client artifact requires at least one server artifact");
	}
	const repoRoot = resolve(options.repoRoot);
	const pluginRoot = join(repoRoot, DEFAULT_PLUGIN_DIRECTORY);
	const prepared = [];
	for (const input of inputs.filter((candidate) => candidate.role === "server")) {
		const binaryPath = realpathSync(resolve(input.binaryPath));
		if (!statSync(binaryPath).isFile()) throw new Error(`Workspace runtime is not a file: ${binaryPath}`);
		const entrypoint = "bin/pi-workspace-server";
		const esbuildPath = join(dirname(binaryPath), "esbuild");
		if (!existsSync(esbuildPath) || !statSync(esbuildPath).isFile()) {
			throw new Error(`Workspace server requires a pinned esbuild binary next to its runtime: ${esbuildPath}`);
		}
		const archive = createWorkspaceTarGzip([
			{ path: entrypoint, data: readFileSync(binaryPath), executable: true },
			{ path: "bin/esbuild", data: readFileSync(esbuildPath), executable: true },
			...readTree(pluginRoot, "plugins/pi-example-plugin"),
			...readChordRuntime(repoRoot),
			...readPluginApiRuntime(repoRoot),
		]);
		const file = `pi-workspace-server-${input.platform}-${options.revision}.tar.gz`;
		prepared.push({
			archive,
			artifact: {
				role: "server",
				platform: input.platform,
				file,
				sha256: sha256(archive),
				size: archive.length,
				entrypoint,
			},
		});
	}
	const serverArtifacts = prepared.map(({ artifact }) => artifact);
	const serverManifest = {
		schemaVersion: 1,
		revision: options.revision,
		protocolVersion: PROTOCOL_VERSION,
		artifacts: serverArtifacts,
	};
	const rawServerManifest = `${JSON.stringify(serverManifest, undefined, "\t")}\n`;
	for (const input of inputs.filter((candidate) => candidate.role === "client")) {
		const binaryPath = realpathSync(resolve(input.binaryPath));
		if (!statSync(binaryPath).isFile()) throw new Error(`Workspace runtime is not a file: ${binaryPath}`);
		const entrypoint = "bin/piw";
		const clientFiles = readTree(dirname(binaryPath), "bin").filter(
			(file) => file.path !== `bin/${basename(binaryPath)}`,
		);
		const archive = createWorkspaceTarGzip([
			{ path: entrypoint, data: readFileSync(binaryPath), executable: true },
			...clientFiles,
			...readChordRuntime(repoRoot),
			...readPluginApiRuntime(repoRoot),
			{ path: "share/workspace-server/manifest.json", data: Buffer.from(rawServerManifest), executable: false },
			{
				path: "share/workspace-server/manifest.sha256",
				data: Buffer.from(`${sha256(rawServerManifest)}  manifest.json\n`),
				executable: false,
			},
			...prepared
				.filter(({ artifact }) => artifact.role === "server")
				.map(({ archive: serverArchive, artifact }) => ({
					path: `share/workspace-server/${artifact.file}`,
					data: serverArchive,
					executable: false,
				})),
		]);
		const file = `pi-workspace-client-${input.platform}-${options.revision}.tar.gz`;
		prepared.push({
			archive,
			artifact: {
				role: "client",
				platform: input.platform,
				file,
				sha256: sha256(archive),
				size: archive.length,
				entrypoint,
			},
		});
	}
	prepared.sort(
		(left, right) =>
			left.artifact.role.localeCompare(right.artifact.role) ||
			left.artifact.platform.localeCompare(right.artifact.platform),
	);
	const manifest = {
		schemaVersion: 1,
		revision: options.revision,
		protocolVersion: PROTOCOL_VERSION,
		artifacts: prepared.map(({ artifact }) => artifact),
	};
	const rawManifest = `${JSON.stringify(manifest, undefined, "\t")}\n`;
	const outDir = resolve(options.outDir);
	if (existsSync(outDir)) {
		if (!options.force) throw new Error(`Output directory already exists: ${outDir}`);
		rmSync(outDir, { recursive: true, force: true });
	}
	mkdirSync(outDir, { recursive: true, mode: 0o700 });
	for (const { archive, artifact } of prepared) writeFileSync(join(outDir, artifact.file), archive, { mode: 0o600 });
	writeFileSync(join(outDir, "manifest.json"), rawManifest, { mode: 0o600 });
	writeFileSync(join(outDir, "manifest.sha256"), `${sha256(rawManifest)}  manifest.json\n`, { mode: 0o600 });
	return manifest;
}

function readPluginApiRuntime(repoRoot) {
	const sourceRoot = join(repoRoot, "packages/coding-agent/dist/experimental");
	return [
		{
			path: "node_modules/@earendil-works/pi-coding-agent/dist/experimental/plugin.js",
			data: readFileSync(join(sourceRoot, "plugin.js")),
			executable: false,
		},
		...readTree(
			join(sourceRoot, "services"),
			"node_modules/@earendil-works/pi-coding-agent/dist/experimental/services",
		),
	];
}

function readChordRuntime(repoRoot) {
	const chordRoot = join(repoRoot, "packages/chord");
	const packageJson = JSON.parse(readFileSync(join(chordRoot, "package.json"), "utf8"));
	for (const target of Object.values(packageJson.exports)) {
		if (typeof target === "object" && target !== null && typeof target.import === "string") {
			target.require = target.import;
		}
	}
	return [
		{
			path: "node_modules/@earendil-works/chord/package.json",
			data: Buffer.from(`${JSON.stringify(packageJson, undefined, "\t")}\n`),
			executable: false,
		},
		...readTree(join(chordRoot, "src"), "node_modules/@earendil-works/chord/src"),
		...readTree(join(chordRoot, "dist"), "node_modules/@earendil-works/chord/dist"),
	];
}

function readTree(root, destination) {
	if (!statSync(root).isDirectory()) throw new Error(`Default Workspace plugin is missing: ${root}`);
	const files = [];
	const visit = (directory) => {
		for (const name of readdirSync(directory).sort()) {
			const path = join(directory, name);
			const stats = statSync(path);
			if (stats.isDirectory()) visit(path);
			else if (stats.isFile()) {
				const child = relative(root, path).split(sep).join("/");
				files.push({ path: `${destination}/${child}`, data: readFileSync(path), executable: false });
			} else {
				throw new Error(`Unsupported file in default Workspace plugin: ${path}`);
			}
		}
	};
	visit(root);
	return files;
}

function createTarHeader(path, size, mode, type) {
	if (!isSafeTarPath(path)) throw new Error(`Unsafe Workspace artifact path: ${path}`);
	const header = Buffer.alloc(TAR_BLOCK_BYTES);
	const split = splitTarPath(path);
	writeTarString(header, 0, 100, split.name);
	writeTarOctal(header, 100, 8, mode);
	writeTarOctal(header, 108, 8, 0);
	writeTarOctal(header, 116, 8, 0);
	writeTarOctal(header, 124, 12, size);
	writeTarOctal(header, 136, 12, 0);
	header.fill(32, 148, 156);
	header[156] = type.charCodeAt(0);
	writeTarString(header, 257, 6, "ustar");
	writeTarString(header, 263, 2, "00");
	writeTarString(header, 265, 32, "pi-workspace");
	writeTarString(header, 297, 32, "pi-workspace");
	writeTarString(header, 345, 155, split.prefix);
	let checksum = 0;
	for (const byte of header) checksum += byte;
	const encoded = checksum.toString(8).padStart(6, "0");
	header.write(encoded, 148, 6, "ascii");
	header[154] = 0;
	header[155] = 32;
	return header;
}

function splitTarPath(path) {
	if (Buffer.byteLength(path) <= 100) return { name: path, prefix: "" };
	for (let separator = path.lastIndexOf("/"); separator > 0; separator = path.lastIndexOf("/", separator - 1)) {
		const prefix = path.slice(0, separator);
		const name = path.slice(separator + 1);
		if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
	}
	throw new Error(`Workspace artifact path is too long: ${path}`);
}

function writeTarString(buffer, offset, length, value) {
	if (Buffer.byteLength(value) > length) throw new Error(`Tar field is too long: ${value}`);
	buffer.write(value, offset, length, "utf8");
}

function writeTarOctal(buffer, offset, length, value) {
	const encoded = value.toString(8).padStart(length - 1, "0");
	if (encoded.length >= length) throw new Error(`Tar numeric field is too large: ${value}`);
	buffer.write(encoded, offset, length - 1, "ascii");
	buffer[offset + length - 1] = 0;
}

function isSafeTarPath(path) {
	const candidate = path.endsWith("/") ? path.slice(0, -1) : path;
	return (
		candidate.length > 0 &&
		!candidate.startsWith("/") &&
		!candidate.includes("\\") &&
		candidate.split("/").every((part) => part.length > 0 && part !== "." && part !== "..")
	);
}

function printUsage() {
	console.log(`Usage: node scripts/build-workspace-release.mjs --out <dir> --revision <sha> [options]

Options:
  --client <platform>=<binary>  Add a pinned local piw client
  --server <platform>=<binary>  Add a pinned Workspace backend
  --force                       Replace the output directory

Build binaries with scripts/build-binaries.sh, then pass the extracted pi paths.
The server archive also carries the bundled split-plugin package.`);
}

function parseInput(role, value) {
	const separator = value.indexOf("=");
	if (separator <= 0 || separator === value.length - 1) throw new Error(`Invalid --${role} value: ${value}`);
	return { role, platform: value.slice(0, separator), binaryPath: value.slice(separator + 1) };
}

function parseArgs(args) {
	const options = { force: false, inputs: [], outDir: undefined, revision: undefined, repoRoot: process.cwd() };
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--help") return { help: true };
		if (argument === "--force") {
			options.force = true;
			continue;
		}
		if (argument === "--out" || argument === "--revision" || argument === "--client" || argument === "--server") {
			const value = args[++index];
			if (!value) throw new Error(`${argument} requires a value`);
			if (argument === "--out") options.outDir = value;
			else if (argument === "--revision") options.revision = value;
			else options.inputs.push(parseInput(argument.slice(2), value));
			continue;
		}
		throw new Error(`Unknown option: ${argument}`);
	}
	if (!options.outDir) throw new Error("--out is required");
	if (!options.revision) throw new Error("--revision is required");
	return { help: false, options };
}

function main() {
	const parsed = parseArgs(process.argv.slice(2));
	if (parsed.help) {
		printUsage();
		return;
	}
	const manifest = buildWorkspaceRelease(parsed.options);
	console.log(`Workspace release ${manifest.revision}`);
	console.log(`Manifest: ${join(resolve(parsed.options.outDir), "manifest.json")}`);
	for (const artifact of manifest.artifacts) console.log(`${artifact.role} ${artifact.platform}: ${artifact.file}`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	try {
		main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
