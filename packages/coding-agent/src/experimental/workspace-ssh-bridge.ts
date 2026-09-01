import { createConnection } from "node:net";
import type { Readable, Writable } from "node:stream";

const SOCKET_PATH_PATTERN = /^\/[A-Za-z0-9._/-]+$/u;

export interface WorkspaceSshBridgeStreams {
	readonly input: Readable;
	readonly output: Writable;
}

/** Connect semantic protocol bytes on stdin/stdout to a private Workspace Unix socket. */
export async function runWorkspaceSshBridge(
	args: readonly string[],
	streams: WorkspaceSshBridgeStreams = { input: process.stdin, output: process.stdout },
): Promise<void> {
	const [socketPath] = args;
	if (args.length !== 1 || socketPath === undefined || !SOCKET_PATH_PATTERN.test(socketPath)) {
		throw new Error("usage: pi-workspace-server <absolute-socket-path>");
	}
	const socket = createConnection(socketPath);
	await new Promise<void>((resolve, reject) => {
		let settled = false;
		const cleanup = (): void => {
			streams.input.unpipe(socket);
			socket.unpipe(streams.output);
			streams.input.off("error", fail);
			streams.output.off("error", fail);
		};
		const finish = (): void => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve();
		};
		const fail = (error: Error): void => {
			if (settled) return;
			settled = true;
			cleanup();
			socket.destroy();
			reject(error);
		};
		socket.once("error", fail);
		socket.once("connect", () => {
			streams.input.pipe(socket);
			socket.pipe(streams.output, { end: false });
			streams.input.resume();
		});
		socket.once("close", finish);
		streams.input.once("error", fail);
		streams.output.once("error", fail);
	});
}
