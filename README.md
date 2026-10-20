# pi-foreground-first

**Keep ordinary Pi work in the foreground. Open a visible Orca tab when you actually need another process.**

No detached task manager, hidden model delegation, automatic Fusion calls, background completion wake-ups, or provider/billing modifications.

| Work | Default |
|---|---|
| Read, edit, investigate, run tests/builds | Ordinary foreground Pi tools |
| Persistent server or watcher | User-confirmed Orca terminal |
| Substantial separate agent | User-confirmed native Orca agent tab |
| Quick second opinion | Not automatically delegated |
| Orca unavailable | Stay foreground; no hidden fallback |

This package is intentionally small. It supplies execution guidance and two explicit launch tools, not another scheduler. A launch returns a **receipt**, not finished work.

## Install

From GitHub:

```sh
pi install git:github.com/franndeli/pi-foreground-first
```

After an npm release is published:

```sh
pi install npm:pi-foreground-first
```

For a local checkout:

```sh
pi install /absolute/path/to/pi-foreground-first
```

Restart Pi after installing. Existing sessions can use `/reload`, but a fresh session avoids old extension instructions in conversation history.

**Requirements**

- Pi **1.3.0 or newer, below 2.0**; tested against 1.3.0.
- Node.js 22.19 or newer.
- Orca with `agent launch`, `terminal create`, JSON receipts, and visible-terminal adoption for the launch tools.
- Interactive Pi or a UI-capable RPC host that handles confirmation dialogs.
- A workspace tracked by Orca. Outside Orca, the foreground guidance still works.

Orca is not bundled or installed by this package. Linux outside an Orca-managed terminal uses `orca-ide`, never the unrelated GNOME `orca` screen reader. `ORCA_CLI_COMMAND` takes precedence; a development Orca session uses `orca-dev`. No fallback to a different executable occurs after failure.

## Migrate from pi-background-tasks

```sh
pi remove npm:pi-background-tasks
pi install git:github.com/franndeli/pi-foreground-first
```

If you installed from git, a pinned npm version, or project-local settings, remove that exact source/scope instead (`pi list`; `pi remove <source> -l` for project scope).

Finish or stop existing background jobs before removing/reloading their owner. This package does not adopt them or delete old `.pi/tasks` artifacts.

The old extension is **not a dependency**. Its `bg_*`, `fusion_*`, `/bg`, task dock, attestation, and Anthropic-attribution features are not reimplemented. Keep your separate provider/billing extension if you need it. A startup warning reports a still-loaded conflicting background tool; it does not uninstall unrelated packages automatically.

## Tools

### `orca_terminal`

For servers, watchers, explicitly requested visible jobs, or genuinely independent long commands:

```json
{
  "title": "Dev server",
  "command": "npm run dev",
  "focus": false
}
```

- Uses `orca terminal create`, not a detached child shell.
- Prompts the user with the command and target workspace **before execution**.
- Defaults to `path:<Pi's current working directory>`, never whichever tab happens to be selected.
- Optional `worktree` supplies an explicit Orca selector.
- Default `focus:false` creates a visible tab without switching away from your current tab.
- The command runs in the target workspace's configured terminal shell, not necessarily Bash.
- Reports success only when Orca confirms `surface: "visible"` and a handle.
- Some Orca versions may create a background handle when UI adoption fails. The tool reports this as an error with the full receipt; it does not relaunch or conceal that side effect.

### `orca_agent`

For a substantial separate worker the user wants to see:

```json
{
  "agent": "pi",
  "prompt": "Review the authentication changes. Do not modify files. Report findings with paths.",
  "focus": false
}
```

Optional: `model`, `effort`, `worktree`. An explicit `effort` requires `model`; omitted model uses Orca's configured default. The confirmation names the agent, requested model/effort, task brief, and workspace.

Uses Orca's **native agent launch**, so your Orca Chat UI settings choose a chat or terminal. It does not force a terminal when you prefer chat. The result includes the exact handle, receipt, and prompt-delivery outcome.

The parent conversation is not copied. Supply a self-contained brief. Workers run with the selected agent's normal permissions; a read-only instruction is **not a sandbox**.

For a full handoff, read the `orca-cli` skill. For supervised workers and return messages, use the `orchestration` skill. This package does not automatically collect answers, supervise workers, invent task-completion status, or create separate git worktrees. Concurrent editing in the same workspace can conflict: use an explicit separate worktree for independent writers.

### `/foreground-first`

Shows the current policy and available tools. There are no automatic/background modes to enable accidentally.

## Failure, cancellation, and ownership

- Rejected confirmation: no process starts.
- Headless mode without confirmation UI: refuses before execution.
- Cancellation before submission: no launch.
- Failure, malformed receipts, CLI timeout, or cancellation after submission: reports **unverified launch state**. The host may already have created a worker.
- Never blindly repeat a launch. Inspect the returned handle; for a native agent launch with `operationId`, follow Orca's `--retry-launch` replay procedure with the same request.
- The CLI call has a 30-second timeout. This is **not** a timeout on the launched job.
- Once launched, Orca owns the process. It can continue after Pi exits/reloads. Use Orca's UI or documented CLI to inspect/stop it.
- The extension never closes your other terminals, kills all jobs, starts Orca automatically, or switches to a hidden fallback.

Prompt guidance is a workflow preference, **not a security boundary**: it does not remove Pi's normal shell access or police arbitrary commands. The two tools enforce their own confirmation gates. Another extension can still introduce conflicting tools/instructions.

## Development and testing

```sh
npm install --ignore-scripts
npm test
npm run pack:check
```

Pi and TypeBox are host-provided peer dependencies. The package has no runtime dependency on `pi-background-tasks`; no compilation step is required.

Automated tests cover CLI selection, structured arguments, explicit workspace targeting, receipt verification, confirmation rejection, headless refusal, cancellation, ambiguous failures/no retry, policy injection, conflict warnings, and real Pi resource loading/reloading.

Live tests are deliberately opt-in because they create real Orca tabs:

```sh
# A 10-second normal shell job: verify non-blocking launch, progress, completion,
# then close only that test terminal (no agent or model involved):
ORCA_SMOKE=1 npm run test:smoke

# Also launch one real model worker and verify its reply (may use paid quota):
ORCA_SMOKE=1 ORCA_SMOKE_AGENT=pi npm run test:smoke

# Set ORCA_SMOKE_CWD to an existing Orca workspace when needed.
```

The smoke test loads the shipped extension through Pi's actual resource loader and executes its registered tools through Pi's `exec` API. Its explicit environment opt-in authorizes a test-only confirmation stub. It does **not** automate the human confirmation dialog. The live agent reply/cleanup test currently requires Orca terminal-mode agent settings; chat receipt handling is covered by automated tests, not a live chat UI run.

Tested live on macOS with Pi 1.3.0 and Orca: an ordinary shell job continuing after tool return, five live progress markers and completion, native Pi agent prompt delivery, model response, and owned-terminal cleanup. Windows/Linux CLI selection is unit-tested; no claim of live platform testing.

### Layout

```text
extensions/index.js    Pi registration, policy hook, confirmation-backed tools
lib/policy.js          CLI selection, arguments, launch/receipt behavior
test/                 unit, Pi-loader, and opt-in live Orca tests
.github/workflows/    CI checks
```

## Release

See [RELEASING.md](RELEASING.md) for validation, npm authentication, and publication. Only runtime sources, README, changelog, and license go into the npm tarball. Local settings, credentials, sessions, test traces, and `node_modules` must never be published.

## License

MIT. This is an independent implementation, not a fork or vendored copy of pi-background-tasks.
