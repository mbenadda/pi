import { describe, expect, test } from "vitest";
import { cli } from "../src/cli/experimental/cli.ts";

const UNSUPPORTED_SERVER_OPTIONS = "The experimental server command does not support existing CLI options yet";
const UNSUPPORTED_CLIENT_OPTIONS = "The experimental client command does not support existing CLI options yet";

describe("experimental CLI commands", () => {
	test("parses server configuration", () => {
		expect(
			cli.parse([
				"server",
				"--server-id",
				"00000000-0000-4000-8000-000000000001",
				"--session-dir",
				"~/pi-sessions",
				"--provider",
				"anthropic",
				"--model",
				"claude-sonnet-4-5",
				"-e",
				"./first-plugin",
				"-e=./second-plugin",
			]),
		).toEqual({
			ok: true,
			command: {
				command: "server",
				serverId: "00000000-0000-4000-8000-000000000001",
				sessionDir: "~/pi-sessions",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				pluginPackages: ["./first-plugin", "./second-plugin"],
			},
		});
	});

	test("parses provider-qualified server models", () => {
		expect(cli.parse(["server", "--model", "anthropic/claude-sonnet-4-5:high"])).toEqual({
			ok: true,
			command: { command: "server", model: "anthropic/claude-sonnet-4-5:high" },
		});
	});

	test("parses client transport addresses", () => {
		expect(cli.parse(["client", "--connect", "unix:///tmp/pi.sock"])).toEqual({
			ok: true,
			command: { command: "client", connect: { transport: "unix", path: "/tmp/pi.sock" } },
		});
		expect(
			cli.parse(["client", "--connect", "radius://00000000-0000-4000-8000-000000000001", "--session-id", "demo-1"]),
		).toEqual({
			ok: true,
			command: {
				command: "client",
				connect: { transport: "radius", serverId: "00000000-0000-4000-8000-000000000001" },
				sessionId: "demo-1",
			},
		});
		expect(
			cli.parse([
				"client",
				"--connect",
				"ssh://workspace-bcli-10/home/bits/.local/state/pi-workspace-mvp/server/00000000-0000-4000-8000-000000000001.sock?bridge=/home/bits/.local/share/pi-workspace-mvp/rev/scripts/workspace-ssh-bridge.mjs&node=/home/bits/.volta/bin/node",
			]),
		).toEqual({
			ok: true,
			command: {
				command: "client",
				connect: {
					transport: "ssh",
					host: "workspace-bcli-10",
					serverId: "00000000-0000-4000-8000-000000000001",
					path: "/home/bits/.local/state/pi-workspace-mvp/server/00000000-0000-4000-8000-000000000001.sock",
					bridgePath: "/home/bits/.local/share/pi-workspace-mvp/rev/scripts/workspace-ssh-bridge.mjs",
					nodePath: "/home/bits/.volta/bin/node",
				},
			},
		});
	});

	test.each([
		["-c", "continue"],
		["--continue", "continue"],
		["-r", "resume"],
		["--resume", "resume"],
	] as const)("parses client Session selection %s", (option, property) => {
		expect(cli.parse(["client", option])).toEqual({
			ok: true,
			command: { command: "client", [property]: true },
		});
	});

	test("parses a Session selection followed by a one-shot prompt", () => {
		expect(cli.parse(["client", "-r", "Explain this project"])).toEqual({
			ok: true,
			command: { command: "client", resume: true, prompt: "Explain this project" },
		});
	});

	test("parses client model and plugin configuration", () => {
		expect(
			cli.parse([
				"client",
				"--model",
				"anthropic/claude-sonnet-4-5:high",
				"-e",
				"./first-plugin",
				"-e",
				"./second-plugin",
			]),
		).toEqual({
			ok: true,
			command: {
				command: "client",
				model: "anthropic/claude-sonnet-4-5:high",
				pluginPackages: ["./first-plugin", "./second-plugin"],
			},
		});
	});

	test.each([
		[["--auth-token", "secret"], { type: "token", token: "secret" }],
		[["--auth-token-file", "/tmp/token"], { type: "file", path: "/tmp/token" }],
	] as const)("parses authentication source %j", (argv, auth) => {
		for (const command of ["server", "client"] as const) {
			expect(cli.parse([command, ...argv])).toMatchObject({ ok: true, command: { command, auth } });
		}
	});

	test.each(["server", "client"] as const)("permits omitted authentication for %s", (command) => {
		expect(cli.parse([command])).toEqual({ ok: true, command: { command } });
	});

	test.each([
		[["client", "--listen", "unix:///tmp/pi.sock"], UNSUPPORTED_CLIENT_OPTIONS],
		[["server", "--listen", "unix:///tmp/pi.sock"], UNSUPPORTED_SERVER_OPTIONS],
		[["server", "--connect", "unix:///tmp/pi.sock"], UNSUPPORTED_SERVER_OPTIONS],
		[["client", "--connect", "ws://localhost:8080"], 'Unsupported --connect transport "ws:"'],
		[["client", "--connect", "radius://not-a-server"], "Radius transport address requires"],
		[["client", "--connect", "unix://relative.sock"], "Unix transport address must not include an authority"],
		[["client", "--connect", "unix:///tmp/pi.sock?wrong=value"], "Invalid --connect address"],
		[["client", "--provider", "anthropic"], "--provider requires --model"],
		[["client", "-c", "-r"], "--session-id, --continue, and --resume are mutually exclusive"],
		[["client", "--continue=true"], "--continue does not take a value"],
		[["server", "--provider", "anthropic"], "--provider requires --model"],
		[["server", "--server-id", "not-a-uuid"], "Invalid --server-id"],
		[["server", "--server-id"], "--server-id requires a value"],
		[["server", "--session-dir"], "--session-dir requires a value"],
		[["client", "-e"], "-e requires a value"],
		[
			["server", "--session-dir", "/tmp/first", "--session-dir=/tmp/second"],
			"--session-dir may only be specified once",
		],
		[["client", "--connect="], "--connect requires a value"],
		[["client", "--connect", "ssh://bad host/a.sock"], 'Invalid --connect address "ssh://bad host/a.sock"'],
		[["client", "--connect", "ssh://-leading/a.sock"], 'Invalid SSH transport host "-leading"'],
		[
			["client", "--connect", "ssh://workspace-bcli-10/home/bits/not-a-server.sock?bridge=/b&node=/n"],
			"SSH transport address requires a <uuidv4-server-id>.sock socket path",
		],
		[
			[
				"client",
				"--connect",
				"ssh://workspace-bcli-10/home/bits/00000000-0000-4000-8000-000000000001.sock?node=/home/bits/.volta/bin/node",
			],
			"SSH transport address requires bridge and node query parameters",
		],
	] as const)("rejects invalid experimental input %j", (argv, error) => {
		const result = cli.parse(argv);
		expect(result).toMatchObject({ ok: false });
		if (!result.ok) expect(result.errors).toContainEqual(expect.stringContaining(error));
	});

	test("rejects unsupported options without parsing them through the stable CLI", () => {
		expect(cli.parse(["client", "--tui-mode", "wrong", "--model", "claude-sonnet"])).toEqual({
			ok: false,
			errors: [UNSUPPORTED_CLIENT_OPTIONS],
		});
	});
});
