import assert from "node:assert/strict";
import test from "node:test";
import { buildLaunch, interpretReceipt, launchVisible, resolveOrca } from "../lib/policy.js";

const execution = (result, extra = {}) => ({ code: 0, killed: false, stderr: "", stdout: JSON.stringify({ ok: true, result }), ...extra });
const terminal = { terminal: { handle: "term_123", surface: "visible" } };
const agent = { launch: { outcome: { kind: "structured", handle: "chat_123" }, prompt: { outcome: "journaled" } } };

test("CLI selection follows Orca guide and avoids the Linux screen reader", () => {
  assert.equal(resolveOrca({}, "linux"), "orca-ide");
  assert.equal(resolveOrca({ ORCA_PANE_KEY: "pane" }, "linux"), "orca");
  assert.equal(resolveOrca({ ORCA_WORKTREE_ID: "workspace" }, "linux"), "orca");
  assert.equal(resolveOrca({}, "darwin"), "orca");
  assert.equal(resolveOrca({ ORCA_DEV_REPO_ROOT: "/dev" }, "darwin"), "orca-dev");
  assert.equal(resolveOrca({ ORCA_CLI_COMMAND: "/path with spaces/orca", ORCA_DEV_REPO_ROOT: "/dev" }), "/path with spaces/orca");
});

test("shell command remains a single argv value, workspace is explicit, focus is opt-in", () => {
  const command = "printf '%s' \"$(echo hello)\"; echo 'quoted'";
  assert.deepEqual(buildLaunch("terminal", { title: "Server", command }, "/tmp/a b"), [
    "terminal", "create", "--title", "Server", "--command", command, "--worktree", "path:/tmp/a b", "--json",
  ]);
  const args = buildLaunch("terminal", { title: "x", command: "true", worktree: "name:test", focus: true }, "/tmp");
  assert.ok(args.includes("--focus"));
  assert.ok(args.includes("name:test"));
});

test("agent launch preserves prompt/model/effort with native Orca routing", () => {
  assert.deepEqual(buildLaunch("agent", { agent: "pi", prompt: "review\nthese files", model: "my/model", effort: "high" }, "/repo"), [
    "agent", "launch", "--agent", "pi", "--prompt", "review\nthese files", "--model", "my/model", "--effort", "high", "--worktree", "path:/repo", "--json",
  ]);
});

test("invalid arguments fail before any launch", () => {
  for (const input of [{ title: "", command: "true" }, { title: "x", command: " " }, { title: "x", command: "a\0b" }, { title: "x", command: "true", worktree: "" }])
    assert.throws(() => buildLaunch("terminal", input, "/repo"));
  assert.throws(() => buildLaunch("agent", { agent: "pi", prompt: "hello", effort: "high" }, "/repo"), /requires/);
  assert.throws(() => buildLaunch("unexpected", {}, "/repo"));
});

test("only a confirmed visible terminal is a successful terminal launch", () => {
  const result = interpretReceipt("terminal", execution(terminal));
  assert.equal(result.isError, undefined);
  assert.equal(result.details.handle, "term_123");
  assert.match(result.content[0].text, /completion is not tracked/);
  for (const surface of ["background", undefined]) {
    const result = interpretReceipt("terminal", execution({ terminal: { handle: "term_123", surface } }));
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Do not automatically launch again/);
    assert.equal(result.details.receipt.result.terminal.handle, "term_123");
  }
});

test("agent launch accepts the direct native receipt observed in Orca", () => {
  const result = interpretReceipt("agent", execution({
    outcome: { kind: "terminal", handle: "term_native" },
    receipt: { mode: "terminal", reason: "user_default" },
    prompt: { delivery: "submit", outcome: "handed-to-terminal" },
    operationId: "operation-native",
  }));
  assert.equal(result.isError, undefined);
  assert.equal(result.details.handle, "term_native");
  assert.equal(result.details.receipt.result.operationId, "operation-native");
});

test("agent launch requires a surface handle and delivered prompt", () => {
  for (const kind of ["structured", "terminal"]) {
    for (const delivery of ["journaled", "handed-to-terminal"]) {
      const result = interpretReceipt("agent", execution({ launch: { outcome: { kind, handle: "h" }, prompt: { outcome: delivery } } }));
      assert.equal(result.isError, undefined);
      assert.equal(result.details.handle, "h");
    }
  }
  for (const result of [{}, { agentTerminalHandle: "legacy" }, { launch: { outcome: { kind: "terminal", handle: "h" }, prompt: { outcome: "unknown" } } }])
    assert.equal(interpretReceipt("agent", execution(result)).isError, true);
});

test("timeout, CLI errors and malformed receipts preserve evidence and forbid blind retries", () => {
  for (const extra of [{ killed: true }, { code: 1, stderr: "not running" }, { stdout: "not JSON" }, { stdout: '{"ok":false,"operationId":"op-1"}' }]) {
    const result = interpretReceipt("agent", execution(agent, extra));
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Do not automatically launch again/);
  }
  assert.match(interpretReceipt("agent", execution(agent, { stdout: '{"ok":false,"operationId":"op-1"}' })).content[0].text, /op-1/);
});

function harness({ approved = true, hasUI = true, exec } = {}) {
  const calls = [];
  return {
    calls,
    pi: { exec: async (...args) => { calls.push(args); return exec ? exec(...args) : execution(terminal); } },
    ctx: { cwd: "/repo", hasUI, ui: { confirm: async () => approved } },
  };
}
const input = { title: "Server", command: "npm run dev" };

test("confirmation rejection and headless mode launch nothing", async () => {
  const denied = harness({ approved: false });
  const result = await launchVisible(denied.pi, "terminal", input, denied.ctx);
  assert.equal(result.details.cancelled, true);
  assert.equal(denied.calls.length, 0);
  const headless = harness({ hasUI: false });
  await assert.rejects(launchVisible(headless.pi, "terminal", input, headless.ctx), /interactive confirmation/);
  assert.equal(headless.calls.length, 0);
});

test("cancellation before and during confirmation launches nothing", async () => {
  const h = harness();
  await assert.rejects(launchVisible(h.pi, "terminal", input, h.ctx, AbortSignal.abort()), /Cancelled/);
  const controller = new AbortController();
  h.ctx.ui.confirm = async () => { controller.abort(); return true; };
  const result = await launchVisible(h.pi, "terminal", input, h.ctx, controller.signal);
  assert.equal(result.details.cancelled, true);
  assert.equal(h.calls.length, 0);
});

test("approved launch executes once, with argv, cwd, timeout, signal and no shell fallback", async () => {
  const h = harness();
  const controller = new AbortController();
  const result = await launchVisible(h.pi, "terminal", input, h.ctx, controller.signal, { ORCA_CLI_COMMAND: "/custom/orca" });
  assert.equal(result.details.handle, "term_123");
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0][0], "/custom/orca");
  assert.deepEqual(h.calls[0][2], { cwd: "/repo", signal: controller.signal, timeout: 30000 });
});

test("CLI unavailable and ambiguous submission never retry or use another executable", async () => {
  for (const exec of [async () => { throw new Error("ENOENT"); }, async () => execution({}, { code: 1, stderr: "transport lost" })]) {
    const h = harness({ exec });
    const result = await launchVisible(h.pi, "terminal", input, h.ctx);
    assert.equal(result.isError, true);
    assert.equal(h.calls.length, 1);
  }
});
