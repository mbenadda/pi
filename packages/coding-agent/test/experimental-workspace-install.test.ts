import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	readlink,
	rm,
	stat,
	symlink,
	utimes,
	writeFile,
} from "node:fs/promises";
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
const IDENTITY = `${JSON.stringify(
	{
		schemaVersion: 1,
		revision: REVISION,
		protocolVersion: PROTOCOL_VERSION,
		role: "client",
		platform: "darwin-arm64",
		entrypoint: "bin/piw",
	},
	undefined,
	"\t",
)}\n`;

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

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
	let settle: (() => void) | undefined;
	const promise = new Promise<void>((resolve) => {
		settle = resolve;
	});
	return {
		promise,
		resolve: () => {
			if (settle === undefined) throw new Error("Deferred promise was not initialized");
			settle();
		},
	};
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
		const invalidRevision = fixture.raw.replace(REVISION, "not-a-revision");
		expect(() => parseWorkspaceReleaseManifest(invalidRevision, sha256(invalidRevision))).toThrow(/invalid revision/);
		const invalidProtocol = fixture.raw.replace(`"protocolVersion": ${PROTOCOL_VERSION}`, '"protocolVersion": 0');
		expect(() => parseWorkspaceReleaseManifest(invalidProtocol, sha256(invalidProtocol))).toThrow(/incompatible/);
		const duplicate = JSON.stringify({ ...fixture.manifest, artifacts: [fixture.artifact, fixture.artifact] });
		expect(() => parseWorkspaceReleaseManifest(duplicate, sha256(duplicate))).toThrow(/duplicate artifact/);
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

	test("derives entry kind only from typeflag and normalizes directory paths", () => {
		const directory = createTarGzip([{ path: "bin", type: "5" }]);
		expect(inspectWorkspaceArchive(directory)).toEqual(["bin/"]);

		const regularFileWithDirectorySpelling = createTarGzip([{ path: "bin/", data: "not-a-directory" }]);
		expect(() => inspectWorkspaceArchive(regularFileWithDirectorySpelling)).toThrow(
			/regular file path ends with a slash/,
		);
	});

	test("rejects file and directory path collisions", () => {
		const archive = createTarGzip([
			{ path: "bin", data: "file" },
			{ path: "bin/piw", data: "nested" },
		]);
		expect(() => inspectWorkspaceArchive(archive)).toThrow(/file conflicts with directory/);
	});

	test("rejects links rather than relying on tar extraction semantics", () => {
		const archive = createTarGzip([{ path: "bin/piw", type: "2", data: "../../outside" }]);
		expect(() => inspectWorkspaceArchive(archive)).toThrow(/Unsupported Workspace archive entry type/);
	});
});

describe("Workspace release installation", () => {
	test("rejects unsafe lock types and recovers an abandoned stale lock", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-workspace-install-"));
		try {
			const archive = createTarGzip([
				{ path: ".pi-workspace-artifact.json", data: IDENTITY },
				{ path: "bin/piw", data: "client", mode: 0o755 },
			]);
			const fixture = release(archive);
			const options = {
				root,
				archive,
				rawManifest: fixture.raw,
				expectedManifestSha256: fixture.manifestSha256,
				role: "client" as const,
				platform: "darwin-arm64",
			};
			const lockPath = join(root, ".install-transaction-lock");
			await writeFile(lockPath, "unsafe", "utf8");
			await expect(installWorkspaceArtifact(options)).rejects.toThrow(/lock path is unsafe/);
			await rm(lockPath);
			await mkdir(lockPath);
			await utimes(lockPath, new Date(0), new Date(0));
			await expect(installWorkspaceArtifact(options)).resolves.toMatchObject({ reused: false });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("does not alias identical artifact bytes across distinct verified manifests", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-workspace-install-"));
		try {
			const archive = createTarGzip([
				{ path: ".pi-workspace-artifact.json", data: IDENTITY },
				{ path: "bin/piw", data: "client", mode: 0o755 },
			]);
			const first = release(archive);
			const second = release(archive, { file: "renamed-client.tar.gz" });
			const installedFirst = await installWorkspaceArtifact({
				root,
				archive,
				rawManifest: first.raw,
				expectedManifestSha256: first.manifestSha256,
				role: "client",
				platform: "darwin-arm64",
			});
			const installedSecond = await installWorkspaceArtifact({
				root,
				archive,
				rawManifest: second.raw,
				expectedManifestSha256: second.manifestSha256,
				role: "client",
				platform: "darwin-arm64",
			});
			expect(installedSecond.reused).toBe(false);
			expect(installedSecond.releaseDir).not.toBe(installedFirst.releaseDir);
			expect((await readdir(join(root, "releases"))).length).toBe(2);
			const changedRevision = second.raw.replace(REVISION, "fedcba9876543210fedcba9876543210fedcba98");
			await expect(
				installWorkspaceArtifact({
					root,
					archive,
					rawManifest: changedRevision,
					expectedManifestSha256: sha256(changedRevision),
					role: "client",
					platform: "darwin-arm64",
				}),
			).rejects.toThrow(/identity does not match/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("keeps active current resolvable between corrupt-release quarantine and activation and rolls back failure", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-workspace-install-"));
		try {
			const archive = createTarGzip([
				{ path: ".pi-workspace-artifact.json", data: IDENTITY },
				{ path: "bin/piw", data: "replacement", mode: 0o755 },
			]);
			const fixture = release(archive);
			const installed = await installWorkspaceArtifact({
				root,
				archive,
				rawManifest: fixture.raw,
				expectedManifestSha256: fixture.manifestSha256,
				role: "client",
				platform: "darwin-arm64",
			});
			await writeFile(installed.entrypoint, "corrupt", "utf8");
			await mkdir(join(root, ".candidate-stale"));
			await mkdir(join(root, "releases", ".repair-stale"));
			const releaseName = `${fixture.manifestSha256}-${fixture.artifact.sha256}`;
			let injected = false;
			await expect(
				installWorkspaceArtifact({
					root,
					archive,
					rawManifest: fixture.raw,
					expectedManifestSha256: fixture.manifestSha256,
					role: "client",
					platform: "darwin-arm64",
					onRepairQuarantined: async () => {
						injected = true;
						expect((await stat(join(root, ".install-transaction-lock"))).isDirectory()).toBe(true);
						expect(await readlink(join(root, "current"))).toMatch(/^releases\/\.repair-/u);
						expect(await readFile(join(root, "current", "bin", "piw"), "utf8")).toBe("replacement");
						throw new Error("injected repair failure");
					},
				}),
			).rejects.toThrow(/injected repair failure/);
			expect(injected).toBe(true);
			expect(await readlink(join(root, "current"))).toBe(`releases/${releaseName}`);
			expect(await readFile(join(root, "current", "bin", "piw"), "utf8")).toBe("corrupt");
			expect((await readdir(root)).some((name) => name.startsWith(".candidate-"))).toBe(false);
			expect((await readdir(join(root, "releases"))).some((name) => name.startsWith(".repair-"))).toBe(false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("retains the active repair fallback when rollback itself fails", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-workspace-install-"));
		try {
			const archive = createTarGzip([
				{ path: ".pi-workspace-artifact.json", data: IDENTITY },
				{ path: "bin/piw", data: "replacement", mode: 0o755 },
			]);
			const fixture = release(archive);
			const installed = await installWorkspaceArtifact({
				root,
				archive,
				rawManifest: fixture.raw,
				expectedManifestSha256: fixture.manifestSha256,
				role: "client",
				platform: "darwin-arm64",
			});
			await writeFile(installed.entrypoint, "corrupt", "utf8");
			let failure: unknown;
			try {
				await installWorkspaceArtifact({
					root,
					archive,
					rawManifest: fixture.raw,
					expectedManifestSha256: fixture.manifestSha256,
					role: "client",
					platform: "darwin-arm64",
					onRepairQuarantined: async () => {
						throw new Error("injected replacement failure");
					},
					onRepairRollback: async () => {
						throw new Error("injected rollback failure");
					},
				});
			} catch (error) {
				failure = error;
			}
			if (!(failure instanceof AggregateError)) throw new Error("Expected repair and rollback failures");
			expect(failure.errors).toEqual([
				expect.objectContaining({ message: "injected replacement failure" }),
				expect.objectContaining({ message: "injected rollback failure" }),
			]);
			expect(await readlink(join(root, "current"))).toMatch(/^releases\/\.repair-/u);
			expect(await readFile(join(root, "current", "bin", "piw"), "utf8")).toBe("replacement");
			expect((await readdir(join(root, "releases"))).some((name) => name.startsWith(".repair-"))).toBe(true);

			const recovered = await installWorkspaceArtifact({
				root,
				archive,
				rawManifest: fixture.raw,
				expectedManifestSha256: fixture.manifestSha256,
				role: "client",
				platform: "darwin-arm64",
			});
			expect(await readlink(join(root, "current"))).toBe(
				`releases/${fixture.manifestSha256}-${fixture.artifact.sha256}`,
			);
			expect(await readFile(recovered.entrypoint, "utf8")).toBe("replacement");
			expect((await readdir(join(root, "releases"))).some((name) => name.startsWith(".repair-"))).toBe(false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("aggregates a primary repair failure with local scratch pruning failure", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-workspace-install-"));
		try {
			const archive = createTarGzip([
				{ path: ".pi-workspace-artifact.json", data: IDENTITY },
				{ path: "bin/piw", data: "replacement", mode: 0o755 },
			]);
			const fixture = release(archive);
			const installed = await installWorkspaceArtifact({
				root,
				archive,
				rawManifest: fixture.raw,
				expectedManifestSha256: fixture.manifestSha256,
				role: "client",
				platform: "darwin-arm64",
			});
			await writeFile(installed.entrypoint, "corrupt", "utf8");
			let failure: unknown;
			try {
				await installWorkspaceArtifact({
					root,
					archive,
					rawManifest: fixture.raw,
					expectedManifestSha256: fixture.manifestSha256,
					role: "client",
					platform: "darwin-arm64",
					onRepairQuarantined: async () => {
						await symlink("missing", join(root, ".install-unsafe"));
						throw new Error("primary repair failure");
					},
				});
			} catch (error) {
				failure = error;
			}
			if (!(failure instanceof AggregateError)) throw new Error("Expected transaction and cleanup failures");
			expect(failure.errors.map((error) => (error instanceof Error ? error.message : String(error)))).toEqual([
				"primary repair failure",
				expect.stringContaining("scratch path is unsafe"),
			]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("serializes concurrent repairs without ever dangling current", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-workspace-install-"));
		try {
			const archive = createTarGzip([
				{ path: ".pi-workspace-artifact.json", data: IDENTITY },
				{ path: "bin/piw", data: "client", mode: 0o755 },
			]);
			const fixture = release(archive);
			const installed = await installWorkspaceArtifact({
				root,
				archive,
				rawManifest: fixture.raw,
				expectedManifestSha256: fixture.manifestSha256,
				role: "client",
				platform: "darwin-arm64",
			});
			await chmod(installed.entrypoint, 0o600);
			const repairEntered = deferred();
			const continueRepair = deferred();
			const first = installWorkspaceArtifact({
				root,
				archive,
				rawManifest: fixture.raw,
				expectedManifestSha256: fixture.manifestSha256,
				role: "client",
				platform: "darwin-arm64",
				onRepairQuarantined: async () => {
					repairEntered.resolve();
					await continueRepair.promise;
				},
			});
			await repairEntered.promise;
			const second = installWorkspaceArtifact({
				root,
				archive,
				rawManifest: fixture.raw,
				expectedManifestSha256: fixture.manifestSha256,
				role: "client",
				platform: "darwin-arm64",
			});
			for (let attempt = 0; attempt < 50; attempt += 1) {
				expect(await readlink(join(root, "current"))).toMatch(/^releases\//u);
				expect(await readFile(join(root, "current", "bin", "piw"), "utf8")).toBe("client");
				await new Promise<void>((resolve) => setTimeout(resolve, 1));
			}
			continueRepair.resolve();
			const [repaired, reused] = await Promise.all([first, second]);
			expect(repaired.reused).toBe(false);
			expect(reused.reused).toBe(true);
			expect(await readFile(join(root, "current", "bin", "piw"), "utf8")).toBe("client");
			expect((await stat(join(root, "current", "bin", "piw"))).mode & 0o777).toBe(0o700);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("installs content-addressed, switches current atomically, and retains rollback releases", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-workspace-install-"));
		try {
			const firstArchive = createTarGzip([
				{ path: ".pi-workspace-artifact.json", data: IDENTITY },
				{ path: "bin/", type: "5" },
				{ path: "bin/piw", data: "first", mode: 0o755 },
			]);
			const first = release(firstArchive);
			const installed = await installWorkspaceArtifact({
				root,
				archive: firstArchive,
				rawManifest: first.raw,
				expectedManifestSha256: first.manifestSha256,
				role: "client",
				platform: "darwin-arm64",
			});
			expect(installed.reused).toBe(false);
			expect(await readFile(installed.entrypoint, "utf8")).toBe("first");
			expect((await stat(root)).mode & 0o777).toBe(0o700);
			expect((await stat(installed.entrypoint)).mode & 0o777).toBe(0o700);
			expect((await stat(join(installed.releaseDir, "install.json"))).mode & 0o777).toBe(0o600);
			const firstReleaseName = `${first.manifestSha256}-${first.artifact.sha256}`;
			expect(await readlink(join(root, "current"))).toBe(`releases/${firstReleaseName}`);

			const repeated = await installWorkspaceArtifact({
				root,
				archive: firstArchive,
				rawManifest: first.raw,
				expectedManifestSha256: first.manifestSha256,
				role: "client",
				platform: "darwin-arm64",
			});
			expect(repeated.reused).toBe(true);

			const secondArchive = createTarGzip([
				{ path: ".pi-workspace-artifact.json", data: IDENTITY },
				{ path: "bin/", type: "5" },
				{ path: "bin/piw", data: "second", mode: 0o755 },
			]);
			const second = release(secondArchive, { file: "piw-client-darwin-arm64-v2.tar.gz" });
			await expect(
				installWorkspaceArtifact({
					root,
					archive: Buffer.from("corrupt"),
					rawManifest: second.raw,
					expectedManifestSha256: second.manifestSha256,
					role: "client",
					platform: "darwin-arm64",
				}),
			).rejects.toThrow(/size mismatch/);
			expect(await readlink(join(root, "current"))).toBe(`releases/${firstReleaseName}`);

			const updated = await installWorkspaceArtifact({
				root,
				archive: secondArchive,
				rawManifest: second.raw,
				expectedManifestSha256: second.manifestSha256,
				role: "client",
				platform: "darwin-arm64",
			});
			expect(await readFile(updated.entrypoint, "utf8")).toBe("second");
			const secondReleaseName = `${second.manifestSha256}-${second.artifact.sha256}`;
			expect(await readlink(join(root, "current"))).toBe(`releases/${secondReleaseName}`);
			expect((await readdir(join(root, "releases"))).sort()).toEqual([firstReleaseName, secondReleaseName].sort());

			await chmod(updated.entrypoint, 0o600);
			const modeRepaired = await installWorkspaceArtifact({
				root,
				archive: secondArchive,
				rawManifest: second.raw,
				expectedManifestSha256: second.manifestSha256,
				role: "client",
				platform: "darwin-arm64",
			});
			expect(modeRepaired.reused).toBe(false);
			expect((await stat(modeRepaired.entrypoint)).mode & 0o777).toBe(0o700);

			await mkdir(join(root, ".candidate-stale"));
			await mkdir(join(root, ".install-stale"));
			await writeFile(join(root, ".install-stale.tar.gz"), "partial", "utf8");
			await symlink("releases/missing", join(root, ".current-stale"));
			await mkdir(join(root, "releases", ".repair-stale"));
			await writeFile(updated.entrypoint, "tampered", "utf8");
			const repaired = await installWorkspaceArtifact({
				root,
				archive: secondArchive,
				rawManifest: second.raw,
				expectedManifestSha256: second.manifestSha256,
				role: "client",
				platform: "darwin-arm64",
			});
			expect(repaired.reused).toBe(false);
			expect(await readFile(repaired.entrypoint, "utf8")).toBe("second");
			expect((await readdir(join(root, "quarantine"))).length).toBe(2);
			const rootEntries = await readdir(root);
			expect(rootEntries.some((name) => name.startsWith(".candidate-"))).toBe(false);
			expect(rootEntries.some((name) => name.startsWith(".install-") && name !== ".install-transaction-lock")).toBe(
				false,
			);
			expect(rootEntries.some((name) => name.startsWith(".current-"))).toBe(false);
			expect((await readdir(join(root, "releases"))).some((name) => name.startsWith(".repair-"))).toBe(false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
