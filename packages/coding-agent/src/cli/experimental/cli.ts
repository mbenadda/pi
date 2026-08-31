import { Command } from "./command.ts";
import { type ClientCommandContext, clientCommand } from "./commands/client.ts";
import { type ServerCommandContext, serverCommand } from "./commands/server.ts";
import { type WorkspaceCommandContext, workspaceCommand } from "./commands/workspace.ts";

interface ExperimentalCommandGroup {
	readonly command: "experimental";
}

export type CliContext = ServerCommandContext & ClientCommandContext & WorkspaceCommandContext;

const experimentalCommand = new Command<ExperimentalCommandGroup, CliContext>("experimental").build(() => ({
	ok: false,
	errors: ["Expected experimental command: server, client, or workspace"],
}));

export const cli = experimentalCommand.command(serverCommand).command(clientCommand).command(workspaceCommand);
