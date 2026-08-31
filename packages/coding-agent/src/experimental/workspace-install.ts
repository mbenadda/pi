import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, posix, relative, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { PROTOCOL_VERSION } from "@earendil-works/pi-protocol";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const PLATFORM_PATTERN = /^(darwin|linux)-(arm64|x64)$/u;
const ARCHIVE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.tar\.gz$/u;
const ENTRYPOINT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/u;
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
const TAR_BLOCK_BYTES = 512;

export type WorkspaceArtifactRole = "client" | "server";

export interface WorkspaceReleaseArtifact {
	readonly role: WorkspaceArtifactRole;
	readonly platform: string;
	readonly file: string;
	readonly sha256: string;
	readonly size: number;
	readonly entrypoint: string;
}

export interface WorkspaceReleaseManifest {
	readonly schemaVersion: 1;
	readonly revision: string;
	readonly protocolVersion: number;
	readonly artifacts: readonly WorkspaceReleaseArtifact[];
}

export interface InstalledWorkspaceRelease {
	readonly releaseDir: string;
	readonly entrypoint: string;
	readonly reused: boolean;
}

interface TarEntry {
	readonly path: string;
	readonly mode: number;
	readonly data: Buffer;
}

export function sha256(data: string | Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

export function parseWorkspaceReleaseManifest(raw: string, expectedManifestSha256?: string): WorkspaceReleaseManifest {
	if (expectedManifestSha256 !== undefined) {
		requireSha256(expectedManifestSha256, "manifest checksum");
		if (sha256(raw) !== expectedManifestSha256) throw new Error("Workspace release manifest checksum mismatch");
	}
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch (error) {
		throw new Error("Workspace release manifest is not valid JSON", { cause: error });
	}
	if (!isRecord(value) || value.schemaVersion !== 1) {
		throw new Error("Unsupported Workspace release manifest schema");
	}
	if (typeof value.revision !== "string" || !REVISION_PATTERN.test(value.revision)) {
		throw new Error("Workspace release manifest has an invalid revision");
	}
	if (value.protocolVersion !== PROTOCOL_VERSION) {
		throw new Error(
			`Workspace release protocol ${String(value.protocolVersion)} is incompatible with client protocol ${PROTOCOL_VERSION}`,
		);
	}
	if (!Array.isArray(value.artifacts) || value.artifacts.length === 0) {
		throw new Error("Workspace release manifest has no artifacts");
	}
	const keys = new Set<string>();
	const artifacts = value.artifacts.map<WorkspaceReleaseArtifact>((artifact, index) => {
		if (!isRecord(artifact)) throw new Error(`Workspace release artifact ${index} is invalid`);
		const role = artifact.role;
		const platform = artifact.platform;
		const file = artifact.file;
		const digest = artifact.sha256;
		const size = artifact.size;
		const entrypoint = artifact.entrypoint;
		if (role !== "client" && role !== "server")
			throw new Error(`Workspace release artifact ${index} has an invalid role`);
		if (typeof platform !== "string" || !PLATFORM_PATTERN.test(platform)) {
			throw new Error(`Workspace release artifact ${index} has an invalid platform`);
		}
		if (typeof file !== "string" || !ARCHIVE_NAME_PATTERN.test(file) || basename(file) !== file) {
			throw new Error(`Workspace release artifact ${index} has an invalid file name`);
		}
		if (typeof digest !== "string") throw new Error(`Workspace release artifact ${index} has no checksum`);
		requireSha256(digest, `artifact ${index} checksum`);
		if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0 || size > MAX_ARTIFACT_BYTES) {
			throw new Error(`Workspace release artifact ${index} has an invalid size`);
		}
		if (typeof entrypoint !== "string" || !isSafeArchivePath(entrypoint) || !ENTRYPOINT_PATTERN.test(entrypoint)) {
			throw new Error(`Workspace release artifact ${index} has an invalid entrypoint`);
		}
		const key = `${role}:${platform}`;
		if (keys.has(key)) throw new Error(`Workspace release manifest has duplicate artifact ${key}`);
		keys.add(key);
		return { role, platform, file, sha256: digest, size, entrypoint };
	});
	return { schemaVersion: 1, revision: value.revision, protocolVersion: value.protocolVersion, artifacts };
}

export function selectWorkspaceReleaseArtifact(
	manifest: WorkspaceReleaseManifest,
	role: WorkspaceArtifactRole,
	platform: string,
): WorkspaceReleaseArtifact {
	const artifact = manifest.artifacts.find((candidate) => candidate.role === role && candidate.platform === platform);
	if (artifact === undefined) throw new Error(`Workspace release has no ${role} artifact for ${platform}`);
	return artifact;
}

export function verifyWorkspaceArtifact(archive: Uint8Array, artifact: WorkspaceReleaseArtifact): void {
	if (archive.byteLength !== artifact.size) {
		throw new Error(`Workspace artifact size mismatch: expected ${artifact.size}, received ${archive.byteLength}`);
	}
	if (sha256(archive) !== artifact.sha256) throw new Error("Workspace artifact checksum mismatch");
}

export function inspectWorkspaceArchive(archive: Uint8Array): readonly string[] {
	return parseTarArchive(archive).map((entry) => entry.path);
}

export async function installWorkspaceArtifact(options: {
	readonly root: string;
	readonly archive: Uint8Array;
	readonly artifact: WorkspaceReleaseArtifact;
	readonly manifest: WorkspaceReleaseManifest;
	readonly manifestSha256: string;
}): Promise<InstalledWorkspaceRelease> {
	const root = resolve(options.root);
	if (root === "/") throw new Error("Workspace install root cannot be the filesystem root");
	requireSha256(options.manifestSha256, "manifest checksum");
	verifyWorkspaceArtifact(options.archive, options.artifact);
	const entries = parseTarArchive(options.archive);
	if (!entries.some((entry) => entry.path === options.artifact.entrypoint)) {
		throw new Error(`Workspace artifact is missing entrypoint ${options.artifact.entrypoint}`);
	}
	await ensurePrivateDirectory(root);
	const releasesDir = join(root, "releases");
	await ensurePrivateDirectory(releasesDir);
	const releaseDir = join(releasesDir, options.artifact.sha256);
	const receipt = `${JSON.stringify(
		{
			schemaVersion: 1,
			manifestSha256: options.manifestSha256,
			revision: options.manifest.revision,
			protocolVersion: options.manifest.protocolVersion,
			artifact: options.artifact,
		},
		undefined,
		"\t",
	)}\n`;
	let reused = false;
	try {
		const stats = await lstat(releaseDir);
		if (!stats.isDirectory() || stats.isSymbolicLink())
			throw new Error(`Workspace release path is unsafe: ${releaseDir}`);
		const existingReceipt = await readFile(join(releaseDir, "install.json"), "utf8");
		if (existingReceipt !== receipt) throw new Error(`Workspace release receipt mismatch: ${releaseDir}`);
		reused = true;
	} catch (error) {
		if (!isMissing(error)) throw error;
		const temporaryDir = join(root, `.install-${randomUUID()}`);
		await mkdir(temporaryDir, { mode: 0o700 });
		try {
			for (const entry of entries) await extractTarEntry(temporaryDir, entry);
			await writeFile(join(temporaryDir, "install.json"), receipt, { mode: 0o600, flag: "wx" });
			try {
				await rename(temporaryDir, releaseDir);
			} catch (renameError) {
				if (!isAlreadyExists(renameError)) throw renameError;
				const existingReceipt = await readFile(join(releaseDir, "install.json"), "utf8");
				if (existingReceipt !== receipt) throw new Error(`Workspace release receipt mismatch: ${releaseDir}`);
				reused = true;
			}
		} finally {
			await rm(temporaryDir, { recursive: true, force: true });
		}
	}
	const entrypoint = join(releaseDir, ...options.artifact.entrypoint.split("/"));
	const entrypointStats = await lstat(entrypoint);
	if (!entrypointStats.isFile() || entrypointStats.isSymbolicLink()) {
		throw new Error(`Workspace release entrypoint is unsafe: ${entrypoint}`);
	}
	await chmod(entrypoint, 0o700);
	await switchCurrent(root, releaseDir);
	return { releaseDir, entrypoint, reused };
}

async function switchCurrent(root: string, releaseDir: string): Promise<void> {
	const current = join(root, "current");
	const target = relative(root, releaseDir);
	try {
		if ((await readlink(current)) === target) return;
	} catch (error) {
		if (!isMissing(error)) {
			const stats = await lstat(current);
			if (!stats.isSymbolicLink()) throw new Error(`Workspace current path is not a symlink: ${current}`);
		}
	}
	const temporary = join(root, `.current-${randomUUID()}`);
	try {
		await symlink(target, temporary);
		await rename(temporary, current);
	} finally {
		await rm(temporary, { force: true });
	}
}

async function ensurePrivateDirectory(path: string): Promise<void> {
	await mkdir(path, { recursive: true, mode: 0o700 });
	const stats = await lstat(path);
	if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error(`Workspace install path is unsafe: ${path}`);
	if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
		throw new Error(`Workspace install path is not owned by the current user: ${path}`);
	}
	await chmod(path, 0o700);
}

async function extractTarEntry(root: string, entry: TarEntry): Promise<void> {
	const output = resolve(root, ...entry.path.split("/"));
	if (output !== root && !output.startsWith(`${root}/`))
		throw new Error(`Unsafe Workspace archive path: ${entry.path}`);
	if (entry.data.length === 0 && entry.path.endsWith("/")) {
		await mkdir(output, { recursive: true, mode: 0o700 });
		await chmod(output, 0o700);
		return;
	}
	await mkdir(dirname(output), { recursive: true, mode: 0o700 });
	const handle = await open(output, "wx", entry.mode & 0o111 ? 0o700 : 0o600);
	try {
		await handle.writeFile(entry.data);
	} finally {
		await handle.close();
	}
}

function parseTarArchive(archive: Uint8Array): TarEntry[] {
	let tar: Buffer;
	try {
		tar = gunzipSync(archive, { maxOutputLength: MAX_ARTIFACT_BYTES });
	} catch (error) {
		throw new Error("Workspace artifact is not a valid gzip archive", { cause: error });
	}
	const entries: TarEntry[] = [];
	const paths = new Set<string>();
	let offset = 0;
	while (offset + TAR_BLOCK_BYTES <= tar.length) {
		const header = tar.subarray(offset, offset + TAR_BLOCK_BYTES);
		if (header.every((byte) => byte === 0)) break;
		validateTarChecksum(header);
		const name = readTarString(header, 0, 100);
		const prefix = readTarString(header, 345, 155);
		const path = prefix.length > 0 ? `${prefix}/${name}` : name;
		const type = String.fromCharCode(header[156] ?? 0);
		const size = readTarOctal(header, 124, 12, "size");
		const mode = readTarOctal(header, 100, 8, "mode");
		if (!isSafeArchivePath(path)) throw new Error(`Unsafe Workspace archive path: ${path}`);
		if (paths.has(path)) throw new Error(`Duplicate Workspace archive path: ${path}`);
		paths.add(path);
		if (type !== "\0" && type !== "0" && type !== "5") {
			throw new Error(`Unsupported Workspace archive entry type for ${path}`);
		}
		if (type === "5" && size !== 0) throw new Error(`Workspace archive directory has data: ${path}`);
		const dataStart = offset + TAR_BLOCK_BYTES;
		const dataEnd = dataStart + size;
		if (dataEnd > tar.length) throw new Error(`Truncated Workspace archive entry: ${path}`);
		entries.push({
			path: type === "5" && !path.endsWith("/") ? `${path}/` : path,
			mode,
			data: tar.subarray(dataStart, dataEnd),
		});
		offset = dataStart + Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
	}
	if (entries.length === 0) throw new Error("Workspace artifact archive is empty");
	return entries;
}

function validateTarChecksum(header: Buffer): void {
	const expected = readTarOctal(header, 148, 8, "checksum");
	let actual = 0;
	for (let index = 0; index < header.length; index += 1) {
		actual += index >= 148 && index < 156 ? 32 : (header[index] ?? 0);
	}
	if (actual !== expected) throw new Error("Workspace artifact tar checksum mismatch");
}

function readTarString(header: Buffer, offset: number, length: number): string {
	const field = header.subarray(offset, offset + length);
	const end = field.indexOf(0);
	return field.subarray(0, end === -1 ? field.length : end).toString("utf8");
}

function readTarOctal(header: Buffer, offset: number, length: number, label: string): number {
	const value = readTarString(header, offset, length).trim();
	if (!/^[0-7]+$/u.test(value)) throw new Error(`Workspace artifact has an invalid tar ${label}`);
	const parsed = Number.parseInt(value, 8);
	if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`Workspace artifact has an invalid tar ${label}`);
	return parsed;
}

function isSafeArchivePath(path: string): boolean {
	if (path.length === 0 || path.includes("\\") || path.includes("\0") || path.startsWith("/")) return false;
	const candidate = path.endsWith("/") ? path.slice(0, -1) : path;
	const normalized = posix.normalize(candidate);
	return normalized !== "." && normalized !== ".." && !normalized.startsWith("../") && normalized === candidate;
}

function requireSha256(value: string, label: string): void {
	if (!SHA256_PATTERN.test(value)) throw new Error(`Invalid ${label}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
	return error instanceof Error && "code" in error && (error.code === "EEXIST" || error.code === "ENOTEMPTY");
}
