import { isValidSshHost } from "@earendil-works/pi-client/ssh";
import { Command, flagOption, valueOption } from "../command.ts";
import { parseRemoteWorkspacePath, unsupportedOptions } from "../command-options.ts";

export interface WorkspaceCommand {
	readonly command: "workspace";
	readonly sshHost: string;
	readonly remoteCwd: string;
	readonly sessionId?: string;
	readonly newSession?: boolean;
	readonly pluginPackages?: readonly string[];
	readonly status?: boolean;
	readonly cleanup?: boolean;
	readonly purge?: boolean;
}

export interface WorkspaceCommandContext {
	runWorkspace(command: WorkspaceCommand): void | Promise<void>;
}

const sshHostOption = valueOption("--ssh-host", (value) =>
	isValidSshHost(value)
		? { ok: true, value }
		: { ok: false, error: `Invalid --ssh-host "${value}"; expected an OpenSSH host alias` },
);
const remoteCwdOption = valueOption("--remote-cwd", (value) => {
	const result = parseRemoteWorkspacePath(value, "remote working directory");
	return result.path ? { ok: true, value: result.path } : { ok: false, error: result.error! };
});
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const sessionIdOption = valueOption("--session-id", (value) =>
	SESSION_ID_PATTERN.test(value) ? { ok: true, value } : { ok: false, error: `Invalid --session-id "${value}"` },
);
const newSessionOption = flagOption("--new-session");
const pluginPackageOption = valueOption(
	"--plugin",
	(value) => {
		const result = parseRemoteWorkspacePath(value, "plugin package path");
		return result.path ? { ok: true, value: result.path } : { ok: false, error: result.error! };
	},
	{ repeatable: true },
);
const statusOption = flagOption("--status");
const cleanupOption = flagOption("--cleanup");
const purgeOption = flagOption("--purge");

export const workspaceCommand = new Command<WorkspaceCommand, WorkspaceCommandContext>("workspace")
	.option(sshHostOption)
	.option(remoteCwdOption)
	.option(sessionIdOption)
	.option(newSessionOption)
	.option(pluginPackageOption)
	.option(statusOption)
	.option(cleanupOption)
	.option(purgeOption)
	.build((input) => {
		const errors = [...unsupportedOptions("workspace", input)];
		const sshHost = input.value(sshHostOption);
		const remoteCwd = input.value(remoteCwdOption);
		const requestedSessionId = input.value(sessionIdOption);
		const newSession = input.value(newSessionOption) === true;
		const pluginPackages = input.values(pluginPackageOption);
		const status = input.value(statusOption) === true;
		const cleanup = input.value(cleanupOption) === true;
		const purge = input.value(purgeOption) === true;
		if (sshHost === undefined) errors.push("--ssh-host is required");
		if (remoteCwd === undefined) errors.push("--remote-cwd is required");
		if (requestedSessionId !== undefined && newSession) {
			errors.push("--session-id and --new-session are mutually exclusive");
		}
		if (status && (cleanup || purge)) errors.push("--status cannot be combined with --cleanup or --purge");
		if (
			(status || cleanup || purge) &&
			(requestedSessionId !== undefined || newSession || pluginPackages.length > 0)
		) {
			errors.push("Session and plugin selection require a launch");
		}
		if (errors.length > 0) return { ok: false, errors };
		return {
			ok: true,
			command: {
				command: "workspace",
				sshHost: sshHost!,
				remoteCwd: remoteCwd!,
				...(requestedSessionId === undefined ? {} : { sessionId: requestedSessionId }),
				...(newSession ? { newSession: true } : {}),
				...(pluginPackages.length === 0 ? {} : { pluginPackages: [...pluginPackages] }),
				...(status ? { status: true } : {}),
				...(cleanup ? { cleanup: true } : {}),
				...(purge ? { purge: true } : {}),
			},
		};
	})
	.action((command, context) => context.runWorkspace(command));
