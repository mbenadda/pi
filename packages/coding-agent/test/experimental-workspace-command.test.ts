import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { cli } from "../src/cli/experimental/cli.ts";
import {
	buildWorkspaceRemotePaths,
	readWorkspaceLocalState,
	remoteCommands,
	requireValidRemotePath,
	serverSocketPath,
	writeWorkspaceLocalState,
} from "../src/experimental/workspace.ts";

const HOME = "/home/bits";
const REVISION = "0123456789abcdef0123456789abcdef01234567";
const SERVER_ID = "00000000-0000-4000-8000-000000000001";
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
		});
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
		});
		expect(command).toContain("cd /home/bits/go/src/github.com/DataDog/dd-source && { nohup env PI_EXPERIMENTAL=1");
		expect(command).toContain("--session-dir /home/bits/.local/state/pi-workspace-mvp/sessions");
		expect(command).toContain(`--server-id ${SERVER_ID}`);
		expect(command).toContain("-e /home/bits/plugins/example");
		expect(command).toContain(">> /home/bits/.local/state/pi-workspace-mvp/server.log 2>&1 < /dev/null &");
		expect(command).toContain(`printf %s ${REVISION} > ${HOME}/.local/state/pi-workspace-mvp/server.revision`);
		expect(command).toMatch(/chmod 600 \S+\/server\.pid \S+\/server\.revision; \}$/);
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
			}),
		).toThrow(/Invalid remote working directory/);
		expect(() =>
			remoteCommands.startServer({
				paths: paths(),
				toolchain,
				remoteCwd: REMOTE_CWD,
				serverId: "not-a-server-id",
				pluginPackages: [],
			}),
		).toThrow(/Invalid remote server identity/);
		expect(() =>
			remoteCommands.startServer({
				paths: paths(),
				toolchain,
				remoteCwd: REMOTE_CWD,
				pluginPackages: ["; rm -rf /"],
			}),
		).toThrow(/Invalid plugin package/);
		expect(() => remoteCommands.writeMarker(paths(), "not-a-revision")).toThrow(/Invalid revision/);
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
