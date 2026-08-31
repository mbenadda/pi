# Pi Workspace client/server MVP

Experimental feature. `pi workspace` opens the local experimental TUI against a persistent agent that runs inside a remote Workspace (for example a Datadog Workspace reachable through OpenSSH). The model, tools, filesystem access, subprocesses, credentials, and the durable session all live on the Workspace host. The laptop owns the keyboard, editor, scrolling, and rendering; the SSH channel carries semantic client/server protocol bytes only (no PTY, no ANSI frames, no terminal grid, no TCP listener).

This command is part of the experimental client/server slice and requires `PI_EXPERIMENTAL=1` like `pi server` and `pi client`. The upstream experimental architecture (`packages/client`, `packages/protocol`, `packages/server`, `packages/chord`, and `packages/coding-agent/src/experimental`) supplies the protocol, coordinator, per-session workers, replicated transcript state, and the experimental TUI; the workspace command adds the staging, remote server lifecycle, and SSH transport.

## Requirements

- A local Git checkout of Pi (the command stages the exact checked-out revision on the Workspace; it cannot run from an installed release).
- An OpenSSH host alias with non-interactive auth (`BatchMode=yes` works; key-based auth in your SSH config).
- Node >= 22.19.0 and npm on the Workspace host (any user-local path, for example `~/.volta/bin`).

## One-command launch

After `npm ci --ignore-scripts && npm run build`, run from the Pi checkout:

```bash
PI_EXPERIMENTAL=1 node packages/coding-agent/dist/bundle/cli.js workspace \
  --ssh-host workspace-bcli-10 \
  --remote-cwd /home/bits/go/src/github.com/DataDog/dd-source
```

`PI_EXPERIMENTAL=1 pi workspace ...` is equivalent when `pi` resolves to this checkout's built CLI.

On first launch the command:

1. resolves the exact local Git revision and streams `git archive` of that revision over SSH into `~/.local/share/pi-workspace-mvp/<git-sha>/` on the Workspace;
2. installs and builds it remotely with an isolated npm cache (never touching the Workspace's globally installed Pi or dotfiles);
3. starts a persistent detached server under `~/.local/state/pi-workspace-mvp/` (directories `0700`, sockets `0600`) with the requested remote working directory as the session cwd;
4. records the server/session identity locally under `~/.local/state/pi-workspace-mvp/<host>/` for reconnect;
5. opens the local experimental TUI over a framed byte channel through OpenSSH.

Later launches skip staging when the same revision is already staged, reuse the running server, and resume the recorded session (same transcript).

## Reconnect

Close the client with Ctrl+D on an empty editor or interrupt the local process. The remote server and session stay durable; the durable JSONL transcript keeps every message. Run the same launch command again and the local TUI reattaches to the same server and session and restores the transcript. A turn already running in its Session worker also continues after the last presentation client disconnects; this is experimental behavior, not yet a compatibility guarantee.

- `--new-session`: create a fresh session instead of resuming.
- `--session-id <id>`: attach to or create a specific session id.
- `--plugin <absolute-remote-path>`: repeatable; overrides the default plugin packages (by default the staged example split plugin is installed server-side).

## Status

```bash
PI_EXPERIMENTAL=1 node packages/coding-agent/dist/bundle/cli.js workspace \
  --ssh-host workspace-bcli-10 \
  --remote-cwd /home/bits/go/src/github.com/DataDog/dd-source --status
```

Reports the pinned revision, staging state, remote Node version, MVP state paths, server identity and reachability, and the locally recorded session id.

## Cleanup

```bash
# Stop the MVP server process (sessions stay durable and reconnectable):
PI_EXPERIMENTAL=1 node packages/coding-agent/dist/bundle/cli.js workspace \
  --ssh-host workspace-bcli-10 \
  --remote-cwd /home/bits/go/src/github.com/DataDog/dd-source --cleanup

# Additionally remove the staged build for the current revision:
PI_EXPERIMENTAL=1 node packages/coding-agent/dist/bundle/cli.js workspace \
  --ssh-host workspace-bcli-10 \
  --remote-cwd /home/bits/go/src/github.com/DataDog/dd-source --purge
```

Cleanup is idempotent and MVP-only: it terminates only the process recorded in the MVP pid file when its command line identifies a server CLI under the MVP staging root, and purge only removes directories under `~/.local/share/pi-workspace-mvp/` that carry the staging marker. It never touches the Workspace's global Pi installation, dotfiles, tmux sessions, or other tasks. Stopping the server does not destroy sessions; the next launch restarts the server with the same logical id and reconnects. The running revision is recorded separately, and launching a newer staged revision replaces an older MVP server before attaching.

## Safety properties

- OpenSSH is spawned from argv with validated inputs; host aliases and every interpolated remote value are checked against a shell-metacharacter-free charset before they reach the remote command. No shell string contains untrusted data.
- SSH is the only authentication boundary; no TCP port is opened on either side, and `RequestTTY=no` plus `ClearAllForwardings=yes` keep the channel a plain byte stream.
- Model and tool credentials come from the Workspace's own Pi configuration; the laptop never copies credentials, auth files, or settings to the Workspace.

## Validated Workspace slice

The MVP was exercised against `workspace-bcli-10` with remote cwd `/home/bits/go/src/github.com/DataDog/dd-source`:

- the local TUI connected through OpenSSH with `RequestTTY=no` and showed the remote model/thinking status;
- remote `bash` returned `/home/bits/go/src/github.com/DataDog/dd-source`, remote `read` returned `# dd-source`, and a second `bash` confirmed the remote `.git` directory;
- after disconnect, the same launch command restored the completed transcript and session id;
- `/hello Workspace-MVP` loaded the package's local `src/tui.ts`, called the remote `src/session.ts`, displayed `Hello Workspace-MVP from the bundled Session worker facet!!! Worker activations: 1.`, and submitted `pong: Workspace-MVP`;
- an in-flight `sleep 20; pwd` turn completed remotely after the client was terminated, and reconnect restored the terminal `INFLIGHT-COMPLETE` response;
- `--status` reported the server reachable, and two consecutive `--cleanup` calls stopped only the MVP server while preserving session files.

## Parity matrix

| Area | MVP status |
|---|---|
| Editor, key/mouse handling, scrolling, themes, transcript and built-in tool rendering | Working in the reused local experimental TUI; no terminal frames cross SSH. |
| Model/thinking status, prompt streaming, remote read/bash tools, durable JSONL | Working across the Workspace boundary. |
| Split plugins | Working for package-based `session.ts` + `tui.ts`; active Sessions reject a different manifest selection. |
| Presentation interaction | Working for the example plugin's remote greeting plus local status presentation and prompt dispatch. |
| Completed-turn and in-flight reconnect | Working in the validated slice; in-flight continuation remains experimental. |
| Stable `InteractiveMode` completeness | Visibly different: the experimental TUI exposes only the current Chord service inventory. |
| Legacy mixed extensions | Blocked on explicit shared/session/presentation facets; arbitrary closures and client-local Node side effects are not transparent. |
| Seamless protocol/version upgrades | Blocked: protocol v1 has no compatibility promise, so the MVP pins and replaces exact Git revisions. |
| Installed-release operation | Not supported by this checkout MVP; staging requires the source revision and a Workspace-side build. |

## Known limits

- The experimental TUI is a semantic slice, not full stable `InteractiveMode` parity; see the experimental services README for the current service inventory.
- Plugin mismatch handling is fail-closed rather than an interactive migration workflow.
- A laptop suspend or Workspace failure can still interrupt an active turn; only deliberate client disconnect was validated.
- The first launch performs a full Workspace-side `npm ci --ignore-scripts` and build and is therefore slow.
