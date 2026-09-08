import type { ChildProcess } from "node:child_process";
import { BACKGROUND_CONTEXT, type JsonlSessionMetadata } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { CoordinatorConnectionEvent } from "../src/experimental/coordinator.ts";
import {
	SESSION_WORKER_CONTROL_TOKEN_ENV,
	SESSION_WORKER_PEER_ID_ENV,
	type SessionWorkerOptions,
} from "../src/experimental/session-worker.ts";
import { SessionWorkerManager } from "../src/experimental/session-worker-manager.ts";

const { spawnInternalProcessMock } = vi.hoisted(() => ({
	spawnInternalProcessMock:
		vi.fn<(role: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => ChildProcess>(),
}));

vi.mock("../src/experimental/process.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/experimental/process.ts")>();
	return {
		...actual,
		spawnInternalProcess: spawnInternalProcessMock.mockImplementation(
			// A pending launch only needs the ChildProcess surface SessionWorkerManager observes;
			// the fake never emits, so the launch settles through the readiness broadcast below.
			() =>
				({
					pid: 4242,
					exitCode: null,
					signalCode: null,
					once: () => {},
					kill: () => true,
					unref: () => {},
				}) as unknown as ChildProcess,
		),
	};
});

class FakeCoordinator {
	readonly controlPath = "/tmp/control.sock";
	readonly serverConnectionId = "server-generation-1";
	readonly wasReplaced = false;
	readonly #listeners = new Set<(event: CoordinatorConnectionEvent) => void>();

	onEvent(listener: (event: CoordinatorConnectionEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	async send(): Promise<void> {}

	async broadcast(payload: unknown): Promise<void> {
		this.emit({ type: "message", from: "worker-1", payload });
	}

	emit(event: CoordinatorConnectionEvent): void {
		for (const listener of this.#listeners) listener(event);
	}
}

const metadata: JsonlSessionMetadata = {
	id: "legacy-session-1",
	createdAt: 1,
	storageVersion: 1,
	cwd: "/tmp",
	path: "/tmp/legacy-session-1.jsonl",
	modifiedAt: 1,
	// A legacy-v3 session whose parent file could not be resolved keeps its lineage as a path.
	legacyParentSessionPath: "/tmp/legacy-parent.jsonl",
};

afterEach(() => {
	spawnInternalProcessMock.mockClear();
});

describe("Session worker metadata boundary", () => {
	test("round-trips unresolved legacy-v3 lineage through worker options and readiness", async () => {
		const coordinator = new FakeCoordinator();
		const workers = new SessionWorkerManager(coordinator, "/tmp");
		const handle = workers.openSession(metadata, BACKGROUND_CONTEXT, []);

		// Manager -> worker: the spawned options must carry the legacy parent session path.
		expect(spawnInternalProcessMock).toHaveBeenCalledTimes(1);
		const launch = spawnInternalProcessMock.mock.calls[0]!;
		expect(launch[0]).toBe("session-worker");
		const options: SessionWorkerOptions = JSON.parse(launch[1]![0]!);
		expect(options.metadata).toMatchObject({
			id: metadata.id,
			legacyParentSessionPath: "/tmp/legacy-parent.jsonl",
		});

		// Worker -> manager: the readiness announcement carries the same metadata back and
		// must not be dropped by the strict SessionWorkerEventSchema validation.
		const workerEnv = launch[2].env ?? {};
		await coordinator.emit({
			type: "message",
			from: workerEnv[SESSION_WORKER_PEER_ID_ENV]!,
			payload: {
				type: "worker_ready",
				token: workerEnv[SESSION_WORKER_CONTROL_TOKEN_ENV]!,
				sessionKey: metadata.path,
				sessionId: metadata.id,
				pid: 4242,
				metadata,
				pluginManifestPaths: [],
			},
		});
		await expect(handle).resolves.toBeDefined();
		expect(workers.trackedSessions).toHaveLength(1);
		expect(workers.trackedSessions[0]?.legacyParentSessionPath).toBe("/tmp/legacy-parent.jsonl");
		workers.detach();
	});
});
