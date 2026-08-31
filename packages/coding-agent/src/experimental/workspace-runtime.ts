import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getPackageDir, isBunBinary } from "../config.ts";
import {
	inspectWorkspaceArchive,
	parseWorkspaceReleaseManifest,
	selectWorkspaceReleaseArtifact,
	verifyWorkspaceArtifact,
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
	return isBunBinary ? join(dirname(getPackageDir()), "share", "workspace-server") : undefined;
}

export async function readBundledWorkspaceServer(
	platform: string,
	root = defaultBundledWorkspaceServerRoot(),
): Promise<BundledWorkspaceServer | undefined> {
	if (root === undefined) return undefined;
	let rawManifest: string;
	let checksumFile: string;
	try {
		[rawManifest, checksumFile] = await Promise.all([
			readFile(join(root, "manifest.json"), "utf8"),
			readFile(join(root, "manifest.sha256"), "utf8"),
		]);
	} catch (error) {
		throw new Error(`Installed piw is missing its bundled Workspace server manifest under ${root}`, { cause: error });
	}
	const match = CHECKSUM_FILE_PATTERN.exec(checksumFile);
	if (match === null) throw new Error("Installed piw has an invalid Workspace server manifest checksum file");
	const manifestSha256 = match[1];
	if (manifestSha256 === undefined) throw new Error("Installed piw has no Workspace server manifest checksum");
	const manifest = parseWorkspaceReleaseManifest(rawManifest, manifestSha256);
	const artifact = selectWorkspaceReleaseArtifact(manifest, "server", platform);
	const archive = await readFile(join(root, artifact.file));
	verifyWorkspaceArtifact(archive, artifact);
	inspectWorkspaceArchive(archive);
	return { manifest, manifestSha256, artifact, archive };
}
