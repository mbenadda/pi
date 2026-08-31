#!/usr/bin/env node
import { runCoordinatorProcess } from "../experimental/coordinator.ts";
import { consumeInternalProcessRole, getInternalProcessRole } from "../experimental/process.ts";
import { runWorkspaceSshBridge } from "../experimental/workspace-ssh-bridge.ts";
import { restoreSandboxEnv } from "./restore-sandbox-env.ts";

restoreSandboxEnv();

if (getInternalProcessRole() === "coordinator") {
	consumeInternalProcessRole();
	await runCoordinatorProcess(process.argv.slice(2));
} else if (process.argv[2] === "--workspace-ssh-bridge") {
	await runWorkspaceSshBridge(process.argv.slice(3));
} else {
	await import("./runtime-setup.ts");
	await import("../cli.ts");
}
