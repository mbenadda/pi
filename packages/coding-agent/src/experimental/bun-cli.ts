#!/usr/bin/env node
/**
 * Standalone Workspace entrypoint for compiled Bun executables (fork-only, never published).
 *
 * Mirrors src/experimental/standalone-cli.ts for the standalone binaries (`pi`, `piw`,
 * `pi-workspace-server` roles). Imports stay top-level on purpose: a compiled executable only
 * bundles its entry's static module graph, so the sandbox environment setup must run before any
 * module that reads the environment, and the Bun runtime registration (OAuth flow loaders + the
 * static Bedrock module) must run before every model/auth path below, including the internal
 * roles. The alternative the ai package uses for treeshaking - variable-specifier dynamic
 * imports - cannot resolve inside a compiled executable.
 */
import "../bun/sandbox-env-setup.ts";
import "../bun/runtime-setup.ts";
import { basename } from "node:path";
import { setupCli } from "../cli/setup.ts";
import { main } from "../main.ts";
import { runExperimentalCommand } from "./commands.ts";
import { runCoordinatorProcess } from "./coordinator.ts";
import { runPiw } from "./piw.ts";
import { consumeInternalProcessRole } from "./process.ts";
import { runServerProcess } from "./server.ts";
import { runSessionWorkerProcess } from "./session-worker.ts";
import { runWorkspaceSshBridge } from "./workspace-ssh-bridge.ts";

const args = process.argv.slice(2);
const internalProcessRole = consumeInternalProcessRole();
if (internalProcessRole === "coordinator") {
	void runCoordinatorProcess(args).catch((error: unknown) => {
		console.error(error);
		process.exit(1);
	});
} else if (internalProcessRole === "server") {
	void runServerProcess(args).catch((error: unknown) => {
		console.error(error);
		process.exit(1);
	});
} else if (internalProcessRole === "session-worker") {
	void runSessionWorkerProcess(args).catch((error: unknown) => {
		console.error(error);
		process.exit(1);
	});
} else if (basename(process.execPath) === "pi-workspace-server" && args.length === 1) {
	await runWorkspaceSshBridge(args);
} else {
	setupCli();
	if (basename(process.execPath) === "piw" || basename(process.argv[1] ?? "") === "piw") {
		void runPiw(args);
	} else if (await runExperimentalCommand(args)) {
		if (args[0] === "client" || args[0] === "workspace") process.exit(process.exitCode ?? 0);
	} else {
		await main(args);
	}
}
