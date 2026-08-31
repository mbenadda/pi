import { mkdtemp, readdir, readFile, readlink, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { PROTOCOL_VERSION } from "@earendil-works/pi-protocol";
import { describe, expect, test } from "vitest";
import {
	inspectWorkspaceArchive,
	installWorkspaceArtifact,
	parseWorkspaceReleaseManifest,
	selectWorkspaceReleaseArtifact,
	sha256,
	verifyWorkspaceArtifact,
	type WorkspaceReleaseArtifact,
	type WorkspaceReleaseManifest,
} from "../src/experimental/workspace-install.ts";

const REVISION = "0123456789abcdef0123456789abcdef01234567";

interface FixtureEntry {
	readonly path: string;
	readonly data?: string;
	readonly mode?: number;
	readonly type?: "0" | "2" | "5";
}

function createTarGzip(entries: readonly FixtureEntry[]): Buffer {
	const blocks: Buffer[] = [];
	for (const entry of entries) {
		const data = Buffer.from(entry.data ?? "");
		const header = Buffer.alloc(512);
		writeString(header, 0, 100, entry.path);
		writeOctal(header, 100, 8, entry.mode ?? (entry.type === "5" ? 0o700 : 0o600));
		writeOctal(header, 108, 8, 0);
		writeOctal(header, 116, 8, 0);
		writeOctal(header, 124, 12, entry.type === "5" ? 0 : data.length);
		writeOctal(header, 136, 12, 0);
		header.fill(32, 148, 156);
		header[156] = (entry.type ?? "0").charCodeAt(0);
		writeString(header, 257, 6, "ustar");
		writeString(header, 263, 2, "00");
		let checksum = 0;
		for (const byte of header) checksum += byte;
		const checksumText = checksum.toString(8).padStart(6, "0");
		header.write(checksumText, 148, 6, "ascii");
		header[154] = 0;
		header[155] = 32;
		blocks.push(header);
		if (entry.type !== "5") {
			blocks.push(data);
			const padding = (512 - (data.length % 512)) % 512;
			if (padding > 0) blocks.push(Buffer.alloc(padding));
		}
	}
	blocks.push(Buffer.alloc(1024));
	return gzipSync(Buffer.concat(blocks));
}

function writeString(buffer: Buffer, offset: number, length: number, value: string): void {
	if (Buffer.byteLength(value) > length) throw new Error("fixture value is too long");
	buffer.write(value, offset, length, "utf8");
}

function writeOctal(buffer: Buffer, offset: number, length: number, value: number): void {
	const encoded = value.toString(8).padStart(length - 1, "0");
	buffer.write(encoded, offset, length - 1, "ascii");
	buffer[offset + length - 1] = 0;
}

function release(
	archive: Buffer,
	overrides: Partial<WorkspaceReleaseArtifact> = {},
): {
	readonly manifest: WorkspaceReleaseManifest;
	readonly artifact: WorkspaceReleaseArtifact;
	readonly raw: string;
	readonly manifestSha256: string;
} {
	const artifact: WorkspaceReleaseArtifact = {
		role: "client",
		platform: "darwin-arm64",
		file: "piw-client-darwin-arm64.tar.gz",
		sha256: sha256(archive),
		size: archive.length,
		entrypoint: "bin/piw",
		...overrides,
	};
	const manifest: WorkspaceReleaseManifest = {
		schemaVersion: 1,
		revision: REVISION,
		protocolVersion: PROTOCOL_VERSION,
		artifacts: [artifact],
	};
	const raw = `${JSON.stringify(manifest, undefined, "\t")}\n`;
	return { manifest, artifact, raw, manifestSha256: sha256(raw) };
}

describe("Workspace release manifest", () => {
	test("verifies the immutable manifest and selects an exact role and platform", () => {
		const archive = createTarGzip([
			{ path: "bin/", type: "5" },
			{ path: "bin/piw", data: "client" },
		]);
		const fixture = release(archive);
		const parsed = parseWorkspaceReleaseManifest(fixture.raw, fixture.manifestSha256);
		expect(parsed).toEqual(fixture.manifest);
		expect(selectWorkspaceReleaseArtifact(parsed, "client", "darwin-arm64")).toEqual(fixture.artifact);
		expect(() => selectWorkspaceReleaseArtifact(parsed, "server", "linux-x64")).toThrow(/no server artifact/);
	});

	test("rejects checksum, revision, protocol, and duplicate artifact mismatches", () => {
		const archive = createTarGzip([{ path: "bin/piw", data: "client" }]);
		const fixture = release(archive);
		expect(() => parseWorkspaceReleaseManifest(fixture.raw, "0".repeat(64))).toThrow(/manifest checksum mismatch/);
		expect(() => parseWorkspaceReleaseManifest(fixture.raw.replace(REVISION, "not-a-revision"))).toThrow(
			/invalid revision/,
		);
		expect(() =>
			parseWorkspaceReleaseManifest(
				fixture.raw.replace(`"protocolVersion": ${PROTOCOL_VERSION}`, '"protocolVersion": 0'),
			),
		).toThrow(/incompatible/);
		const duplicate = JSON.stringify({ ...fixture.manifest, artifacts: [fixture.artifact, fixture.artifact] });
		expect(() => parseWorkspaceReleaseManifest(duplicate)).toThrow(/duplicate artifact/);
	});
});

describe("Workspace release archive", () => {
	test("verifies artifact bytes and accepts regular files and directories", () => {
		const archive = createTarGzip([
			{ path: "bin/", type: "5" },
			{ path: "bin/piw", data: "client", mode: 0o755 },
		]);
		const fixture = release(archive);
		expect(() => verifyWorkspaceArtifact(archive, fixture.artifact)).not.toThrow();
		expect(inspectWorkspaceArchive(archive)).toEqual(["bin/", "bin/piw"]);
		expect(() => verifyWorkspaceArtifact(Buffer.concat([archive, Buffer.from("x")]), fixture.artifact)).toThrow(
			/size mismatch/,
		);
		const corrupted = Buffer.from(archive);
		corrupted[corrupted.length - 1] ^= 1;
		expect(() => verifyWorkspaceArtifact(corrupted, fixture.artifact)).toThrow(/checksum mismatch/);
	});

	test.each(["../escape", "/absolute", "bin/../../escape", "bin\\escape"])(
		"rejects unsafe archive path %s",
		(path) => {
			const archive = createTarGzip([{ path, data: "bad" }]);
			expect(() => inspectWorkspaceArchive(archive)).toThrow(/Unsafe Workspace archive path/);
		},
	);

	test("rejects links rather than relying on tar extraction semantics", () => {
		const archive = createTarGzip([{ path: "bin/piw", type: "2", data: "../../outside" }]);
		expect(() => inspectWorkspaceArchive(archive)).toThrow(/Unsupported Workspace archive entry type/);
	});
});

describe("Workspace release installation", () => {
	test("installs content-addressed, switches current atomically, and retains rollback releases", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-workspace-install-"));
		try {
			const firstArchive = createTarGzip([
				{ path: "bin/", type: "5" },
				{ path: "bin/piw", data: "first", mode: 0o755 },
			]);
			const first = release(firstArchive);
			const installed = await installWorkspaceArtifact({
				root,
				archive: firstArchive,
				artifact: first.artifact,
				manifest: first.manifest,
				manifestSha256: first.manifestSha256,
			});
			expect(installed.reused).toBe(false);
			expect(await readFile(installed.entrypoint, "utf8")).toBe("first");
			expect((await stat(root)).mode & 0o777).toBe(0o700);
			expect((await stat(installed.entrypoint)).mode & 0o777).toBe(0o700);
			expect((await stat(join(installed.releaseDir, "install.json"))).mode & 0o777).toBe(0o600);
			expect(await readlink(join(root, "current"))).toBe(`releases/${first.artifact.sha256}`);

			const repeated = await installWorkspaceArtifact({
				root,
				archive: firstArchive,
				artifact: first.artifact,
				manifest: first.manifest,
				manifestSha256: first.manifestSha256,
			});
			expect(repeated.reused).toBe(true);

			const secondArchive = createTarGzip([
				{ path: "bin/", type: "5" },
				{ path: "bin/piw", data: "second", mode: 0o755 },
			]);
			const second = release(secondArchive, { file: "piw-client-darwin-arm64-v2.tar.gz" });
			await expect(
				installWorkspaceArtifact({
					root,
					archive: Buffer.from("corrupt"),
					artifact: second.artifact,
					manifest: second.manifest,
					manifestSha256: second.manifestSha256,
				}),
			).rejects.toThrow(/size mismatch/);
			expect(await readlink(join(root, "current"))).toBe(`releases/${first.artifact.sha256}`);

			const updated = await installWorkspaceArtifact({
				root,
				archive: secondArchive,
				artifact: second.artifact,
				manifest: second.manifest,
				manifestSha256: second.manifestSha256,
			});
			expect(await readFile(updated.entrypoint, "utf8")).toBe("second");
			expect(await readlink(join(root, "current"))).toBe(`releases/${second.artifact.sha256}`);
			expect((await readdir(join(root, "releases"))).sort()).toEqual(
				[first.artifact.sha256, second.artifact.sha256].sort(),
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
