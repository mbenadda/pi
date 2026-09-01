import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildSshSpawnArgs } from "@earendil-works/pi-client/ssh";
import { describe, expect, test } from "vitest";
import { cli } from "../src/cli/experimental/cli.ts";
import {
	buildInstalledWorkspaceRemotePaths,
	buildWorkspaceRemotePaths,
	readWorkspaceLocalState,
	remoteCommands,
	requireValidRemotePath,
	serverSocketPath,
	waitForWorkspaceGeneration,
	workspaceSshRemoteCommand,
	writeWorkspaceLocalState,
} from "../src/experimental/workspace.ts";

const HOME = "/home/bits";
const REVISION = "0123456789abcdef0123456789abcdef01234567";
const SERVER_ID = "00000000-0000-4000-8000-000000000001";
const GENERATION = `${REVISION}:00000000-0000-4000-8000-000000000003`;
const REMOTE_CWD = "/home/bits/go/src/github.com/DataDog/dd-source";

function paths() {
	return buildWorkspaceRemotePaths(HOME, REVISION);
}

describe("experimental workspace command parsing", () => {
	test("parses a launch configuration", () => {
		expect(
			cli.parse([
				"workspace",
				"--ssh-host",
				"workspace-bcli-10",
				"--remote-cwd",
				REMOTE_CWD,
				"--session-id",
				"demo-1",
			]),
		).toEqual({
			ok: true,
			command: {
				command: "workspace",
				sshHost: "workspace-bcli-10",
				remoteCwd: REMOTE_CWD,
				sessionId: "demo-1",
			},
		});
	});

	test("parses plugin packages and lifecycle modes", () => {
		expect(
			cli.parse([
				"workspace",
				"--ssh-host",
				"workspace-bcli-10",
				"--remote-cwd",
				REMOTE_CWD,
				"--new-session",
				"--plugin",
				REMOTE_CWD,
			]),
		).toEqual({
			ok: true,
			command: {
				command: "workspace",
				sshHost: "workspace-bcli-10",
				remoteCwd: REMOTE_CWD,
				newSession: true,
				pluginPackages: [REMOTE_CWD],
			},
		});
		expect(
			cli.parse(["workspace", "--ssh-host", "workspace-bcli-10", "--remote-cwd", REMOTE_CWD, "--status"]),
		).toEqual({
			ok: true,
			command: {
				command: "workspace",
				sshHost: "workspace-bcli-10",
				remoteCwd: REMOTE_CWD,
				status: true,
			},
		});
		expect(
			cli.parse(["workspace", "--ssh-host", "workspace-bcli-10", "--remote-cwd", REMOTE_CWD, "--purge"]),
		).toMatchObject({ ok: true, command: { purge: true } });
	});

	test.each([
		[["workspace", "--remote-cwd", REMOTE_CWD], ["--ssh-host is required"]],
		[["workspace", "--ssh-host", "workspace-bcli-10"], ["--remote-cwd is required"]],
		[
			["workspace", "--ssh-host", "bad host", "--remote-cwd", REMOTE_CWD],
			['Invalid --ssh-host "bad host"; expected an OpenSSH host alias', "--ssh-host is required"],
		],
		[
			["workspace", "--ssh-host", "workspace-bcli-10", "--remote-cwd", "relative/path"],
			['Invalid remote working directory "relative/path"', "--remote-cwd is required"],
		],
		[
			["workspace", "--ssh-host", "workspace-bcli-10", "--remote-cwd", REMOTE_CWD, "--session-id", "a b"],
			['Invalid --session-id "a b"'],
		],
		[
			[
				"workspace",
				"--ssh-host",
				"workspace-bcli-10",
				"--remote-cwd",
				REMOTE_CWD,
				"--session-id",
				"x",
				"--new-session",
			],
			["--session-id and --new-session are mutually exclusive"],
		],
		[
			["workspace", "--ssh-host", "workspace-bcli-10", "--remote-cwd", REMOTE_CWD, "--status", "--cleanup"],
			["--status cannot be combined with --cleanup or --purge"],
		],
		[
			[
				"workspace",
				"--ssh-host",
				"workspace-bcli-10",
				"--remote-cwd",
				REMOTE_CWD,
				"--cleanup",
				"--plugin",
				REMOTE_CWD,
			],
			["Session and plugin selection require a launch"],
		],
		[
			["workspace", "--ssh-host", "workspace-bcli-10", "--remote-cwd", REMOTE_CWD, "--listen", "x"],
			["The experimental workspace command does not support existing CLI options yet"],
		],
	] as const)("rejects %j with %j", (argv, errors) => {
		expect(cli.parse([...argv])).toEqual({ ok: false, errors: [...errors] });
	});
});

describe("workspace remote paths and command construction", () => {
	test("builds isolated versioned MVP paths", () => {
		expect(paths()).toEqual({
			revision: REVISION,
			shareRoot: `${HOME}/.local/share/pi-workspace-mvp`,
			stateRoot: `${HOME}/.local/state/pi-workspace-mvp`,
			revisionDir: `${HOME}/.local/share/pi-workspace-mvp/${REVISION}`,
			serverDir: `${HOME}/.local/state/pi-workspace-mvp/server`,
			sessionDir: `${HOME}/.local/state/pi-workspace-mvp/sessions`,
			npmCacheDir: `${HOME}/.local/state/pi-workspace-mvp/npm-cache`,
			serverPidFile: `${HOME}/.local/state/pi-workspace-mvp/server.pid`,
			serverRevisionFile: `${HOME}/.local/state/pi-workspace-mvp/server.revision`,
			serverLogPath: `${HOME}/.local/state/pi-workspace-mvp/server.log`,
			serverIdFile: `${HOME}/.local/state/pi-workspace-mvp/server/default-server-id`,
			bridgePath: `${HOME}/.local/share/pi-workspace-mvp/${REVISION}/scripts/workspace-ssh-bridge.mjs`,
			cliEntry: `${HOME}/.local/share/pi-workspace-mvp/${REVISION}/packages/coding-agent/dist/bundle/cli.js`,
			markerPath: `${HOME}/.local/share/pi-workspace-mvp/${REVISION}/.pi-workspace-staged`,
			standalone: false,
		});
	});

	test("builds content-addressed standalone backend paths", () => {
		const manifestDigest = "b".repeat(64);
		const artifactDigest = "a".repeat(64);
		const release = `${manifestDigest}-${artifactDigest}`;
		expect(buildInstalledWorkspaceRemotePaths(HOME, REVISION, manifestDigest, artifactDigest)).toMatchObject({
			shareRoot: `${HOME}/.local/share/pi-workspace-server`,
			stateRoot: `${HOME}/.local/state/pi-workspace-server`,
			revisionDir: `${HOME}/.local/share/pi-workspace-server/releases/${release}`,
			bridgePath: `${HOME}/.local/share/pi-workspace-server/releases/${release}/bin/pi-workspace-server`,
			cliEntry: `${HOME}/.local/share/pi-workspace-server/releases/${release}/bin/pi-workspace-server`,
			standalone: true,
		});
	});

	test("builds the actual source and standalone SSH bridge argv", () => {
		const source = paths();
		const toolchain = {
			home: HOME,
			nodePath: `${HOME}/.volta/bin/node`,
			npmPath: `${HOME}/.volta/bin/npm`,
			nodeVersion: "v22.23.2",
		};
		const socket = serverSocketPath(source, SERVER_ID);
		expect(workspaceSshRemoteCommand(source, toolchain, socket)).toEqual([
			toolchain.nodePath,
			source.bridgePath,
			socket,
		]);
		const standalone = buildInstalledWorkspaceRemotePaths(HOME, REVISION, "b".repeat(64), "a".repeat(64));
		const standaloneCommand = workspaceSshRemoteCommand(
			standalone,
			{ ...toolchain, nodePath: "/usr/bin/env" },
			socket,
		);
		expect(standaloneCommand).toEqual([standalone.bridgePath, socket]);
		expect(buildSshSpawnArgs({ host: "workspace-bcli-10", remoteCommand: standaloneCommand })).toEqual([
			"ssh",
			"-o",
			"BatchMode=yes",
			"-o",
			"RequestTTY=no",
			"-o",
			"ClearAllForwardings=yes",
			"workspace-bcli-10",
			`${standalone.bridgePath} ${socket}`,
		]);
	});

	test("derives the coordinator socket from the server identity", () => {
		expect(serverSocketPath(paths(), SERVER_ID)).toBe(
			`${HOME}/.local/state/pi-workspace-mvp/server/${SERVER_ID}.sock`,
		);
		expect(() => serverSocketPath(paths(), "not-a-server-id")).toThrow(/Invalid remote server identity/);
	});

	test("validates remote paths", () => {
		expect(requireValidRemotePath("/home/bits/dir/", "label")).toBe("/home/bits/dir");
		expect(() => requireValidRemotePath("relative", "label")).toThrow(/Invalid label/);
		expect(() => requireValidRemotePath("/a b", "label")).toThrow(/Invalid label/);
		expect(() => requireValidRemotePath("/../etc", "label")).toThrow(/Invalid label/);
		expect(() => requireValidRemotePath("/", "label")).toThrow(/Invalid label/);
	});

	test("prefers the conventional dd-source checkout and safely falls back to DATADOG_ROOT", () => {
		expect(remoteCommands.probeDefaultCwd).toContain('test -d "$DATADOG_ROOT/dd-source"');
		expect(remoteCommands.probeDefaultCwd).toContain('printf %s "$DATADOG_ROOT/dd-source"');
		expect(remoteCommands.probeDefaultCwd).toContain('elif test -d "$DATADOG_ROOT"');
	});

	test("builds a detached server start command with validated values", () => {
		const command = remoteCommands.startServer({
			paths: paths(),
			toolchain: {
				home: HOME,
				nodePath: `${HOME}/.volta/bin/node`,
				npmPath: `${HOME}/.volta/bin/npm`,
				nodeVersion: "v22.23.2",
			},
			remoteCwd: REMOTE_CWD,
			serverId: SERVER_ID,
			pluginPackages: [`${HOME}/plugins/example`],
			generation: GENERATION,
		});
		expect(command).toContain("cd /home/bits/go/src/github.com/DataDog/dd-source && { nohup env PI_EXPERIMENTAL=1");
		expect(command).toContain("--session-dir /home/bits/.local/state/pi-workspace-mvp/sessions");
		expect(command).toContain(`--server-id ${SERVER_ID}`);
		expect(command).toContain("-e /home/bits/plugins/example");
		expect(command).toContain(
			`--ready-file ${HOME}/.local/state/pi-workspace-mvp/server.revision --generation ${GENERATION}`,
		);
		expect(command).toContain(">> /home/bits/.local/state/pi-workspace-mvp/server.log 2>&1 < /dev/null &");
		expect(command).not.toContain(`printf %s ${REVISION}`);
		expect(command).toMatch(/chmod 600 \S+\/server\.pid; \}$/);
	});

	test("rejects unvalidated values in remote command builders", () => {
		const toolchain = {
			home: HOME,
			nodePath: `${HOME}/.volta/bin/node`,
			npmPath: `${HOME}/.volta/bin/npm`,
			nodeVersion: "v22.23.2",
		};
		expect(() =>
			remoteCommands.startServer({
				paths: paths(),
				toolchain,
				remoteCwd: "not/absolute",
				pluginPackages: [],
				generation: GENERATION,
			}),
		).toThrow(/Invalid remote working directory/);
		expect(() =>
			remoteCommands.startServer({
				paths: paths(),
				toolchain,
				remoteCwd: REMOTE_CWD,
				serverId: "not-a-server-id",
				pluginPackages: [],
				generation: GENERATION,
			}),
		).toThrow(/Invalid remote server identity/);
		expect(() =>
			remoteCommands.startServer({
				paths: paths(),
				toolchain,
				remoteCwd: REMOTE_CWD,
				pluginPackages: ["; rm -rf /"],
				generation: GENERATION,
			}),
		).toThrow(/Invalid plugin package/);
		expect(() => remoteCommands.writeMarker(paths(), "not-a-revision")).toThrow(/Invalid revision/);
	});

	test("builds a locked, transfer-verified standalone install without trusting remote tar paths", () => {
		const manifestDigest = "b".repeat(64);
		const artifactDigest = "a".repeat(64);
		const installed = buildInstalledWorkspaceRemotePaths(HOME, REVISION, manifestDigest, artifactDigest);
		const command = remoteCommands.installArtifact(installed, artifactDigest);
		const reuse = remoteCommands.isInstalled(installed, artifactDigest);
		const reuseLocked = reuse.indexOf("flock -w 120 9");
		const reuseModeVerified = reuse.indexOf(`test -x ${installed.cliEntry}`);
		const reuseActivated = reuse.indexOf(`ln -s releases/${manifestDigest}-${artifactDigest}`);
		expect(reuseLocked).toBeGreaterThan(-1);
		expect(reuseModeVerified).toBeGreaterThan(reuseLocked);
		expect(reuseActivated).toBeGreaterThan(reuseModeVerified);
		expect(reuse).toContain(`test -x ${installed.revisionDir}/bin/esbuild`);
		expect(reuse).toContain("trap cleanup_workspace_reuse EXIT HUP INT TERM");
		expect(command).toContain(
			`sha256sum ${installed.shareRoot}/.install-${manifestDigest}-${artifactDigest}-$$.tar.gz`,
		);
		expect(command).toContain("--no-same-owner --no-same-permissions");
		expect(command).toContain(".pi-workspace-artifact.json");
		expect(command).toContain("sha256sum > .tree.sha256");
		expect(command).toContain(`[ ! -L ${installed.shareRoot}/current ]`);
		const lockAcquired = command.indexOf(`flock -w 120 9`);
		const archiveReceived = command.indexOf(`cat > ${installed.shareRoot}/.install-`);
		expect(lockAcquired).toBeGreaterThan(-1);
		expect(archiveReceived).toBeGreaterThan(lockAcquired);
		expect(command).toContain("trap cleanup_workspace_install EXIT HUP INT TERM");
		expect(command).toContain(`test -f ${installed.shareRoot}/.install-transaction.lock`);
		expect(command).toContain(`stat -c %u ${installed.shareRoot}/.install-transaction.lock`);
		expect(command).toContain(`for scratch in ${installed.shareRoot}/.candidate-*`);
		expect(command).toContain(`${installed.shareRoot}/releases/.repair-*`);
		const candidate = `${installed.shareRoot}/.candidate-${manifestDigest}-${artifactDigest}-$$`;
		const fallback = `${installed.shareRoot}/releases/.repair-${manifestDigest}-${artifactDigest}-$$`;
		const quarantine = `${installed.shareRoot}/quarantine/${manifestDigest}-${artifactDigest}-$$`;
		const candidateModeVerified = command.indexOf(`test -x ${candidate}/bin/pi-workspace-server`);
		const candidateVerified = command.indexOf(`cd ${candidate} && test -z`);
		const fallbackActivated = command.indexOf(`ln -s releases/.repair-${manifestDigest}-${artifactDigest}-$$`);
		const quarantined = command.indexOf(`mv -T ${installed.revisionDir} ${quarantine}`);
		const replacementActivated = command.indexOf(`mv -T ${candidate} ${installed.revisionDir}`);
		expect(candidateModeVerified).toBeGreaterThan(-1);
		expect(candidateVerified).toBeGreaterThan(candidateModeVerified);
		expect(fallbackActivated).toBeGreaterThan(candidateVerified);
		expect(quarantined).toBeGreaterThan(fallbackActivated);
		expect(replacementActivated).toBeGreaterThan(quarantined);
		expect(command).toContain(`rm -rf ${installed.revisionDir} && mv -T ${quarantine} ${installed.revisionDir}`);
		expect(command).toContain(`rm -rf ${fallback}`);
		const targetModeVerified = command.indexOf(`test -x ${installed.revisionDir}/bin/pi-workspace-server`);
		const targetActivated = command.indexOf(`ln -s releases/${manifestDigest}-${artifactDigest}`);
		expect(targetModeVerified).toBeGreaterThan(-1);
		expect(targetActivated).toBeGreaterThan(targetModeVerified);
	});

	test("builds stop and purge commands that only touch MVP-owned paths", () => {
		const built = paths();
		expect(remoteCommands.stopServer(built)).toContain(`grep -qF ${built.shareRoot}/`);
		expect(remoteCommands.stopServer(built)).toContain("/packages/coding-agent/dist/bundle/cli.js\\ server");
		expect(remoteCommands.stopServer(built)).toMatch(/printf %s stopped; else printf %s absent; fi/);
		expect(remoteCommands.removeStaging(built)).toContain(
			`if [ -f ${built.markerPath} ]; then rm -rf ${built.revisionDir}`,
		);
	});
});

describe("workspace exact generation readiness", () => {
	test("does not probe the old coordinator generation before first attach", async () => {
		const expected = GENERATION;
		const old = `${REVISION}:00000000-0000-4000-8000-000000000099`;
		const generations = [old, old, expected];
		const probes: string[] = [];
		let iteration = 0;
		let clock = 0;
		const serverId = await waitForWorkspaceGeneration(expected, 10_000, {
			readServerId: async () => SERVER_ID,
			readGeneration: async () => generations[Math.min(iteration++, generations.length - 1)],
			hasSocket: async (candidate) => candidate === SERVER_ID,
			probe: async (candidate) => {
				probes.push(candidate);
				return true;
			},
			now: () => clock,
			sleep: async (delayMs) => {
				clock += delayMs;
			},
		});
		expect(serverId).toBe(SERVER_ID);
		expect(probes).toEqual([SERVER_ID]);
		expect(iteration).toBe(3);
	});

	test("times out on a different exact generation without probing generic socket liveness", async () => {
		let clock = 0;
		let probes = 0;
		await expect(
			waitForWorkspaceGeneration(GENERATION, 1_000, {
				readServerId: async () => SERVER_ID,
				readGeneration: async () => `${REVISION}:00000000-0000-4000-8000-000000000099`,
				hasSocket: async () => true,
				probe: async () => {
					probes += 1;
					return true;
				},
				now: () => clock,
				sleep: async (delayMs) => {
					clock += delayMs;
				},
			}),
		).rejects.toThrow(/exact Workspace server generation/);
		expect(probes).toBe(0);
	});
});

describe("workspace local state", () => {
	test("persists reconnect identity under 0700/0600 permissions", async () => {
		const root = await mkdtemp(join("/tmp", "pi-workspace-state-"));
		try {
			expect(await readWorkspaceLocalState("workspace-bcli-10", REMOTE_CWD, { root })).toBeUndefined();
			const state = { revision: REVISION, serverId: SERVER_ID, sessionId: "00000000-0000-4000-8000-000000000002" };
			await writeWorkspaceLocalState("workspace-bcli-10", REMOTE_CWD, state, { root });
			expect(await readWorkspaceLocalState("workspace-bcli-10", REMOTE_CWD, { root })).toEqual(state);
			const stateDirectory = await stat(join(root, "workspace-bcli-10"));
			expect(stateDirectory.mode & 0o777).toBe(0o700);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("ignores corrupted local state", async () => {
		const root = await mkdtemp(join("/tmp", "pi-workspace-state-"));
		try {
			const state = { revision: REVISION, serverId: SERVER_ID, sessionId: "00000000-0000-4000-8000-000000000002" };
			await writeWorkspaceLocalState("workspace-bcli-10", REMOTE_CWD, state, { root });
			const path = join(root, "workspace-bcli-10");
			const files = await readdir(path);
			await writeFile(join(path, files[0]!), "{invalid", "utf8");
			expect(await readWorkspaceLocalState("workspace-bcli-10", REMOTE_CWD, { root })).toBeUndefined();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
