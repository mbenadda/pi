# Pi Workspace client/server

Experimental feature. `piw` keeps presentation on the laptop and runs the agent, model, tools, filesystem access, credentials, durable sessions, and split Session facets in a remote Workspace. SSH carries framed semantic protocol bytes over a private Unix socket. It does not allocate a PTY, forward a port, or send terminal frames.

## Daily use

```bash
piw bcli-10
piw bcli-10 --new
piw bcli-10 --cwd /home/bits/go/src/github.com/DataDog/dd-source
piw status bcli-10
piw stop bcli-10
piw update bcli-10
```

A Workspace name must contain lowercase letters, digits, and interior hyphens. `bcli-10` resolves to the OpenSSH alias `workspace-bcli-10`. The default cwd is `$DATADOG_ROOT/dd-source` when that directory exists, otherwise the absolute, shell-safe `$DATADOG_ROOT`; `--cwd` overrides it. Status, stop, and update do not require `DATADOG_ROOT`. Diagnostic overrides remain available as `--ssh-host`, `--remote-cwd`, `--session-id`, and repeatable `--plugin`.

The first launch or `update` streams the backend bundled with that exact `piw` client. It does not require a Pi checkout, Node, npm, or a source build on the Workspace. Authentication and model configuration remain Workspace-side.

`stop` terminates only the PID whose command line identifies the isolated backend. Durable sessions and old runtime releases remain. A later launch starts the same logical server and resumes the last session for host + cwd. `update` verifies and activates the backend pinned inside the installed client without opening the TUI.

## Isolated installation

The laptop installation is separate from global `pi`:

```text
~/.local/bin/piw
~/.local/share/pi-workspace/releases/<manifest-sha256>-<client-artifact-sha256>/
~/.local/share/pi-workspace/current -> releases/<manifest-sha256>-<client-artifact-sha256>
```

The backend is separate from the Workspace's global Pi and managed tasks:

```text
~/.local/share/pi-workspace-server/releases/<manifest-sha256>-<server-artifact-sha256>/
~/.local/share/pi-workspace-server/current -> releases/<manifest-sha256>-<server-artifact-sha256>
~/.local/state/pi-workspace-server/
```

Install the laptop client from a downloaded release directory with an independently obtained manifest digest:

```bash
node scripts/install-workspace-release.mjs \
  --manifest /path/to/release/manifest.json \
  --manifest-sha256 <digest-pinned-in-release-metadata>
```

The digest is mandatory and must not be derived from the downloaded manifest or its adjacent checksum file. Directories and executables are mode `0700`; metadata and plugin source are `0600`. Installation extracts into a private temporary directory, verifies the immutable manifest, embedded artifact revision/protocol/role identity, artifact size, SHA-256, tar header checksum, entry types, normalized paths, executable modes, and every reused file, renames the manifest-and-content-addressed release, then atomically replaces `current`. Partial, changed, or mode-corrupt releases move to `quarantine` and are repaired before activation. Links, traversal, absolute archive paths, corrupt archives, and receipt mismatches fail before activation. Existing valid releases remain rollbackable.

Local installation and remote backend activation serialize their full reuse, repair, and `current` transaction under their private share root. Lock acquisition has a bounded wait and stale-owner recovery; lock paths and share directories must have the expected type and current-user ownership. Abandoned unreferenced `.candidate-*` and `.repair-*` trees are removed while holding the lock. A scratch tree named by `current` is preserved until another verified release is active, so concurrent installers cannot make `current` dangle.

### Repair fault injection

`installWorkspaceArtifact()` accepts `onRepairQuarantined` only as a test seam. Tests use it to pause or fail after an active corrupt release has moved to `quarantine`, while `current` points at its verified repair fallback, and before the replacement is activated. Production installers must leave it unset; it is not a runtime hook or supported installer extension point.

## Artifact contract

`scripts/build-workspace-release.mjs` consumes standalone Bun binaries produced by the existing binary build and writes:

```text
manifest.json
manifest.sha256
pi-workspace-client-<platform>-<revision>.tar.gz
pi-workspace-server-<platform>-<revision>.tar.gz
```

`manifest.json` has schema version 1, the exact 40-character Git revision, Pi protocol version, and one immutable record per role/platform containing file name, byte size, SHA-256, and entrypoint. Each archive independently embeds that revision, protocol, role, platform, and entrypoint; the client identity also pins the bundled server-only manifest digest. A client archive contains `bin/piw`, normal standalone TUI assets, host facet modules, the server-only manifest and checksum, and every supported backend archive. A server archive contains `bin/pi-workspace-server`, a pinned platform `bin/esbuild`, the example split-plugin package, and its exact host facet modules.

Example local build for an Apple Silicon laptop and Linux ARM64 Workspace:

```bash
npm run build
./scripts/build-binaries.sh --skip-install --skip-deps --skip-build \
  --platform darwin-arm64 --out /tmp/piw-darwin
./scripts/build-binaries.sh --skip-install --skip-deps --skip-build \
  --platform linux-arm64 --out /tmp/piw-linux
# Place the exact esbuild 0.28.1 Linux ARM64 executable next to the Linux pi binary.
node scripts/build-workspace-release.mjs \
  --out /tmp/pi-workspace-release-$(git rev-parse HEAD) \
  --revision $(git rev-parse HEAD) \
  --client darwin-arm64=/tmp/piw-darwin/darwin-arm64/pi \
  --server linux-arm64=/tmp/piw-linux/linux-arm64/pi
```

The server executable has an internal byte-bridge role selected only when invoked as `pi-workspace-server` with one validated absolute socket path. Coordinator, server, and Session-worker internal roles take precedence. Normal use therefore requires neither a staged bridge script nor a remote JavaScript runtime.

## Generation fencing

Each start chooses `<exact-revision>:<uuid>` and passes it to the backend with a private readiness file. The backend writes the token only after its private server socket has started and its generation has replaced the coordinator route. The launcher does not probe or attach through the stable public socket until that exact token is visible. An old healthy coordinator generation is therefore not accepted as readiness for a replacement.

## Source development path

`PI_EXPERIMENTAL=1 pi workspace --ssh-host <host> --remote-cwd <path>` remains a checkout-backed development command. It retains the older exact-revision staging path for protocol development. Installed `piw` never enters that path: it discovers its embedded manifest next to the executable and fails closed if the manifest, checksum, platform, protocol, or backend archive is missing or inconsistent.

## Safety and isolation

- OpenSSH is spawned from validated argv with `BatchMode=yes`, `RequestTTY=no`, and `ClearAllForwardings=yes`.
- No TCP listener, PTY, ANSI stream, laptop credential copy, or remote source build is used.
- The global `pi`, Workspace dotfiles, tmux sessions, and managed task processes are not changed.
- Exact client/backend revisions are checked before Session or plugin RPC. Generation readiness is exact, not a retry of generic disconnects.
- Split plugin source is bundled remotely by the pinned local artifact toolchain and loaded against host-provided Chord and Pi plugin modules.
