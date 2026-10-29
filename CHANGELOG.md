# Changelog

## Unreleased

- `bg_run` and `orca_terminal` start immediately instead of asking "Run in a managed visible Orca terminal?" every time; `orca_agent` still asks, because it starts another agent session.
- In a non-TUI host (e.g. an embedding app running Pi in rpc mode) the Orca tools and foreground-first policy are switched off.

## 0.2.0

- Restore managed background execution in visible Orca terminals: `bg_run`, `bg_status`, `bg_logs`, `bg_kill`, and `/bg`, `/jobs`, `/tasks`, `/logs`, `/kill`, `/bg-rerun`.
- Upgrade `orca_terminal` to use the same managed runner.
- Automatically deliver completion/failure/timeout/cancellation with exit status and bounded logs, and wake Pi for a follow-up by default.
- Persist task ownership/results and recover notifications across reload/resume without restarting commands.
- Add runner-owned cancellation with TERM/KILL escalation, optional timeout, output caps, and a verified-visible-placement execution gate.
- Emit task lifecycle events for Orca's existing status integration.
- Add real end-to-end tests proving automatic Pi responses after successful, failed, cancelled, and reload-surviving normal jobs.
- Managed execution is explicitly local POSIX only; native interactive agents continue to use Orca's launch/orchestration workflow.

## 0.1.0

- Foreground-first execution guidance without hidden model/task orchestration.
- User-confirmed native Orca agent and visible terminal launch tools.
- Explicit workspace targeting, structured argv, receipt validation, and no blind retries.
- No-UI refusal, pre-launch cancellation, and honest ambiguous-launch errors.
- Pi-loader/reload regression tests and opt-in live Orca smoke tests.
