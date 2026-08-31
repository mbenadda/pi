import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@earendil-works/pi-client";
import { createSshTransportFactory, isValidRemoteCommandPart, isValidSshHost } from "@earendil-works/pi-client/ssh";
import { isServerId } from "@earendil-works/pi-protocol";
import type { WorkspaceCommand } from "../cli/experimental/commands/workspace.ts";
import { getPackageDir } from "../config.ts";
import { runClientTui } from "./client-tui.ts";
import {
	type BundledWorkspaceServer,
	defaultBundledWorkspaceServerRoot,
	readBundledWorkspaceServer,
} from "./workspace-runtime.ts";

/**
 * Pi Workspace client/server MVP.
 *
 * One laptop command stages the exact running Git revision on a Workspace over
 * OpenSSH, starts or discovers a persistent remote server under isolated
 * user-owned directories, and opens the local experimental TUI over a semantic
 * SSH byte transport. All model, tool, filesystem, and session state stays on
 * the Workspace; the laptop owns keyboard, editor, rendering, and scrolling.
 *
 * Every value interpolated into a remote command is validated against a
 * shell-metacharacter-free charset, and OpenSSH is spawned from argv, so no
 * untrusted value can be shell-interpolated.
 */

const MIN_REMOTE_NODE_VERSION = [22, 19, 0];
const SSH_EXEC_TIMEOUT_MS = 30_000;
const STAGE_BUILD_TIMEOUT_MS = 30 * 60_000;
const SERVER_START_TIMEOUT_MS = 180_000;
const SERVER_STOP_TIMEOUT_MS = 30_000;
const POLL_MS = 500;
const MAX_SSH_CAPTURE_BYTES = 1_000_000;
const REVISION_PATTERN = /^[0-9a-f]{40}$/u;

const SSH_ARGS = ["-o", "BatchMode=yes", "-o", "RequestTTY=no", "-o", "ClearAllForwardings=yes"] as const;

export interface WorkspaceRemotePaths {
	/** Exact Git revision represented by this path set. */
	readonly revision: string;
	/** Remote staging root for exact-revision Pi builds. */
	readonly shareRoot: string;
	/** Remote runtime state root owned by this MVP. */
	readonly stateRoot: string;
	/** Staged build for one exact revision. */
	readonly revisionDir: string;
	readonly serverDir: string;
	readonly sessionDir: string;
	readonly npmCacheDir: string;
	readonly serverPidFile: string;
	readonly serverRevisionFile: string;
	readonly serverLogPath: string;
	readonly serverIdFile: string;
	readonly bridgePath: string;
	readonly cliEntry: string;
	readonly markerPath: string;
	readonly standalone: boolean;
}

export interface WorkspaceRemoteToolchain {
	readonly home: string;
	readonly nodePath: string;
	readonly npmPath: string;
	readonly nodeVersion: string;
}

/** Validates an absolute remote path: POSIX separators, no traversal, shell-safe charset. */
export function requireValidRemotePath(value: string, label: string): string {
	if (!isValidRemoteCommandPart(value) || !value.startsWith("/") || value === "/") {
		throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
	}
	return value.endsWith("/") && value.length > 1 ? value.slice(0, -1) : value;
}

/** Builds every MVP-owned remote path from the remote home and the pinned revision. */
export function buildWorkspaceRemotePaths(home: string, revision: string): WorkspaceRemotePaths {
	const shareRoot = `${home}/.local/share/pi-workspace-mvp`;
	const stateRoot = `${home}/.local/state/pi-workspace-mvp`;
	const revisionDir = `${shareRoot}/${revision}`;
	const serverDir = `${stateRoot}/server`;
	return {
		revision,
		shareRoot,
		stateRoot,
		revisionDir,
		serverDir,
		sessionDir: `${stateRoot}/sessions`,
		npmCacheDir: `${stateRoot}/npm-cache`,
		serverPidFile: `${stateRoot}/server.pid`,
		serverRevisionFile: `${stateRoot}/server.revision`,
		serverLogPath: `${stateRoot}/server.log`,
		serverIdFile: `${serverDir}/default-server-id`,
		bridgePath: `${revisionDir}/scripts/workspace-ssh-bridge.mjs`,
		cliEntry: `${revisionDir}/packages/coding-agent/dist/bundle/cli.js`,
		markerPath: `${revisionDir}/.pi-workspace-staged`,
		standalone: false,
	};
}

/** Builds installed backend paths addressed by the verified artifact digest. */
export function buildInstalledWorkspaceRemotePaths(
	home: string,
	revision: string,
	artifactSha256: string,
): WorkspaceRemotePaths {
	if (!REVISION_PATTERN.test(revision)) throw new Error(`Invalid revision: ${JSON.stringify(revision)}`);
	if (!/^[0-9a-f]{64}$/u.test(artifactSha256)) {
		throw new Error(`Invalid artifact checksum: ${JSON.stringify(artifactSha256)}`);
	}
	const shareRoot = `${home}/.local/share/pi-workspace-server`;
	const stateRoot = `${home}/.local/state/pi-workspace-server`;
	const revisionDir = `${shareRoot}/releases/${artifactSha256}`;
	const serverDir = `${stateRoot}/server`;
	return {
		revision,
		shareRoot,
		stateRoot,
		revisionDir,
		serverDir,
		sessionDir: `${stateRoot}/sessions`,
		npmCacheDir: `${stateRoot}/npm-cache`,
		serverPidFile: `${stateRoot}/server.pid`,
		serverRevisionFile: `${stateRoot}/server.generation`,
		serverLogPath: `${stateRoot}/server.log`,
		serverIdFile: `${serverDir}/default-server-id`,
		bridgePath: "--workspace-ssh-bridge",
		cliEntry: `${revisionDir}/bin/pi-workspace-server`,
		markerPath: `${revisionDir}/install.json`,
		standalone: true,
	};
}

/** Unix-domain socket the coordinator exposes for one logical remote server. */
export function serverSocketPath(paths: WorkspaceRemotePaths, serverId: string): string {
	if (!isServerId(serverId)) throw new Error(`Invalid remote server identity: ${JSON.stringify(serverId)}`);
	return `${paths.serverDir}/${serverId}.sock`;
}

/** Builds the exact argv used to spawn OpenSSH for one remote command. */
export function buildSshCommand(host: string, remoteCommand: string): readonly string[] {
	if (!isValidSshHost(host)) throw new Error(`Invalid SSH host: ${JSON.stringify(host)}`);
	return ["ssh", ...SSH_ARGS, host, remoteCommand];
}

export interface SshExecResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

interface SshExecOptions {
	readonly timeoutMs?: number;
	readonly onStdout?: (chunk: string) => void;
	readonly onStderr?: (chunk: string) => void;
}

/** Runs one validated literal command on the Workspace host and returns its captured result. */
export async function sshExec(
	host: string,
	remoteCommand: string,
	options: SshExecOptions = {},
): Promise<SshExecResult> {
	const args = buildSshCommand(host, remoteCommand);
	const child = spawn(args[0]!, args.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		if (stdout.length < MAX_SSH_CAPTURE_BYTES) {
			stdout = (stdout + chunk).slice(0, MAX_SSH_CAPTURE_BYTES);
		}
		options.onStdout?.(chunk);
	});
	child.stderr.on("data", (chunk: string) => {
		if (stderr.length < MAX_SSH_CAPTURE_BYTES) {
			stderr = (stderr + chunk).slice(0, MAX_SSH_CAPTURE_BYTES);
		}
		options.onStderr?.(chunk);
	});
	const timer = setTimeout(() => {
		child.kill("SIGKILL");
	}, options.timeoutMs ?? SSH_EXEC_TIMEOUT_MS);
	timer.unref();
	const code = await new Promise<number>((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (exitCode) => resolve(exitCode ?? 0));
	});
	clearTimeout(timer);
	return { code, stdout, stderr };
}

export interface LocalRepository {
	readonly root: string;
	readonly revision: string;
}

/** Resolves the Git checkout running this process and its exact revision. */
export function resolveLocalRepository(): LocalRepository {
	let directory = getPackageDir();
	let root: string | undefined;
	for (let depth = 0; depth < 8 && directory !== dirname(directory); depth += 1) {
		const parent = dirname(directory);
		const probe = spawnSync("git", ["-C", directory, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
		if (probe.status === 0) {
			root = probe.stdout.trim();
			break;
		}
		directory = parent;
	}
	if (root === undefined) {
		throw new Error("pi workspace requires a Git checkout of Pi to stage the exact revision");
	}
	const revisionResult = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" });
	if (revisionResult.error !== undefined || revisionResult.status !== 0) {
		throw new Error(`Failed to resolve the local Pi revision in ${root}`);
	}
	const revision = revisionResult.stdout.trim();
	if (!REVISION_PATTERN.test(revision)) throw new Error(`Unexpected Git revision: ${revision}`);
	return { root, revision };
}

/** Remote command builders. Exported for tests: every interpolated value is path/host validated. */
export const remoteCommands = {
	probeHome: 'printf %s "$HOME"',
	probeDatadogRoot: 'test -n "$DATADOG_ROOT" && printf %s "$DATADOG_ROOT"',
	probePlatform:
		'case "$(uname -s):$(uname -m)" in Linux:x86_64) printf %s linux-x64;; Linux:aarch64|Linux:arm64) printf %s linux-arm64;; *) exit 1;; esac',
	probeNode(home: string): string {
		const candidates = [
			`${home}/.volta/bin/node`,
			`${home}/.local/bin/node`,
			"/usr/local/bin/node",
			"/usr/bin/node",
		].map((path) => requireValidRemotePath(path, "node candidate"));
		return `for p in ${candidates.join(" ")}; do if [ -x "$p" ]; then printf %s "$p"; exit 0; fi; done; exit 1`;
	},
	probeNpm(home: string): string {
		const candidates = [`${home}/.volta/bin/npm`, `${home}/.local/bin/npm`, "/usr/local/bin/npm", "/usr/bin/npm"].map(
			(path) => requireValidRemotePath(path, "npm candidate"),
		);
		return `for p in ${candidates.join(" ")}; do if [ -x "$p" ]; then printf %s "$p"; exit 0; fi; done; exit 1`;
	},
	nodeVersion(nodePath: string): string {
		return `${requireValidRemotePath(nodePath, "node path")} --version`;
	},
	ensureDirectories(paths: WorkspaceRemotePaths): string {
		const dirs = [
			paths.shareRoot,
			...(paths.standalone ? [`${paths.shareRoot}/releases`] : []),
			paths.stateRoot,
			paths.serverDir,
			paths.sessionDir,
			paths.npmCacheDir,
		];
		const validated = dirs.map((path) => requireValidRemotePath(path, "state directory"));
		return `mkdir -p ${validated.join(" ")} && chmod 700 ${validated.join(" ")}`;
	},
	isStaged(paths: WorkspaceRemotePaths): string {
		return `test -f ${requireValidRemotePath(paths.markerPath, "staging marker")}`;
	},
	isInstalled(paths: WorkspaceRemotePaths, artifactSha256: string): string {
		if (!paths.standalone || !/^[0-9a-f]{64}$/u.test(artifactSha256)) throw new Error("Invalid installed artifact");
		const marker = requireValidRemotePath(paths.markerPath, "install marker");
		const entrypoint = requireValidRemotePath(paths.cliEntry, "server entrypoint");
		const shareRoot = requireValidRemotePath(paths.shareRoot, "runtime root");
		return (
			`test -x ${entrypoint} && test "$(cat ${marker})" = ${artifactSha256}` +
			` && test "$(readlink ${shareRoot}/current)" = releases/${artifactSha256}`
		);
	},
	extractArchive(paths: WorkspaceRemotePaths): string {
		const target = requireValidRemotePath(paths.revisionDir, "staging directory");
		return `mkdir -p ${target} && tar -x -C ${target} && test -f ${target}/package.json`;
	},
	installArtifact(paths: WorkspaceRemotePaths, artifactSha256: string): string {
		if (!paths.standalone) throw new Error("Installed artifact paths are required");
		if (!/^[0-9a-f]{64}$/u.test(artifactSha256)) throw new Error("Invalid artifact checksum");
		const shareRoot = requireValidRemotePath(paths.shareRoot, "runtime root");
		const target = requireValidRemotePath(paths.revisionDir, "release directory");
		const entrypoint = requireValidRemotePath(paths.cliEntry, "server entrypoint");
		const marker = requireValidRemotePath(paths.markerPath, "install marker");
		const temporary = `${shareRoot}/.install-${artifactSha256}`;
		const next = `${shareRoot}/.current-${artifactSha256}`;
		return (
			`rm -rf ${temporary} ${next} && mkdir -p ${temporary} && chmod 700 ${temporary}` +
			` && tar -xz -C ${temporary} && test -x ${temporary}/bin/pi-workspace-server` +
			` && test -x ${temporary}/bin/esbuild` +
			` && printf %s ${artifactSha256} > ${temporary}/install.json && chmod 600 ${temporary}/install.json` +
			` && if [ -d ${target} ]; then test "$(cat ${marker})" = ${artifactSha256} && rm -rf ${temporary};` +
			` else mv ${temporary} ${target}; fi` +
			` && test -x ${entrypoint} && ln -s releases/${artifactSha256} ${next}` +
			` && mv -Tf ${next} ${shareRoot}/current`
		);
	},
	installAndBuild(paths: WorkspaceRemotePaths, toolchain: WorkspaceRemoteToolchain): string {
		const revisionDir = requireValidRemotePath(paths.revisionDir, "staging directory");
		const npm = requireValidRemotePath(toolchain.npmPath, "npm path");
		const cache = requireValidRemotePath(paths.npmCacheDir, "npm cache directory");
		return `cd ${revisionDir} && npm_config_cache=${cache} ${npm} ci --ignore-scripts --no-audit --no-fund && ${npm} run build`;
	},
	writeMarker(paths: WorkspaceRemotePaths, revision: string): string {
		if (!REVISION_PATTERN.test(revision)) throw new Error(`Invalid revision: ${JSON.stringify(revision)}`);
		const marker = requireValidRemotePath(paths.markerPath, "staging marker");
		return `printf %s ${revision} > ${marker} && chmod 600 ${marker}`;
	},
	readServerId(paths: WorkspaceRemotePaths): string {
		return `cat ${requireValidRemotePath(paths.serverIdFile, "server identity file")}`;
	},
	readServerRevision(paths: WorkspaceRemotePaths): string {
		return `cat ${requireValidRemotePath(paths.serverRevisionFile, "server revision file")}`;
	},
	hasSocket(socketPath: string): string {
		return `test -S ${requireValidRemotePath(socketPath, "server socket")}`;
	},
	startServer(options: {
		readonly paths: WorkspaceRemotePaths;
		readonly toolchain: WorkspaceRemoteToolchain;
		readonly remoteCwd: string;
		readonly serverId?: string;
		readonly pluginPackages: readonly string[];
		readonly generation: string;
	}): string {
		const cwd = requireValidRemotePath(options.remoteCwd, "remote working directory");
		const serverDir = requireValidRemotePath(options.paths.serverDir, "server directory");
		const sessionDir = requireValidRemotePath(options.paths.sessionDir, "session directory");
		const node = requireValidRemotePath(options.toolchain.nodePath, "node path");
		const cli = requireValidRemotePath(options.paths.cliEntry, "server entrypoint");
		const log = requireValidRemotePath(options.paths.serverLogPath, "server log");
		const pidFile = requireValidRemotePath(options.paths.serverPidFile, "server pid file");
		const revisionFile = requireValidRemotePath(options.paths.serverRevisionFile, "server revision file");
		const revision = options.paths.revision;
		if (!REVISION_PATTERN.test(revision)) throw new Error(`Invalid revision: ${JSON.stringify(revision)}`);
		if (!new RegExp(`^${revision}:[0-9a-f-]{36}$`, "u").test(options.generation)) {
			throw new Error(`Invalid server generation: ${JSON.stringify(options.generation)}`);
		}
		const serverId = options.serverId === undefined ? [] : ["--server-id", requireValidServerId(options.serverId)];
		const plugins = options.pluginPackages.map(
			(packagePath) => `-e ${requireValidRemotePath(packagePath, "plugin package")}`,
		);
		const runtime = options.paths.standalone ? cli : `${node} ${cli}`;
		const standaloneEnv = options.paths.standalone
			? ` ESBUILD_BINARY_PATH=${requireValidRemotePath(`${options.paths.revisionDir}/bin/esbuild`, "esbuild path")}`
			: "";
		return (
			`cd ${cwd} && { nohup env PI_EXPERIMENTAL=1 PI_SERVER_DIR=${serverDir}${standaloneEnv} ${runtime} server` +
			` --session-dir ${sessionDir}${serverId.length > 0 ? ` ${serverId.join(" ")}` : ""}` +
			`${plugins.length > 0 ? ` ${plugins.join(" ")}` : ""}` +
			` --ready-file ${revisionFile} --generation ${options.generation}` +
			` >> ${log} 2>&1 < /dev/null & printf %s "$!" > ${pidFile}; chmod 600 ${pidFile}; }`
		);
	},
	stopServer(paths: WorkspaceRemotePaths): string {
		const pidFile = requireValidRemotePath(paths.serverPidFile, "server pid file");
		const revisionFile = requireValidRemotePath(paths.serverRevisionFile, "server revision file");
		const shareRoot = requireValidRemotePath(paths.shareRoot, "staging root");
		return (
			`pid=$(cat ${pidFile} 2>/dev/null || true); cmd=$(tr "\\0" " " < /proc/$pid/cmdline 2>/dev/null || true)` +
			`; if [ -n "$pid" ] && printf %s "$cmd" | grep -qF ${shareRoot}/` +
			` && printf %s "$cmd" | grep -qF ${paths.standalone ? "/bin/pi-workspace-server\\ server" : "/packages/coding-agent/dist/bundle/cli.js\\ server"}` +
			`; then kill -TERM "$pid"; printf %s stopped; else printf %s absent; fi` +
			`; rm -f ${pidFile} ${revisionFile}`
		);
	},
	removeStaging(paths: WorkspaceRemotePaths): string {
		const revisionDir = requireValidRemotePath(paths.revisionDir, "staging directory");
		const marker = requireValidRemotePath(paths.markerPath, "staging marker");
		return `if [ -f ${marker} ]; then rm -rf ${revisionDir}; printf %s removed; else printf %s absent; fi`;
	},
};

function requireValidServerId(value: string): string {
	if (!isServerId(value)) throw new Error(`Invalid remote server identity: ${JSON.stringify(value)}`);
	return value;
}

function parseRemoteNodeVersion(version: string): number[] {
	const match = /^v(\d+)\.(\d+)\.(\d+)/u.exec(version.trim());
	if (!match) throw new Error(`Unexpected remote Node version: ${version}`);
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function versionAtLeast(version: number[], minimum: readonly number[]): boolean {
	for (let index = 0; index < minimum.length; index += 1) {
		const actual = version[index] ?? 0;
		if (actual !== minimum[index]) return actual > minimum[index];
	}
	return true;
}

/** Discovers the remote toolchain and validates the Node version this build requires. */
export async function resolveRemoteToolchain(host: string): Promise<WorkspaceRemoteToolchain> {
	const homeResult = await sshExec(host, remoteCommands.probeHome);
	if (homeResult.code !== 0) throw new Error("Failed to read the remote home directory");
	const home = requireValidRemotePath(homeResult.stdout, "remote home");
	const nodeResult = await sshExec(host, remoteCommands.probeNode(home));
	if (nodeResult.code !== 0) throw new Error("No remote Node executable found; the Workspace must provide Node");
	const nodePath = requireValidRemotePath(nodeResult.stdout, "remote node path");
	const npmResult = await sshExec(host, remoteCommands.probeNpm(home));
	if (npmResult.code !== 0) throw new Error("No remote npm executable found; the Workspace must provide npm");
	const npmPath = requireValidRemotePath(npmResult.stdout, "remote npm path");
	const versionResult = await sshExec(host, remoteCommands.nodeVersion(nodePath));
	if (versionResult.code !== 0) throw new Error("Failed to read the remote Node version");
	const nodeVersion = versionResult.stdout.trim();
	if (!versionAtLeast(parseRemoteNodeVersion(nodeVersion), MIN_REMOTE_NODE_VERSION)) {
		throw new Error(`Remote Node ${nodeVersion} is older than the required v22.19.0`);
	}
	return { home, nodePath, npmPath, nodeVersion };
}

/** Ensures the exact local revision is staged remotely; returns whether staging ran. */
export async function stageRemoteRevision(
	host: string,
	paths: WorkspaceRemotePaths,
	toolchain: WorkspaceRemoteToolchain,
	repository: LocalRepository,
): Promise<boolean> {
	const staged = await sshExec(host, remoteCommands.isStaged(paths));
	if (staged.code === 0) return false;
	console.log(`Staging revision ${repository.revision} on ${host} (first run; this installs and builds)…`);
	const archive = spawn("git", ["-C", repository.root, "archive", "--format=tar", repository.revision], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	const extract = spawn("ssh", [...SSH_ARGS, host, remoteCommands.extractArchive(paths)], {
		stdio: ["pipe", "pipe", "pipe"],
	});
	let archiveStderr = "";
	let extractStderr = "";
	archive.stderr.setEncoding("utf8");
	archive.stderr.on("data", (chunk: string) => {
		archiveStderr += chunk;
	});
	extract.stderr.setEncoding("utf8");
	extract.stderr.on("data", (chunk: string) => {
		extractStderr += chunk;
	});
	archive.stdout.pipe(extract.stdin);
	const archiveCode = new Promise<number>((resolve, reject) => {
		archive.once("error", reject);
		archive.once("exit", (code) => resolve(code ?? 0));
	});
	const extractCode = new Promise<number>((resolve, reject) => {
		extract.once("error", reject);
		extract.once("exit", (code) => resolve(code ?? 0));
	});
	const [archiveExit, extractExit] = await Promise.all([archiveCode, extractCode]);
	if (archiveExit !== 0) throw new Error(`git archive failed: ${archiveStderr.trim()}`);
	if (extractExit !== 0) throw new Error(`Remote archive extraction failed: ${extractStderr.trim()}`);
	const build = await sshExec(host, remoteCommands.installAndBuild(paths, toolchain), {
		timeoutMs: STAGE_BUILD_TIMEOUT_MS,
		onStderr: (chunk) => process.stderr.write(chunk),
	});
	if (build.code !== 0) {
		throw new Error(`Remote install/build failed (exit ${build.code}): ${build.stderr.trim().slice(0, 4000)}`);
	}
	const marker = await sshExec(host, remoteCommands.writeMarker(paths, repository.revision));
	if (marker.code !== 0) throw new Error("Failed to record the staging marker");
	console.log(`Staged ${repository.revision} at ${paths.revisionDir}`);
	return true;
}

/** Streams a verified standalone backend and atomically activates its content-addressed release. */
export async function installRemoteWorkspaceArtifact(
	host: string,
	paths: WorkspaceRemotePaths,
	bundle: BundledWorkspaceServer,
): Promise<boolean> {
	const installed = await sshExec(host, remoteCommands.isInstalled(paths, bundle.artifact.sha256));
	if (installed.code === 0) return false;
	console.log(`Installing Workspace backend ${bundle.manifest.revision} on ${host}…`);
	const command = buildSshCommand(host, remoteCommands.installArtifact(paths, bundle.artifact.sha256));
	const child = spawn(command[0]!, command.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => {
		stderr = (stderr + chunk).slice(-MAX_SSH_CAPTURE_BYTES);
	});
	child.stdin.end(bundle.archive);
	const code = await new Promise<number>((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (exitCode) => resolve(exitCode ?? 0));
	});
	if (code !== 0) throw new Error(`Remote Workspace backend install failed: ${stderr.trim()}`);
	const verified = await sshExec(host, remoteCommands.isInstalled(paths, bundle.artifact.sha256));
	if (verified.code !== 0) throw new Error("Remote Workspace backend install did not activate the exact artifact");
	return true;
}

/** Connects one protocol client over the SSH byte bridge; used to probe server liveness. */
export async function probeRemoteServer(
	connection: {
		readonly serverId: string;
		readonly socketPath: string;
		readonly bridgePath: string;
		readonly nodePath: string;
	},
	host: string,
): Promise<boolean> {
	const client = new Client({
		serverId: requireValidServerId(connection.serverId),
		transportFactory: createSshTransportFactory({
			host,
			remoteCommand: [connection.nodePath, connection.bridgePath, connection.socketPath],
		}),
	});
	try {
		await client.connect();
		return true;
	} catch {
		return false;
	} finally {
		await client.dispose().catch(() => {});
	}
}

export interface WorkspaceLocalState {
	readonly revision: string;
	readonly serverId: string;
	readonly sessionId: string;
}

/** Local state directory override used by tests; defaults to the laptop home. */
export function workspaceLocalStateRoot(): string {
	return join(homedir(), ".local", "state", "pi-workspace-mvp");
}

function localStatePath(root: string, host: string, remoteCwd: string): string {
	const cwdKey = createHash("sha256").update(remoteCwd).digest("hex").slice(0, 16);
	return join(root, host, `${cwdKey}.json`);
}

export async function readWorkspaceLocalState(
	host: string,
	remoteCwd: string,
	options: { readonly root?: string } = {},
): Promise<WorkspaceLocalState | undefined> {
	const path = localStatePath(options.root ?? workspaceLocalStateRoot(), host, remoteCwd);
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		!("revision" in parsed) ||
		!("serverId" in parsed) ||
		!("sessionId" in parsed) ||
		typeof parsed.revision !== "string" ||
		typeof parsed.serverId !== "string" ||
		typeof parsed.sessionId !== "string"
	) {
		return undefined;
	}
	return { revision: parsed.revision, serverId: parsed.serverId, sessionId: parsed.sessionId };
}

export async function writeWorkspaceLocalState(
	host: string,
	remoteCwd: string,
	state: WorkspaceLocalState,
	options: { readonly root?: string } = {},
): Promise<void> {
	const path = localStatePath(options.root ?? workspaceLocalStateRoot(), host, remoteCwd);
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	await chmod(dirname(path), 0o700);
	await writeFile(path, `${JSON.stringify(state, null, "\t")}\n`, { encoding: "utf8", mode: 0o600 });
}

/** Reads the logical remote server identity if the MVP has created one before. */
async function readRemoteServerId(host: string, paths: WorkspaceRemotePaths): Promise<string | undefined> {
	const identity = await sshExec(host, remoteCommands.readServerId(paths));
	if (identity.code !== 0) return undefined;
	const serverId = identity.stdout.trim();
	if (serverId.length === 0) return undefined;
	return requireValidServerId(serverId);
}

async function readRemoteServerGeneration(host: string, paths: WorkspaceRemotePaths): Promise<string | undefined> {
	const result = await sshExec(host, remoteCommands.readServerRevision(paths));
	if (result.code !== 0) return undefined;
	const generation = result.stdout.trim();
	return new RegExp(`^${paths.revision}:[0-9a-f-]{36}$`, "u").test(generation) ? generation : undefined;
}

async function startRemoteServer(
	host: string,
	paths: WorkspaceRemotePaths,
	toolchain: WorkspaceRemoteToolchain,
	remoteCwd: string,
	serverId: string | undefined,
	pluginPackages: readonly string[],
	generation: string,
): Promise<void> {
	const start = await sshExec(
		host,
		remoteCommands.startServer({
			paths,
			toolchain,
			remoteCwd,
			...(serverId === undefined ? {} : { serverId }),
			pluginPackages,
			generation,
		}),
		{ timeoutMs: SSH_EXEC_TIMEOUT_MS },
	);
	if (start.code !== 0) {
		throw new Error(`Failed to start the remote server: ${start.stderr.trim()}`);
	}
}

export interface WorkspaceGenerationOperations {
	readServerId(): Promise<string | undefined>;
	readGeneration(): Promise<string | undefined>;
	hasSocket(serverId: string): Promise<boolean>;
	probe(serverId: string): Promise<boolean>;
	now?(): number;
	sleep?(delayMs: number): Promise<void>;
}

/** Wait until the exact started generation owns the public route before the first real attach. */
export async function waitForWorkspaceGeneration(
	expectedGeneration: string,
	timeoutMs: number,
	operations: WorkspaceGenerationOperations,
): Promise<string> {
	const now = operations.now ?? Date.now;
	const sleep =
		operations.sleep ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
	const deadline = now() + timeoutMs;
	while (true) {
		const serverId = await operations.readServerId();
		const generation = await operations.readGeneration();
		if (
			serverId !== undefined &&
			generation === expectedGeneration &&
			(await operations.hasSocket(serverId)) &&
			(await operations.probe(serverId))
		) {
			return serverId;
		}
		if (now() >= deadline) throw new Error("Timed out waiting for the exact Workspace server generation");
		await sleep(POLL_MS);
	}
}

/** Ensures the persistent server is reachable; starts (or restarts) it when it is not. */
async function ensureRemoteServer(
	host: string,
	paths: WorkspaceRemotePaths,
	toolchain: WorkspaceRemoteToolchain,
	remoteCwd: string,
	pluginPackages: readonly string[],
): Promise<string> {
	const existing = await readRemoteServerId(host, paths);
	if (existing !== undefined) {
		const socketPath = serverSocketPath(paths, existing);
		const socket = await sshExec(host, remoteCommands.hasSocket(socketPath));
		const runningGeneration = await readRemoteServerGeneration(host, paths);
		if (
			runningGeneration !== undefined &&
			socket.code === 0 &&
			(await probeRemoteServer(
				{ serverId: existing, socketPath, bridgePath: paths.bridgePath, nodePath: toolchain.nodePath },
				host,
			))
		) {
			return existing;
		}
		if (runningGeneration === undefined) {
			console.log(`Replacing stale Workspace server with revision ${paths.revision}…`);
			const stopped = await sshExec(host, remoteCommands.stopServer(paths));
			if (!stopped.stdout.includes("stopped") && !stopped.stdout.includes("absent")) {
				throw new Error("Refused to stop the previous Pi Workspace server revision");
			}
			if (stopped.stdout.includes("stopped")) {
				const deadline = Date.now() + SERVER_STOP_TIMEOUT_MS;
				while (Date.now() < deadline) {
					if ((await sshExec(host, remoteCommands.hasSocket(socketPath))).code !== 0) break;
					await new Promise<void>((resolve) => setTimeout(resolve, POLL_MS));
				}
			}
		}
	}
	console.log("Starting the persistent Workspace server…");
	const generation = `${paths.revision}:${randomUUID()}`;
	await startRemoteServer(host, paths, toolchain, remoteCwd, existing, pluginPackages, generation);
	try {
		return await waitForWorkspaceGeneration(generation, SERVER_START_TIMEOUT_MS, {
			readServerId: async () => (await readRemoteServerId(host, paths)) ?? existing,
			readGeneration: () => readRemoteServerGeneration(host, paths),
			hasSocket: async (serverId) =>
				(await sshExec(host, remoteCommands.hasSocket(serverSocketPath(paths, serverId)))).code === 0,
			probe: (serverId) =>
				probeRemoteServer(
					{
						serverId,
						socketPath: serverSocketPath(paths, serverId),
						bridgePath: paths.bridgePath,
						nodePath: toolchain.nodePath,
					},
					host,
				),
		});
	} catch (error) {
		throw new Error(`Timed out waiting for the remote server; inspect ${paths.serverLogPath}`, { cause: error });
	}
}

/** Default split-plugin packages loaded by every MVP server generation. */
function defaultPluginPackages(paths: WorkspaceRemotePaths): readonly string[] {
	return [
		paths.standalone
			? `${paths.revisionDir}/plugins/pi-example-plugin`
			: `${paths.revisionDir}/packages/coding-agent/examples/plugins/pi-example-plugin`,
	];
}

function resolveSessionId(command: WorkspaceCommand, serverId: string, remoteCwd: string): Promise<string> {
	if (command.sessionId !== undefined) return Promise.resolve(command.sessionId);
	if (command.newSession === true) return Promise.resolve(randomUUID());
	return readWorkspaceLocalState(command.sshHost, remoteCwd).then((state) => {
		if (state !== undefined && state.serverId === serverId) return state.sessionId;
		return randomUUID();
	});
}

/** Entry point for `pi workspace`: launch, status, cleanup, and purge flows. */
export async function runWorkspace(command: WorkspaceCommand): Promise<void> {
	const host = command.sshHost;
	if (!isValidSshHost(host)) throw new Error(`Invalid SSH host: ${JSON.stringify(host)}`);
	let repository: LocalRepository | undefined;
	let bundle: BundledWorkspaceServer | undefined;
	let paths: WorkspaceRemotePaths;
	let toolchain: WorkspaceRemoteToolchain;
	const bundledRoot = defaultBundledWorkspaceServerRoot();
	if (bundledRoot === undefined) {
		repository = resolveLocalRepository();
		toolchain = await resolveRemoteToolchain(host);
		paths = buildWorkspaceRemotePaths(toolchain.home, repository.revision);
	} else {
		const [homeResult, platformResult] = await Promise.all([
			sshExec(host, remoteCommands.probeHome),
			sshExec(host, remoteCommands.probePlatform),
		]);
		if (homeResult.code !== 0) throw new Error("Failed to read the remote home directory");
		if (platformResult.code !== 0) throw new Error("Workspace platform is not supported by this piw release");
		const home = requireValidRemotePath(homeResult.stdout, "remote home");
		bundle = await readBundledWorkspaceServer(platformResult.stdout.trim(), bundledRoot);
		if (bundle === undefined) throw new Error("Installed piw has no bundled Workspace server artifact");
		paths = buildInstalledWorkspaceRemotePaths(home, bundle.manifest.revision, bundle.artifact.sha256);
		toolchain = {
			home,
			nodePath: paths.cliEntry,
			npmPath: paths.cliEntry,
			nodeVersion: `standalone ${bundle.manifest.revision}`,
		};
	}
	let remoteCwd: string;
	if (command.remoteCwd === undefined) {
		const inferred = await sshExec(host, remoteCommands.probeDatadogRoot);
		if (inferred.code !== 0 || inferred.stdout.length === 0) {
			throw new Error("Remote DATADOG_ROOT is unset; pass --cwd with an absolute remote path");
		}
		remoteCwd = requireValidRemotePath(inferred.stdout, "remote DATADOG_ROOT");
	} else {
		remoteCwd = requireValidRemotePath(command.remoteCwd, "remote working directory");
	}
	const directories = await sshExec(host, remoteCommands.ensureDirectories(paths));
	if (directories.code !== 0) throw new Error("Failed to create private Pi Workspace state directories");

	if (command.status === true) {
		await reportWorkspaceStatus(host, remoteCwd, paths.revision, paths, toolchain);
		return;
	}
	if (command.cleanup === true || command.purge === true) {
		await cleanupWorkspace(host, paths, command.purge === true);
		return;
	}
	if (bundle === undefined) {
		if (repository === undefined) throw new Error("Workspace source staging has no local repository");
		await stageRemoteRevision(host, paths, toolchain, repository);
	} else {
		await installRemoteWorkspaceArtifact(host, paths, bundle);
		if (command.update === true) {
			console.log(`Workspace backend is pinned to ${bundle.manifest.revision} (${bundle.artifact.sha256}).`);
			return;
		}
	}
	const serverId = await ensureRemoteServer(
		host,
		paths,
		toolchain,
		remoteCwd,
		command.pluginPackages ?? defaultPluginPackages(paths),
	);
	const sessionId = await resolveSessionId(command, serverId, remoteCwd);
	await writeWorkspaceLocalState(host, remoteCwd, { revision: paths.revision, serverId, sessionId });

	console.log(`Workspace ${host}: server ${serverId}, session ${sessionId}`);
	await runClientTui({
		command: "client",
		connect: {
			transport: "ssh",
			host,
			serverId,
			path: serverSocketPath(paths, serverId),
			bridgePath: paths.bridgePath,
			nodePath: toolchain.nodePath,
		},
		sessionId,
	});
}

async function reportWorkspaceStatus(
	host: string,
	remoteCwd: string,
	revision: string,
	paths: WorkspaceRemotePaths,
	toolchain: WorkspaceRemoteToolchain,
): Promise<void> {
	const staged = await sshExec(host, remoteCommands.isStaged(paths));
	console.log(`Host:            ${host}`);
	console.log(`Remote cwd:      ${remoteCwd}`);
	console.log(`Revision:        ${revision} (${staged.code === 0 ? "installed" : "not installed"})`);
	console.log(`Remote runtime:  ${toolchain.nodeVersion} (${toolchain.nodePath})`);
	console.log(`State root:      ${paths.stateRoot}`);
	console.log(`Staging root:    ${paths.shareRoot}`);
	const serverId = await readRemoteServerId(host, paths);
	if (serverId === undefined) {
		console.log("Server:          none");
	} else {
		const socketPath = serverSocketPath(paths, serverId);
		const socket = await sshExec(host, remoteCommands.hasSocket(socketPath));
		const alive =
			socket.code === 0 &&
			(await probeRemoteServer(
				{ serverId, socketPath, bridgePath: paths.bridgePath, nodePath: toolchain.nodePath },
				host,
			));
		const runningGeneration = await readRemoteServerGeneration(host, paths);
		console.log(
			`Server:          ${serverId} (${alive ? "reachable" : "stopped"}; generation ${runningGeneration ?? "unknown"})`,
		);
	}
	const state = await readWorkspaceLocalState(host, remoteCwd);
	console.log(`Local session:   ${state === undefined ? "none" : state.sessionId}`);
}

async function cleanupWorkspace(host: string, paths: WorkspaceRemotePaths, purge: boolean): Promise<void> {
	const stop = await sshExec(host, remoteCommands.stopServer(paths));
	if (stop.stdout.includes("stopped")) {
		console.log("Stopped the MVP Workspace server. Remote sessions remain durable for reconnect.");
	} else {
		console.log("No MVP Workspace server process found (already clean).");
	}
	const serverId = await readRemoteServerId(host, paths);
	if (serverId !== undefined) {
		const socketPath = serverSocketPath(paths, serverId);
		const deadline = Date.now() + SERVER_STOP_TIMEOUT_MS;
		while (Date.now() < deadline) {
			const socket = await sshExec(host, remoteCommands.hasSocket(socketPath));
			if (socket.code !== 0) break;
			await new Promise<void>((resolve) => setTimeout(resolve, POLL_MS));
		}
	}
	if (purge) {
		const removed = await sshExec(host, remoteCommands.removeStaging(paths));
		console.log(removed.stdout.includes("removed") ? `Removed staging ${paths.revisionDir}` : "No staging to purge.");
	}
}
