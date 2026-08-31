import { isServerId, type ServerId } from "@earendil-works/pi-protocol";
import { Command, stringOption, valueOption } from "../command.ts";
import {
	type AuthInput,
	authTokenFileOption,
	authTokenOption,
	parseAuth,
	parseRemoteWorkspacePath,
	unsupportedOptions,
} from "../command-options.ts";

export interface ServerCommand {
	readonly command: "server";
	readonly auth?: AuthInput;
	readonly provider?: string;
	readonly model?: string;
	readonly pluginPackages?: readonly string[];
	readonly serverId?: ServerId;
	readonly sessionDir?: string;
	readonly readyFile?: string;
	readonly generation?: string;
}

export interface ServerCommandContext {
	runServer(command: ServerCommand): void | Promise<void>;
}

const serverIdOption = valueOption("--server-id", (value) =>
	isServerId(value)
		? { ok: true, value }
		: { ok: false, error: `Invalid --server-id "${value}"; expected a lowercase UUIDv4` },
);
const sessionDirOption = stringOption("--session-dir");
const readyFileOption = valueOption("--ready-file", (value) => {
	const result = parseRemoteWorkspacePath(value, "server readiness file");
	return result.path
		? { ok: true, value: result.path }
		: { ok: false, error: result.error ?? `Invalid server readiness file "${value}"` };
});
const GENERATION_PATTERN = /^[0-9a-f]{40}:[0-9a-f-]{36}$/u;
const generationOption = valueOption("--generation", (value) =>
	GENERATION_PATTERN.test(value) ? { ok: true, value } : { ok: false, error: `Invalid --generation "${value}"` },
);
const providerOption = stringOption("--provider");
const modelOption = stringOption("--model");
const pluginPackageOption = stringOption("-e", { repeatable: true });

export const serverCommand = new Command<ServerCommand, ServerCommandContext>("server")
	.option(serverIdOption)
	.option(sessionDirOption)
	.option(readyFileOption)
	.option(generationOption)
	.option(providerOption)
	.option(modelOption)
	.option(pluginPackageOption)
	.option(authTokenOption)
	.option(authTokenFileOption)
	.build((input) => {
		const { auth, errors: authErrors } = parseAuth(input);
		const serverId = input.value(serverIdOption);
		const sessionDir = input.value(sessionDirOption);
		const readyFile = input.value(readyFileOption);
		const generation = input.value(generationOption);
		const provider = input.value(providerOption);
		const model = input.value(modelOption);
		const pluginPackages = input.values(pluginPackageOption);
		const modelErrors = provider !== undefined && model === undefined ? ["--provider requires --model"] : [];
		const readinessErrors =
			(readyFile === undefined) === (generation === undefined)
				? []
				: ["--ready-file and --generation must be provided together"];
		const errors = [...authErrors, ...modelErrors, ...readinessErrors, ...unsupportedOptions("server", input)];
		if (errors.length > 0) return { ok: false, errors };
		return {
			ok: true,
			command: {
				command: "server",
				...(auth === undefined ? {} : { auth }),
				...(provider === undefined ? {} : { provider }),
				...(model === undefined ? {} : { model }),
				...(pluginPackages.length === 0 ? {} : { pluginPackages }),
				...(serverId === undefined ? {} : { serverId }),
				...(sessionDir === undefined ? {} : { sessionDir }),
				...(readyFile === undefined ? {} : { readyFile }),
				...(generation === undefined ? {} : { generation }),
			},
		};
	})
	.action((command, context) => context.runServer(command));
