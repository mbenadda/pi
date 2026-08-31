import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export const workspaceSourcePaths = {
	telemetryIndex: fileURLToPath(new URL("./packages/telemetry/src/index.ts", import.meta.url)),
	telemetryTesting: fileURLToPath(new URL("./packages/telemetry/src/testing/index.ts", import.meta.url)),
	aiIndex: fileURLToPath(new URL("./packages/ai/src/index.ts", import.meta.url)),
	aiCompat: fileURLToPath(new URL("./packages/ai/src/compat.ts", import.meta.url)),
	aiOAuth: fileURLToPath(new URL("./packages/ai/src/oauth.ts", import.meta.url)),
	aiProviders: fileURLToPath(new URL("./packages/ai/src/providers", import.meta.url)),
	agentIndex: fileURLToPath(new URL("./packages/agent/src/index.ts", import.meta.url)),
	agentNode: fileURLToPath(new URL("./packages/agent/src/node.ts", import.meta.url)),
	protocolIndex: fileURLToPath(new URL("./packages/protocol/src/index.ts", import.meta.url)),
	clientIndex: fileURLToPath(new URL("./packages/client/src/index.ts", import.meta.url)),
	clientUnix: fileURLToPath(new URL("./packages/client/src/unix.ts", import.meta.url)),
	clientSsh: fileURLToPath(new URL("./packages/client/src/ssh.ts", import.meta.url)),
	serverIndex: fileURLToPath(new URL("./packages/server/src/index.ts", import.meta.url)),
	serverUnix: fileURLToPath(new URL("./packages/server/src/transports/unix/index.ts", import.meta.url)),
	codingAgentIndex: fileURLToPath(new URL("./packages/coding-agent/src/index.ts", import.meta.url)),
	tuiIndex: fileURLToPath(new URL("./packages/tui/src/index.ts", import.meta.url)),
} as const;

export default defineConfig({
	resolve: {
		conditions: ["source"],
		alias: [
			{ find: /^@earendil-works\/pi-telemetry$/, replacement: workspaceSourcePaths.telemetryIndex },
			{ find: /^@earendil-works\/pi-telemetry\/testing$/, replacement: workspaceSourcePaths.telemetryTesting },
			{ find: /^@earendil-works\/pi-ai$/, replacement: workspaceSourcePaths.aiIndex },
			{ find: /^@earendil-works\/pi-ai\/compat$/, replacement: workspaceSourcePaths.aiCompat },
			{ find: /^@earendil-works\/pi-ai\/oauth$/, replacement: workspaceSourcePaths.aiOAuth },
			{
				find: /^@earendil-works\/pi-ai\/providers\/(.+)$/,
				replacement: `${workspaceSourcePaths.aiProviders}/$1.ts`,
			},
			{ find: /^@earendil-works\/pi-agent-core$/, replacement: workspaceSourcePaths.agentIndex },
			{ find: /^@earendil-works\/pi-agent-core\/node$/, replacement: workspaceSourcePaths.agentNode },
			{ find: /^@earendil-works\/pi-protocol$/, replacement: workspaceSourcePaths.protocolIndex },
			{ find: /^@earendil-works\/pi-client$/, replacement: workspaceSourcePaths.clientIndex },
			{ find: /^@earendil-works\/pi-client\/unix$/, replacement: workspaceSourcePaths.clientUnix },
			{ find: /^@earendil-works\/pi-client\/ssh$/, replacement: workspaceSourcePaths.clientSsh },
			{ find: /^@earendil-works\/pi-server$/, replacement: workspaceSourcePaths.serverIndex },
			{ find: /^@earendil-works\/pi-server\/unix$/, replacement: workspaceSourcePaths.serverUnix },
			{ find: /^@earendil-works\/pi-tui$/, replacement: workspaceSourcePaths.tuiIndex },
		],
	},
	ssr: { resolve: { conditions: ["source"] } },
});
