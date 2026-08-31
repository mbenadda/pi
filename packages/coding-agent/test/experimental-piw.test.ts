import { describe, expect, test } from "vitest";
import { parsePiwArgs, workspaceSshHost } from "../src/experimental/piw.ts";

const CWD = "/home/bits/go/src/github.com/DataDog/dd-source";

describe("piw daily command", () => {
	test("infers the OpenSSH alias and leaves cwd for remote DATADOG_ROOT discovery", () => {
		expect(parsePiwArgs(["bcli-10"])).toEqual({
			command: "workspace",
			workspaceName: "bcli-10",
			sshHost: "workspace-bcli-10",
		});
	});

	test("parses launch overrides without changing inferred defaults", () => {
		expect(parsePiwArgs(["bcli-10", "--new", "--cwd", CWD])).toEqual({
			command: "workspace",
			workspaceName: "bcli-10",
			sshHost: "workspace-bcli-10",
			remoteCwd: CWD,
			newSession: true,
		});
		expect(
			parsePiwArgs([
				"bcli-10",
				"--ssh-host",
				"my-workspace",
				"--remote-cwd",
				CWD,
				"--session-id",
				"session-1",
				"--plugin",
				"/home/bits/plugin",
			]),
		).toMatchObject({
			sshHost: "my-workspace",
			remoteCwd: CWD,
			sessionId: "session-1",
			pluginPackages: ["/home/bits/plugin"],
		});
	});

	test.each([
		["status", { status: true }],
		["stop", { cleanup: true }],
		["update", { update: true }],
	] as const)("parses %s lifecycle action", (action, expected) => {
		expect(parsePiwArgs([action, "bcli-10"])).toMatchObject(expected);
	});

	test.each(["BCLI-10", "-bcli", "bcli-", "bad_name", "bad.name", "bad name"])(
		"rejects invalid Workspace name %s",
		(name) => {
			expect(() => workspaceSshHost(name)).toThrow(/Invalid Workspace name/);
		},
	);

	test("rejects conflicting and action-only launch options", () => {
		expect(() => parsePiwArgs(["bcli-10", "--new", "--session-id", "one"])).toThrow(/mutually exclusive/);
		expect(() => parsePiwArgs(["status", "bcli-10", "--new"])).toThrow(/require a launch/);
		expect(() => parsePiwArgs(["bcli-10", "--ssh-host", "bad host"])).toThrow(/Invalid SSH host/);
		expect(() => parsePiwArgs([])).toThrow(/usage: piw/);
	});
});
