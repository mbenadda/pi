#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readlink, rename, rm, symlink } from "node:fs/promises";
import { homedir, platform as hostPlatform, arch as hostArch } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	installWorkspaceArtifact,
	parseWorkspaceReleaseManifest,
	selectWorkspaceReleaseArtifact,
} from "../packages/coding-agent/src/experimental/workspace-install.ts";

function parseArgs(args) {
	const options = {
		manifest: undefined,
		manifestSha256: undefined,
		archive: undefined,
		root: join(homedir(), ".local", "share", "pi-workspace"),
		bin: join(homedir(), ".local", "bin", "piw"),
		platform: `${hostPlatform()}-${hostArch()}`,
	};
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--help") return { help: true, options };
		if (["--manifest", "--manifest-sha256", "--archive", "--root", "--bin", "--platform"].includes(argument)) {
			const value = args[++index];
			if (value === undefined || value.length === 0) throw new Error(`${argument} requires a value`);
			if (argument === "--manifest") options.manifest = value;
			else if (argument === "--manifest-sha256") options.manifestSha256 = value;
			else if (argument === "--archive") options.archive = value;
			else if (argument === "--root") options.root = value;
			else if (argument === "--bin") options.bin = value;
			else options.platform = value;
			continue;
		}
		throw new Error(`Unknown option: ${argument}`);
	}
	if (options.manifest === undefined) throw new Error("--manifest is required");
	if (options.manifestSha256 === undefined) {
		throw new Error("--manifest-sha256 is required and must come from an independently trusted source");
	}
	return { help: false, options };
}

async function activateCommand(binPath, root) {
	const bin = resolve(binPath);
	const directory = dirname(bin);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const directoryStats = await lstat(directory);
	if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
		throw new Error(`Workspace command directory is unsafe: ${directory}`);
	}
	const target = relative(directory, join(resolve(root), "current", "bin", "piw"));
	try {
		const stats = await lstat(bin);
		if (!stats.isSymbolicLink()) throw new Error(`Refusing to replace non-symlink command: ${bin}`);
		if ((await readlink(bin)) === target) return;
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
	}
	const temporary = join(directory, `.piw-${randomUUID()}`);
	try {
		await symlink(target, temporary);
		await rename(temporary, bin);
	} finally {
		await rm(temporary, { force: true });
	}
}

function printUsage() {
	console.log(`Usage: node scripts/install-workspace-release.mjs \\
  --manifest <manifest.json> --manifest-sha256 <trusted-sha256> [options]

Options:
  --archive <file>      Artifact archive; defaults to the selected manifest file
  --platform <target>   Client platform; defaults to the current OS and architecture
  --root <directory>    Install root; defaults to ~/.local/share/pi-workspace
  --bin <path>          Command symlink; defaults to ~/.local/bin/piw

The manifest digest is mandatory. Obtain it independently from the pinned release
metadata; do not derive it from manifest.json or its adjacent checksum file.`);
}

export async function installWorkspaceRelease(options) {
	const manifestPath = resolve(options.manifest);
	const rawManifest = await readFile(manifestPath, "utf8");
	const manifest = parseWorkspaceReleaseManifest(rawManifest, options.manifestSha256);
	const artifact = selectWorkspaceReleaseArtifact(manifest, "client", options.platform);
	const archivePath = resolve(options.archive ?? join(dirname(manifestPath), artifact.file));
	const installed = await installWorkspaceArtifact({
		root: options.root,
		archive: await readFile(archivePath),
		rawManifest,
		expectedManifestSha256: options.manifestSha256,
		role: "client",
		platform: options.platform,
	});
	await activateCommand(options.bin, options.root);
	return installed;
}

async function main() {
	const parsed = parseArgs(process.argv.slice(2));
	if (parsed.help) {
		printUsage();
		return;
	}
	const installed = await installWorkspaceRelease(parsed.options);
	console.log(`${installed.reused ? "Reused" : "Installed"} ${installed.entrypoint}`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
