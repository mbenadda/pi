#!/usr/bin/env node
import { basename } from "node:path";
import { runCoordinatorProcess } from "../experimental/coordinator.ts";
import { consumeInternalProcessRole, getInternalProcessRole } from "../experimental/process.ts";
import { runWorkspaceSshBridge } from "../experimental/workspace-ssh-bridge.ts";
import "./sandbox-env-setup.ts";

const internalProcessRole = getInternalProcessRole();
if (internalProcessRole === "coordinator") {
	consumeInternalProcessRole();
	await runCoordinatorProcess(process.argv.slice(2));
} else if (
	internalProcessRole === undefined &&
	basename(process.execPath) === "pi-workspace-server" &&
	process.argv.slice(2).length === 1
) {
	await runWorkspaceSshBridge(process.argv.slice(2));
} else {
	await import("./runtime-setup.ts");
	await import("../cli.ts");
}
