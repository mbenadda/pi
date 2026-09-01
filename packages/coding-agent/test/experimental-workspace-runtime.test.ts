import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { PROTOCOL_VERSION } from "@earendil-works/pi-protocol";
import { afterEach, describe, expect, test } from "vitest";
import { sha256 } from "../src/experimental/workspace-install.ts";
import { readBundledWorkspaceServer } from "../src/experimental/workspace-runtime.ts";

const REVISION = "0123456789abcdef0123456789abcdef01234567";
const cleanups: string[] = [];

afterEach(async () => {
	await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function tarGzip(files: ReadonlyArray<{ path: string; data: string; executable?: boolean }>): Buffer {
	const blocks: Buffer[] = [];
	for (const file of files) {
		const data = Buffer.from(file.data);
		const header = Buffer.alloc(512);
		header.write(file.path, 0, 100, "utf8");
		writeOctal(header, 100, 8, file.executable ? 0o700 : 0o600);
		writeOctal(header, 108, 8, 0);
		writeOctal(header, 116, 8, 0);
		writeOctal(header, 124, 12, data.length);
		writeOctal(header, 136, 12, 0);
		header.fill(32, 148, 156);
		header[156] = "0".charCodeAt(0);
		header.write("ustar", 257, 6, "ascii");
		header.write("00", 263, 2, "ascii");
		let checksum = 0;
		for (const byte of header) checksum += byte;
		header.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii");
		header[154] = 0;
		header[155] = 32;
		blocks.push(header, data);
		const padding = (512 - (data.length % 512)) % 512;
		if (padding > 0) blocks.push(Buffer.alloc(padding));
	}
	blocks.push(Buffer.alloc(1024));
	return gzipSync(Buffer.concat(blocks));
}

function writeOctal(buffer: Buffer, offset: number, length: number, value: number): void {
	buffer.write(value.toString(8).padStart(length - 1, "0"), offset, length - 1, "ascii");
	buffer[offset + length - 1] = 0;
}

async function bundledFixture(): Promise<{ releaseRoot: string; serverRoot: string }> {
	const temporary = await mkdtemp(join(tmpdir(), "pi-workspace-runtime-"));
	cleanups.push(temporary);
	const releaseRoot = join(temporary, "release");
	const serverRoot = join(releaseRoot, "share", "workspace-server");
	await mkdir(serverRoot, { recursive: true });
	const serverIdentity = `${JSON.stringify({
		schemaVersion: 1,
		revision: REVISION,
		protocolVersion: PROTOCOL_VERSION,
		role: "server",
		platform: "linux-arm64",
		entrypoint: "bin/pi-workspace-server",
	})}\n`;
	const archive = tarGzip([
		{ path: ".pi-workspace-artifact.json", data: serverIdentity },
		{ path: "bin/pi-workspace-server", data: "server", executable: true },
	]);
	const artifact = {
		role: "server",
		platform: "linux-arm64",
		file: "server.tar.gz",
		sha256: sha256(archive),
		size: archive.length,
		entrypoint: "bin/pi-workspace-server",
	};
	const rawManifest = `${JSON.stringify({
		schemaVersion: 1,
		revision: REVISION,
		protocolVersion: PROTOCOL_VERSION,
		artifacts: [artifact],
	})}\n`;
	const manifestSha256 = sha256(rawManifest);
	const clientIdentity = `${JSON.stringify({
		schemaVersion: 1,
		revision: REVISION,
		protocolVersion: PROTOCOL_VERSION,
		role: "client",
		platform: "darwin-arm64",
		entrypoint: "bin/piw",
		bundledManifestSha256: manifestSha256,
	})}\n`;
	await Promise.all([
		writeFile(join(releaseRoot, ".pi-workspace-artifact.json"), clientIdentity),
		writeFile(join(serverRoot, "manifest.json"), rawManifest),
		writeFile(join(serverRoot, "manifest.sha256"), `${manifestSha256}  manifest.json\n`),
		writeFile(join(serverRoot, artifact.file), archive),
	]);
	return { releaseRoot, serverRoot };
}

describe("bundled Workspace server", () => {
	test("binds the server selection to the manifest digest pinned by the client artifact", async () => {
		const fixture = await bundledFixture();
		const bundle = await readBundledWorkspaceServer("linux-arm64", fixture.serverRoot);
		expect(bundle?.manifest.revision).toBe(REVISION);
		expect(bundle?.artifact.role).toBe("server");
	});

	test("rejects a manifest and adjacent checksum changed together", async () => {
		const fixture = await bundledFixture();
		const changed = `${JSON.stringify({ schemaVersion: 1, revision: REVISION, protocolVersion: PROTOCOL_VERSION, artifacts: [] })}\n`;
		await Promise.all([
			writeFile(join(fixture.serverRoot, "manifest.json"), changed),
			writeFile(join(fixture.serverRoot, "manifest.sha256"), `${sha256(changed)}  manifest.json\n`),
		]);
		await expect(readBundledWorkspaceServer("linux-arm64", fixture.serverRoot)).rejects.toThrow(
			/not the independently pinned checksum/,
		);
	});
});
