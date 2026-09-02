import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Client } from "@earendil-works/pi-client";
import { createSshTransportFactory, isValidRemoteCommandPart, isValidSshHost } from "@earendil-works/pi-client/ssh";
import { isServerId } from "@earendil-works/pi-protocol";
import type { WorkspaceCommand } from "../cli/experimental/commands/workspace.ts";
import { getPackageDir } from "../config.ts";
import { runClientTui } from "./client-tui.ts";
import {
	buildDdtoolAuthProbeCommand,
	buildDdtoolDeviceLoginCommand,
	classifyDdtoolAuthProbe,
	createDdtoolLoginDisplay,
	DDTOOL_AUTH_PROBE_TIMEOUT_MS,
	DDTOOL_DEVICE_LOGIN_TIMEOUT_MS,
	type DdtoolAuthProbeResult,
	type DdtoolDeviceLoginDisplay,
	type DdtoolDeviceLoginOperations,
	type DdtoolDeviceLoginProcess,
	manualDdtoolLoginCommand,
	openDdtoolLoginUrl,
	orchestrateDdtoolDeviceLogin,
	WorkspaceAuthError,
	WorkspaceUntrustedDeviceLoginUrlError,
} from "./workspace-auth.ts";
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
export const SSH_EXEC_TIMEOUT_MS = 30_000;
export const REMOTE_INSTALL_CHECK_WORK_TIMEOUT_MS = 5 * 60_000;
export const REMOTE_ARTIFACT_INSTALL_WORK_TIMEOUT_MS = 10 * 60_000;
export const REMOTE_INSTALL_LOCK_WAIT_MS = REMOTE_ARTIFACT_INSTALL_WORK_TIMEOUT_MS + 60_000;
export const REMOTE_INSTALL_CHECK_TIMEOUT_MS = REMOTE_INSTALL_LOCK_WAIT_MS + REMOTE_INSTALL_CHECK_WORK_TIMEOUT_MS;
export const REMOTE_ARTIFACT_INSTALL_TIMEOUT_MS = REMOTE_INSTALL_LOCK_WAIT_MS + REMOTE_ARTIFACT_INSTALL_WORK_TIMEOUT_MS;
export const REMOTE_INSTALL_LOCK_HARD_STALE_MS = REMOTE_ARTIFACT_INSTALL_TIMEOUT_MS + 60_000;
const REMOTE_INSTALL_LOCK_STALE_SECONDS = 300;
const REMOTE_INSTALL_LOCK_HARD_STALE_SECONDS = REMOTE_INSTALL_LOCK_HARD_STALE_MS / 1_000;
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
	manifestSha256: string,
	artifactSha256: string,
): WorkspaceRemotePaths {
	if (!REVISION_PATTERN.test(revision)) throw new Error(`Invalid revision: ${JSON.stringify(revision)}`);
	if (!/^[0-9a-f]{64}$/u.test(manifestSha256)) {
		throw new Error(`Invalid manifest checksum: ${JSON.stringify(manifestSha256)}`);
	}
	if (!/^[0-9a-f]{64}$/u.test(artifactSha256)) {
		throw new Error(`Invalid artifact checksum: ${JSON.stringify(artifactSha256)}`);
	}
	const shareRoot = `${home}/.local/share/pi-workspace-server`;
	const stateRoot = `${home}/.local/state/pi-workspace-server`;
	const releaseName = `${manifestSha256}-${artifactSha256}`;
	const revisionDir = `${shareRoot}/releases/${releaseName}`;
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
		bridgePath: `${revisionDir}/bin/pi-workspace-server`,
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

export class SshCommandTimeoutError extends Error {
	readonly host: string;
	readonly timeoutMs: number;

	constructor(host: string, timeoutMs: number, operation = "SSH command") {
		super(`${operation} timed out after ${timeoutMs}ms and was killed: ${host}`);
		this.name = "SshCommandTimeoutError";
		this.host = host;
		this.timeoutMs = timeoutMs;
	}
}

export class SshCommandSignalError extends Error {
	readonly host: string;
	readonly signal: NodeJS.Signals | null;

	constructor(host: string, signal: NodeJS.Signals | null, operation = "SSH command") {
		super(`${operation} to ${host} was terminated by signal ${signal ?? "unknown"}`);
		this.name = "SshCommandSignalError";
		this.host = host;
		this.signal = signal;
	}
}

function isSshPollingInterruption(error: unknown): error is SshCommandTimeoutError | SshCommandSignalError {
	return error instanceof SshCommandTimeoutError || error instanceof SshCommandSignalError;
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
	const timeoutMs = options.timeoutMs ?? SSH_EXEC_TIMEOUT_MS;
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		child.kill("SIGKILL");
	}, timeoutMs);
	timer.unref();
	let outcome: { readonly code: number | null; readonly signal: NodeJS.Signals | null };
	try {
		outcome = await new Promise((resolve, reject) => {
			child.once("error", reject);
			child.once("exit", (code, signal) => resolve({ code, signal }));
		});
	} finally {
		clearTimeout(timer);
	}
	if (timedOut) throw new SshCommandTimeoutError(host, timeoutMs);
	if (outcome.code === null) throw new SshCommandSignalError(host, outcome.signal);
	return { code: outcome.code, stdout, stderr };
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

function remoteInstallTransactionShell(shareRoot: string): string {
	const lock = `${shareRoot}/.install-transaction-lock`;
	const waitSeconds = REMOTE_INSTALL_LOCK_WAIT_MS / 1_000;
	return (
		`require_install_tools() { for piw_tool in stat date find sha256sum sort xargs cmp readlink mv tar mkdir chmod rm cp ln touch sleep id cut cat; do` +
		` command -v "$piw_tool" >/dev/null 2>&1 || { printf 'piw: required remote install tool missing: %s\\n' "$piw_tool" >&2; return 1; }; done;` +
		` stat -c %u ${shareRoot} >/dev/null 2>&1 || { printf 'piw: remote install requires GNU-compatible stat\\n' >&2; return 1; };` +
		` test -r /proc/self/stat && test -r /proc/sys/kernel/random/uuid` +
		` || { printf 'piw: remote install requires Linux procfs process identity and random UUID support\\n' >&2; return 1; }; };` +
		` read_process_start_time() { case "$1" in ''|*[!0-9]*) return 1;; esac;` +
		` piw_proc_stat=$(cat /proc/$1/stat 2>/dev/null) || return 1; piw_proc_fields=\${piw_proc_stat##*) };` +
		` test "$piw_proc_fields" != "$piw_proc_stat" || return 1; piw_proc_index=1;` +
		` while [ "$piw_proc_index" -lt 20 ]; do case "$piw_proc_fields" in *" "*)` +
		` piw_proc_field=\${piw_proc_fields%% *}; piw_proc_fields=\${piw_proc_fields#* };; *) return 1;; esac;` +
		` test -n "$piw_proc_field" || return 1; piw_proc_index=$((piw_proc_index+1)); done;` +
		` piw_proc_start=\${piw_proc_fields%% *}; case "$piw_proc_start" in ''|*[!0-9]*) return 1;; esac;` +
		` printf %s "$piw_proc_start"; };` +
		` parse_install_lock_owner() { piw_parsed_pid=\${1%%:*}; piw_owner_rest=\${1#*:};` +
		` test "$piw_owner_rest" != "$1" || return 1; piw_parsed_start=\${piw_owner_rest%%:*}; piw_owner_rest=\${piw_owner_rest#*:};` +
		` piw_parsed_token=\${piw_owner_rest%%:*}; piw_parsed_created=\${piw_owner_rest#*:};` +
		` test "$piw_parsed_created" != "$piw_owner_rest" || return 1;` +
		` case "$piw_parsed_pid" in ''|*[!0-9]*) return 1;; esac; case "$piw_parsed_start" in ''|*[!0-9]*) return 1;; esac;` +
		` case "$piw_parsed_created" in ''|*[!0-9]*) return 1;; esac;` +
		` case "$piw_parsed_token" in ''|*[!0-9a-f-]*) return 1;; esac; };` +
		` retry_install_lock() {` +
		` if [ "$piw_lock_attempt" -ge ${waitSeconds} ]; then` +
		` printf 'piw: timed out waiting for remote install lock ${lock} after ${waitSeconds}s\\n' >&2; return 1; fi;` +
		` piw_lock_attempt=$((piw_lock_attempt+1)); sleep 1 || return 1; };` +
		` validate_install_lock_owner() {` +
		` test -d ${lock} && test ! -L ${lock}` +
		` && test "$(stat -c %u ${lock} 2>/dev/null)" = "$(id -u)"` +
		` && test -f ${lock}/owner && test ! -L ${lock}/owner` +
		` && test "$(stat -c %u ${lock}/owner 2>/dev/null)" = "$(id -u)"` +
		` && piw_validated_owner=$(cat ${lock}/owner 2>/dev/null)` +
		` && test "$piw_validated_owner" = "$piw_lock_owner"` +
		` && parse_install_lock_owner "$piw_validated_owner"` +
		` && test "$piw_parsed_pid:$piw_parsed_start:$piw_parsed_token:$piw_parsed_created" =` +
		` "$piw_lock_pid:$piw_lock_start:$piw_lock_token:$piw_lock_created"` +
		` && test "$(read_process_start_time "$piw_lock_pid")" = "$piw_lock_start"` +
		` && kill -0 "$piw_lock_pid" 2>/dev/null; };` +
		` acquire_install_lock() { piw_lock_attempt=0; while :; do` +
		` if (umask 077; mkdir ${lock}) 2>/dev/null; then` +
		` piw_lock_pid=$$; piw_lock_start=$(read_process_start_time "$piw_lock_pid")` +
		` && piw_lock_token=$(cat /proc/sys/kernel/random/uuid) && piw_lock_created=$(date +%s)` +
		` && parse_install_lock_owner "$piw_lock_pid:$piw_lock_start:$piw_lock_token:$piw_lock_created"` +
		` || { rm -rf ${lock}; return 1; };` +
		` piw_lock_owner="$piw_lock_pid:$piw_lock_start:$piw_lock_token:$piw_lock_created";` +
		` printf %s "$piw_lock_owner" > ${lock}/owner.new && chmod 600 ${lock}/owner.new` +
		` && mv -T ${lock}/owner.new ${lock}/owner && chmod 700 ${lock}` +
		` || { rm -rf ${lock}; return 1; }; break; fi;` +
		` if ! test -d ${lock} || test -L ${lock}; then` +
		` if [ ! -e ${lock} ] && [ ! -L ${lock} ]; then retry_install_lock || return 1; continue; fi;` +
		` printf 'piw: unsafe remote install lock path (expected a directory, not a symlink): ${lock}\\n' >&2; return 1; fi;` +
		` piw_lock_uid=$(stat -c %u ${lock} 2>/dev/null) || {` +
		` if [ ! -e ${lock} ] && [ ! -L ${lock} ]; then retry_install_lock || return 1; continue; fi;` +
		` printf 'piw: unable to inspect remote install lock directory: ${lock}\\n' >&2; return 1; };` +
		` test "$piw_lock_uid" = "$(id -u)" || { printf 'piw: unsafe remote install lock ownership: ${lock}\\n' >&2; return 1; };` +
		` piw_lock_now=$(date +%s) && piw_lock_mtime=$(stat -c %Y ${lock} 2>/dev/null)` +
		` && piw_lock_snapshot=$(stat -c %d:%i:%u:%f:%Y ${lock} 2>/dev/null) || {` +
		` if [ ! -e ${lock} ] && [ ! -L ${lock} ]; then retry_install_lock || return 1; continue; fi;` +
		` printf 'piw: unable to snapshot remote install lock directory: ${lock}\\n' >&2; return 1; };` +
		` case "$piw_lock_now:$piw_lock_mtime" in *[!0-9:]*|:*)` +
		` printf 'piw: invalid remote install lock timestamps: ${lock}\\n' >&2; return 1;; esac;` +
		` piw_owner_state=missing; piw_owner_snapshot=; piw_existing_owner=;` +
		` if [ -e ${lock}/owner ] || [ -L ${lock}/owner ]; then` +
		` test -f ${lock}/owner && test ! -L ${lock}/owner` +
		` || { printf 'piw: unsafe remote install lock owner path (expected a regular file, not a symlink): ${lock}/owner\\n' >&2; return 1; };` +
		` piw_owner_uid=$(stat -c %u ${lock}/owner 2>/dev/null)` +
		` && piw_owner_snapshot=$(stat -c %d:%i:%u:%f:%s:%Y:%Z ${lock}/owner 2>/dev/null) || {` +
		` retry_install_lock || return 1; continue; };` +
		` test "$piw_owner_uid" = "$(id -u)"` +
		` || { printf 'piw: unsafe remote install lock owner ownership: ${lock}/owner\\n' >&2; return 1; };` +
		` if piw_existing_owner=$(cat ${lock}/owner 2>/dev/null); then` +
		` if parse_install_lock_owner "$piw_existing_owner"; then piw_owner_state=valid; else piw_owner_state=legacy; fi;` +
		` else piw_owner_state=unreadable; fi; fi;` +
		` validate_observed_install_lock() { piw_observed_lock=$1;` +
		` test -d "$piw_observed_lock" && test ! -L "$piw_observed_lock"` +
		` && test "$(stat -c %u "$piw_observed_lock" 2>/dev/null)" = "$(id -u)"` +
		` && test "$(stat -c %d:%i:%u:%f:%Y "$piw_observed_lock" 2>/dev/null)" = "$piw_lock_snapshot" || return 1;` +
		` if [ "$piw_owner_state" = missing ]; then` +
		` test ! -e "$piw_observed_lock/owner" && test ! -L "$piw_observed_lock/owner"; return; fi;` +
		` test -f "$piw_observed_lock/owner" && test ! -L "$piw_observed_lock/owner"` +
		` && test "$(stat -c %u "$piw_observed_lock/owner" 2>/dev/null)" = "$(id -u)"` +
		` && test "$(stat -c %d:%i:%u:%f:%s:%Y:%Z "$piw_observed_lock/owner" 2>/dev/null)" = "$piw_owner_snapshot"` +
		` || return 1; if [ "$piw_owner_state" = unreadable ]; then` +
		` ! cat "$piw_observed_lock/owner" >/dev/null 2>&1; else` +
		` test "$(cat "$piw_observed_lock/owner" 2>/dev/null)" = "$piw_existing_owner"; fi; };` +
		` piw_lock_age=$((piw_lock_now-piw_lock_mtime)); piw_recover_lock=0; piw_lock_recovery_reason=;` +
		` case "$piw_owner_state" in missing) piw_lock_recovery_reason=ownerless;;` +
		` unreadable) piw_lock_recovery_reason=unreadable-owner;; legacy) piw_lock_recovery_reason=legacy-owner-format;;` +
		` valid) piw_existing_pid=$piw_parsed_pid; piw_existing_start=$piw_parsed_start;` +
		` piw_existing_created=$piw_parsed_created; piw_existing_alive=0;` +
		` piw_observed_start=$(read_process_start_time "$piw_existing_pid" 2>/dev/null || true);` +
		` if kill -0 "$piw_existing_pid" 2>/dev/null && [ "$piw_observed_start" = "$piw_existing_start" ]; then` +
		` piw_existing_alive=1; fi; piw_owner_age=$((piw_lock_now-piw_existing_created));` +
		` if [ "$piw_owner_age" -ge ${REMOTE_INSTALL_LOCK_HARD_STALE_SECONDS} ]; then` +
		` piw_recover_lock=1; piw_lock_recovery_reason=hard-stale-owner;` +
		` elif [ "$piw_existing_alive" = 0 ]; then piw_lock_recovery_reason=dead-owner; fi;; esac;` +
		` if [ "$piw_recover_lock" = 0 ] && [ -n "$piw_lock_recovery_reason" ]` +
		` && [ "$piw_lock_age" -ge ${REMOTE_INSTALL_LOCK_STALE_SECONDS} ]; then piw_recover_lock=1; fi;` +
		` if [ "$piw_recover_lock" = 1 ]; then` +
		` if ! validate_observed_install_lock ${lock}; then retry_install_lock || return 1; continue; fi;` +
		` piw_recovery_token=$(cat /proc/sys/kernel/random/uuid 2>/dev/null)` +
		` || { printf 'piw: failed to create remote install lock recovery identity\\n' >&2; return 1; };` +
		` case "$piw_recovery_token" in ''|*[!0-9a-f-]*) return 1;; esac;` +
		` piw_stale_lock=${shareRoot}/.lock-recovery-$piw_recovery_token;` +
		` printf 'piw: recovering stale remote install lock (%s): ${lock}\\n' "$piw_lock_recovery_reason" >&2;` +
		` if mv -T ${lock} "$piw_stale_lock" 2>/dev/null; then` +
		` if ! validate_observed_install_lock "$piw_stale_lock"; then` +
		` printf 'piw: unsafe stale remote install lock after recovery move: %s\\n' "$piw_stale_lock" >&2;` +
		` if [ -L "$piw_stale_lock" ] || { [ -e "$piw_stale_lock" ] && [ ! -d "$piw_stale_lock" ]; }; then` +
		` rm -f "$piw_stale_lock" 2>/dev/null || true; fi; return 1; fi;` +
		` printf 'piw: recovered stale remote install lock (%s): ${lock}\\n' "$piw_lock_recovery_reason" >&2;` +
		` retry_install_lock || return 1; continue; fi;` +
		` printf 'piw: remote install lock recovery move raced; retrying: ${lock}\\n' >&2;` +
		` retry_install_lock || return 1; continue; fi;` +
		` retry_install_lock || return 1; done;` +
		` (while sleep 1; do validate_install_lock_owner || exit; touch -c ${lock} 2>/dev/null || exit; done)` +
		` & piw_lock_heartbeat=$!; };` +
		` release_install_lock() { piw_release_result=0;` +
		` if [ -n "$piw_lock_heartbeat" ]; then kill "$piw_lock_heartbeat" 2>/dev/null || true; wait "$piw_lock_heartbeat" 2>/dev/null || true; fi;` +
		` validate_install_lock_owner` +
		` || { printf 'piw: remote install lock ownership changed while held\\n' >&2; piw_release_result=1; };` +
		` if [ "$piw_release_result" = 0 ]; then rm -rf ${lock} || piw_release_result=1; fi;` +
		` return "$piw_release_result"; };`
	);
}

function remoteInstallPruneShell(shareRoot: string, releases: string): string {
	return (
		`prune_install_scratch() { validate_install_lock_owner || return 1; piw_active_target=;` +
		` if [ -e ${shareRoot}/current ] || [ -L ${shareRoot}/current ]; then` +
		` test -L ${shareRoot}/current || return 1; piw_active_target=$(readlink ${shareRoot}/current) || return 1; fi;` +
		` find ${shareRoot} -mindepth 1 -maxdepth 1 \\( \\( -name .install-\\* ! -name .install-transaction-lock \\)` +
		` -o -name .lock-recovery-\\* -o -name .candidate-\\* -o -name .current-\\*` +
		` -o -name .reuse-current-\\* -o -name .rollback-current-\\* \\) -print` +
		` | while IFS= read -r piw_scratch; do piw_scratch_name=\${piw_scratch##*/};` +
		` piw_relative_scratch=\${piw_scratch#${shareRoot}/};` +
		` if [ "$piw_active_target" = "$piw_relative_scratch" ] || [ "$piw_preserve_fallback" = "$piw_scratch" ]; then continue; fi;` +
		` case "$piw_scratch_name" in .current-*|.reuse-current-*|.rollback-current-*)` +
		` test -L "$piw_scratch" || return 1;; .candidate-*|.lock-recovery-*)` +
		` test -d "$piw_scratch" && test ! -L "$piw_scratch" || return 1;;` +
		` .install-*) test ! -L "$piw_scratch" && { test -d "$piw_scratch" || test -f "$piw_scratch"; } || return 1;;` +
		` *) return 1;; esac; test "$(stat -c %u "$piw_scratch")" = "$(id -u)" || return 1;` +
		` validate_install_lock_owner || return 1; rm -rf "$piw_scratch" || return 1; done || return 1;` +
		` find ${releases} -mindepth 1 -maxdepth 1 -name .repair-\\* -print` +
		` | while IFS= read -r piw_scratch; do piw_relative_scratch=\${piw_scratch#${shareRoot}/};` +
		` if [ "$piw_active_target" = "$piw_relative_scratch" ] || [ "$piw_preserve_fallback" = "$piw_scratch" ]; then continue; fi;` +
		` test -d "$piw_scratch" && test ! -L "$piw_scratch"` +
		` && test "$(stat -c %u "$piw_scratch")" = "$(id -u)" || return 1;` +
		` validate_install_lock_owner || return 1; rm -rf "$piw_scratch" || return 1; done; };`
	);
}

/** Remote command builders. Exported for tests: every interpolated value is path/host validated. */
export const remoteCommands = {
	probeHome: 'printf %s "$HOME"',
	probeDefaultCwd:
		'if test -n "$DATADOG_ROOT"; then if test -d "$DATADOG_ROOT/dd-source"; then printf %s "$DATADOG_ROOT/dd-source"; elif test -d "$DATADOG_ROOT"; then printf %s "$DATADOG_ROOT"; else exit 1; fi; else exit 1; fi',
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
			...(paths.standalone ? [`${paths.shareRoot}/releases`, `${paths.shareRoot}/quarantine`] : []),
			paths.stateRoot,
			paths.serverDir,
			paths.sessionDir,
			paths.npmCacheDir,
		];
		const validated = dirs.map((path) => requireValidRemotePath(path, "state directory"));
		return (
			`mkdir -p ${validated.join(" ")} && chmod 700 ${validated.join(" ")}` +
			(paths.standalone
				? ` && { command -v stat >/dev/null 2>&1 || { printf 'piw: required remote install tool missing: stat\\n' >&2; exit 1; };` +
					` stat -c %u ${paths.shareRoot} >/dev/null 2>&1 || { printf 'piw: remote install requires GNU-compatible stat\\n' >&2; exit 1; }; }`
				: "") +
			` && for p in ${validated.join(" ")}; do test -d "$p" && test ! -L "$p"` +
			` && test "$(stat -c %u "$p")" = "$(id -u)" && test "$(stat -c %a "$p")" = 700 || exit 1; done`
		);
	},
	isStaged(paths: WorkspaceRemotePaths): string {
		return `test -f ${requireValidRemotePath(paths.markerPath, "staging marker")}`;
	},
	isInstalled(paths: WorkspaceRemotePaths, artifactSha256: string): string {
		if (!paths.standalone || !/^[0-9a-f]{64}$/u.test(artifactSha256)) throw new Error("Invalid installed artifact");
		const marker = requireValidRemotePath(paths.markerPath, "install marker");
		const entrypoint = requireValidRemotePath(paths.cliEntry, "server entrypoint");
		const esbuild = requireValidRemotePath(`${paths.revisionDir}/bin/esbuild`, "esbuild entrypoint");
		const shareRoot = requireValidRemotePath(paths.shareRoot, "runtime root");
		const releases = requireValidRemotePath(`${shareRoot}/releases`, "release root");
		const releaseDir = requireValidRemotePath(paths.revisionDir, "release directory");
		const releaseName = basename(paths.revisionDir);
		if (!new RegExp(`^[0-9a-f]{64}-${artifactSha256}$`, "u").test(releaseName))
			throw new Error("Invalid release identity");
		const next = `${shareRoot}/.reuse-current-${releaseName}-$$`;
		const ownedDirectory = (directory: string) =>
			`test -d ${directory} && test ! -L ${directory} && test "$(stat -c %u ${directory})" = "$(id -u)"`;
		return (
			`${remoteInstallTransactionShell(shareRoot)} ${remoteInstallPruneShell(shareRoot, releases)}` +
			` piw_lock_heartbeat=; piw_lock_owner=; piw_preserve_fallback=;` +
			` cleanup_workspace_reuse() { piw_reuse_result=$?;` +
			` prune_install_scratch || printf 'piw: warning: failed to prune remote install scratch after activation\\n' >&2;` +
			` rm -f ${next}; release_install_lock || { [ "$piw_reuse_result" != 0 ] || piw_reuse_result=1; };` +
			` trap - EXIT HUP INT TERM; exit "$piw_reuse_result"; };` +
			` require_install_tools && ${ownedDirectory(shareRoot)} && ${ownedDirectory(releases)}` +
			` && acquire_install_lock && trap cleanup_workspace_reuse EXIT HUP INT TERM` +
			` && prune_install_scratch` +
			` && ${ownedDirectory(releaseDir)} && test -x ${entrypoint} && test -x ${esbuild}` +
			` && test "$(cat ${marker})" = ${releaseName}` +
			` && cd ${releaseDir} && test -z "$(find . ! -type d ! -type f -print -quit)"` +
			` && find . -type f ! -name .tree.sha256 -print0 | sort -z | xargs -0 sha256sum | cmp - .tree.sha256` +
			` && if [ -e ${shareRoot}/current ] && [ ! -L ${shareRoot}/current ]; then exit 1; fi` +
			` && rm -f ${next} && cd ${shareRoot} && ln -s releases/${releaseName} ${next}` +
			` && mv -Tf ${next} ${shareRoot}/current`
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
		const releases = requireValidRemotePath(`${shareRoot}/releases`, "release root");
		const quarantineRoot = requireValidRemotePath(`${shareRoot}/quarantine`, "quarantine root");
		const target = requireValidRemotePath(paths.revisionDir, "release directory");
		const entrypoint = requireValidRemotePath(paths.cliEntry, "server entrypoint");
		const esbuild = requireValidRemotePath(`${paths.revisionDir}/bin/esbuild`, "esbuild entrypoint");
		const releaseName = basename(paths.revisionDir);
		if (!new RegExp(`^[0-9a-f]{64}-${artifactSha256}$`, "u").test(releaseName))
			throw new Error("Invalid release identity");
		const temporary = `${shareRoot}/.install-${releaseName}-$$`;
		const candidate = `${shareRoot}/.candidate-${releaseName}-$$`;
		const fallback = `${releases}/.repair-${releaseName}-$$`;
		const archive = `${temporary}.tar.gz`;
		const next = `${shareRoot}/.current-${releaseName}-$$`;
		const rollbackNext = `${shareRoot}/.rollback-current-${releaseName}-$$`;
		const quarantine = `${quarantineRoot}/${releaseName}-$$`;
		const ownedDirectory = (directory: string) =>
			`test -d ${directory} && test ! -L ${directory} && test "$(stat -c %u ${directory})" = "$(id -u)"`;
		const validateDirectory = (directory: string) =>
			`${ownedDirectory(directory)} && test -x ${directory}/bin/pi-workspace-server` +
			` && test -x ${directory}/bin/esbuild && test "$(cat ${directory}/install.json)" = ${releaseName}` +
			` && cd ${directory} && test -z "$(find . ! -type d ! -type f -print -quit)"` +
			` && find . -type f ! -name .tree.sha256 -print0 | sort -z | xargs -0 sha256sum | cmp - .tree.sha256`;
		const activate = (targetName: string, link: string) =>
			`rm -f ${link} && cd ${shareRoot} && ln -s releases/${targetName} ${link}` +
			` && mv -Tf ${link} ${shareRoot}/current`;
		const restore =
			`restore_workspace_release() { rm -rf ${target} && mv -T ${quarantine} ${target}` +
			` && ${ownedDirectory(target)}` +
			` && if [ "$piw_repair_active" = 1 ]; then ${activate(releaseName, rollbackNext)}` +
			` && test "$(readlink ${shareRoot}/current)" = releases/${releaseName}; fi` +
			` && piw_preserve_fallback= && rm -rf ${fallback}; };`;
		const cleanup =
			`cleanup_workspace_install() { piw_install_result=$?;` +
			` prune_install_scratch || printf 'piw: warning: failed to prune remote install scratch after activation\\n' >&2;` +
			` rm -rf ${temporary} ${archive} ${next} ${rollbackNext};` +
			` release_install_lock || { [ "$piw_install_result" != 0 ] || piw_install_result=1; };` +
			` trap - EXIT HUP INT TERM; exit "$piw_install_result"; };`;
		return (
			`${remoteInstallTransactionShell(shareRoot)} ${remoteInstallPruneShell(shareRoot, releases)}` +
			` ${restore} ${cleanup} piw_lock_heartbeat=; piw_lock_owner=; piw_preserve_fallback=; piw_repair_active=0;` +
			` require_install_tools && ${ownedDirectory(shareRoot)} && ${ownedDirectory(releases)}` +
			` && ${ownedDirectory(quarantineRoot)} && acquire_install_lock` +
			` && trap cleanup_workspace_install EXIT HUP INT TERM && prune_install_scratch` +
			` && rm -rf ${temporary} ${archive} ${next} ${rollbackNext} && cat > ${archive}` +
			` && test "$(sha256sum ${archive} | cut -d " " -f 1)" = ${artifactSha256}` +
			` && mkdir ${temporary} && chmod 700 ${temporary}` +
			` && tar -xzf ${archive} -C ${temporary} --no-same-owner --no-same-permissions && rm -f ${archive}` +
			` && test -x ${temporary}/bin/pi-workspace-server && test -x ${temporary}/bin/esbuild` +
			` && test -f ${temporary}/.pi-workspace-artifact.json` +
			` && printf %s ${releaseName} > ${temporary}/install.json && chmod 600 ${temporary}/install.json` +
			` && cd ${temporary} && find . -type f ! -name .tree.sha256 -print0 | sort -z | xargs -0 sha256sum > .tree.sha256` +
			` && chmod 600 .tree.sha256 && cd ${shareRoot}` +
			` && if [ -e ${shareRoot}/current ] && [ ! -L ${shareRoot}/current ]; then exit 1; fi` +
			` && if [ -e ${target} ] || [ -L ${target} ]; then` +
			` if (${validateDirectory(target)}); then rm -rf ${temporary} && ${activate(releaseName, next)};` +
			` else cp -a ${temporary} ${candidate} && (${validateDirectory(candidate)}) && piw_repair_active=0` +
			` && if test "$(readlink ${shareRoot}/current)" = releases/${releaseName}; then` +
			` mv -T ${temporary} ${fallback} && piw_preserve_fallback=${fallback}` +
			` && ${activate(`.repair-${releaseName}-$$`, next)} && piw_repair_active=1;` +
			` else rm -rf ${temporary}; fi` +
			` && if ! mv -T ${target} ${quarantine}; then` +
			` if [ "$piw_repair_active" = 1 ] && ${activate(releaseName, rollbackNext)}` +
			` && test "$(readlink ${shareRoot}/current)" = releases/${releaseName}; then` +
			` piw_preserve_fallback=; rm -rf ${fallback}; fi; exit 1; fi` +
			` && if ! mv -T ${candidate} ${target} || ! (${validateDirectory(target)}); then` +
			` restore_workspace_release; exit 1; fi` +
			` && if ! (${activate(releaseName, next)}); then restore_workspace_release; exit 1; fi` +
			` && piw_preserve_fallback= && rm -rf ${fallback}; fi;` +
			` else mv -T ${temporary} ${target} && (${validateDirectory(target)})` +
			` && ${activate(releaseName, next)}; fi` +
			` && test -x ${entrypoint} && test -x ${esbuild}`
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
			? ` ESBUILD_BINARY_PATH=${requireValidRemotePath(`${options.paths.revisionDir}/bin/esbuild`, "esbuild path")}` +
				` PI_WORKSPACE_RUNTIME_MODULES=${requireValidRemotePath(
					`${options.paths.revisionDir}/node_modules`,
					"runtime modules path",
				)}`
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
		archive.once("exit", (code) => resolve(code ?? 1));
	});
	const extractCode = new Promise<number>((resolve, reject) => {
		extract.once("error", reject);
		extract.once("exit", (code) => resolve(code ?? 1));
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
	const installed = await sshExec(host, remoteCommands.isInstalled(paths, bundle.artifact.sha256), {
		timeoutMs: REMOTE_INSTALL_CHECK_TIMEOUT_MS,
	});
	if (installed.code === 0) return false;
	console.log(`Installing Workspace backend ${bundle.manifest.revision} on ${host}…`);
	const command = buildSshCommand(host, remoteCommands.installArtifact(paths, bundle.artifact.sha256));
	const child = spawn(command[0]!, command.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => {
		stderr = (stderr + chunk).slice(-MAX_SSH_CAPTURE_BYTES);
	});
	let stdinError: Error | undefined;
	child.stdin.on("error", (error) => {
		stdinError = error;
	});
	const exit = new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>(
		(resolve, reject) => {
			child.once("error", reject);
			child.once("exit", (code, signal) => resolve({ code, signal }));
		},
	);
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		child.kill("SIGKILL");
	}, REMOTE_ARTIFACT_INSTALL_TIMEOUT_MS);
	timer.unref();
	try {
		child.stdin.end(bundle.archive);
	} catch (error) {
		stdinError = error instanceof Error ? error : new Error(String(error));
		child.stdin.destroy();
	}
	let outcome: { readonly code: number | null; readonly signal: NodeJS.Signals | null };
	try {
		outcome = await exit;
	} finally {
		clearTimeout(timer);
	}
	if (timedOut) {
		throw new SshCommandTimeoutError(host, REMOTE_ARTIFACT_INSTALL_TIMEOUT_MS, "Remote Workspace backend install");
	}
	if (outcome.code === null) {
		throw new SshCommandSignalError(host, outcome.signal, "Remote Workspace backend install");
	}
	if (outcome.code !== 0) {
		throw new Error(
			`Remote Workspace backend install failed (exit ${outcome.code}): ${stderr.trim()}`,
			stdinError === undefined ? undefined : { cause: stdinError },
		);
	}
	if (stdinError !== undefined) {
		throw new Error(`Remote Workspace backend install rejected archive input: ${stdinError.message}`, {
			cause: stdinError,
		});
	}
	const verified = await sshExec(host, remoteCommands.isInstalled(paths, bundle.artifact.sha256), {
		timeoutMs: REMOTE_INSTALL_CHECK_TIMEOUT_MS,
	});
	if (verified.code !== 0) throw new Error("Remote Workspace backend install did not activate the exact artifact");
	return true;
}

export function workspaceSshRemoteCommand(
	paths: WorkspaceRemotePaths,
	toolchain: WorkspaceRemoteToolchain,
	socketPath: string,
): readonly string[] {
	const socket = requireValidRemotePath(socketPath, "server socket");
	return paths.standalone
		? [requireValidRemotePath(paths.bridgePath, "server bridge"), socket]
		: [
				requireValidRemotePath(toolchain.nodePath, "node path"),
				requireValidRemotePath(paths.bridgePath, "server bridge"),
				socket,
			];
}

/** Connects one protocol client over the SSH byte bridge; used to probe server liveness. */
export async function probeRemoteServer(
	connection: {
		readonly serverId: string;
		readonly remoteCommand: readonly string[];
	},
	host: string,
	timeoutMs = SSH_EXEC_TIMEOUT_MS,
): Promise<boolean> {
	const client = new Client({
		serverId: requireValidServerId(connection.serverId),
		transportFactory: createSshTransportFactory({ host, remoteCommand: connection.remoteCommand }),
	});
	let timer: NodeJS.Timeout | undefined;
	try {
		await Promise.race([
			client.connect(),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new SshCommandTimeoutError(host, timeoutMs, "Workspace server probe")),
					timeoutMs,
				);
				timer.unref();
			}),
		]);
		return true;
	} catch {
		return false;
	} finally {
		if (timer !== undefined) clearTimeout(timer);
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
async function readRemoteServerId(
	host: string,
	paths: WorkspaceRemotePaths,
	timeoutMs = SSH_EXEC_TIMEOUT_MS,
): Promise<string | undefined> {
	const identity = await sshExec(host, remoteCommands.readServerId(paths), { timeoutMs });
	if (identity.code !== 0) return undefined;
	const serverId = identity.stdout.trim();
	if (serverId.length === 0) return undefined;
	return requireValidServerId(serverId);
}

async function readRemoteServerGeneration(
	host: string,
	paths: WorkspaceRemotePaths,
	timeoutMs = SSH_EXEC_TIMEOUT_MS,
): Promise<string | undefined> {
	const result = await sshExec(host, remoteCommands.readServerRevision(paths), { timeoutMs });
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
	readServerId(timeoutMs: number): Promise<string | undefined>;
	readGeneration(timeoutMs: number): Promise<string | undefined>;
	hasSocket(serverId: string, timeoutMs: number): Promise<boolean>;
	probe(serverId: string, timeoutMs: number): Promise<boolean>;
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
	const operationTimeout = () => {
		const remaining = deadline - now();
		if (remaining <= 0) throw new Error("Timed out waiting for the exact Workspace server generation");
		return Math.min(SSH_EXEC_TIMEOUT_MS, remaining);
	};
	while (true) {
		try {
			const serverId = await operations.readServerId(operationTimeout());
			const generation = await operations.readGeneration(operationTimeout());
			if (
				serverId !== undefined &&
				generation === expectedGeneration &&
				(await operations.hasSocket(serverId, operationTimeout())) &&
				(await operations.probe(serverId, operationTimeout()))
			) {
				return serverId;
			}
		} catch (error) {
			if (!isSshPollingInterruption(error)) throw error;
		}
		const remaining = deadline - now();
		if (remaining <= 0) throw new Error("Timed out waiting for the exact Workspace server generation");
		await sleep(Math.min(POLL_MS, remaining));
	}
}

export interface WorkspaceSocketRemovalOperations {
	hasSocket(timeoutMs: number): Promise<boolean>;
	now?(): number;
	sleep?(delayMs: number): Promise<void>;
}

/** Polls server shutdown while treating a bounded SSH timeout or signal as an inconclusive observation. */
export async function waitForWorkspaceSocketRemoval(
	timeoutMs: number,
	operations: WorkspaceSocketRemovalOperations,
): Promise<boolean> {
	const now = operations.now ?? Date.now;
	const sleep =
		operations.sleep ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
	const deadline = now() + timeoutMs;
	while (true) {
		const remainingBeforeCheck = deadline - now();
		if (remainingBeforeCheck <= 0) return false;
		try {
			if (!(await operations.hasSocket(Math.min(SSH_EXEC_TIMEOUT_MS, remainingBeforeCheck)))) return true;
		} catch (error) {
			if (!isSshPollingInterruption(error)) throw error;
		}
		const remaining = deadline - now();
		if (remaining <= 0) return false;
		await sleep(Math.min(POLL_MS, remaining));
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
	const existingSocketPath = existing === undefined ? undefined : serverSocketPath(paths, existing);
	if (existing !== undefined && existingSocketPath !== undefined) {
		const socket = await sshExec(host, remoteCommands.hasSocket(existingSocketPath));
		const runningGeneration = await readRemoteServerGeneration(host, paths);
		if (
			runningGeneration !== undefined &&
			socket.code === 0 &&
			(await probeRemoteServer(
				{ serverId: existing, remoteCommand: workspaceSshRemoteCommand(paths, toolchain, existingSocketPath) },
				host,
			))
		) {
			return existing;
		}
	}
	const stopped = await sshExec(host, remoteCommands.stopServer(paths));
	if (!stopped.stdout.includes("stopped") && !stopped.stdout.includes("absent")) {
		throw new Error("Refused to stop the unreachable or stale Pi Workspace server generation");
	}
	if (stopped.stdout.includes("stopped") && existingSocketPath !== undefined) {
		console.log(`Replacing unreachable or stale Workspace server with revision ${paths.revision}…`);
		const removed = await waitForWorkspaceSocketRemoval(SERVER_STOP_TIMEOUT_MS, {
			hasSocket: async (timeoutMs) =>
				(await sshExec(host, remoteCommands.hasSocket(existingSocketPath), { timeoutMs })).code === 0,
		});
		if (!removed) throw new Error("Timed out stopping the unreachable or stale Pi Workspace server generation");
	}
	console.log("Starting the persistent Workspace server…");
	const generation = `${paths.revision}:${randomUUID()}`;
	await startRemoteServer(host, paths, toolchain, remoteCwd, existing, pluginPackages, generation);
	try {
		return await waitForWorkspaceGeneration(generation, SERVER_START_TIMEOUT_MS, {
			readServerId: async (timeoutMs) => (await readRemoteServerId(host, paths, timeoutMs)) ?? existing,
			readGeneration: (timeoutMs) => readRemoteServerGeneration(host, paths, timeoutMs),
			hasSocket: async (serverId, timeoutMs) =>
				(
					await sshExec(host, remoteCommands.hasSocket(serverSocketPath(paths, serverId)), {
						timeoutMs,
					})
				).code === 0,
			probe: (serverId, timeoutMs) =>
				probeRemoteServer(
					{
						serverId,
						remoteCommand: workspaceSshRemoteCommand(paths, toolchain, serverSocketPath(paths, serverId)),
					},
					host,
					timeoutMs,
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

/** Bounded non-interactive probe of the Workspace-side ddtool vault session. */
export async function probeWorkspaceDdtoolAuth(host: string): Promise<DdtoolAuthProbeResult> {
	const manualCommand = manualDdtoolLoginCommand(host);
	let probe: SshExecResult;
	try {
		probe = await sshExec(host, buildDdtoolAuthProbeCommand(), { timeoutMs: DDTOOL_AUTH_PROBE_TIMEOUT_MS });
	} catch (error) {
		if (error instanceof SshCommandTimeoutError || error instanceof SshCommandSignalError) {
			throw new WorkspaceAuthError(`Workspace ddtool auth probe failed over SSH: ${error.message}`, manualCommand);
		}
		throw error;
	}
	if (probe.code === 255) {
		const stderrTail = probe.stderr.trim().slice(-400);
		const detail = stderrTail.length > 0 ? `: ${stderrTail}` : "";
		throw new WorkspaceAuthError(`Workspace ddtool auth probe failed over SSH (exit 255)${detail}`, manualCommand);
	}
	return classifyDdtoolAuthProbe(probe.code);
}

function startDdtoolDeviceLoginProcess(
	host: string,
	handlers: { readonly onOutput: (chunk: string) => void },
): DdtoolDeviceLoginProcess {
	const manualCommand = manualDdtoolLoginCommand(host);
	const args = buildSshCommand(host, buildDdtoolDeviceLoginCommand());
	const child = spawn(args[0]!, args.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", handlers.onOutput);
	child.stderr.setEncoding("utf8");
	let stderr = "";
	child.stderr.on("data", (chunk: string) => {
		// ddtool prints the device-flow output on stderr; feed it to the same
		// parser/display path as stdout and keep a tail for failure detail.
		stderr = (stderr + chunk).slice(-MAX_SSH_CAPTURE_BYTES);
		handlers.onOutput(chunk);
	});
	const killTimer = setTimeout(() => child.kill("SIGKILL"), DDTOOL_DEVICE_LOGIN_TIMEOUT_MS);
	killTimer.unref();
	const exit = new Promise<{
		readonly code: number | null;
		readonly signal: NodeJS.Signals | null;
		readonly stderr: string;
	}>((resolve, reject) => {
		child.once("error", (error) =>
			reject(new WorkspaceAuthError(`Workspace device login SSH spawn failed: ${error.message}`, manualCommand)),
		);
		// Resolve on "close", not "exit": the process can exit before its stdio
		// streams drain, and the orchestrator must see every URL-bearing chunk.
		child.once("close", (code, signal) => resolve({ code, signal, stderr }));
	});
	return {
		exit: exit.finally(() => clearTimeout(killTimer)),
		abort: () => {
			child.kill("SIGKILL");
		},
	};
}

function ddtoolDeviceLoginOperations(host: string): DdtoolDeviceLoginOperations {
	return {
		probeAuth: () => probeWorkspaceDdtoolAuth(host),
		startDeviceLogin: (handlers) => startDdtoolDeviceLoginProcess(host, handlers),
		openUrl: openDdtoolLoginUrl,
	};
}

function warnWorkspaceAttachAuth(detail: string, manualCommand: string): void {
	console.error(
		`piw: warning: Workspace ddtool auth could not be completed: ${detail}; model calls may fail until you ` +
			`log in. Run the login manually:\n  ${manualCommand}\nOr relaunch with --no-login to attach without the auth check.`,
	);
}

function authFailureDetail(error: unknown): string {
	if (error instanceof WorkspaceAuthError) return error.reason;
	return error instanceof Error ? error.message : String(error);
}

/**
 * Attach-path auth policy. An expired session runs the device login; every
 * advisory failure (a declined or failed login, an unreachable probe or
 * transport error, a missing ddtool, or a login that never printed a
 * verification URL) warns with the manual command and the `--no-login`
 * alternative and lets the attach proceed. Only an untrusted verification URL
 * hard-aborts: that URL must never be opened or trusted locally.
 */
export async function ensureWorkspaceAttachAuth(
	host: string,
	probe: Promise<DdtoolAuthProbeResult>,
	options: {
		readonly loginOperations?: DdtoolDeviceLoginOperations;
		readonly loginDisplay?: DdtoolDeviceLoginDisplay;
	} = {},
): Promise<void> {
	const manualCommand = manualDdtoolLoginCommand(host);
	const operations = options.loginOperations ?? ddtoolDeviceLoginOperations(host);
	const display = options.loginDisplay ?? createDdtoolLoginDisplay();
	let state: DdtoolAuthProbeResult;
	try {
		state = await probe;
	} catch (error) {
		warnWorkspaceAttachAuth(authFailureDetail(error), manualCommand);
		return;
	}
	if (state === "authenticated") return;
	if (state === "unavailable") {
		warnWorkspaceAttachAuth(`ddtool is missing or not executable on ${host}`, manualCommand);
		return;
	}
	console.log(`Workspace ${host}: ddtool auth is expired; starting the device login…`);
	let result: Awaited<ReturnType<typeof orchestrateDdtoolDeviceLogin>>;
	try {
		result = await orchestrateDdtoolDeviceLogin(host, operations, display);
	} catch (error) {
		if (error instanceof WorkspaceUntrustedDeviceLoginUrlError) throw error;
		warnWorkspaceAttachAuth(authFailureDetail(error), manualCommand);
		return;
	}
	if (result.outcome === "authenticated") {
		console.log(`Workspace ${host}: ddtool login complete.`);
		return;
	}
	warnWorkspaceAttachAuth(result.detail, manualCommand);
}

/** `piw login <name>`: probe, orchestrate the device login when expired, and verify. */
async function runWorkspaceLogin(host: string): Promise<void> {
	const manualCommand = manualDdtoolLoginCommand(host);
	const state = await probeWorkspaceDdtoolAuth(host);
	if (state === "authenticated") {
		console.log(`Workspace ${host}: ddtool auth is already valid.`);
		return;
	}
	if (state === "unavailable") {
		throw new WorkspaceAuthError(`Workspace ddtool is missing or not executable on ${host}`, manualCommand);
	}
	console.log(`Workspace ${host}: ddtool auth is expired; starting the device login…`);
	const result = await orchestrateDdtoolDeviceLogin(
		host,
		ddtoolDeviceLoginOperations(host),
		createDdtoolLoginDisplay(),
	);
	if (result.outcome !== "authenticated") {
		throw new WorkspaceAuthError(`Workspace ddtool login was not completed: ${result.detail}`, manualCommand);
	}
	console.log(`Workspace ${host}: ddtool login complete.`);
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
	if (command.login === true) {
		await runWorkspaceLogin(host);
		return;
	}
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
		process.env.PI_WORKSPACE_RUNTIME_MODULES = join(dirname(getPackageDir()), "node_modules");
		const [homeResult, platformResult] = await Promise.all([
			sshExec(host, remoteCommands.probeHome),
			sshExec(host, remoteCommands.probePlatform),
		]);
		if (homeResult.code !== 0) throw new Error("Failed to read the remote home directory");
		if (platformResult.code !== 0) throw new Error("Workspace platform is not supported by this piw release");
		const home = requireValidRemotePath(homeResult.stdout, "remote home");
		bundle = await readBundledWorkspaceServer(platformResult.stdout.trim(), bundledRoot);
		if (bundle === undefined) throw new Error("Installed piw has no bundled Workspace server artifact");
		paths = buildInstalledWorkspaceRemotePaths(
			home,
			bundle.manifest.revision,
			bundle.manifestSha256,
			bundle.artifact.sha256,
		);
		toolchain = {
			home,
			nodePath: "/usr/bin/env",
			npmPath: paths.cliEntry,
			nodeVersion: `standalone ${bundle.manifest.revision}`,
		};
	}
	if (command.status === true) {
		await reportWorkspaceStatus(
			host,
			await resolveRemoteCwd(host, command.remoteCwd, false),
			paths.revision,
			paths,
			toolchain,
		);
		return;
	}
	if (command.cleanup === true || command.purge === true) {
		await cleanupWorkspace(host, paths, command.purge === true);
		return;
	}
	const directories = await sshExec(host, remoteCommands.ensureDirectories(paths));
	if (directories.code !== 0) throw new Error("Failed to create private Pi Workspace state directories");
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
	// The auth probe runs concurrently with server discovery and readiness work
	// so a healthy session adds no noticeable attach latency; it is awaited
	// before the TUI opens, and an expired session triggers the device login
	// flow.
	const authProbe = command.noLogin === true ? undefined : probeWorkspaceDdtoolAuth(host);
	// Mark the early-started probe as handled up front so an attach that aborts
	// before the await point cannot surface an unhandled rejection.
	authProbe?.catch(() => {});
	const remoteCwd = await resolveRemoteCwd(host, command.remoteCwd, true);
	if (remoteCwd === undefined) throw new Error("Remote working directory resolution failed");
	const serverId = await ensureRemoteServer(
		host,
		paths,
		toolchain,
		remoteCwd,
		command.pluginPackages ?? defaultPluginPackages(paths),
	);
	const sessionId = await resolveSessionId(command, serverId, remoteCwd);
	await writeWorkspaceLocalState(host, remoteCwd, { revision: paths.revision, serverId, sessionId });

	if (authProbe !== undefined) {
		await ensureWorkspaceAttachAuth(host, authProbe);
	}

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
			remoteCommand: workspaceSshRemoteCommand(paths, toolchain, serverSocketPath(paths, serverId)),
		},
		sessionId,
	});
}

async function resolveRemoteCwd(
	host: string,
	configured: string | undefined,
	required: boolean,
): Promise<string | undefined> {
	if (configured !== undefined) return requireValidRemotePath(configured, "remote working directory");
	const inferred = await sshExec(host, remoteCommands.probeDefaultCwd);
	if (inferred.code === 0 && inferred.stdout.length > 0) {
		return requireValidRemotePath(inferred.stdout, "remote default working directory");
	}
	if (required) throw new Error("Remote DATADOG_ROOT is unset or invalid; pass --cwd with an absolute remote path");
	return undefined;
}

async function reportWorkspaceStatus(
	host: string,
	remoteCwd: string | undefined,
	revision: string,
	paths: WorkspaceRemotePaths,
	toolchain: WorkspaceRemoteToolchain,
): Promise<void> {
	const staged = await sshExec(host, remoteCommands.isStaged(paths));
	console.log(`Host:            ${host}`);
	console.log(`Remote cwd:      ${remoteCwd ?? "not selected"}`);
	console.log(`Revision:        ${revision} (${staged.code === 0 ? "installed" : "not installed"})`);
	console.log(`Remote runtime:  ${toolchain.nodeVersion} (${paths.standalone ? paths.cliEntry : toolchain.nodePath})`);
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
				{ serverId, remoteCommand: workspaceSshRemoteCommand(paths, toolchain, socketPath) },
				host,
			));
		const runningGeneration = await readRemoteServerGeneration(host, paths);
		console.log(
			`Server:          ${serverId} (${alive ? "reachable" : "stopped"}; generation ${runningGeneration ?? "unknown"})`,
		);
	}
	const state = remoteCwd === undefined ? undefined : await readWorkspaceLocalState(host, remoteCwd);
	console.log(`Local session:   ${state === undefined ? "none" : state.sessionId}`);
}

async function cleanupWorkspace(host: string, paths: WorkspaceRemotePaths, purge: boolean): Promise<void> {
	const stop = await sshExec(host, remoteCommands.stopServer(paths));
	if (stop.stdout.includes("stopped")) {
		console.log("Stopped the Pi Workspace server. Remote sessions remain durable for reconnect.");
	} else {
		console.log("No Pi Workspace server process found (already clean).");
	}
	const serverId = await readRemoteServerId(host, paths);
	if (serverId !== undefined) {
		const socketPath = serverSocketPath(paths, serverId);
		await waitForWorkspaceSocketRemoval(SERVER_STOP_TIMEOUT_MS, {
			hasSocket: async (timeoutMs) =>
				(await sshExec(host, remoteCommands.hasSocket(socketPath), { timeoutMs })).code === 0,
		});
	}
	if (purge) {
		const removed = await sshExec(host, remoteCommands.removeStaging(paths));
		console.log(removed.stdout.includes("removed") ? `Removed staging ${paths.revisionDir}` : "No staging to purge.");
	}
}
