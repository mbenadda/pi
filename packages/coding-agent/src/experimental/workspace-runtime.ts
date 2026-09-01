import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { getPackageDir, isBunBinary } from "../config.ts";
import {
	parseWorkspaceArtifactIdentity,
	parseWorkspaceReleaseManifest,
	selectWorkspaceReleaseArtifact,
	verifyWorkspaceArtifactContents,
	type WorkspaceReleaseArtifact,
	type WorkspaceReleaseManifest,
} from "./workspace-install.ts";

const CHECKSUM_FILE_PATTERN = /^([0-9a-f]{64}) {2}manifest\.json\n$/u;

export interface BundledWorkspaceServer {
	readonly manifest: WorkspaceReleaseManifest;
	readonly manifestSha256: string;
	readonly artifact: WorkspaceReleaseArtifact;
	readonly archive: Buffer;
}

export function defaultBundledWorkspaceServerRoot(): string | undefined {
	return isBunBinary && basename(process.execPath) === "piw"
		? join(dirname(getPackageDir()), "share", "workspace-server")
		: undefined;
}

export async function readBundledWorkspaceServer(
	platform: string,
	root = defaultBundledWorkspaceServerRoot(),
): Promise<BundledWorkspaceServer | undefined> {
	if (root === undefined) return undefined;
	let rawManifest: string;
	let checksumFile: string;
	let rawIdentity: string;
	try {
		[rawManifest, checksumFile, rawIdentity] = await Promise.all([
			readFile(join(root, "manifest.json"), "utf8"),
			readFile(join(root, "manifest.sha256"), "utf8"),
			readFile(join(dirname(dirname(root)), ".pi-workspace-artifact.json"), "utf8"),
		]);
	} catch (error) {
		throw new Error(`Installed piw is missing its bundled Workspace server manifest under ${root}`, { cause: error });
	}
	const identity = parseWorkspaceArtifactIdentity(rawIdentity);
	if (identity.role !== "client" || identity.bundledManifestSha256 === undefined) {
		throw new Error("Installed piw identity does not pin its bundled Workspace server manifest");
	}
	const match = CHECKSUM_FILE_PATTERN.exec(checksumFile);
	if (match === null) throw new Error("Installed piw has an invalid Workspace server manifest checksum file");
	const manifestSha256 = match[1];
	if (manifestSha256 === undefined || manifestSha256 !== identity.bundledManifestSha256) {
		throw new Error("Installed piw Workspace server manifest checksum is not the independently pinned checksum");
	}
	const manifest = parseWorkspaceReleaseManifest(rawManifest, identity.bundledManifestSha256);
	if (manifest.revision !== identity.revision) {
		throw new Error("Installed piw and bundled Workspace server revisions do not match");
	}
	const artifact = selectWorkspaceReleaseArtifact(manifest, "server", platform);
	const archive = await readFile(join(root, artifact.file));
	verifyWorkspaceArtifactContents(archive, manifest, artifact);
	return { manifest, manifestSha256, artifact, archive };
}
