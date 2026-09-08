import { writeFile } from "node:fs/promises";
import chalk from "chalk";
import { cli } from "../cli/experimental/cli.ts";
import type { ClientCommand } from "../cli/experimental/commands/client.ts";
import type { ServerCommand } from "../cli/experimental/commands/server.ts";
import type { WorkspaceCommand } from "../cli/experimental/commands/workspace.ts";
import { areExperimentalFeaturesEnabled } from "../core/experimental.ts";
import { runClient } from "./client.ts";
import { runClientTui } from "./client-tui.ts";
import type { RadiusRelayHostStatus } from "./radius-relay.ts";
import { startForegroundServer } from "./server.ts";
import { runWorkspace } from "./workspace.ts";

async function waitForTermination(serverClosed: Promise<void>): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const cleanup = (): void => {
			process.off("SIGINT", finish);
			process.off("SIGTERM", finish);
		};
		const finish = (): void => {
			cleanup();
			resolve();
		};
		const fail = (error: unknown): void => {
			cleanup();
			reject(error);
		};
		process.once("SIGINT", finish);
		process.once("SIGTERM", finish);
		void serverClosed.then(finish, fail);
	});
}

async function runServerCommand(command: ServerCommand): Promise<void> {
	let previousRelayStatus = "";
	let relayOutputReady = false;
	let pendingRelayStatus: RadiusRelayHostStatus | undefined;
	const reportRelayStatus = (status: RadiusRelayHostStatus): void => {
		const description =
			status.status === "connected"
				? "connected"
				: status.status === "not_authenticated"
					? "not connected; local only"
					: status.status === "retrying"
						? `reconnecting: ${status.error}`
						: "connecting";
		if (description === previousRelayStatus || status.status === "connecting") return;
		previousRelayStatus = description;
		console.log(`Radius: ${description}`);
	};
	const runtime = await startForegroundServer({
		serverId: command.serverId,
		sessionDir: command.sessionDir,
		provider: command.provider,
		model: command.model,
		pluginPackages: command.pluginPackages ?? [],
		relayAuth: command.auth,
		onRelayStatus(status) {
			if (relayOutputReady) reportRelayStatus(status);
			else pendingRelayStatus = status;
		},
	});
	try {
		if (command.readyFile !== undefined && command.generation !== undefined) {
			await writeFile(command.readyFile, `${command.generation}\n`, { encoding: "utf8", mode: 0o600 });
		}
		console.log(`Server: ${runtime.serverId}`);
		console.log(`Socket: ${runtime.socketPath}`);
		relayOutputReady = true;
		if (pendingRelayStatus !== undefined) reportRelayStatus(pendingRelayStatus);
		await waitForTermination(runtime.closed);
	} finally {
		await runtime.close();
	}
}

async function runClientCommand(command: ClientCommand): Promise<void> {
	if (command.prompt === undefined && process.stdin.isTTY === true && process.stdout.isTTY === true) {
		await runClientTui(command);
		return;
	}
	let streamedText = false;
	const result = await runClient(command, {
		onEvent(event) {
			if (event.type !== "message_update" || event.frame?.type !== "text_delta") return;
			streamedText = true;
			process.stdout.write(event.frame.delta);
		},
	});
	if (result.kind === "attached") {
		console.log(`${result.serverId}\t${result.sessionId}\tattached`);
		return;
	}
	if (result.kind === "prompted") {
		if (streamedText) process.stdout.write("\n");
		else console.log(result.text);
		return;
	}
	for (const session of result.sessions) console.log(`${session.serverId}\t${session.sessionId}`);
}

async function runWorkspaceCommand(command: WorkspaceCommand): Promise<void> {
	await runWorkspace(command);
}

/**
 * Dispatch for the experimental server, client, and workspace commands.
 *
 * Upstream keeps this behind the development entrypoint only; the standalone Workspace
 * runtime also dispatches it from its own entrypoints (experimental/standalone-cli.ts and
 * experimental/bun-cli.ts, both excluded from the published package) because the pinned
 * backend runs `pi server` / `pi-workspace-server server` from the standalone build.
 */
export async function runExperimentalCommand(args: string[]): Promise<boolean> {
	if (!areExperimentalFeaturesEnabled() || (args[0] !== "server" && args[0] !== "client" && args[0] !== "workspace")) {
		return false;
	}
	try {
		const result = await cli.execute(args, {
			runServer: runServerCommand,
			runClient: runClientCommand,
			runWorkspace: runWorkspaceCommand,
		});
		if (!result.ok) {
			for (const error of result.errors) console.error(chalk.red(`Error: ${error}`));
			process.exitCode = 1;
		}
	} catch (error) {
		console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
		process.exitCode = 1;
	}
	return true;
}
