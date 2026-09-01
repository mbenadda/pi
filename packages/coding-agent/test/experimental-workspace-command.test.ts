import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
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
import { buildSshSpawnArgs } from "@earendil-works/pi-client/ssh";
import { describe, expect, test } from "vitest";
import { cli } from "../src/cli/experimental/cli.ts";
import {
	buildInstalledWorkspaceRemotePaths,
	buildWorkspaceRemotePaths,
	REMOTE_ARTIFACT_INSTALL_TIMEOUT_MS,
	REMOTE_INSTALL_CHECK_TIMEOUT_MS,
	REMOTE_INSTALL_LOCK_WAIT_MS,
	readWorkspaceLocalState,
	remoteCommands,
	requireValidRemotePath,
	SSH_EXEC_TIMEOUT_MS,
	serverSocketPath,
	sshExec,
	waitForWorkspaceGeneration,
	workspaceSshRemoteCommand,
	writeWorkspaceLocalState,
} from "../src/experimental/workspace.ts";

const HOME = "/home/bits";
const REVISION = "0123456789abcdef0123456789abcdef01234567";
const SERVER_ID = "00000000-0000-4000-8000-000000000001";
const GENERATION = `${REVISION}:00000000-0000-4000-8000-000000000003`;
const REMOTE_CWD = "/home/bits/go/src/github.com/DataDog/dd-source";

function remoteInstallArchive(): Buffer {
	const files = [
		{ path: ".pi-workspace-artifact.json", data: "{}", mode: 0o600 },
		{ path: "bin/pi-workspace-server", data: "server", mode: 0o700 },
		{ path: "bin/esbuild", data: "esbuild", mode: 0o700 },
	];
	const blocks: Buffer[] = [];
	for (const file of files) {
		const data = Buffer.from(file.data);
		const header = Buffer.alloc(512);
		header.write(file.path, 0, 100, "utf8");
		for (const [offset, length, value] of [
			[100, 8, file.mode],
			[108, 8, 0],
			[116, 8, 0],
			[124, 12, data.length],
			[136, 12, 0],
		] as const) {
			header.write(value.toString(8).padStart(length - 1, "0"), offset, length - 1, "ascii");
			header[offset + length - 1] = 0;
		}
		header.fill(32, 148, 156);
		header[156] = "0".charCodeAt(0);
		header.write("ustar", 257, 6, "ascii");
		header.write("00", 263, 2, "ascii");
		let checksum = 0;
		for (const byte of header) checksum += byte;
		header.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii");
		header[154] = 0;
		header[155] = 32;
		blocks.push(header, data);
		const padding = (512 - (data.length % 512)) % 512;
		if (padding > 0) blocks.push(Buffer.alloc(padding));
	}
	blocks.push(Buffer.alloc(1024));
	return gzipSync(Buffer.concat(blocks));
}

const HOMEBREW_GNU_TOOL_DIRECTORIES = ["/opt/homebrew", "/usr/local"].flatMap((prefix) => [
	`${prefix}/opt/coreutils/libexec/gnubin`,
	`${prefix}/opt/findutils/libexec/gnubin`,
	`${prefix}/opt/gnu-tar/libexec/gnubin`,
]);

function shellTestPath(): string {
	return process.platform === "darwin"
		? [...HOMEBREW_GNU_TOOL_DIRECTORIES, process.env.PATH ?? ""].join(":")
		: (process.env.PATH ?? "");
}

function hasGeneratedShellTools(): boolean {
	return ["stat", "find", "tar", "mv", "sha256sum"].every((tool) => {
		const result = spawnSync(tool, ["--version"], {
			env: { ...process.env, PATH: shellTestPath() },
			encoding: "utf8",
		});
		return result.status === 0 && /GNU|coreutils/iu.test(`${result.stdout}${result.stderr}`);
	});
}

const GENERATED_SHELL_TOOLS_AVAILABLE = hasGeneratedShellTools();
const GENERATED_SHELL_REQUIREMENTS =
	process.platform === "darwin"
		? "requires: brew install coreutils findutils gnu-tar"
		: "requires GNU coreutils, findutils, and tar";
const GENERATED_SHELL_TEST_NAME = `executes install transactions under sh and zsh (${GENERATED_SHELL_REQUIREMENTS})`;

function generatedShellTest(name: string, run: () => Promise<void>): void {
	const selectedTest = GENERATED_SHELL_TOOLS_AVAILABLE ? test : test.skip;
	selectedTest(name, run, 60_000);
}

function runGeneratedShell(
	shell: string,
	command: string,
	input?: Uint8Array,
): Promise<{ code: number; signal: NodeJS.Signals | null; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(shell, shell.endsWith("zsh") ? ["-f", "-c", command] : ["-c", command], {
			env: { ...process.env, PATH: shellTestPath() },
			stdio: ["pipe", "ignore", "pipe"],
		});
		let stderr = "";
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.once("error", reject);
		child.once("exit", (code, signal) => resolve({ code: code ?? 1, signal, stderr }));
		child.stdin.end(input);
	});
}

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
		const reuseLocked = reuse.indexOf("acquire_install_lock");
		const reuseModeVerified = reuse.indexOf(`test -x ${installed.cliEntry}`);
		const reuseActivated = reuse.indexOf(`ln -s releases/${manifestDigest}-${artifactDigest}`);
		expect(reuse).not.toContain("flock");
		expect(reuseLocked).toBeGreaterThan(-1);
		expect(reuseModeVerified).toBeGreaterThan(reuseLocked);
		expect(reuseActivated).toBeGreaterThan(reuseModeVerified);
		expect(reuse).toContain(`test -x ${installed.revisionDir}/bin/esbuild`);
		expect(reuse).toContain("trap cleanup_workspace_reuse EXIT HUP INT TERM");
		expect(reuse).not.toMatch(/\bstatus=/u);
		expect(command).not.toMatch(/\bstatus=/u);
		expect(command).toContain(
			`sha256sum ${installed.shareRoot}/.install-${manifestDigest}-${artifactDigest}-$$.tar.gz`,
		);
		expect(command).toContain("--no-same-owner --no-same-permissions");
		expect(command).toContain(".pi-workspace-artifact.json");
		expect(command).toContain("sha256sum > .tree.sha256");
		expect(command).toContain(`[ ! -L ${installed.shareRoot}/current ]`);
		const lockAcquired = command.lastIndexOf(`acquire_install_lock`);
		const archiveReceived = command.indexOf(`cat > ${installed.shareRoot}/.install-`);
		expect(command).not.toContain("flock");
		expect(lockAcquired).toBeGreaterThan(-1);
		expect(archiveReceived).toBeGreaterThan(lockAcquired);
		expect(command).toContain("trap cleanup_workspace_install EXIT HUP INT TERM");
		expect(command).toContain(`mkdir ${installed.shareRoot}/.install-transaction-lock`);
		expect(command).toContain(`stat -c %u ${installed.shareRoot}/.install-transaction-lock`);
		expect(command).toContain("required remote install tool missing");
		expect(command).toContain(`-name .install-\\* ! -name .install-transaction-lock`);
		expect(command).toContain(`-name .candidate-\\*`);
		expect(command).toContain(`-name .lock-recovery-\\*`);
		expect(command).toContain("while sleep 1; do validate_install_lock_owner");
		expect(command).toContain(`touch -c ${installed.shareRoot}/.install-transaction-lock`);
		expect(command.indexOf("validate_install_lock_owner")).toBeLessThan(
			command.indexOf(`touch -c ${installed.shareRoot}/.install-transaction-lock`),
		);
		const lockAcquisition = command.slice(
			command.indexOf("acquire_install_lock()"),
			command.indexOf("& piw_lock_heartbeat=$!"),
		);
		expect(lockAcquisition.match(/continue;/gu)).toHaveLength(4);
		expect(lockAcquisition.match(/retry_install_lock \|\| return 1; continue;/gu)).toHaveLength(4);
		expect(command).toContain("piw_lock_attempt=$((piw_lock_attempt+1)); sleep 1");
		expect(command).toContain(`find ${installed.shareRoot}/releases -mindepth 1 -maxdepth 1 -name .repair-\\*`);
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
		expect(command).toContain(`piw_preserve_fallback=${fallback}`);
		expect(command).toContain(`piw_preserve_fallback= && rm -rf ${fallback}`);
		const targetModeVerified = command.indexOf(`test -x ${installed.revisionDir}/bin/pi-workspace-server`);
		const targetActivated = command.lastIndexOf(`ln -s releases/${manifestDigest}-${artifactDigest}`);
		expect(targetModeVerified).toBeGreaterThan(-1);
		expect(targetActivated).toBeGreaterThan(targetModeVerified);
	});

	test("orders default SSH, lock wait, install check, and artifact upload timeouts", () => {
		expect(SSH_EXEC_TIMEOUT_MS).toBeLessThan(REMOTE_INSTALL_LOCK_WAIT_MS);
		expect(REMOTE_INSTALL_LOCK_WAIT_MS).toBeGreaterThanOrEqual(120_000);
		expect(REMOTE_INSTALL_LOCK_WAIT_MS).toBeLessThan(REMOTE_INSTALL_CHECK_TIMEOUT_MS);
		expect(REMOTE_INSTALL_CHECK_TIMEOUT_MS).toBeLessThan(REMOTE_ARTIFACT_INSTALL_TIMEOUT_MS);
	});

	test("treats a signal-only generated shell exit as a failure", async () => {
		await expect(runGeneratedShell("/bin/sh", "kill -TERM $$")).resolves.toMatchObject({
			code: 1,
			signal: "SIGTERM",
		});
	});

	test("treats a signal-only SSH exit as a production failure", async () => {
		const fakeBin = await mkdtemp(join(tmpdir(), "pi-workspace-ssh-signal-"));
		const originalPath = process.env.PATH;
		try {
			await writeFile(join(fakeBin, "ssh"), "#!/bin/sh\nkill -TERM $$\n", { mode: 0o700 });
			process.env.PATH = `${fakeBin}:${originalPath ?? ""}`;
			await expect(sshExec("workspace-bcli-10", "true")).rejects.toThrow(/terminated by signal SIGTERM/);
		} finally {
			process.env.PATH = originalPath;
			await rm(fakeBin, { recursive: true, force: true });
		}
	});

	generatedShellTest(GENERATED_SHELL_TEST_NAME, async () => {
		const shells = ["/bin/sh", "/bin/zsh"].filter(existsSync);
		expect(shells).toContain("/bin/sh");
		const archive = remoteInstallArchive();
		const artifactDigest = createHash("sha256").update(archive).digest("hex");
		const manifestDigest = "b".repeat(64);
		for (const shell of shells) {
			const home = await mkdtemp(join(tmpdir(), "pi-workspace-shell-"));
			try {
				const installed = buildInstalledWorkspaceRemotePaths(home, REVISION, manifestDigest, artifactDigest);
				await Promise.all([
					mkdir(join(installed.shareRoot, "releases"), { recursive: true, mode: 0o700 }),
					mkdir(join(installed.shareRoot, "quarantine"), { recursive: true, mode: 0o700 }),
				]);
				await chmod(installed.shareRoot, 0o700);
				const install = remoteCommands.installArtifact(installed, artifactDigest);
				const installs =
					shell === "/bin/sh"
						? await Promise.all([
								runGeneratedShell(shell, install, archive),
								runGeneratedShell(shell, install, archive),
							])
						: [await runGeneratedShell(shell, install, archive)];
				expect(
					installs.every((result) => result.code === 0),
					`${shell}: ${installs.map((result) => result.stderr).join("\n")}`,
				).toBe(true);
				expect(await readlink(join(installed.shareRoot, "current"))).toBe(
					`releases/${manifestDigest}-${artifactDigest}`,
				);
				expect(await readFile(installed.cliEntry, "utf8")).toBe("server");

				await mkdir(join(installed.shareRoot, ".install-stale"));
				await writeFile(join(installed.shareRoot, ".install-stale.tar.gz"), "partial", "utf8");
				await symlink("releases/missing", join(installed.shareRoot, ".current-stale"));
				await mkdir(join(installed.shareRoot, "releases", ".repair-stale"));
				const reuse = remoteCommands.isInstalled(installed, artifactDigest);
				const reused =
					shell === "/bin/sh"
						? await Promise.all([runGeneratedShell(shell, reuse), runGeneratedShell(shell, reuse)])
						: [await runGeneratedShell(shell, reuse)];
				expect(
					reused.every((result) => result.code === 0),
					`${shell}: ${reused.map((result) => result.stderr).join("\n")}`,
				).toBe(true);
				const scratch = await readdir(installed.shareRoot);
				expect(scratch.some((name) => name.startsWith(".install-") && name !== ".install-transaction-lock")).toBe(
					false,
				);
				expect(scratch.some((name) => name.startsWith(".current-"))).toBe(false);
				expect(scratch.some((name) => name.startsWith(".lock-recovery-"))).toBe(false);
				expect(
					(await readdir(join(installed.shareRoot, "releases"))).some((name) => name.startsWith(".repair-")),
				).toBe(false);

				if (shell === "/bin/sh") {
					const unsafeScratch = join(installed.shareRoot, ".candidate-unsafe");
					await symlink("missing", unsafeScratch);
					const unsafeScratchResult = await runGeneratedShell(shell, reuse);
					expect(unsafeScratchResult.code).not.toBe(0);
					expect(unsafeScratchResult.stderr).toContain("failed to prune remote install scratch after activation");
					await rm(unsafeScratch);

					const lock = join(installed.shareRoot, ".install-transaction-lock");
					await symlink("missing", lock);
					const unsafeLockResult = await runGeneratedShell(shell, reuse);
					expect(unsafeLockResult.code).not.toBe(0);
					expect(unsafeLockResult.stderr).toContain("unsafe remote install lock");
					await rm(lock);
					await mkdir(lock, { mode: 0o700 });
					await writeFile(join(lock, "owner"), "999999999", "utf8");
					await utimes(lock, new Date(0), new Date(0));
					expect(await runGeneratedShell(shell, reuse)).toMatchObject({ code: 0 });

					await writeFile(installed.cliEntry, "corrupt", "utf8");
					const faultBin = join(home, "fault-bin");
					await mkdir(faultBin, { mode: 0o700 });
					const realMv = spawnSync("sh", ["-c", "command -v mv"], {
						env: { ...process.env, PATH: shellTestPath() },
						encoding: "utf8",
					}).stdout.trim();
					const faultMv = join(faultBin, "mv");
					await writeFile(
						faultMv,
						`#!/bin/sh\ncase "$2" in *.candidate-*|*/quarantine/*) exit 91;; esac\nexec ${realMv} "$@"\n`,
						{ mode: 0o700 },
					);
					const failedRepair = await runGeneratedShell(
						shell,
						`PATH=${faultBin}:${shellTestPath()}; export PATH; ${install}`,
						archive,
					);
					expect(failedRepair.code).not.toBe(0);
					expect(await readlink(join(installed.shareRoot, "current"))).toMatch(/^releases\/\.repair-/u);
					expect(await readFile(join(installed.shareRoot, "current", "bin", "pi-workspace-server"), "utf8")).toBe(
						"server",
					);
					expect(
						(await readdir(join(installed.shareRoot, "releases"))).some((name) => name.startsWith(".repair-")),
					).toBe(true);
					expect(await runGeneratedShell(shell, install, archive)).toMatchObject({ code: 0 });
				}
			} finally {
				await rm(home, { recursive: true, force: true });
			}
		}
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
