# Pi Workspace client/server

Experimental feature. `piw` keeps presentation on the laptop and runs the agent, model, tools, filesystem access, credentials, durable sessions, and split Session facets in a remote Workspace. SSH carries framed semantic protocol bytes over a private Unix socket. It does not allocate a PTY, forward a port, or send terminal frames.

## Daily use

```bash
piw bcli-10
piw bcli-10 --new
piw bcli-10 --cwd /home/bits/go/src/github.com/DataDog/dd-source
piw login bcli-10
piw bcli-10 --no-login
piw status bcli-10
piw stop bcli-10
piw update bcli-10
```

A Workspace name must contain lowercase letters, digits, and interior hyphens. `bcli-10` resolves to the OpenSSH alias `workspace-bcli-10`. The default cwd is `$DATADOG_ROOT/dd-source` when that directory exists, otherwise the absolute, shell-safe `$DATADOG_ROOT`; `--cwd` overrides it. Status, stop, and update do not require `DATADOG_ROOT`. Diagnostic overrides remain available as `--ssh-host`, `--remote-cwd`, `--session-id`, and repeatable `--plugin`.

### ddtool auth automation

Workspace ddtool vault sessions expire roughly every 12 hours. Every launch probes the session non-interactively over SSH with a hard 12-second bound (`timeout -k` because an expired mint hangs inside OIDC refresh and ignores SIGTERM); a healthy probe takes ~135 ms. The probe starts once the backend is installed and runs concurrently with server discovery and readiness work, so healthy attaches gain no noticeable latency.

When the probe reports an expired session, the launch runs `ddtool auth login --mode device --datacenter us1.ddbuild.io` over the validated SSH argv without a TTY, streams its output, validates the printed verification URL (https, expected host shape, no auth-code `redirect_uri`) before opening it in the laptop browser (`open` on macOS, printed elsewhere), surfaces the device code, waits for the human OIDC click-through, and verifies with a fresh probe before opening the TUI. Every advisory failure — a declined or failed login, an unreachable probe or SSH transport error, a missing ddtool, or a login that exits before printing a verification URL — warns with the exact manual command plus the `--no-login` alternative and lets the attach proceed; only an untrusted verification URL aborts the launch. A clean exit with no verification URL is accepted as success when a fresh probe reports `authenticated`: a concurrent login already refreshed the session. `--no-login` skips the probe and orchestration entirely.

`piw login <name>` runs the same probe and device login without attaching; it reports success or exits nonzero with the manual command.

The remote ddtool must be v1.127.1 or newer: older versions accept `--mode device` but silently fall back to the auth-code flow, whose localhost callback can never complete from a laptop browser. The orchestrator detects that output and fails closed with the manual command instead of opening the callback URL.

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

Local installation and remote backend activation serialize their full reuse, repair, and `current` transaction under their private share root. Remote activation acquires `.install-transaction-lock` with atomic `mkdir`, refreshes its age while held, waits at most 20 seconds, and atomically reclaims abandoned locks after five minutes. Lock paths and share directories must have the expected type and current-user ownership. Abandoned unreferenced `.install-*`, `.candidate-*`, `.current-*`, and `releases/.repair-*` scratch paths are removed while holding the lock; the lock directory itself is never treated as scratch. A scratch tree named by `current`, including a repair fallback, is preserved until the replacement is verified and active or rollback is verified, so concurrent installers and failed rollback cannot make `current` dangle.

The installed backend does not need Node or npm, but remote installation requires a POSIX `sh`-compatible login shell plus Linux/GNU coreutils, findutils, and tar. In particular, `stat`, `date`, `find`, `sha256sum`, `sort`, `xargs`, `cmp`, `readlink`, `mv`, `tar`, `mkdir`, `chmod`, `rm`, `cp`, `ln`, `touch`, `sleep`, `id`, `cut`, and `cat` must be on `PATH`; core commands must support `stat -c`, `mv -T`, null-delimited hashing, and `tar --no-same-owner --no-same-permissions`. Missing commands fail with `piw: required remote install tool missing: <name>`; unsafe lock or scratch types and ownership also fail before archive extraction. Cleanup-only pruning after a verified activation reports a warning but does not invalidate the activated release.

### Repair fault injection

`installWorkspaceArtifact()` accepts `onRepairQuarantined` and `onRepairRollback` only as test seams. Tests use them to pause or fail after an active corrupt release has moved to `quarantine`, while `current` points at its verified repair fallback, and before replacement or rollback. Production installers must leave them unset; they are not runtime hooks or supported installer extension points.

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
