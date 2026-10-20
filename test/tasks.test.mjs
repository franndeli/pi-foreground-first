import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicJson, createTask, listTasks, readJson, readLogs, requestStop, sessionRoot, snapshot, taskPath, TERMINAL_STATES } from "../lib/task-store.js";
import { TaskManager, TASK_MESSAGE } from "../lib/task-manager.js";

const runner = fileURLToPath(new URL("../lib/task-runner.js", import.meta.url));
const waitFor = async (condition, timeout = 8000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = condition(); if (value) return value; await new Promise((done) => setTimeout(done, 30)); }
  throw new Error("Condition timed out");
};
function setup(t, session = "session-a") {
  const cwd = mkdtempSync(join(tmpdir(), "pi-managed-task-"));
  const root = sessionRoot(cwd, session);
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const create = (command = "printf hello", extra = {}) => createTask(root, { sessionId: session, cwd, shell: "/bin/sh", name: "Test", command, maxOutputBytes: 4096, notifyOnCompletion: true, triggerOnCompletion: true, ...extra });
  const entries = [], messages = [], notices = [];
  const ctx = { cwd, hasUI: true, sessionManager: { getSessionId: () => session, getEntries: () => entries }, ui: { confirm: async () => true, setStatus() {}, notify: (...args) => notices.push(args) } };
  const pi = { sendMessage: (message, options) => messages.push({ message, options }) };
  const manager = new TaskManager(pi);
  t.after(() => manager.stop());
  return { cwd, root, create, ctx, pi, entries, messages, notices, manager };
}
function startRunner(t, task, approved = true) {
  if (approved) atomicJson(join(task.dir, "start.json"), { token: task.spec.token });
  const child = spawn(process.execPath, [runner, task.dir], { stdio: "ignore" });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); });
  return child;
}
const terminal = (h, id) => waitFor(() => { const task = snapshot(h.root, id); return TERMINAL_STATES.has(task.status) && task; });

test("runner captures output and exact exit status durably before completion", async (t) => {
  const h = setup(t), task = h.create("printf 'hello 🌍\\n'; printf 'stderr\\n' >&2");
  startRunner(t, task);
  const done = await terminal(h, task.spec.id);
  assert.equal(done.status, "completed"); assert.equal(done.exitCode, 0);
  const logs = readLogs(h.root, task.spec.id);
  assert.match(logs.text, /hello 🌍/); assert.match(logs.text, /stderr/);
  assert.equal(readJson(join(task.dir, "state.json")).status, "completed");
});

test("nonzero exits are failures, not successful task completion", async (t) => {
  const h = setup(t), task = h.create("printf failed; exit 7");
  startRunner(t, task);
  const done = await terminal(h, task.spec.id);
  assert.equal(done.status, "failed"); assert.equal(done.exitCode, 7);
});

test("unapproved launch cannot execute the user command, and can be cancelled", async (t) => {
  const h = setup(t), task = h.create("touch should-not-exist");
  startRunner(t, task, false);
  await waitFor(() => readJson(join(task.dir, "state.json")));
  assert.equal(existsSync(join(h.cwd, "should-not-exist")), false);
  requestStop(h.root, task.spec.id);
  assert.equal((await terminal(h, task.spec.id)).status, "cancelled");
  assert.equal(existsSync(join(h.cwd, "should-not-exist")), false);
});

test("duplicate runner claim never executes a command twice", async (t) => {
  const h = setup(t), task = h.create("printf x >> once");
  startRunner(t, task);
  await terminal(h, task.spec.id);
  const duplicate = startRunner(t, task);
  await new Promise((done) => duplicate.once("close", done));
  assert.equal(readFileSync(join(h.cwd, "once"), "utf8"), "x");
  assert.equal(snapshot(h.root, task.spec.id).status, "completed");
});

test("timeout is enforced by the runner independently of Pi", async (t) => {
  const h = setup(t), task = h.create("sleep 30", { timeoutSeconds: 0.15 });
  startRunner(t, task);
  assert.equal((await terminal(h, task.spec.id)).status, "timed_out");
});

test("stop request terminates a running command and reports cancellation after exit", async (t) => {
  const h = setup(t), task = h.create("sleep 30");
  startRunner(t, task);
  await waitFor(() => snapshot(h.root, task.spec.id).status === "running");
  assert.equal(requestStop(h.root, task.spec.id).stopRequested, true);
  assert.equal((await terminal(h, task.spec.id)).status, "cancelled");
  assert.throws(() => requestStop(h.root, task.spec.id), /already terminal/);
});

test("output limit bounds durable logs and fails/stops the job", async (t) => {
  const h = setup(t), task = h.create("yes output", { maxOutputBytes: 100 });
  startRunner(t, task);
  const done = await terminal(h, task.spec.id);
  assert.equal(done.status, "failed"); assert.equal(done.reason, "output_limit");
  assert.equal(readLogs(h.root, task.spec.id).bytes, 100);
});

test("log tail is bounded and avoids partial leading UTF-8 characters", (t) => {
  const h = setup(t), task = h.create();
  writeFileSync(join(task.dir, "output.log"), "prefix🌍tail");
  const logs = readLogs(h.root, task.spec.id, 6);
  assert.equal(logs.truncated, true); assert.equal(logs.text, "tail");
  assert.throws(() => readLogs(h.root, task.spec.id, 60000));
  assert.throws(() => snapshot(h.root, "../../outside"));
});

function finish(h, extra = {}) {
  const task = h.create("printf result", extra);
  atomicJson(join(task.dir, "state.json"), { status: "completed", exitCode: 0, endedAt: Date.now() });
  writeFileSync(join(task.dir, "output.log"), "result");
  return task;
}
test("terminal completion sends one automatic follow-up with status and output", (t) => {
  const h = setup(t); const task = finish(h);
  h.manager.start(h.ctx); h.manager.tick(); h.manager.tick();
  assert.equal(h.messages.length, 1);
  assert.deepEqual(h.messages[0].options, { triggerTurn: true, deliverAs: "followUp" });
  assert.match(h.messages[0].message.content, /Exit code: 0/);
  assert.match(h.messages[0].message.content, /result/);
  assert.equal(h.messages[0].message.details.taskId, task.spec.id);
  assert.equal(existsSync(join(task.dir, "delivered.json")), false, "enqueue alone is not durable delivery");
});

test("recorded notification survives reload/resume without duplicate delivery", (t) => {
  const h = setup(t); const task = finish(h);
  h.manager.start(h.ctx);
  h.entries.push({ type: "custom_message", customType: TASK_MESSAGE, details: h.messages[0].message.details });
  h.manager.tick();
  assert.ok(existsSync(join(task.dir, "delivered.json")));
  h.manager.stop(); h.manager.start(h.ctx);
  assert.equal(h.messages.length, 1);
});

test("queued but unpersisted notification is recovered on restart", (t) => {
  const h = setup(t); finish(h);
  h.manager.start(h.ctx); h.manager.stop(); h.manager.start(h.ctx);
  assert.equal(h.messages.length, 2, "at-least-once retry is preferable to losing completion");
});

test("notifications disabled and notify-only behavior are respected", (t) => {
  const h = setup(t); finish(h, { notifyOnCompletion: false }); finish(h, { triggerOnCompletion: false });
  h.manager.start(h.ctx);
  assert.equal(h.messages.length, 1); assert.equal(h.messages[0].options.triggerTurn, false);
});

test("shutdown stops monitoring, session switches never deliver another session's task", (t) => {
  const h = setup(t); h.manager.start(h.ctx); h.manager.stop(); finish(h); h.manager.tick();
  assert.equal(h.messages.length, 0);
  const otherCtx = { ...h.ctx, sessionManager: { getSessionId: () => "session-b", getEntries: () => [] } };
  h.manager.start(otherCtx); assert.equal(h.messages.length, 0);
  h.manager.start(h.ctx); assert.equal(h.messages.length, 1);
});

test("corrupt task state reports an error and never fabricates completion", (t) => {
  const h = setup(t); const task = h.create(); writeFileSync(join(task.dir, "state.json"), "bad-json");
  h.manager.start(h.ctx); h.manager.tick();
  assert.equal(h.messages.length, 0); assert.equal(h.notices.length, 1);
});

test("expired launch authorization fails without executing a late runner", async (t) => {
  const h = setup(t), task = h.create("touch too-late");
  task.spec.createdAt = Date.now() - 91000;
  atomicJson(join(task.dir, "spec.json"), task.spec);
  assert.equal(snapshot(h.root, task.spec.id).status, "failed");
  const child = startRunner(t, task);
  await new Promise((done) => child.once("close", done));
  assert.equal(existsSync(join(h.cwd, "too-late")), false);
  assert.equal(snapshot(h.root, task.spec.id).status, "failed");
});

test("spawn failure is captured with a reason and a terminal notification", async (t) => {
  const h = setup(t), task = h.create("true", { shell: "/no-such-shell-for-task-test" });
  startRunner(t, task);
  const done = await terminal(h, task.spec.id);
  assert.equal(done.status, "failed"); assert.match(done.reason, /ENOENT/);
  h.manager.start(h.ctx); assert.equal(h.messages.length, 1);
});

test("cancellation escalates when the command ignores TERM", async (t) => {
  const h = setup(t), task = h.create("trap '' TERM; printf ready; while :; do sleep 1; done");
  startRunner(t, task);
  await waitFor(() => readLogs(h.root, task.spec.id).text.includes("ready"));
  requestStop(h.root, task.spec.id);
  const done = await terminal(h, task.spec.id);
  assert.equal(done.status, "cancelled"); assert.equal(done.signal, "SIGKILL");
});

test("malformed control records stop the command rather than orphaning it", async (t) => {
  const h = setup(t), task = h.create("sleep 30");
  startRunner(t, task);
  await waitFor(() => snapshot(h.root, task.spec.id).status === "running");
  writeFileSync(join(task.dir, "stop.json"), "bad-json");
  assert.equal((await terminal(h, task.spec.id)).status, "failed");
});

test("a closed output pipe cancels the owned command instead of crashing the runner", async (t) => {
  const h = setup(t), task = h.create("while :; do printf progress; sleep 0.1; done");
  atomicJson(join(task.dir, "start.json"), { token: task.spec.token });
  const child = spawn(process.execPath, [runner, task.dir], { stdio: ["ignore", "pipe", "ignore"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); });
  await waitFor(() => snapshot(h.root, task.spec.id).status === "running");
  child.stdout.destroy();
  assert.equal((await terminal(h, task.spec.id)).status, "cancelled");
});

test("task lifecycle events expose ordinary jobs to Orca's existing status integration", (t) => {
  const h = setup(t), task = h.create(); const events = [];
  h.pi.events = { emit: (...args) => events.push(args) };
  h.manager.start(h.ctx); h.manager.tick();
  assert.equal(events.length, 1); assert.equal(events[0][0], "task:subagent:lifecycle");
  assert.equal(events[0][1].status, "started");
  atomicJson(join(task.dir, "state.json"), { status: "completed", exitCode: 0 });
  h.manager.tick(); h.manager.tick();
  assert.equal(events.length, 2); assert.equal(events[1][1].status, "completed");
  assert.equal(h.messages.length, 1);
});

test("a failing optional Orca status listener cannot block completion delivery", (t) => {
  const h = setup(t); finish(h);
  t.mock.method(console, "warn", () => {});
  h.pi.events = { emit: () => { throw new Error("host unavailable"); } };
  h.manager.start(h.ctx);
  assert.equal(h.messages.length, 1);
});

const cliResult = (value) => ({ code: 0, killed: false, stderr: "", stdout: JSON.stringify({ ok: true, result: value }) });
function cliHarness(h, surface = "visible") {
  const calls = [];
  h.pi.exec = async (_cli, args) => {
    calls.push(args);
    if (args[0] === "worktree") return cliResult({ worktree: { hostId: "local" } });
    return cliResult({ terminal: { handle: "term-test", surface, executionHostId: "local" } });
  };
  return calls;
}
test("managed launch verifies local visible placement before opening its execution gate", async (t) => {
  const h = setup(t), calls = cliHarness(h);
  const response = await h.manager.run({ name: "test", command: "printf 'quoted'" }, h.ctx);
  const dir = taskPath(h.root, response.details.taskId);
  assert.equal(response.isError, undefined);
  assert.ok(existsSync(join(dir, "start.json")));
  assert.equal(readJson(join(dir, "spec.json")).command, "printf 'quoted'");
  assert.equal(calls.length, 2);
  assert.ok(!calls[1][calls[1].indexOf("--command") + 1].includes("printf"), "user command stays in JSON, not launcher interpolation");
});

test("invisible Orca fallback never gets execution approval", async (t) => {
  const h = setup(t); cliHarness(h, "background");
  const response = await h.manager.run({ name: "test", command: "printf hello" }, h.ctx);
  const dir = taskPath(h.root, response.details.taskId);
  assert.equal(response.isError, true); assert.equal(existsSync(join(dir, "start.json")), false);
  assert.ok(existsSync(join(dir, "stop.json")));
});

test("confirmation rejection, headless mode, invalid timeout and remote targets launch nothing", async (t) => {
  const h = setup(t), calls = cliHarness(h);
  h.ctx.ui.confirm = async () => false;
  assert.equal((await h.manager.run({ name: "test", command: "true" }, h.ctx)).details.cancelled, true);
  await assert.rejects(h.manager.run({ name: "test", command: "true" }, { ...h.ctx, hasUI: false }), /confirmation/);
  await assert.rejects(h.manager.run({ name: "test", command: "true", timeoutSeconds: -1 }, h.ctx), /timeoutSeconds/);
  await assert.rejects(h.manager.run({ name: "test", command: "true", worktree: "name:remote" }, h.ctx), /local cwd/);
  assert.equal(calls.length, 0); assert.deepEqual(listTasks(h.root), []);
});
