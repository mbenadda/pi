import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { PROTOCOL_VERSION } from "@earendil-works/pi-protocol";
import { createWorkspaceTarGzip, sha256 } from "./build-workspace-release.mjs";

const run = promisify(execFile);
const REVISION = "0123456789abcdef0123456789abcdef01234567";

async function fixture(root) {
	const identity = `${JSON.stringify({
		schemaVersion: 1,
		revision: REVISION,
		protocolVersion: PROTOCOL_VERSION,
		role: "client",
		platform: "darwin-arm64",
		entrypoint: "bin/piw",
	})}\n`;
	const archive = createWorkspaceTarGzip([
		{ path: ".pi-workspace-artifact.json", data: Buffer.from(identity), executable: false },
		{ path: "bin/piw", data: Buffer.from("client-runtime"), executable: true },
	]);
	const artifact = {
		role: "client",
		platform: "darwin-arm64",
		file: "client.tar.gz",
		sha256: sha256(archive),
		size: archive.length,
		entrypoint: "bin/piw",
	};
	const rawManifest = `${JSON.stringify({
		schemaVersion: 1,
		revision: REVISION,
		protocolVersion: PROTOCOL_VERSION,
		artifacts: [artifact],
	})}\n`;
	const manifest = join(root, "manifest.json");
	const archivePath = join(root, artifact.file);
	await Promise.all([writeFile(manifest, rawManifest), writeFile(archivePath, archive)]);
	return { manifest, digest: sha256(rawManifest) };
}

test("standalone installer requires an independent manifest pin and activates the selected command", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-workspace-command-install-"));
	try {
		const release = await fixture(root);
		const installRoot = join(root, "install");
		const bin = join(root, "commands", "piw");
		await assert.rejects(
			run(process.execPath, [
				resolve("scripts/install-workspace-release.mjs"),
				"--manifest",
				release.manifest,
				"--root",
				installRoot,
				"--bin",
				bin,
				"--platform",
				"darwin-arm64",
			]),
			/--manifest-sha256 is required/,
		);
		await assert.rejects(
			run(process.execPath, [
				resolve("scripts/install-workspace-release.mjs"),
				"--manifest",
				release.manifest,
				"--manifest-sha256",
				"0".repeat(64),
				"--root",
				installRoot,
				"--bin",
				bin,
				"--platform",
				"darwin-arm64",
			]),
			/manifest checksum mismatch/,
		);
		const { stdout } = await run(process.execPath, [
			resolve("scripts/install-workspace-release.mjs"),
			"--manifest",
			release.manifest,
			"--manifest-sha256",
			release.digest,
			"--root",
			installRoot,
			"--bin",
			bin,
			"--platform",
			"darwin-arm64",
		]);
		assert.match(stdout, /^Installed /u);
		assert.equal(await readlink(bin), "../install/current/bin/piw");
		assert.equal(await readFile(join(installRoot, "current", "bin", "piw"), "utf8"), "client-runtime");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("standalone installer refuses to replace a non-symlink command", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-workspace-command-install-"));
	try {
		const release = await fixture(root);
		const bin = join(root, "commands", "piw");
		await mkdir(join(root, "commands"));
		await writeFile(bin, "existing");
		await assert.rejects(
			run(process.execPath, [
				resolve("scripts/install-workspace-release.mjs"),
				"--manifest",
				release.manifest,
				"--manifest-sha256",
				release.digest,
				"--root",
				join(root, "install"),
				"--bin",
				bin,
				"--platform",
				"darwin-arm64",
			]),
			/Refusing to replace non-symlink command/,
		);
		assert.equal(await readFile(bin, "utf8"), "existing");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
