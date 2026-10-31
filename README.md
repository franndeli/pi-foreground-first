# pi-foreground-first

[![npm version](https://img.shields.io/npm/v/pi-foreground-first?logo=npm)](https://www.npmjs.com/package/pi-foreground-first)
[![npm downloads](https://img.shields.io/npm/dm/pi-foreground-first)](https://www.npmjs.com/package/pi-foreground-first)
[![CI](https://github.com/franndeli/pi-foreground-first/actions/workflows/test.yml/badge.svg)](https://github.com/franndeli/pi-foreground-first/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Pi package](https://img.shields.io/badge/pi-package-8A2BE2)](https://pi.dev/packages/pi-foreground-first)

A [Pi](https://pi.dev) extension for running background jobs in visible Orca terminals. Ordinary work stays in the main conversation; a slow command doesn't automatically become a background task.

When a background job finishes, Pi gets its exit status and the last part of its output, then continues without you having to ask. You can watch the command in Orca, read its saved logs, or stop it from Pi.

## Install

```sh
pi install npm:pi-foreground-first
# or straight from GitHub:
pi install git:github.com/franndeli/pi-foreground-first
```

Use `/reload` or restart Pi after installing or updating.

You'll need Pi >=1.3.0 and <2.0, Node.js >=22.19, and a recent Orca installation. Managed jobs currently work in local macOS/Linux workspaces. Windows and remote workspaces aren't supported for managed jobs yet.

If you're replacing `pi-background-tasks`, stop its running jobs and remove it first:

```sh
pi remove npm:pi-background-tasks
```

Use `pi list` to find the exact source if you installed a pinned version or used git. Add `-l` when removing a project-local installation. Old tasks and logs aren't imported.

## Use it

Start a server or another command you want to leave running:

```text
/bg npm run dev
```

It opens in an Orca tab without switching focus. Pi returns a task ID and log path. When the command exits, a notification brings the result back into the conversation and wakes Pi for a follow-up.

```text
/jobs                    List tasks in this session
/logs <task-id>           Read a task's output
/kill <task-id>           Stop a task
/bg-rerun <task-id>       Run its command again as a new task
```

`/tasks` is an alias for `/jobs`. `/foreground-first` shows a short explanation of the workflow.

You can also ask Pi to run something in the background. It uses `bg_run` and opens the terminal straight away, without a confirmation dialog. Only `orca_agent`, which starts another agent session, still asks first.

Foreground-first is guidance, not a restriction on Pi's shell tool. The point is to keep routine reads, edits and checks in the conversation, and use background execution when you ask for it, for a server or watcher, or when there's genuinely separate work to do.

## Tools

| Tool | What it does |
|---|---|
| `bg_run` | Start a managed command using `name` and `command` |
| `orca_terminal` | The same runner, with `title` instead of `name` |
| `bg_status` | Inspect a task, or list up to 50 recent tasks |
| `bg_logs` | Read a saved log tail |
| `bg_kill` | Request cancellation |
| `orca_agent` | Open a native interactive Orca agent |

For example, Pi can call `bg_run` with:

```json
{
  "name": "Integration tests",
  "command": "npm run test:integration",
  "timeoutSeconds": 600
}
```

Both command-launch tools accept these options:

| Option | Default | Meaning |
|---|---|---|
| `notifyOnCompletion` | `true` | Send the result back to the launching Pi session |
| `triggerOnCompletion` | `true` | Let Pi continue automatically after receiving it |
| `timeoutSeconds` | No timeout | Stop the command after this many seconds; maximum seven days |
| `maxOutputBytes` | 20 MiB | Stop the command if its combined output exceeds this limit |
| `focus` | `false` | Switch to the new terminal when it opens |

Set `triggerOnCompletion:false` if you want the notification without another model turn. Set `notifyOnCompletion:false` to turn off automatic delivery entirely. Status and log tools still work.

`bg_status`, `bg_logs` and `bg_kill` take the exact `taskId` returned at launch. `bg_logs` also accepts `maxBytes`: the default is 16,000 bytes and the maximum is 50 KiB. Notifications include up to 4,000 bytes of output and a path to the full log.

`/bg` treats everything after the command name as the shell command. It doesn't parse options such as `--name` or `--timeout`; use `bg_run` for those settings.

### How commands run

Managed jobs run in the current Pi working directory, under `$SHELL -c` or `/bin/sh -c`, without login-shell startup files. Standard input is closed, so these are noninteractive jobs. Output appears live in Orca and is saved to disk.

`orca_terminal.worktree`, if supplied, must be `path:<Pi's cwd>`. Running managed commands in another workspace isn't supported yet.

The command doesn't start until Orca confirms a visible local terminal. If launch fails or the result is ambiguous, the extension won't silently start a hidden process or retry the command.

Cancellation sends TERM to the command's process group, then KILL after two seconds if needed. `bg_kill` returns a stop request; the completion notification follows once the runner has observed the exit. Use `/kill` before closing a terminal if you want a recorded cancellation. If the runner is forcibly killed, the extension reports an interruption rather than guessing whether its children finished.

Finished tabs stay open so you can inspect them. An open tab doesn't mean the command is still running—check its task status.

## Agent workers

A noninteractive agent command can use the same background runner:

```text
/bg pi --print 'Review the current changes without editing files; report findings.'
```

Its output stays visible, and Pi receives the result when the command exits. Add the CLI's model/provider flags if you want a specific model. The worker uses its normal credentials and permissions; it doesn't inherit the parent conversation automatically.

For an interactive worker, use `orca_agent`:

```json
{
  "agent": "pi",
  "prompt": "Review the authentication changes without editing files. Report findings with paths."
}
```

It follows your Orca Chat UI setting, opening either a chat or terminal. Optional fields are `model`, `effort`, `worktree` and `focus`; `effort` requires an explicit `model`.

Interactive agents stay alive after answering, so this tool only returns the launch and prompt-delivery result. Use the `orchestration` skill for coordinated return messages, or a noninteractive command when you want exit-based completion. The `orca-cli` skill covers handoffs and worktrees. Separate workers that edit files should use separate worktrees.

## Reloads, recovery and limits

Orca owns the running jobs, not the parent Pi process. They continue across `/reload` or Pi exiting. Resume the same Pi session to recover pending notifications; a new conversation won't receive another session's results. Pi can't run a follow-up while it's closed.

Task records and logs are stored under:

```text
<cwd>/.pi/foreground-tasks/<session-hash>/<task-id>/
```

The runner saves and synchronizes its logs before publishing a final status. The monitor checks Pi's transcript before marking a notification delivered. A crash between queuing and saving a notification can cause it to be delivered again on resume; delivery isn't guaranteed to be exactly once across a crash.

The footer shows active and finished counts. The extension also sends lifecycle events to Orca's existing Pi status integration. It doesn't need the model to poll for progress.

A few things to keep in mind:

- Commands run with your permissions. This isn't a sandbox, and it doesn't change authentication or billing.
- Logs aren't deleted automatically and may contain sensitive output. Don't commit `.pi/foreground-tasks`.
- If Orca is unavailable, keep the work in the foreground. There is no hidden-process fallback.
- `ORCA_CLI_COMMAND` overrides the CLI executable. Development sessions use `orca-dev`; Linux outside Orca uses `orca-ide` to avoid the unrelated GNOME screen reader.
- This is an independent implementation, not a drop-in replacement for every `pi-background-tasks` feature. Fusion, context-seeded delegates, attestation and Anthropic-attribution features aren't included.

## Development

```sh
npm install --ignore-scripts
npm test
npm run pack:check
```

Pi and TypeBox are host-provided peer dependencies. There's no build step. To load a local checkout:

```sh
pi install /absolute/path/to/pi-foreground-first
```

The tests cover command execution, cancellation, timeouts, output limits, notification recovery, Pi loading and the packaged npm tarball. Live Orca tests are separate because they open real terminals:

```sh
# A normal shell job with progress output
ORCA_SMOKE=1 npm run test:smoke

# Also launch an interactive Pi worker; uses model quota
ORCA_SMOKE=1 ORCA_SMOKE_AGENT=pi npm run test:smoke

# Success, failure, cancellation and reload, each followed by an automatic Pi reply
# Uses four model responses
ORCA_MANAGED_SMOKE=1 npm run test:managed
```

Set `ORCA_SMOKE_CWD` to an existing Orca workspace if needed. Install the checkout into Pi before running the managed tests so fresh agents load it. Live agent tests require terminal-mode Pi settings. The low-level tool test supplies confirmation itself; the end-to-end tests use `/bg` as user authorization. Each test closes only the terminals it created.

Live testing has been done on macOS with Pi 1.3.0 and Orca. Automated CI also runs on Linux. Chat-mode receipts have unit coverage, but the live tests don't drive the chat UI.

The entry point is `extensions/index.js`. `lib/task-manager.js` handles launches and notifications, `lib/task-runner.js` runs inside the Orca terminal, and `lib/task-store.js` handles persistence. Foreground guidance and native agent launching live in `lib/policy.js`.

See [RELEASING.md](RELEASING.md) for publishing instructions.

## License

MIT.
