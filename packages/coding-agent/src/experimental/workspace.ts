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
	readonly serverLogPath: string;
	readonly serverIdFile: string;
	readonly bridgePath: string;
	readonly cliEntry: string;
	readonly markerPath: string;
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
		shareRoot,
		stateRoot,
		revisionDir,
		serverDir,
		sessionDir: `${stateRoot}/sessions`,
		npmCacheDir: `${stateRoot}/npm-cache`,
		serverPidFile: `${stateRoot}/server.pid`,
		serverLogPath: `${stateRoot}/server.log`,
		serverIdFile: `${serverDir}/default-server-id`,
		bridgePath: `${revisionDir}/scripts/workspace-ssh-bridge.mjs`,
		cliEntry: `${revisionDir}/packages/coding-agent/dist/bundle/cli.js`,
		markerPath: `${revisionDir}/.pi-workspace-staged`,
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
		const dirs = [paths.shareRoot, paths.stateRoot, paths.serverDir, paths.sessionDir, paths.npmCacheDir];
		const validated = dirs.map((path) => requireValidRemotePath(path, "state directory"));
		return `mkdir -p ${validated.join(" ")} && chmod 700 ${validated.join(" ")}`;
	},
	isStaged(paths: WorkspaceRemotePaths): string {
		return `test -f ${requireValidRemotePath(paths.markerPath, "staging marker")}`;
	},
	extractArchive(paths: WorkspaceRemotePaths): string {
		const target = requireValidRemotePath(paths.revisionDir, "staging directory");
		return `mkdir -p ${target} && tar -x -C ${target} && test -f ${target}/package.json`;
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
	hasSocket(socketPath: string): string {
		return `test -S ${requireValidRemotePath(socketPath, "server socket")}`;
	},
	startServer(options: {
		readonly paths: WorkspaceRemotePaths;
		readonly toolchain: WorkspaceRemoteToolchain;
		readonly remoteCwd: string;
		readonly serverId?: string;
		readonly pluginPackages: readonly string[];
	}): string {
		const cwd = requireValidRemotePath(options.remoteCwd, "remote working directory");
		const serverDir = requireValidRemotePath(options.paths.serverDir, "server directory");
		const sessionDir = requireValidRemotePath(options.paths.sessionDir, "session directory");
		const node = requireValidRemotePath(options.toolchain.nodePath, "node path");
		const cli = requireValidRemotePath(options.paths.cliEntry, "server entrypoint");
		const log = requireValidRemotePath(options.paths.serverLogPath, "server log");
		const pidFile = requireValidRemotePath(options.paths.serverPidFile, "server pid file");
		const serverId = options.serverId === undefined ? [] : ["--server-id", requireValidServerId(options.serverId)];
		const plugins = options.pluginPackages.map(
			(packagePath) => `-e ${requireValidRemotePath(packagePath, "plugin package")}`,
		);
		return (
			`cd ${cwd} && { nohup env PI_EXPERIMENTAL=1 PI_SERVER_DIR=${serverDir} ${node} ${cli} server` +
			` --session-dir ${sessionDir}${serverId.length > 0 ? ` ${serverId.join(" ")}` : ""}` +
			`${plugins.length > 0 ? ` ${plugins.join(" ")}` : ""}` +
			` >> ${log} 2>&1 < /dev/null & printf %s "$!" > ${pidFile}; }`
		);
	},
	stopServer(paths: WorkspaceRemotePaths): string {
		const pidFile = requireValidRemotePath(paths.serverPidFile, "server pid file");
		const revisionDir = requireValidRemotePath(paths.revisionDir, "staging directory");
		return (
			`pid=$(cat ${pidFile} 2>/dev/null || true)` +
			`; if [ -n "$pid" ] && tr "\\0" " " < /proc/$pid/cmdline 2>/dev/null | grep -qF ${revisionDir}` +
			`; then kill -TERM "$pid"; printf %s stopped; else printf %s absent; fi` +
			`; rm -f ${pidFile}`
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

async function startRemoteServer(
	host: string,
	paths: WorkspaceRemotePaths,
	toolchain: WorkspaceRemoteToolchain,
	remoteCwd: string,
	serverId: string | undefined,
	pluginPackages: readonly string[],
): Promise<void> {
	const start = await sshExec(
		host,
		remoteCommands.startServer({
			paths,
			toolchain,
			remoteCwd,
			...(serverId === undefined ? {} : { serverId }),
			pluginPackages,
		}),
		{ timeoutMs: SSH_EXEC_TIMEOUT_MS },
	);
	if (start.code !== 0) {
		throw new Error(`Failed to start the remote server: ${start.stderr.trim()}`);
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
		if (
			socket.code === 0 &&
			(await probeRemoteServer(
				{ serverId: existing, socketPath, bridgePath: paths.bridgePath, nodePath: toolchain.nodePath },
				host,
			))
		) {
			return existing;
		}
	}
	console.log("Starting the persistent Workspace server…");
	await startRemoteServer(host, paths, toolchain, remoteCwd, existing, pluginPackages);
	const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
	while (true) {
		const serverId = (await readRemoteServerId(host, paths)) ?? existing;
		if (serverId !== undefined) {
			const socketPath = serverSocketPath(paths, serverId);
			const socket = await sshExec(host, remoteCommands.hasSocket(socketPath));
			if (
				socket.code === 0 &&
				(await probeRemoteServer(
					{ serverId, socketPath, bridgePath: paths.bridgePath, nodePath: toolchain.nodePath },
					host,
				))
			) {
				return serverId;
			}
		}
		if (Date.now() >= deadline) {
			throw new Error(`Timed out waiting for the remote server; inspect ${paths.serverLogPath}`);
		}
		await new Promise<void>((resolve) => setTimeout(resolve, POLL_MS));
	}
}

/** Default split-plugin packages loaded by every MVP server generation. */
function defaultPluginPackages(paths: WorkspaceRemotePaths): readonly string[] {
	return [`${paths.revisionDir}/packages/coding-agent/examples/plugins/pi-example-plugin`];
}

function resolveSessionId(command: WorkspaceCommand, serverId: string): Promise<string> {
	if (command.sessionId !== undefined) return Promise.resolve(command.sessionId);
	if (command.newSession === true) return Promise.resolve(randomUUID());
	return readWorkspaceLocalState(command.sshHost, command.remoteCwd).then((state) => {
		if (state !== undefined && state.serverId === serverId) return state.sessionId;
		return randomUUID();
	});
}

/** Entry point for `pi workspace`: launch, status, cleanup, and purge flows. */
export async function runWorkspace(command: WorkspaceCommand): Promise<void> {
	const host = command.sshHost;
	if (!isValidSshHost(host)) throw new Error(`Invalid SSH host: ${JSON.stringify(host)}`);
	const remoteCwd = requireValidRemotePath(command.remoteCwd, "remote working directory");
	const repository = resolveLocalRepository();
	const toolchain = await resolveRemoteToolchain(host);
	const paths = buildWorkspaceRemotePaths(toolchain.home, repository.revision);
	const directories = await sshExec(host, remoteCommands.ensureDirectories(paths));
	if (directories.code !== 0) throw new Error("Failed to create the MVP state directories on the Workspace");

	if (command.status === true) {
		await reportWorkspaceStatus(host, command, repository, paths, toolchain);
		return;
	}
	if (command.cleanup === true || command.purge === true) {
		await cleanupWorkspace(host, paths, command.purge === true);
		return;
	}

	await stageRemoteRevision(host, paths, toolchain, repository);
	const serverId = await ensureRemoteServer(
		host,
		paths,
		toolchain,
		remoteCwd,
		command.pluginPackages ?? defaultPluginPackages(paths),
	);
	const sessionId = await resolveSessionId(command, serverId);
	await writeWorkspaceLocalState(host, remoteCwd, { revision: repository.revision, serverId, sessionId });

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
	command: WorkspaceCommand,
	repository: LocalRepository,
	paths: WorkspaceRemotePaths,
	toolchain: WorkspaceRemoteToolchain,
): Promise<void> {
	const staged = await sshExec(host, remoteCommands.isStaged(paths));
	console.log(`Host:            ${host}`);
	console.log(`Remote cwd:      ${command.remoteCwd}`);
	console.log(`Revision:        ${repository.revision} (${staged.code === 0 ? "staged" : "not staged"})`);
	console.log(`Remote Node:     ${toolchain.nodeVersion} (${toolchain.nodePath})`);
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
		console.log(`Server:          ${serverId} (${alive ? "reachable" : "stopped"})`);
	}
	const state = await readWorkspaceLocalState(host, command.remoteCwd);
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
