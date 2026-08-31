import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { PROTOCOL_VERSION } from "@earendil-works/pi-protocol";
import { buildWorkspaceRelease, createWorkspaceTarGzip, sha256 } from "./build-workspace-release.mjs";

const REVISION = "0123456789abcdef0123456789abcdef01234567";

function tarEntries(archive) {
	const tar = gunzipSync(archive);
	const entries = [];
	let offset = 0;
	while (offset + 512 <= tar.length) {
		const header = tar.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) break;
		const name = readString(header, 0, 100);
		const prefix = readString(header, 345, 155);
		const size = Number.parseInt(readString(header, 124, 12).trim(), 8);
		const mode = Number.parseInt(readString(header, 100, 8).trim(), 8);
		entries.push({ path: prefix ? `${prefix}/${name}` : name, size, mode, type: String.fromCharCode(header[156]) });
		offset += 512 + Math.ceil(size / 512) * 512;
	}
	return entries;
}

function readString(buffer, offset, length) {
	const field = buffer.subarray(offset, offset + length);
	const end = field.indexOf(0);
	return field.subarray(0, end === -1 ? field.length : end).toString("utf8");
}

test("builds deterministic checksummed client and server Workspace artifacts", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-workspace-release-test-"));
	try {
		const clientBinary = join(root, "client");
		const serverBinary = join(root, "server");
		await writeFile(clientBinary, "client-runtime");
		await writeFile(serverBinary, "server-runtime");
		const inputs = [
			{ role: "server", platform: "linux-x64", binaryPath: serverBinary },
			{ role: "client", platform: "darwin-arm64", binaryPath: clientBinary },
		];
		const firstDir = join(root, "first");
		const secondDir = join(root, "second");
		const first = buildWorkspaceRelease({
			outDir: firstDir,
			revision: REVISION,
			inputs,
			force: false,
			repoRoot: resolve("."),
		});
		const second = buildWorkspaceRelease({
			outDir: secondDir,
			revision: REVISION,
			inputs: [...inputs].reverse(),
			force: false,
			repoRoot: resolve("."),
		});
		assert.deepEqual(first, second);
		assert.equal(first.protocolVersion, PROTOCOL_VERSION);
		assert.deepEqual(
			first.artifacts.map(({ role, platform }) => `${role}:${platform}`),
			["client:darwin-arm64", "server:linux-x64"],
		);

		for (const artifact of first.artifacts) {
			const firstArchive = await readFile(join(firstDir, artifact.file));
			const secondArchive = await readFile(join(secondDir, artifact.file));
			assert.deepEqual(firstArchive, secondArchive);
			assert.equal(firstArchive.length, artifact.size);
			assert.equal(sha256(firstArchive), artifact.sha256);
			const entries = tarEntries(firstArchive);
			assert.ok(entries.some((entry) => entry.path === artifact.entrypoint && entry.mode === 0o700));
			if (artifact.role === "server") {
				assert.ok(entries.some((entry) => entry.path === "plugins/pi-example-plugin/src/session.ts"));
				assert.ok(entries.some((entry) => entry.path === "plugins/pi-example-plugin/src/tui.ts"));
			}
		}

		const manifestRaw = await readFile(join(firstDir, "manifest.json"), "utf8");
		const checksumRaw = await readFile(join(firstDir, "manifest.sha256"), "utf8");
		assert.equal(checksumRaw, `${sha256(manifestRaw)}  manifest.json\n`);
		assert.deepEqual(JSON.parse(manifestRaw), first);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("rejects duplicate target inputs without replacing an existing output", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-workspace-release-test-"));
	try {
		const binary = join(root, "runtime");
		await writeFile(binary, "runtime");
		assert.throws(
			() =>
				buildWorkspaceRelease({
					outDir: join(root, "release"),
					revision: REVISION,
					inputs: [
						{ role: "client", platform: "darwin-arm64", binaryPath: binary },
						{ role: "client", platform: "darwin-arm64", binaryPath: binary },
					],
					force: false,
					repoRoot: resolve("."),
				}),
			/Duplicate artifact input/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("tar writer rejects traversal paths", () => {
	assert.throws(
		() => createWorkspaceTarGzip([{ path: "../outside", data: Buffer.from("bad"), executable: false }]),
		/Unsafe Workspace artifact path/,
	);
});
