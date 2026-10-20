// Real end-to-end test: native Pi -> /bg -> visible shell job -> automatic
// completion custom message -> model reply. No second user/model prompt.
// Also verifies failure, cancellation, and in-process reload recovery.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { resolveOrca } from "../lib/policy.js";
import { readJson, requestStop, snapshot, TASK_ID, TERMINAL_STATES } from "../lib/task-store.js";

if (process.env.ORCA_MANAGED_SMOKE !== "1") throw new Error("Set ORCA_MANAGED_SMOKE=1 to authorize real Orca terminals and four Pi model responses.");
const exec = promisify(execFile), cli = resolveOrca();
const cwd = process.env.ORCA_SMOKE_CWD || process.cwd();
const call = async (args) => JSON.parse((await exec(cli, [...args, "--json"], { cwd, timeout: 30000 })).stdout);
const waitFor = async (condition, label, timeout = 90000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await condition(); if (value) return value; await new Promise((done) => setTimeout(done, 400)); }
  throw new Error("Timed out: " + label);
};
function findTask(marker) {
  const home = join(cwd, ".pi", "foreground-tasks");
  if (!existsSync(home)) return;
  for (const session of readdirSync(home)) {
    if (!/^[0-9a-f]{24}$/.test(session)) continue;
    const root = join(home, session);
    for (const id of readdirSync(root).filter((id) => TASK_ID.test(id))) {
      const dir = join(root, id), spec = readJson(join(dir, "spec.json"));
      if (spec?.command.includes(marker)) return { root, dir, spec };
    }
  }
}
async function send(handle, text) {
  await call(["terminal", "read", "--terminal", handle]);
  const response = await call(["terminal", "send", "--terminal", handle, "--text", text, "--enter"]);
  assert.equal(response.ok, true);
}
async function runCase(kind) {
  const marker = "MANAGED_SMOKE_" + randomUUID().replaceAll("-", "");
  const command = kind === "failure" ? `printf '${marker} failed\\n'; exit 7`
    : kind === "cancel" ? `printf '${marker} running\\n'; sleep 60`
    : kind === "reload" ? `printf '${marker} started\\n'; sleep 6; printf '${marker} done\\n'`
    : `sleep 2; printf '${marker} done\\n'`;
  const owned = new Set();
  let task;
  try {
    const launch = await call(["agent", "launch", "--agent", "pi", "--worktree", "path:" + cwd, "--prompt", "/bg " + command]);
    assert.equal(launch.ok, true);
    const outcome = launch.result?.outcome ?? launch.result?.launch?.outcome;
    assert.equal(outcome?.kind, "terminal", "This live test requires terminal-mode Pi agents");
    owned.add(outcome.handle);
    task = await waitFor(() => findTask(marker), "task specification");
    const started = await waitFor(() => {
      const state = snapshot(task.root, task.spec.id);
      if (state.handle) owned.add(state.handle);
      return state.status !== "starting" && state;
    }, "task start");
    if (kind === "cancel") await send(outcome.handle, "/kill " + task.spec.id);
    if (kind === "reload") await send(outcome.handle, "/reload");
    const done = await waitFor(() => {
      const state = snapshot(task.root, task.spec.id);
      return TERMINAL_STATES.has(state.status) && state;
    }, "task terminal state");
    assert.equal(done.status, kind === "failure" ? "failed" : kind === "cancel" ? "cancelled" : "completed");
    if (kind === "failure") assert.equal(done.exitCode, 7);
    if (kind === "reload") assert.equal(done.runnerPid, started.runnerPid, "reload must not restart the command");
    await waitFor(() => existsSync(join(task.dir, "delivered.json")), "durable notification acknowledgement");
    const transcript = await waitFor(() => {
      if (!task.spec.sessionFile || !existsSync(task.spec.sessionFile)) return;
      const entries = readFileSync(task.spec.sessionFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      const index = entries.findIndex((entry) => entry.type === "custom_message" && entry.details?.taskId === task.spec.id);
      if (index < 0) return;
      const reply = entries.slice(index + 1).find((entry) => entry.type === "message" && entry.message?.role === "assistant" && entry.message?.stopReason === "stop");
      return reply && { entries, reply };
    }, "automatic Pi assistant reply after task notification");
    const notifications = transcript.entries.filter((entry) => entry.type === "custom_message" && entry.details?.taskId === task.spec.id);
    assert.equal(notifications.length, 1);
    assert.equal(transcript.entries.filter((entry) => entry.type === "message" && entry.message?.role === "user").length, 0, "No user/model prompt should be needed; /bg and /kill are commands");
    console.log("PASS", kind, JSON.stringify({ taskId: task.spec.id, status: done.status, exitCode: done.exitCode, notificationCount: notifications.length, automaticAssistantReply: true, unchangedRunnerOnReload: kind === "reload" ? done.runnerPid === started.runnerPid : undefined }));
  } finally {
    if (task) {
      const current = snapshot(task.root, task.spec.id);
      if (current.handle) owned.add(current.handle);
      if (!TERMINAL_STATES.has(current.status)) {
        requestStop(task.root, task.spec.id);
        await waitFor(() => TERMINAL_STATES.has(snapshot(task.root, task.spec.id).status), "cleanup cancellation", 10000);
      }
    }
    for (const handle of owned) {
      const closed = await call(["terminal", "close", "--terminal", handle]);
      assert.equal(closed.result?.close?.ptyKilled, true);
    }
  }
}
for (const kind of ["success", "failure", "cancel", "reload"]) await runCase(kind);
console.log("PASS: all managed Orca end-to-end cases; owned terminals cleaned up");
