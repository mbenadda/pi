import { posix } from "node:path";
import { isValidRemoteCommandPart, isValidSshHost } from "@earendil-works/pi-client/ssh";
import { isServerId, type ServerId } from "@earendil-works/pi-protocol";
import { type ParsedCommandInput, stringOption, valueOption } from "./command.ts";

export type AuthInput =
	| { readonly type: "token"; readonly token: string }
	| { readonly type: "file"; readonly path: string };

interface UnixTransportAddress {
	readonly transport: "unix";
	readonly path: string;
}

interface RadiusTransportAddress {
	readonly transport: "radius";
	readonly serverId: ServerId;
}

export interface SshTransportAddress {
	readonly transport: "ssh";
	readonly host: string;
	readonly serverId: ServerId;
	/** Absolute remote Unix-domain socket path ending in <server-id>.sock. */
	readonly path: string;
	/** Absolute remote path to the staged SSH bridge script. */
	readonly bridgePath: string;
	/** Absolute remote Node executable path used to run the bridge. */
	readonly nodePath: string;
}

export type TransportAddress = UnixTransportAddress | RadiusTransportAddress | SshTransportAddress;

/** Validates one absolute remote path: POSIX separators and a shell-metacharacter-free charset. */
export function parseRemoteWorkspacePath(value: string, label: string): { path?: string; error?: string } {
	if (!isValidRemoteCommandPart(value) || !posix.isAbsolute(value)) {
		return { error: `Invalid ${label} "${value}"` };
	}
	return { path: value };
}

export const authTokenOption = stringOption("--auth-token");
export const authTokenFileOption = stringOption("--auth-token-file");

function parseAuthInput(options: { readonly authToken?: string; readonly authTokenFile?: string }): {
	auth?: AuthInput;
	errors: string[];
} {
	if (options.authToken !== undefined && options.authTokenFile !== undefined) {
		return { errors: ["--auth-token and --auth-token-file are mutually exclusive"] };
	}
	if (options.authToken !== undefined) {
		return { auth: { type: "token", token: options.authToken }, errors: [] };
	}
	if (options.authTokenFile !== undefined) {
		return { auth: { type: "file", path: options.authTokenFile }, errors: [] };
	}
	return { errors: [] };
}

function parseTransportAddress(value: string): { address?: TransportAddress; error?: string } {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return { error: `Invalid --connect address "${value}"` };
	}
	if (url.protocol === "radius:") {
		if (
			url.username ||
			url.password ||
			url.port ||
			(url.pathname !== "" && url.pathname !== "/") ||
			url.search ||
			url.hash ||
			value !== `radius://${url.hostname}${url.pathname}`
		) {
			return { error: `Invalid --connect address "${value}"` };
		}
		const serverId = url.hostname;
		if (!isServerId(serverId)) {
			return { error: "Radius transport address requires a lowercase UUIDv4 server ID" };
		}
		return { address: { transport: "radius", serverId } };
	}
	if (url.protocol === "ssh:") return parseSshTransportAddress(value, url);
	if (url.protocol !== "unix:") return { error: `Unsupported --connect transport "${url.protocol}"` };
	if (url.hostname || url.port || url.username || url.password) {
		return { error: "Unix transport address must not include an authority" };
	}
	if (
		!value.startsWith("unix:///") ||
		value.startsWith("unix:////") ||
		value.includes("?") ||
		value.includes("#") ||
		url.href !== value
	) {
		return { error: `Invalid --connect address "${value}"` };
	}
	let path: string;
	try {
		path = decodeURIComponent(url.pathname);
	} catch {
		return { error: `Invalid --connect address "${value}"` };
	}
	if (path.includes("\0")) return { error: `Invalid --connect address "${value}"` };
	if (!posix.isAbsolute(path)) return { error: "Unix transport address requires an absolute path" };
	return { address: { transport: "unix", path } };
}

function parseSshTransportAddress(value: string, url: URL): { address?: SshTransportAddress; error?: string } {
	if (url.username || url.password || url.port || url.hash) {
		return { error: `Invalid --connect address "${value}"` };
	}
	if (!isValidSshHost(url.hostname)) {
		return { error: `Invalid SSH transport host "${url.hostname}"` };
	}
	let socketPath: string;
	try {
		socketPath = decodeURIComponent(url.pathname);
	} catch {
		return { error: `Invalid --connect address "${value}"` };
	}
	const socket = parseRemoteWorkspacePath(socketPath, "SSH transport socket path");
	if (socket.error !== undefined) return { error: socket.error };
	const serverId = posix.basename(socketPath).replace(/\.sock$/, "");
	if (!socketPath.endsWith(".sock") || !isServerId(serverId)) {
		return { error: "SSH transport address requires a <uuidv4-server-id>.sock socket path" };
	}
	const bridge = url.searchParams.get("bridge");
	const node = url.searchParams.get("node");
	if ([...url.searchParams.keys()].some((key) => key !== "bridge" && key !== "node")) {
		return { error: `Invalid --connect address "${value}"` };
	}
	if (bridge === null || node === null) {
		return { error: "SSH transport address requires bridge and node query parameters" };
	}
	let bridgePath: string;
	let nodePath: string;
	try {
		bridgePath = decodeURIComponent(bridge);
		nodePath = decodeURIComponent(node);
	} catch {
		return { error: `Invalid --connect address "${value}"` };
	}
	const bridgePathResult = parseRemoteWorkspacePath(bridgePath, "SSH transport bridge path");
	if (bridgePathResult.error !== undefined) return { error: bridgePathResult.error };
	const nodePathResult = parseRemoteWorkspacePath(nodePath, "SSH transport node path");
	if (nodePathResult.error !== undefined) return { error: nodePathResult.error };
	return {
		address: { transport: "ssh", host: url.hostname, serverId, path: socketPath, bridgePath, nodePath },
	};
}

export const connectOption = valueOption("--connect", (value) => {
	const result = parseTransportAddress(value);
	return result.address
		? { ok: true, value: result.address }
		: { ok: false, error: result.error ?? `Invalid --connect address "${value}"` };
});

export function parseAuth(input: ParsedCommandInput): { auth?: AuthInput; errors: string[] } {
	return parseAuthInput({
		authToken: input.value(authTokenOption),
		authTokenFile: input.value(authTokenFileOption),
	});
}

export function unsupportedOptions(command: string, input: ParsedCommandInput): string[] {
	if (input.remainingArgs.length === 0) return [];
	return [`The experimental ${command} command does not support existing CLI options yet`];
}
