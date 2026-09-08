#!/usr/bin/env node
/**
 * Standalone Workspace CLI entrypoint (fork-only, never published).
 *
 * Upstream's published entrypoints (src/cli.ts, src/main.ts, and the package root) stay free
 * of experimental imports; tsconfig.build.json excludes this tree from the published build and
 * the package.json file allowlist keeps its output out of the npm tarball. This entry adds what
 * the standalone Workspace runtime needs on top of the stable CLI: internal-process role
 * dispatch, the experimental server/client/workspace commands behind PI_EXPERIMENTAL, and
 * `piw`, then falls back to the stable main().
 *
 * The compiled-Bun counterpart is src/experimental/bun-cli.ts. tsconfig.standalone.json compiles
 * this tree into dist so the checkout-backed development path can run
 * `node dist/experimental/standalone-cli.js server`.
 */
import { basename } from "node:path";
import { setupCli } from "../cli/setup.ts";
import { main } from "../main.ts";
import { runExperimentalCommand } from "./commands.ts";
import { runCoordinatorProcess } from "./coordinator.ts";
import { runPiw } from "./piw.ts";
import { consumeInternalProcessRole } from "./process.ts";
import { runServerProcess } from "./server.ts";
import { runSessionWorkerProcess } from "./session-worker.ts";

const internalProcessRole = consumeInternalProcessRole();
if (internalProcessRole === "coordinator") {
	void runCoordinatorProcess(process.argv.slice(2)).catch((error: unknown) => {
		console.error(error);
		process.exit(1);
	});
} else if (internalProcessRole === "server") {
	void runServerProcess(process.argv.slice(2)).catch((error: unknown) => {
		console.error(error);
		process.exit(1);
	});
} else if (internalProcessRole === "session-worker") {
	void runSessionWorkerProcess(process.argv.slice(2)).catch((error: unknown) => {
		console.error(error);
		process.exit(1);
	});
} else {
	setupCli();
	const args = process.argv.slice(2);
	// piw keeps precedence over the experimental commands so a Workspace named "server",
	// "client", or "workspace" still launches through piw (matches experimental/bun-cli.ts).
	if (basename(process.execPath) === "piw" || basename(process.argv[1] ?? "") === "piw") {
		void runPiw(args);
	} else if (await runExperimentalCommand(args)) {
		if (args[0] === "client" || args[0] === "workspace") process.exit(process.exitCode ?? 0);
	} else {
		await main(args);
	}
}
