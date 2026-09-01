import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, test } from "vitest";
import { runWorkspaceSshBridge } from "../src/experimental/workspace-ssh-bridge.ts";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("Workspace semantic SSH bridge", () => {
	test("carries raw bidirectional bytes over a Unix socket", async () => {
		const directory = await mkdtemp("/tmp/pi-workspace-bridge-");
		const path = join(directory, "server.sock");
		const server = createServer((socket) => {
			socket.on("data", (data) => socket.write(Buffer.concat([Buffer.from("echo:"), data])));
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(path, resolve);
		});
		cleanups.push(async () => {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(directory, { recursive: true, force: true });
		});

		const input = new PassThrough();
		const output = new PassThrough();
		const received = new Promise<Buffer>((resolve) => output.once("data", resolve));
		const bridge = runWorkspaceSshBridge([path], { input, output });
		input.write(Buffer.from([0, 1, 2, 255]));
		expect(await received).toEqual(Buffer.from([101, 99, 104, 111, 58, 0, 1, 2, 255]));
		input.end();
		await bridge;
	});

	test("drains the socket response after input EOF", async () => {
		const directory = await mkdtemp("/tmp/pi-workspace-bridge-");
		const path = join(directory, "server.sock");
		const server = createServer({ allowHalfOpen: true }, (socket) => {
			const chunks: Buffer[] = [];
			socket.on("data", (chunk: Buffer) => chunks.push(chunk));
			socket.on("end", () => {
				socket.end(Buffer.concat([Buffer.from("complete:"), ...chunks]));
			});
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(path, resolve);
		});
		cleanups.push(async () => {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(directory, { recursive: true, force: true });
		});

		const input = new PassThrough();
		const output = new PassThrough();
		const chunks: Buffer[] = [];
		output.on("data", (chunk: Buffer) => chunks.push(chunk));
		const bridge = runWorkspaceSshBridge([path], { input, output });
		input.end("request");
		await bridge;
		expect(Buffer.concat(chunks).toString("utf8")).toBe("complete:request");
	});

	test.each([[[]], [["relative.sock"]], [["/tmp/socket", "extra"]], [["/tmp/socket;bad"]]] as const)(
		"rejects invalid argv %j before connecting",
		async (args) => {
			await expect(runWorkspaceSshBridge(args)).rejects.toThrow(/usage: pi-workspace-server/);
		},
	);
});
