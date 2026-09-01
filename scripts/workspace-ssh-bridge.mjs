#!/usr/bin/env node
/**
 * Workspace SSH byte bridge.
 *
 * Connects the stdin/stdout of one OpenSSH session to one Unix-domain socket carrying
 * framed Pi client/server protocol bytes. The laptop client spawns this through
 * `ssh <validated-host> node <this-script> <validated-socket-path>`; no PTY, terminal
 * control data, or TCP listener participates in either direction.
 *
 * Exit codes: 0 on orderly close, 1 on usage or connection failure.
 */
import { createConnection } from "node:net";

const SOCKET_PATH_PATTERN = /^\/[A-Za-z0-9._/-]+$/u;

const socketPath = process.argv[2];
if (process.argv.length !== 3 || socketPath === undefined || !SOCKET_PATH_PATTERN.test(socketPath)) {
	process.stderr.write("usage: node workspace-ssh-bridge.mjs <absolute-socket-path>\n");
	process.exit(1);
}

const socket = createConnection(socketPath);
socket.once("error", (error) => {
	process.stderr.write(`workspace-ssh-bridge: ${error.message}\n`);
	process.exitCode = 1;
});
socket.once("connect", () => {
	process.stdin.pipe(socket);
	socket.pipe(process.stdout);
	process.stdin.resume();
});
process.stdin.once("error", (error) => {
	process.stderr.write(`workspace-ssh-bridge: stdin: ${error.message}\n`);
	process.exitCode = 1;
	socket.destroy();
});
process.stdout.once("error", (error) => {
	process.stderr.write(`workspace-ssh-bridge: stdout: ${error.message}\n`);
	process.exitCode = 1;
	socket.destroy();
});
