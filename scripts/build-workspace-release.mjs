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
import { join, relative, resolve, sep } from "node:path";
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
	const outDir = resolve(options.outDir);
	if (existsSync(outDir)) {
		if (!options.force) throw new Error(`Output directory already exists: ${outDir}`);
		rmSync(outDir, { recursive: true, force: true });
	}
	mkdirSync(outDir, { recursive: true, mode: 0o700 });
	const repoRoot = resolve(options.repoRoot);
	const pluginRoot = join(repoRoot, DEFAULT_PLUGIN_DIRECTORY);
	const artifacts = [];
	const seen = new Set();
	for (const input of [...options.inputs].sort(
		(left, right) => left.role.localeCompare(right.role) || left.platform.localeCompare(right.platform),
	)) {
		if (!PLATFORM_PATTERN.test(input.platform)) throw new Error(`Invalid platform: ${input.platform}`);
		const key = `${input.role}:${input.platform}`;
		if (seen.has(key)) throw new Error(`Duplicate artifact input: ${key}`);
		seen.add(key);
		const binaryPath = realpathSync(resolve(input.binaryPath));
		const binaryStats = statSync(binaryPath);
		if (!binaryStats.isFile()) throw new Error(`Workspace runtime is not a file: ${binaryPath}`);
		const entrypoint = input.role === "client" ? "bin/piw" : "bin/pi-workspace-server";
		const files = [{ path: entrypoint, data: readFileSync(binaryPath), executable: true }];
		if (input.role === "server") files.push(...readTree(pluginRoot, "plugins/pi-example-plugin"));
		const archive = createWorkspaceTarGzip(files);
		const file = `pi-workspace-${input.role}-${input.platform}-${options.revision}.tar.gz`;
		writeFileSync(join(outDir, file), archive, { mode: 0o600 });
		artifacts.push({
			role: input.role,
			platform: input.platform,
			file,
			sha256: sha256(archive),
			size: archive.length,
			entrypoint,
		});
	}
	const manifest = {
		schemaVersion: 1,
		revision: options.revision,
		protocolVersion: PROTOCOL_VERSION,
		artifacts,
	};
	const rawManifest = `${JSON.stringify(manifest, undefined, "\t")}\n`;
	writeFileSync(join(outDir, "manifest.json"), rawManifest, { mode: 0o600 });
	writeFileSync(join(outDir, "manifest.sha256"), `${sha256(rawManifest)}  manifest.json\n`, { mode: 0o600 });
	return manifest;
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
