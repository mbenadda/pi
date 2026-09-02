import { isValidSshHost } from "@earendil-works/pi-client/ssh";
import type { WorkspaceCommand } from "../cli/experimental/commands/workspace.ts";
import { runWorkspace } from "./workspace.ts";

const WORKSPACE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export function workspaceSshHost(name: string): string {
	if (!WORKSPACE_NAME_PATTERN.test(name)) throw new Error(`Invalid Workspace name: ${JSON.stringify(name)}`);
	return `workspace-${name}`;
}

export function parsePiwArgs(args: readonly string[]): WorkspaceCommand {
	let index = 0;
	let action: "launch" | "status" | "stop" | "update" | "login" = "launch";
	const requestedAction = args[index];
	if (
		requestedAction === "status" ||
		requestedAction === "stop" ||
		requestedAction === "update" ||
		requestedAction === "login"
	) {
		action = requestedAction;
		index += 1;
	}
	const workspaceName = args[index++];
	if (workspaceName === undefined) {
		throw new Error("usage: piw [status|stop|update|login] <workspace> [options]");
	}
	let sshHost = workspaceSshHost(workspaceName);
	let remoteCwd: string | undefined;
	let sessionId: string | undefined;
	let newSession = false;
	let noLogin = false;
	const pluginPackages: string[] = [];
	while (index < args.length) {
		const argument = args[index++];
		if (argument === "--no-login") {
			noLogin = true;
			continue;
		}
		if (argument === "--new" || argument === "--new-session") {
			newSession = true;
			continue;
		}
		if (argument === "--cwd" || argument === "--remote-cwd") {
			remoteCwd = requireOptionValue(args, index++, argument);
			continue;
		}
		if (argument === "--ssh-host") {
			sshHost = requireOptionValue(args, index++, argument);
			if (!isValidSshHost(sshHost)) throw new Error(`Invalid SSH host: ${JSON.stringify(sshHost)}`);
			continue;
		}
		if (argument === "--session-id") {
			sessionId = requireOptionValue(args, index++, argument);
			if (!SESSION_ID_PATTERN.test(sessionId)) throw new Error(`Invalid session ID: ${JSON.stringify(sessionId)}`);
			continue;
		}
		if (argument === "--plugin") {
			pluginPackages.push(requireOptionValue(args, index++, argument));
			continue;
		}
		throw new Error(`Unknown piw option: ${argument}`);
	}
	if (sessionId !== undefined && newSession) throw new Error("--session-id and --new are mutually exclusive");
	if (noLogin && action !== "launch") throw new Error("--no-login requires a launch");
	if (action !== "launch" && (sessionId !== undefined || newSession || pluginPackages.length > 0)) {
		throw new Error("Session and plugin selection require a launch");
	}
	if (action === "login" && remoteCwd !== undefined) throw new Error("cwd selection requires a launch");
	return {
		command: "workspace",
		workspaceName,
		sshHost,
		...(remoteCwd === undefined ? {} : { remoteCwd }),
		...(sessionId === undefined ? {} : { sessionId }),
		...(newSession ? { newSession: true } : {}),
		...(pluginPackages.length === 0 ? {} : { pluginPackages }),
		...(action === "status" ? { status: true } : {}),
		...(action === "stop" ? { cleanup: true } : {}),
		...(action === "update" ? { update: true } : {}),
		...(action === "login" ? { login: true } : {}),
		...(noLogin ? { noLogin: true } : {}),
	};
}

export async function runPiw(args: readonly string[]): Promise<void> {
	try {
		await runWorkspace(parsePiwArgs(args));
	} catch (error) {
		console.error(`piw: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}

function requireOptionValue(args: readonly string[], index: number, option: string): string {
	const value = args[index];
	if (value === undefined || value.startsWith("--")) throw new Error(`${option} requires a value`);
	return value;
}
