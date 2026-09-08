/**
 * Offline smoke entry for compiled Bun executables (bun build --compile).
 *
 * The compiled binaries re-enter through src/experimental/bun-cli.ts, which must import the
 * sandbox environment setup and the Bun runtime registration (OAuth flow loaders + the static
 * Bedrock module) before any model/auth path runs: the variable-specifier dynamic imports the
 * ai package uses for treeshaking cannot be resolved inside a compiled executable. This entry
 * runs the same registration modules and proves both paths work without network access:
 *
 * - OAuth: the registered bundled loaders return statically embedded flows.
 * - Bedrock: the request goes through the embedded Bedrock module to a local mock endpoint
 *   (PI_COMPILED_SMOKE_BEDROCK_URL) with dummy credentials (AWS_BEDROCK_SKIP_AUTH=1); no real
 *   credentials are read and no paid request leaves the machine.
 *
 * Compiled and exercised by
 * packages/coding-agent/test/experimental-compiled-binary-smoke.test.ts.
 */
import "../packages/coding-agent/src/bun/sandbox-env-setup.ts";
import "../packages/coding-agent/src/bun/runtime-setup.ts";
import { getModel, streamSimple } from "@earendil-works/pi-ai/compat";
import { loadAnthropicOAuth, loadGitHubCopilotOAuth } from "../packages/ai/src/auth/oauth/load.ts";

const anthropicFlow = await loadAnthropicOAuth();
const copilotFlow = await loadGitHubCopilotOAuth();
console.log(`oauth-anthropic ${anthropicFlow.name}`);
console.log(`oauth-copilot ${copilotFlow.name}`);

process.env.AWS_BEDROCK_SKIP_AUTH = "1";
const bedrockUrl = process.env.PI_COMPILED_SMOKE_BEDROCK_URL;
if (!bedrockUrl) throw new Error("PI_COMPILED_SMOKE_BEDROCK_URL is required");
// The mock endpoint speaks plain HTTP/1.1, like the custom endpoints this flag exists for.
process.env.AWS_BEDROCK_FORCE_HTTP1 = "1";
const bedrockModel = getModel("amazon-bedrock", "amazon.nova-2-lite-v1:0");
try {
	const message = await streamSimple(
		{ ...bedrockModel, baseUrl: bedrockUrl },
		{ messages: [{ role: "user", content: [{ type: "text", text: "compiled smoke" }], timestamp: 0 }] },
	).result();
	console.log(`bedrock ${message.stopReason} ${message.errorMessage ?? ""}`);
} catch (error) {
	console.log(`bedrock throw ${error instanceof Error ? error.message : String(error)}`);
}
