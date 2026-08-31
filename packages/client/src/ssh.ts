import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { DEFAULT_MAX_FRAME_LENGTH } from "@earendil-works/pi-protocol";
import type { ByteTransport, ByteTransportFactory, ByteTransportHandlers } from "./transport.ts";

const MAX_REMOTE_COMMAND_PARTS = 8;
const MAX_STDERR_CAPTURE_BYTES = 8192;
const CLOSE_KILL_GRACE_MS = 2_000;

export interface SshTransportOptions {
	/** Preconfigured OpenSSH host alias or hostname. Never an interpolated command. */
	readonly host: string;
	/**
	 * Remote command as validated argv parts. Parts are joined with single spaces into the one
	 * argv element OpenSSH passes to the remote shell. Every part is validated against a
	 * shell-metacharacter-free charset, so no untrusted value can be shell-interpolated.
	 */
	readonly remoteCommand: readonly string[];
	/** Executable used to reach the host. Defaults to "ssh"; overridable for tests. */
	readonly sshCommand?: string;
	readonly maxPendingBytes?: number;
}

/** Validates a host alias: letters, digits, dots, underscores, and hyphens only. */
export function isValidSshHost(value: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9._-]{0,253}$/u.test(value);
}

/**
 * Validates one remote command part. Parts must stay free of whitespace, quotes, and every
 * shell metacharacter so joining them with spaces cannot change the intended command.
 */
export function isValidRemoteCommandPart(value: string): boolean {
	if (value.length === 0 || value.length > 4096) return false;
	if (!/^(\/[A-Za-z0-9]|[A-Za-z0-9])[A-Za-z0-9._/=+:,-]*$/u.test(value)) return false;
	if (value.startsWith("/") && value.split("/").includes("..")) return false;
	return true;
}

/** Builds the exact argv used to spawn OpenSSH. Exported for tests and diagnostics. */
export function buildSshSpawnArgs(options: SshTransportOptions): readonly string[] {
	const host = requireValidHost(options.host);
	const remoteCommand = requireValidRemoteCommand(options.remoteCommand);
	return [
		options.sshCommand ?? "ssh",
		"-o",
		"BatchMode=yes",
		"-o",
		"RequestTTY=no",
		"-o",
		"ClearAllForwardings=yes",
		host,
		remoteCommand.join(" "),
	];
}

/**
 * Creates transports that carry framed protocol bytes over the stdin/stdout of one OpenSSH
 * process executing a remote bridge against a Unix-domain socket. No PTY, no TCP port, and
 * no terminal control data participate: the channel carries semantic client/server bytes only.
 * The transport is usable as soon as the OpenSSH process exists; the protocol handshake on the
 * byte channel validates the remote endpoint, and every process failure is reported through
 * the terminal transport handler.
 */
export function createSshTransportFactory(options: SshTransportOptions): ByteTransportFactory {
	const maxPendingBytes = validateSshTransportOptions(options);
	const spawnArgs = buildSshSpawnArgs(options);
	return (handlers) => {
		const [command, ...rest] = spawnArgs;
		const child = spawn(command ?? "ssh", [...rest], { stdio: ["pipe", "pipe", "pipe"] });
		return new SshByteTransport(child, maxPendingBytes, handlers);
	};
}

function validateSshTransportOptions(options: SshTransportOptions): number {
	requireValidHost(options.host);
	requireValidRemoteCommand(options.remoteCommand);
	if (options.sshCommand !== undefined && (options.sshCommand.length === 0 || options.sshCommand.includes("\0"))) {
		throw new TypeError("SSH transport sshCommand must be a non-empty command path or name");
	}
	const maxPendingBytes = options.maxPendingBytes ?? DEFAULT_MAX_FRAME_LENGTH * 4;
	if (!Number.isSafeInteger(maxPendingBytes) || maxPendingBytes <= 0) {
		throw new TypeError("SSH transport maxPendingBytes must be a positive safe integer");
	}
	return maxPendingBytes;
}

function requireValidHost(value: string): string {
	if (!isValidSshHost(value)) throw new TypeError(`Invalid SSH transport host: ${JSON.stringify(value)}`);
	return value;
}

function requireValidRemoteCommand(parts: readonly string[]): readonly string[] {
	if (parts.length === 0 || parts.length > MAX_REMOTE_COMMAND_PARTS) {
		throw new TypeError("SSH transport remote command requires between 1 and 8 validated parts");
	}
	for (const part of parts) {
		if (!isValidRemoteCommandPart(part)) {
			throw new TypeError(`Invalid SSH transport remote command part: ${JSON.stringify(part)}`);
		}
	}
	return parts;
}

class SshByteTransport implements ByteTransport {
	readonly #child: ChildProcessWithoutNullStreams;
	readonly #handlers: ByteTransportHandlers;
	readonly #maxPendingBytes: number;
	readonly #stderr: Buffer[] = [];
	#stderrBytes = 0;
	#closed = false;
	#closeTimers: NodeJS.Timeout[] = [];
	#pendingBytes = 0;
	#writeTail: Promise<void> = Promise.resolve();

	constructor(child: ChildProcessWithoutNullStreams, maxPendingBytes: number, handlers: ByteTransportHandlers) {
		this.#child = child;
		this.#handlers = handlers;
		this.#maxPendingBytes = maxPendingBytes;
		child.stdout.on("data", (chunk: Buffer) => {
			if (!this.#closed) this.#handlers.onData(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
		});
		child.stderr.on("data", (chunk: Buffer) => {
			if (this.#stderrBytes < MAX_STDERR_CAPTURE_BYTES) {
				this.#stderr.push(chunk);
				this.#stderrBytes += chunk.byteLength;
			}
		});
		child.once("error", (error) => this.#terminate(error instanceof Error ? error : new Error(String(error))));
		child.once("exit", (code, signal) => this.#handleExit(code, signal));
		child.once("exit", () => {
			for (const timer of this.#closeTimers) clearTimeout(timer);
			this.#closeTimers.length = 0;
		});
	}

	send(chunk: Uint8Array): Promise<void> {
		if (!(chunk instanceof Uint8Array)) {
			return Promise.reject(new TypeError("SSH transport chunks must be Uint8Array"));
		}
		if (this.#closed) return Promise.reject(new Error("SSH transport is closed"));
		if (this.#pendingBytes + chunk.byteLength > this.#maxPendingBytes) {
			return Promise.reject(new Error("SSH transport exceeded its pending byte limit"));
		}
		this.#pendingBytes += chunk.byteLength;
		const bytes = chunk.slice();
		const write = this.#writeTail.then(() => this.#write(bytes));
		const tracked = write.finally(() => {
			this.#pendingBytes -= bytes.byteLength;
		});
		this.#writeTail = tracked.catch(() => {});
		return tracked;
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		const child = this.#child;
		child.stdin.end();
		// Ending stdin asks the remote bridge for an orderly close; escalate only if the
		// OpenSSH process wedges and would otherwise outlive the local client.
		const termTimer = setTimeout(() => child.kill("SIGTERM"), CLOSE_KILL_GRACE_MS);
		termTimer.unref();
		this.#closeTimers.push(termTimer);
		const killTimer = setTimeout(() => child.kill("SIGKILL"), CLOSE_KILL_GRACE_MS * 3);
		killTimer.unref();
		this.#closeTimers.push(killTimer);
	}

	#write(chunk: Uint8Array): Promise<void> {
		if (this.#closed) return Promise.reject(new Error("SSH transport is closed"));
		return new Promise<void>((resolve, reject) => {
			this.#child.stdin.write(chunk, (error) => {
				if (error) reject(new Error("SSH transport failed to write", { cause: error }));
				else resolve();
			});
		});
	}

	#handleExit(code: number | null, signal: NodeJS.Signals | null): void {
		if (this.#closed) {
			this.#handlers.onClose();
			return;
		}
		this.#closed = true;
		if (code === 0) {
			this.#handlers.onClose();
			return;
		}
		const detail = Buffer.concat(this.#stderr).toString("utf8").trim().slice(0, MAX_STDERR_CAPTURE_BYTES);
		this.#handlers.onError(
			new Error(`SSH transport exited unexpectedly (${signal ?? code ?? "unknown"})${detail ? `: ${detail}` : ""}`),
		);
	}

	#terminate(error: Error): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#handlers.onError(error);
	}
}
