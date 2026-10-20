# pi-foreground-first

**Managed background work you can see in Orca—without making every Pi action a background task.**

Routine work stays in the main Pi conversation. When background execution is useful, commands run in visible Orca terminals with **durable logs, exit status, cancellation, timeouts, and automatic completion notifications that wake Pi to continue**.

| Work | Behavior |
|---|---|
| Ordinary reads, edits, dependent checks | Normal foreground Pi tools |
| Explicit background job, server, watcher, independent test/build | Managed visible Orca terminal |
| Job finishes, fails, times out, or is cancelled | Status + log tail delivered to the launching Pi session; automatic follow-up by default |
| Pi reloads or exits | Orca-owned job continues; resume the same session to recover pending notifications |
| Noninteractive CLI agent | Can use the same managed visible runner and exit-based result delivery |
| Native interactive agent | Orca chat/terminal; use Orca orchestration for return messages |

No dependency on `pi-background-tasks`, no provider/billing rewrites, no automatic multi-model delegation, and no invisible fallback when Orca cannot show a terminal.

## Install

```sh
pi install git:github.com/franndeli/pi-foreground-first
```

After the npm release is published:

```sh
pi install npm:pi-foreground-first
```

Local development checkout:

```sh
pi install /absolute/path/to/pi-foreground-first
```

Restart Pi or use `/reload` after updating. A fresh session avoids obsolete extension instructions left in conversation history.

**Requirements**

- Pi **>=1.3.0, <2.0** and Node.js >=22.19; tested against Pi 1.3.0.
- Orca with native agent launch, JSON receipts and visible-terminal adoption.
- Managed shell tasks currently require a **local macOS/Linux POSIX workspace**, with the same filesystem as Pi. Remote/SSH/WSL-cross-host and native Windows managed execution are refused, not silently emulated.
- Tool-launched tasks require confirmation UI. The user-entered `/bg` command is explicit authorization and needs no additional confirmation dialog.

`ORCA_CLI_COMMAND` chooses the executable when set; a development session uses `orca-dev`. Linux outside Orca uses `orca-ide`, never the unrelated GNOME screen reader. No automatic fallback to another executable occurs.

## Migration

```sh
pi remove npm:pi-background-tasks
pi install git:github.com/franndeli/pi-foreground-first
```

Remove your exact source/scope if the old extension was installed from git, a pinned version, or project settings (`pi list`; `pi remove <source> -l` for project scope). Finish/stop its jobs before removing their owner. This package does not adopt old `.pi/tasks` records.

The familiar `bg_run`, `bg_status`, `bg_logs`, `bg_kill`, `/bg`, `/jobs`, `/logs`, and `/kill` now operate on **visible Orca-backed managed jobs**. This is not complete API compatibility: the old Fusion, inspect-only context-seeded delegate, attestation, Anthropic-attribution, and custom task-dock subsystems are not bundled. Keep your separate billing/provider extension if needed.

## Quick start

```text
/bg npm run dev
/jobs
/logs <task-uuid>
/kill <task-uuid>
```

Or ask Pi to run genuinely independent work in the background. It can call:

```json
{
  "name": "Integration tests",
  "command": "npm run test:integration",
  "timeoutSeconds": 600
}
```

`bg_run` returns promptly with a task UUID, visible Orca terminal handle, and full log path. Pi can do other work or yield. Once the command exits, a `foreground-task-notification` carries its real status, exit code and bounded output tail, and **starts/queues Pi's next turn without another user message**.

The extension monitors local task records itself. The model should not repeatedly poll status/log tools merely to wait.

### Notification controls

Both launch tools accept:

| Option | Default | Effect |
|---|---|---|
| `notifyOnCompletion` | `true` | Deliver a visible custom message to the launching session |
| `triggerOnCompletion` | `true` | Wake Pi/queue a follow-up; requires notifications enabled |
| `timeoutSeconds` | None | Command deadline, enforced by the runner even while Pi is closed; maximum seven days |
| `maxOutputBytes` | 20 MiB | Combined output cap; exceeding it stops/fails the command |
| `focus` | `false` | Make a visible tab without stealing focus; set true to reveal it |

Set `triggerOnCompletion:false` for notification-only delivery. Set `notifyOnCompletion:false` to disable automatic messages entirely. Explicit status/log inspection still works.

## Tools and commands

### `bg_run` / `orca_terminal`

These are two interfaces to **the same managed runner**; never launch both for one job.

- `bg_run`: `{ name, command, ...options }`
- `orca_terminal`: `{ title, command, ...options }`

Tool launches show a confirmation with the original command, cwd and notification settings. The managed cwd is always this Pi session's cwd. For compatibility, `orca_terminal.worktree` accepts exactly `path:<cwd>`; other workspaces are refused for managed execution.

Commands run under `$SHELL -c` (or `/bin/sh -c`) without login startup files. Standard input is closed: use this for **noninteractive jobs**. Output streams live to the visible terminal and is also saved locally. Ctrl+C/cancellation stops the runner-owned command group. Use `orca_agent` for interactive agent TUIs.

The command is stored in JSON, not interpolated into the launcher. A runner gate prevents execution until Orca confirms a **visible, local** terminal. An invisible-adoption fallback, ambiguous receipt, or pre-launch cancellation never opens that gate. There is no blind launch retry.

### `bg_status`

`{ taskId? }`: inspect one exact task UUID, or list up to 50 recent tasks in this session. Includes real command state, exit code, terminal handle and log path. A terminal tab's shell remaining open does **not** mean the managed command is still running.

### `bg_logs`

`{ taskId, maxBytes? }`: read a bounded log tail (default 16,000 bytes, maximum 50 KiB). Returns the full local path and whether the tail is truncated. Notifications include at most 4,000 bytes. Command output is untrusted data, not agent instructions.

### `bg_kill`

`{ taskId }`: write a cancellation request for the task's own runner. It sends TERM to its command process group, escalating to KILL after two seconds if necessary. The tool returns **stop requested**, not an invented stopped verdict. Cancellation notification is emitted after the runner observes exit and finalizes logs.

Only exact task UUIDs belonging to this session are accepted. No arbitrary-PID or stop-all interface is exposed. Use `/kill` before closing a task terminal if you need a recorded cancellation. A force-killed runner cannot attest its descendants' outcome; recovery reports interruption/unknown outcome, never success.

### User commands

```text
/bg <shell command>       Explicitly launch a managed visible job; auto-follow-up defaults on
/jobs                    List this session's tasks
/tasks                   Alias for /jobs
/logs <task UUID>         Read a bounded log tail
/kill <task UUID>         Request cancellation
/bg-rerun <task UUID>     Explicitly run the same command as a NEW task with current defaults
/foreground-first        Explain the execution policy
```

`/bg` takes the command literally; it does not implement the old package's leading flag parser. Use the model-callable launch tool when you need a custom name/timeout/notification options.

## Model workers

For an explicitly requested noninteractive CLI agent, a managed command can provide the same exit-based notification/result loop as a build or test:

```json
{
  "name": "Review worker",
  "command": "pi --print 'Review the current changes without editing files; report findings.'"
}
```

Choose model/provider flags explicitly when needed. It uses the CLI's configured credentials and normal permissions; no provider, authentication, sandbox, or billing policy is changed. Output is visible and the bounded result tail comes back on exit. There is no implicit parent-context copy.

For an interactive worker use `orca_agent`:

```json
{
  "agent": "pi",
  "prompt": "Review the authentication changes without editing files. Report findings with paths.",
  "focus": false
}
```

Optional `model`, `effort` (requires model), and `worktree` follow native Orca behavior. Orca's Chat UI settings decide chat versus terminal. **An interactive agent remains alive after answering**, so its process exit is not a reliable answer-completion signal; use the `orchestration` skill for supervised return messages, or use a noninteractive managed command above. A launch receipt is not a completed answer.

For full handoffs read the `orca-cli` skill. For coordinated workers read `orchestration`. Concurrent writers should use separate worktrees; this extension does not silently create checkouts or isolate file writes.

## Persistence, visibility and safety

Tasks live under:

```text
<cwd>/.pi/foreground-tasks/<hash-of-Pi-session-id>/<task-uuid>/
  spec.json       command, owner session and execution settings
  launch.json     Orca receipt/terminal identity
  start.json      verified visible-placement execution gate
  runner.claim    exclusive execution claim; replay cannot execute twice
  state.json      heartbeat and finalized state/exit code
  output.log      bounded durable combined output
  stop.json       cancellation request, if any
  delivered.json  notification acknowledged in Pi's transcript
```

Metadata is atomically replaced with file/directory synchronization on POSIX. Logs are synchronized before terminal state is published. The runner is owned by the visible Orca terminal, not Pi, so it continues across Pi reload/exit. The monitor starts only with the session, stops on shutdown, and resumes tracking that **same session** later. It never delivers another session's tasks into a new conversation.

Notification delivery is deduplicated against Pi's transcript and durable delivery record. Queued-but-not-persisted notifications are retried on resume: this is **at-least-once crash recovery**, not a claim of perfect exactly-once delivery across crashes. If Pi is closed, it cannot run a model; pending results are delivered when the launching session is resumed.

A missing runner, stale heartbeat, or unverified process outcome is surfaced explicitly. A runner that never starts has a 90-second authorization expiry and cannot later execute the command. Jobs have an optional timeout and a bounded output cap. This is process management, **not an OS sandbox**; commands have your user permissions and can use credentials/network services.

The footer shows active/finished counts. Job lifecycle events are also emitted for Orca's existing Pi status integration, so ordinary managed jobs can remain visible as activity while the parent waits. No custom terminal renderer or detached hidden process dock is required.

Finished Orca tabs stay open for inspection; the extension does not close arbitrary user tabs. Old task records/logs are not deleted automatically. They can contain sensitive command output—do not commit them or publish them.

## Testing

```sh
npm install --ignore-scripts
npm test
npm run pack:check
```

Tests cover real runner processes, success/nonzero exits, cancellation and TERM escalation, timeout, output caps, durable bounded logs, the visible-launch gate, duplicate-run prevention, session isolation, reload/resume delivery, lifecycle events, Pi resource loading, and the actual npm tarball.

Live Orca tests are opt-in:

```sh
# Normal 10-second shell job: nonblocking launch, five progress markers, completion, cleanup
ORCA_SMOKE=1 npm run test:smoke

# Also verify a native interactive Pi agent reply (uses model quota)
ORCA_SMOKE=1 ORCA_SMOKE_AGENT=pi npm run test:smoke

# Full native Pi -> /bg -> visible job -> automatic notification -> model reply:
# success, failure, cancellation, and /reload with the same runner PID.
# Uses four real Pi model responses; no follow-up user prompts.
ORCA_MANAGED_SMOKE=1 npm run test:managed
```

Set `ORCA_SMOKE_CWD` to an existing local Orca workspace. Install this checkout into Pi before the managed end-to-end suite so fresh native agents load it. Live agent tests require terminal-mode Pi settings; chat launch receipts are unit-tested, not live chat UI automation.

Live coverage is macOS + Pi 1.3.0 + Orca. Linux runs automated CI; live Linux/Windows/remote UI behavior is not claimed. Low-level tool smoke tests use an explicit test-only confirmation stub; real end-to-end tests use user-command authorization via `/bg`.

## Development and release

```text
extensions/index.js        tools, commands and session hooks
lib/policy.js              foreground guidance and native interactive-agent launches
lib/task-manager.js        visible task launch, observer, notifications and Orca lifecycle events
lib/task-runner.js         terminal-owned execution, output, timeout and cancellation
lib/task-store.js          durable task records, recovery and bounded logs
test/                     automated and opt-in live integration tests
```

Pi and TypeBox are host-provided peer dependencies; no build step or old-background-package dependency is required. See [RELEASING.md](RELEASING.md) for npm publication. Only runtime files and documentation belong in the tarball—never credentials, settings, local task artifacts or transcripts.

MIT. Independent implementation, not a vendored copy of `pi-background-tasks`.
