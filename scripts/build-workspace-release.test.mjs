import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
		const path = prefix ? `${prefix}/${name}` : name;
		entries.push({
			path,
			size,
			mode,
			type: String.fromCharCode(header[156]),
			data: tar.subarray(offset + 512, offset + 512 + size),
		});
		offset += 512 + Math.ceil(size / 512) * 512;
	}
	return entries;
}

async function createFixtureRepo(root) {
	const repo = join(root, "repo");
	const plugin = join(repo, "packages", "coding-agent", "examples", "plugins", "pi-example-plugin");
	const chord = join(repo, "packages", "chord");
	await Promise.all([
		mkdir(join(plugin, "src"), { recursive: true }),
		mkdir(join(chord, "src"), { recursive: true }),
		mkdir(join(chord, "dist"), { recursive: true }),
	]);
	await Promise.all([
		writeFile(join(plugin, "README.md"), "plugin\n"),
		writeFile(join(plugin, "package.json"), '{"name":"fixture-plugin"}\n'),
		writeFile(join(plugin, "src", "contract.ts"), "export {};\n"),
		writeFile(join(plugin, "src", "session.ts"), "export {};\n"),
		writeFile(join(plugin, "src", "tui.ts"), "export {};\n"),
		writeFile(
			join(chord, "package.json"),
			'{"name":"@earendil-works/chord","exports":{".":{"import":"./dist/index.js"}}}\n',
		),
		writeFile(join(chord, "src", "index.ts"), "export {};\n"),
		writeFile(join(chord, "dist", "index.js"), "export {};\n"),
	]);
	execFileSync("git", ["init", "-q", repo]);
	execFileSync("git", ["-C", repo, "add", "packages/coding-agent/examples/plugins/pi-example-plugin"]);
	return repo;
}

function readString(buffer, offset, length) {
	const field = buffer.subarray(offset, offset + length);
	const end = field.indexOf(0);
	return field.subarray(0, end === -1 ? field.length : end).toString("utf8");
}

test("builds deterministic checksummed client and server Workspace artifacts", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-workspace-release-test-"));
	try {
		const repoRoot = await createFixtureRepo(root);
		const clientBinary = join(root, "client-build", "pi");
		const serverBinary = join(root, "server-build", "pi");
		await Promise.all([mkdir(join(root, "client-build")), mkdir(join(root, "server-build"))]);
		await writeFile(clientBinary, "client-runtime");
		await writeFile(serverBinary, "server-runtime");
		await writeFile(join(root, "server-build", "esbuild"), "esbuild-runtime");
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
			repoRoot,
		});
		const second = buildWorkspaceRelease({
			outDir: secondDir,
			revision: REVISION,
			inputs: [...inputs].reverse(),
			force: false,
			repoRoot,
		});
		const replaced = buildWorkspaceRelease({
			outDir: secondDir,
			revision: REVISION,
			inputs,
			force: true,
			repoRoot,
		});
		assert.deepEqual(first, second);
		assert.deepEqual(second, replaced);
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
			const identityEntry = entries.find((entry) => entry.path === ".pi-workspace-artifact.json");
			assert.ok(identityEntry);
			const identity = JSON.parse(identityEntry.data.toString("utf8"));
			assert.deepEqual(
				{
					revision: identity.revision,
					protocolVersion: identity.protocolVersion,
					role: identity.role,
					platform: identity.platform,
					entrypoint: identity.entrypoint,
				},
				{
					revision: REVISION,
					protocolVersion: PROTOCOL_VERSION,
					role: artifact.role,
					platform: artifact.platform,
					entrypoint: artifact.entrypoint,
				},
			);
			if (artifact.role === "server") {
				assert.ok(entries.some((entry) => entry.path === "plugins/pi-example-plugin/src/session.ts"));
				assert.ok(entries.some((entry) => entry.path === "plugins/pi-example-plugin/src/tui.ts"));
			} else {
				const bundledManifest = entries.find((entry) => entry.path === "share/workspace-server/manifest.json");
				assert.ok(bundledManifest);
				assert.equal(identity.bundledManifestSha256, sha256(bundledManifest.data));
				assert.ok(entries.some((entry) => entry.path === `share/workspace-server/${first.artifacts[1].file}`));
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
		const repoRoot = await createFixtureRepo(root);
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
					repoRoot,
				}),
			/Duplicate artifact input/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("refuses to force-replace an unrecognized output directory", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-workspace-release-test-"));
	try {
		const repoRoot = await createFixtureRepo(root);
		const build = join(root, "server-build");
		const output = join(root, "unrelated");
		await Promise.all([mkdir(build), mkdir(output)]);
		await Promise.all([
			writeFile(join(build, "pi"), "runtime"),
			writeFile(join(build, "esbuild"), "esbuild"),
			writeFile(join(output, "keep"), "sentinel"),
		]);
		assert.throws(
			() =>
				buildWorkspaceRelease({
					outDir: output,
					revision: REVISION,
					inputs: [{ role: "server", platform: "linux-arm64", binaryPath: join(build, "pi") }],
					force: true,
					repoRoot,
				}),
			/Refusing to replace an unrecognized Workspace release directory/,
		);
		assert.equal(await readFile(join(output, "keep"), "utf8"), "sentinel");
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
