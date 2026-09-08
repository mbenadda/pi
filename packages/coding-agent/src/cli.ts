#!/usr/bin/env node
import { basename } from "node:path";
import { setupCli } from "./cli/setup.ts";
import { runPiw } from "./experimental/piw.ts";
import { consumeInternalProcessRole } from "./experimental/process.ts";
import { runServerProcess } from "./experimental/server.ts";
import { runSessionWorkerProcess } from "./experimental/session-worker.ts";
import { main } from "./main.ts";

const internalProcessRole = consumeInternalProcessRole();
if (internalProcessRole === "server") {
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
	if (internalProcessRole !== undefined) {
		throw new Error(`Internal ${internalProcessRole} process must use its lightweight entrypoint`);
	}
	setupCli();

	if (basename(process.execPath) === "piw" || basename(process.argv[1] ?? "") === "piw") {
		void runPiw(process.argv.slice(2));
	} else {
		main(process.argv.slice(2));
	}
}
