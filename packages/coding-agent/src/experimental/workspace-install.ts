import { isUtf8 } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import {
	chmod,
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	readlink,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
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
const MAX_ARCHIVE_ENTRIES = 100_000;
const ARTIFACT_IDENTITY_PATH = ".pi-workspace-artifact.json";

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
	readonly kind: "file" | "directory";
	readonly mode: number;
	readonly data: Buffer;
}

export interface WorkspaceArtifactIdentity {
	readonly schemaVersion: 1;
	readonly revision: string;
	readonly protocolVersion: number;
	readonly role: WorkspaceArtifactRole;
	readonly platform: string;
	readonly entrypoint: string;
	readonly bundledManifestSha256?: string;
}

export function sha256(data: string | Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

export function parseWorkspaceReleaseManifest(raw: string, expectedManifestSha256: string): WorkspaceReleaseManifest {
	requireSha256(expectedManifestSha256, "manifest checksum");
	if (sha256(raw) !== expectedManifestSha256) throw new Error("Workspace release manifest checksum mismatch");
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

export function verifyWorkspaceArtifactContents(
	archive: Uint8Array,
	manifest: WorkspaceReleaseManifest,
	artifact: WorkspaceReleaseArtifact,
): void {
	verifyWorkspaceArtifact(archive, artifact);
	validateArtifactIdentity(parseTarArchive(archive), manifest, artifact);
}

export async function installWorkspaceArtifact(options: {
	readonly root: string;
	readonly archive: Uint8Array;
	readonly rawManifest: string;
	readonly expectedManifestSha256: string;
	readonly role: WorkspaceArtifactRole;
	readonly platform: string;
	readonly onRepairQuarantined?: () => Promise<void>;
}): Promise<InstalledWorkspaceRelease> {
	const root = resolve(options.root);
	if (root === "/") throw new Error("Workspace install root cannot be the filesystem root");
	const manifest = parseWorkspaceReleaseManifest(options.rawManifest, options.expectedManifestSha256);
	const artifact = selectWorkspaceReleaseArtifact(manifest, options.role, options.platform);
	verifyWorkspaceArtifact(options.archive, artifact);
	const entries = parseTarArchive(options.archive);
	validateArtifactIdentity(entries, manifest, artifact);
	if (!entries.some((entry) => entry.path === artifact.entrypoint && entry.kind === "file")) {
		throw new Error(`Workspace artifact is missing entrypoint ${artifact.entrypoint}`);
	}
	await ensurePrivateDirectory(root);
	const releasesDir = join(root, "releases");
	await ensurePrivateDirectory(releasesDir);
	const releaseName = `${options.expectedManifestSha256}-${artifact.sha256}`;
	const releaseDir = join(releasesDir, releaseName);
	const receipt = `${JSON.stringify(
		{
			schemaVersion: 1,
			manifestSha256: options.expectedManifestSha256,
			revision: manifest.revision,
			protocolVersion: manifest.protocolVersion,
			artifact,
		},
		undefined,
		"\t",
	)}\n`;
	let reused = false;
	let corruptRelease = false;
	if (await pathExists(releaseDir)) {
		try {
			await verifyInstalledRelease(releaseDir, entries, receipt);
			reused = true;
		} catch {
			corruptRelease = true;
		}
	}
	if (!reused) {
		const temporaryDir = join(root, `.install-${randomUUID()}`);
		try {
			await prepareInstalledRelease(temporaryDir, entries, receipt);
			if (corruptRelease) {
				try {
					await verifyInstalledRelease(releaseDir, entries, receipt);
					reused = true;
				} catch {
					await replaceCorruptRelease({
						root,
						releaseDir,
						releaseName,
						replacementDir: temporaryDir,
						entries,
						receipt,
						...(options.onRepairQuarantined === undefined ? {} : { onQuarantined: options.onRepairQuarantined }),
					});
				}
			} else {
				try {
					await rename(temporaryDir, releaseDir);
				} catch (renameError) {
					if (!isAlreadyExists(renameError)) throw renameError;
					await verifyInstalledRelease(releaseDir, entries, receipt);
					reused = true;
				}
			}
		} finally {
			await rm(temporaryDir, { recursive: true, force: true });
		}
	}
	await verifyInstalledRelease(releaseDir, entries, receipt);
	const entrypoint = join(releaseDir, ...artifact.entrypoint.split("/"));
	await switchCurrent(root, releaseDir);
	return { releaseDir, entrypoint, reused };
}

export function parseWorkspaceArtifactIdentity(raw: string): WorkspaceArtifactIdentity {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch (error) {
		throw new Error("Workspace artifact identity is not valid JSON", { cause: error });
	}
	if (
		!isRecord(value) ||
		value.schemaVersion !== 1 ||
		typeof value.revision !== "string" ||
		!REVISION_PATTERN.test(value.revision) ||
		value.protocolVersion !== PROTOCOL_VERSION ||
		(value.role !== "client" && value.role !== "server") ||
		typeof value.platform !== "string" ||
		!PLATFORM_PATTERN.test(value.platform) ||
		typeof value.entrypoint !== "string" ||
		!isSafeArchivePath(value.entrypoint)
	) {
		throw new Error("Workspace artifact identity is invalid");
	}
	if (value.bundledManifestSha256 !== undefined) {
		if (value.role !== "client" || typeof value.bundledManifestSha256 !== "string") {
			throw new Error("Workspace artifact identity has an invalid bundledManifestSha256");
		}
		requireSha256(value.bundledManifestSha256, "bundled manifest checksum");
	}
	return {
		schemaVersion: 1,
		revision: value.revision,
		protocolVersion: value.protocolVersion,
		role: value.role,
		platform: value.platform,
		entrypoint: value.entrypoint,
		...(value.bundledManifestSha256 === undefined ? {} : { bundledManifestSha256: value.bundledManifestSha256 }),
	};
}

function validateArtifactIdentity(
	entries: readonly TarEntry[],
	manifest: WorkspaceReleaseManifest,
	artifact: WorkspaceReleaseArtifact,
): void {
	const entry = entries.find((candidate) => candidate.path === ARTIFACT_IDENTITY_PATH && candidate.kind === "file");
	if (entry === undefined) throw new Error(`Workspace artifact is missing ${ARTIFACT_IDENTITY_PATH}`);
	const identity = parseWorkspaceArtifactIdentity(entry.data.toString("utf8"));
	if (
		identity.revision !== manifest.revision ||
		identity.protocolVersion !== manifest.protocolVersion ||
		identity.role !== artifact.role ||
		identity.platform !== artifact.platform ||
		identity.entrypoint !== artifact.entrypoint
	) {
		throw new Error("Workspace artifact identity does not match its verified manifest record");
	}
	if (
		artifact.role === "client" &&
		manifest.artifacts.some((candidate) => candidate.role === "server") &&
		identity.bundledManifestSha256 === undefined
	) {
		throw new Error("Workspace client artifact identity does not pin its bundled server manifest");
	}
}

async function verifyInstalledRelease(
	releaseDir: string,
	entries: readonly TarEntry[],
	receipt: string,
): Promise<void> {
	const releaseStats = await lstat(releaseDir);
	if (!releaseStats.isDirectory() || releaseStats.isSymbolicLink()) {
		throw new Error(`Workspace release path is unsafe: ${releaseDir}`);
	}
	const expectedPaths = new Set<string>(["install.json"]);
	for (const entry of entries) {
		const parts = entry.path.replace(/\/$/u, "").split("/");
		for (let index = 1; index < parts.length; index += 1) expectedPaths.add(`${parts.slice(0, index).join("/")}/`);
		expectedPaths.add(entry.path);
		const output = join(releaseDir, ...parts);
		const stats = await lstat(output);
		if (entry.kind === "directory") {
			if (!stats.isDirectory() || stats.isSymbolicLink())
				throw new Error(`Workspace release directory is unsafe: ${output}`);
			if ((stats.mode & 0o777) !== 0o700) throw new Error(`Workspace release directory mode mismatch: ${output}`);
		} else {
			if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`Workspace release file is unsafe: ${output}`);
			const expectedMode = entry.mode & 0o111 ? 0o700 : 0o600;
			if ((stats.mode & 0o777) !== expectedMode) throw new Error(`Workspace release file mode mismatch: ${output}`);
			if (!(await readFile(output)).equals(entry.data))
				throw new Error(`Workspace release file content mismatch: ${output}`);
		}
	}
	if ((await readFile(join(releaseDir, "install.json"), "utf8")) !== receipt) {
		throw new Error(`Workspace release receipt mismatch: ${releaseDir}`);
	}
	const actualPaths = await collectReleasePaths(releaseDir);
	if (actualPaths.length !== expectedPaths.size || actualPaths.some((path) => !expectedPaths.has(path))) {
		throw new Error(`Workspace release contains unexpected contents: ${releaseDir}`);
	}
}

async function collectReleasePaths(root: string, prefix = ""): Promise<string[]> {
	const paths: string[] = [];
	for (const name of (await readdir(join(root, ...prefix.split("/").filter(Boolean)))).sort()) {
		const child = prefix.length === 0 ? name : `${prefix}/${name}`;
		const stats = await lstat(join(root, ...child.split("/")));
		if (stats.isSymbolicLink()) throw new Error(`Workspace release contains a symlink: ${child}`);
		if (stats.isDirectory()) {
			paths.push(`${child}/`);
			paths.push(...(await collectReleasePaths(root, child)));
		} else if (stats.isFile()) {
			paths.push(child);
		} else {
			throw new Error(`Workspace release contains an unsupported entry: ${child}`);
		}
	}
	return paths;
}

async function prepareInstalledRelease(
	directory: string,
	entries: readonly TarEntry[],
	receipt: string,
): Promise<void> {
	await mkdir(directory, { mode: 0o700 });
	try {
		for (const entry of entries) await extractTarEntry(directory, entry);
		await writeFile(join(directory, "install.json"), receipt, { mode: 0o600, flag: "wx" });
		await verifyInstalledRelease(directory, entries, receipt);
	} catch (error) {
		await rm(directory, { recursive: true, force: true });
		throw error;
	}
}

async function replaceCorruptRelease(options: {
	readonly root: string;
	readonly releaseDir: string;
	readonly releaseName: string;
	readonly replacementDir: string;
	readonly entries: readonly TarEntry[];
	readonly receipt: string;
	readonly onQuarantined?: () => Promise<void>;
}): Promise<void> {
	const active = await currentTargetsRelease(options.root, options.releaseDir);
	const fallbackDir = join(options.root, "releases", `.repair-${options.releaseName}-${randomUUID()}`);
	let fallbackPrepared = false;
	let quarantinePath: string | undefined;
	try {
		if (active) {
			await prepareInstalledRelease(fallbackDir, options.entries, options.receipt);
			fallbackPrepared = true;
			await switchCurrent(options.root, fallbackDir);
		}
		quarantinePath = await quarantineRelease(options.root, options.releaseDir, options.releaseName);
		await options.onQuarantined?.();
		await rename(options.replacementDir, options.releaseDir);
		await verifyInstalledRelease(options.releaseDir, options.entries, options.receipt);
		await switchCurrent(options.root, options.releaseDir);
	} catch (error) {
		try {
			if (quarantinePath !== undefined) {
				if (await pathExists(options.releaseDir)) {
					const quarantine = dirname(quarantinePath);
					await rename(
						options.releaseDir,
						join(quarantine, `${options.releaseName}-failed-replacement-${randomUUID()}`),
					);
				}
				await rename(quarantinePath, options.releaseDir);
			}
			if (active) await switchCurrent(options.root, options.releaseDir);
		} catch (rollbackError) {
			throw new AggregateError([error, rollbackError], "Workspace release repair and rollback failed");
		}
		throw error;
	} finally {
		if (fallbackPrepared && !(await currentTargetsRelease(options.root, fallbackDir))) {
			await rm(fallbackDir, { recursive: true, force: true });
		}
	}
}

async function quarantineRelease(root: string, releaseDir: string, releaseName: string): Promise<string> {
	const quarantine = join(root, "quarantine");
	await ensurePrivateDirectory(quarantine);
	const destination = join(quarantine, `${releaseName}-${randomUUID()}`);
	await rename(releaseDir, destination);
	return destination;
}

async function currentTargetsRelease(root: string, releaseDir: string): Promise<boolean> {
	const current = join(root, "current");
	try {
		const stats = await lstat(current);
		if (!stats.isSymbolicLink()) return false;
		return resolve(root, await readlink(current)) === releaseDir;
	} catch (error) {
		if (isMissing(error)) return false;
		throw error;
	}
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if (isMissing(error)) return false;
		throw error;
	}
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
	if (entry.kind === "directory") {
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
	const directoryPrefixes = new Set<string>();
	let offset = 0;
	let terminated = false;
	while (offset + TAR_BLOCK_BYTES <= tar.length) {
		const header = tar.subarray(offset, offset + TAR_BLOCK_BYTES);
		if (header.every((byte) => byte === 0)) {
			terminated = true;
			break;
		}
		if (entries.length >= MAX_ARCHIVE_ENTRIES) throw new Error("Workspace artifact has too many archive entries");
		validateTarChecksum(header);
		const name = readTarString(header, 0, 100);
		const prefix = readTarString(header, 345, 155);
		const path = prefix.length > 0 ? `${prefix}/${name}` : name;
		const type = String.fromCharCode(header[156] ?? 0);
		const size = readTarOctal(header, 124, 12, "size");
		const mode = readTarOctal(header, 100, 8, "mode");
		if (!isSafeArchivePath(path)) throw new Error(`Unsafe Workspace archive path: ${path}`);
		if (type !== "\0" && type !== "0" && type !== "5") {
			throw new Error(`Unsupported Workspace archive entry type for ${path}`);
		}
		const kind = type === "5" ? "directory" : "file";
		if (kind === "file" && path.endsWith("/")) {
			throw new Error(`Workspace archive regular file path ends with a slash: ${path}`);
		}
		const canonicalPath = path.endsWith("/") ? path.slice(0, -1) : path;
		if (paths.has(canonicalPath)) throw new Error(`Duplicate Workspace archive path: ${path}`);
		paths.add(canonicalPath);
		const parts = canonicalPath.split("/");
		for (let index = 1; index < parts.length; index += 1) {
			directoryPrefixes.add(parts.slice(0, index).join("/"));
		}
		if (kind === "directory" && size !== 0) throw new Error(`Workspace archive directory has data: ${path}`);
		const dataStart = offset + TAR_BLOCK_BYTES;
		const dataEnd = dataStart + size;
		if (dataEnd > tar.length) throw new Error(`Truncated Workspace archive entry: ${path}`);
		entries.push({
			path: kind === "directory" ? `${canonicalPath}/` : canonicalPath,
			kind,
			mode,
			data: tar.subarray(dataStart, dataEnd),
		});
		offset = dataStart + Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
	}
	if (entries.length === 0) throw new Error("Workspace artifact archive is empty");
	if (!terminated || !tar.subarray(offset).every((byte) => byte === 0)) {
		throw new Error("Workspace artifact tar has invalid trailing data");
	}
	for (const entry of entries) {
		const path = entry.kind === "directory" ? entry.path.slice(0, -1) : entry.path;
		if (entry.kind === "file" && directoryPrefixes.has(path)) {
			throw new Error(`Workspace archive file conflicts with directory: ${path}`);
		}
	}
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
	const value = field.subarray(0, end === -1 ? field.length : end);
	if (!isUtf8(value)) throw new Error("Workspace artifact has invalid UTF-8 in a tar header");
	return value.toString("utf8");
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
