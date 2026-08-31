import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	ClientMessageDecoder,
	encodeClientMessage,
	encodeServerMessage,
	PROTOCOL_VERSION,
} from "@earendil-works/pi-protocol";
import { afterEach, describe, expect, test } from "vitest";
import { Client } from "../src/index.ts";
import { buildSshSpawnArgs, createSshTransportFactory, isValidRemoteCommandPart, isValidSshHost } from "../src/ssh.ts";
import type { ByteTransportHandlers } from "../src/transport.ts";

const serverId = "00000000-0000-4000-8000-000000000001";
const rootDir = fileURLToPath(new URL("../../..", import.meta.url));
const bridgePath = join(rootDir, "scripts", "workspace-ssh-bridge.mjs");
const tempDirectories = new Set<string>();
const servers = new Set<Server>();
const sockets = new Set<Socket>();

async function makeTempDirectory(): Promise<string> {
	const directory = await mkdtemp(join("/tmp", "pi-client-ssh-"));
	tempDirectories.add(directory);
	return directory;
}

/**
 * Stand-in for OpenSSH: forwards its stdin/stdout to the validated remote command
 * instead of a shell, mirroring how OpenSSH passes one remote command string.
 */
const FAKE_SSH = `#!/usr/bin/env node
import { spawn } from "node:child_process";
const remoteCommand = process.argv[process.argv.length - 1];
const parts = remoteCommand.split(" ");
const child = spawn(parts[0], parts.slice(1), { stdio: ["pipe", "pipe", "inherit"] });
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.once("exit", (code) => process.exit(code ?? 0));
`;

async function makeFakeSsh(directory: string): Promise<string> {
	const path = join(directory, "fake-ssh.mjs");
	await writeFile(path, FAKE_SSH);
	await chmod(path, 0o700);
	return path;
}

async function listen(server: Server, path: string): Promise<void> {
	servers.add(server);
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(path, resolve);
	});
}

function terminalHandlers(onTerminal: (error: Error | undefined) => void): ByteTransportHandlers {
	return {
		onData: () => {},
		onClose: () => onTerminal(undefined),
		onError: (error: Error) => onTerminal(error),
	};
}

afterEach(async () => {
	for (const socket of sockets) socket.destroy();
	sockets.clear();
	await Promise.all(
		[...servers].map(
			(server) =>
				new Promise<void>((resolve) => {
					server.close(() => resolve());
				}),
		),
	);
	servers.clear();
	await Promise.all([...tempDirectories].map((directory) => rm(directory, { recursive: true, force: true })));
	tempDirectories.clear();
});

describe("ssh transport validation", () => {
	test("accepts host aliases and validated remote command parts", () => {
		expect(isValidSshHost("workspace-bcli-10")).toBe(true);
		expect(isValidSshHost("host.example.com")).toBe(true);
		expect(isValidSshHost("bad host")).toBe(false);
		expect(isValidSshHost("host;rm")).toBe(false);
		expect(isValidSshHost("")).toBe(false);
		expect(isValidRemoteCommandPart("/home/bits/.volta/bin/node")).toBe(true);
		expect(isValidRemoteCommandPart("/home/bits/go/src/github.com/DataDog/dd-source")).toBe(true);
		expect(isValidRemoteCommandPart("")).toBe(false);
		expect(isValidRemoteCommandPart("/path with space")).toBe(false);
		expect(isValidRemoteCommandPart("/safe/../../etc/passwd")).toBe(false);
		expect(isValidRemoteCommandPart("$(reboot)")).toBe(false);
		expect(isValidRemoteCommandPart("a;rm -rf /")).toBe(false);
		expect(isValidRemoteCommandPart("a|b")).toBe(false);
		expect(isValidRemoteCommandPart("a&b")).toBe(false);
	});

	test("builds one OpenSSH argv with a single validated remote command element", () => {
		expect(
			buildSshSpawnArgs({
				host: "workspace-bcli-10",
				remoteCommand: ["/home/bits/.volta/bin/node", bridgePath, "/tmp/server.sock"],
			}),
		).toEqual([
			"ssh",
			"-o",
			"BatchMode=yes",
			"-o",
			"RequestTTY=no",
			"-o",
			"ClearAllForwardings=yes",
			"workspace-bcli-10",
			`/home/bits/.volta/bin/node ${bridgePath} /tmp/server.sock`,
		]);
	});

	test("rejects invalid hosts and remote command parts", () => {
		expect(() => buildSshSpawnArgs({ host: "bad host", remoteCommand: ["node"] })).toThrow(
			/Invalid SSH transport host/,
		);
		expect(() => buildSshSpawnArgs({ host: "ok", remoteCommand: [] })).toThrow(/between 1 and 8/);
		expect(() =>
			buildSshSpawnArgs({ host: "ok", remoteCommand: ["a", "b", "c", "d", "e", "f", "g", "h", "i"] }),
		).toThrow(/between 1 and 8/);
		expect(() => buildSshSpawnArgs({ host: "ok", remoteCommand: ["node; rm -rf /"] })).toThrow(
			/Invalid SSH transport remote command part/,
		);
		expect(() => createSshTransportFactory({ host: "ok", remoteCommand: ["node"], maxPendingBytes: 0 })).toThrow(
			/positive safe integer/,
		);
	});
});

describe.runIf(process.platform !== "win32")("createSshTransportFactory", () => {
	test("carries a complete Client handshake and request over the SSH byte bridge", async () => {
		const directory = await makeTempDirectory();
		const socketPath = join(directory, "server.sock");
		const receivedMembers: string[] = [];
		const server = createServer((socket) => {
			const decoder = new ClientMessageDecoder();
			socket.on("data", (chunk) => {
				for (const message of decoder.push(chunk)) {
					if (message.type === "hello") {
						socket.write(encodeServerMessage({ type: "hello", version: PROTOCOL_VERSION, serverId }));
						continue;
					}
					if (message.type === "cancel") continue;
					receivedMembers.push(`${message.call.serviceId}.${message.call.member}`);
					const frame = encodeServerMessage({ type: "response", id: message.id, ok: true, result: [] });
					const split = Math.floor(frame.byteLength / 2);
					socket.write(frame.subarray(0, split));
					socket.write(frame.subarray(split));
				}
			});
		});
		await listen(server, socketPath);
		const client = new Client({
			serverId,
			transportFactory: createSshTransportFactory({
				host: "unused-host",
				sshCommand: await makeFakeSsh(directory),
				remoteCommand: [process.execPath, bridgePath, socketPath],
			}),
		});

		try {
			await expect(client.connect()).resolves.toMatchObject({ serverId });
			await expect(
				client.request({ serverId }, { serviceId: "test.server", member: "list", args: [] }),
			).resolves.toEqual([]);
			expect(receivedMembers).toEqual(["test.server.list"]);
		} finally {
			await client.dispose();
		}
	});
});

describe.runIf(process.platform !== "win32")("ssh transport lifecycle", () => {
	test("close ends the transport orderly and rejects later sends", async () => {
		const directory = await makeTempDirectory();
		const socketPath = join(directory, "server.sock");
		const server = createServer((socket) => {
			const decoder = new ClientMessageDecoder();
			socket.on("data", (chunk) => {
				for (const message of decoder.push(chunk)) {
					if (message.type === "hello") {
						socket.write(encodeServerMessage({ type: "hello", version: PROTOCOL_VERSION, serverId }));
					}
				}
			});
		});
		await listen(server, socketPath);
		let terminal: ((error: Error | undefined) => void) | undefined;
		const settled = new Promise<Error | undefined>((resolve) => {
			terminal = resolve;
		});
		const transport = await createSshTransportFactory({
			host: "unused-host",
			sshCommand: await makeFakeSsh(directory),
			remoteCommand: [process.execPath, bridgePath, socketPath],
		})(terminalHandlers((error) => terminal?.(error)));
		await transport.send(encodeClientMessage({ type: "hello", version: PROTOCOL_VERSION }));
		transport.close();
		transport.close();
		await expect(transport.send(new TextEncoder().encode("late"))).rejects.toThrow(/closed/);
		await settled;
	});

	test("surfaces a bridge connection failure as onError instead of onClose", async () => {
		const directory = await makeTempDirectory();
		let terminal: ((error: Error | undefined) => void) | undefined;
		const settled = new Promise<Error | undefined>((resolve) => {
			terminal = resolve;
		});
		const transport = await createSshTransportFactory({
			host: "unused-host",
			sshCommand: await makeFakeSsh(directory),
			remoteCommand: [process.execPath, bridgePath, join(directory, "missing.sock")],
		})(terminalHandlers((error) => terminal?.(error)));
		const result = await settled;
		transport.close();
		expect(result).toBeInstanceOf(Error);
		expect(result?.message).toMatch(/exited unexpectedly/);
	});
});
