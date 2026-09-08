#!/usr/bin/env node
/**
 * Standalone Workspace entrypoint for compiled Bun executables (fork-only, never published).
 *
 * Mirrors src/experimental/standalone-cli.ts for the standalone binaries (`pi`, `piw`,
 * `pi-workspace-server` roles). Internal role and bridge processes must stay lightweight, so
 * only the sandbox environment setup runs before dispatch and the stable CLI runtime is loaded
 * lazily on the user-facing path.
 */
import "../bun/sandbox-env-setup.ts";
import { basename } from "node:path";
import { setupCli } from "../cli/setup.ts";
import { consumeInternalProcessRole, getInternalProcessRole } from "./process.ts";
import { runWorkspaceSshBridge } from "./workspace-ssh-bridge.ts";

const internalProcessRole = getInternalProcessRole();
if (internalProcessRole !== undefined) {
	consumeInternalProcessRole();
	if (internalProcessRole === "coordinator") {
		await (await import("./coordinator.ts")).runCoordinatorProcess(process.argv.slice(2));
	} else if (internalProcessRole === "server") {
		await (await import("./server.ts")).runServerProcess(process.argv.slice(2));
	} else {
		await (await import("./session-worker.ts")).runSessionWorkerProcess(process.argv.slice(2));
	}
} else if (basename(process.execPath) === "pi-workspace-server" && process.argv.slice(2).length === 1) {
	await runWorkspaceSshBridge(process.argv.slice(2));
} else {
	const args = process.argv.slice(2);
	if (basename(process.execPath) === "piw" || basename(process.argv[1] ?? "") === "piw") {
		setupCli();
		void (await import("./piw.ts")).runPiw(args);
	} else if (
		(args[0] === "server" || args[0] === "client" || args[0] === "workspace") &&
		(await import("../core/experimental.ts")).areExperimentalFeaturesEnabled()
	) {
		setupCli();
		await (await import("./commands.ts")).runExperimentalCommand(args);
		if (args[0] === "client" || args[0] === "workspace") process.exit(process.exitCode ?? 0);
	} else {
		await import("../bun/runtime-setup.ts");
		await import("../cli.ts");
	}
}
