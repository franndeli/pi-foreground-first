import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import foregroundFirst from "../extensions/index.js";
import { GUIDELINES } from "../lib/policy.js";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

function harness(existingTools = []) {
  const events = new Map(), tools = new Map(), commands = new Map(), notices = [];
  const pi = {
    on: (event, fn) => events.set(event, fn),
    registerTool: (tool) => tools.set(tool.name, tool),
    registerCommand: (name, definition) => commands.set(name, definition),
    getAllTools: () => existingTools,
  };
  foregroundFirst(pi);
  return { pi, events, tools, commands, notices, ctx: {
    cwd: join(tmpdir(), "pi-no-task-fixture"),
    sessionManager: { getSessionId: () => "fixture", getEntries: () => [] },
    ui: { notify: (...args) => notices.push(args), setStatus() {} },
  } };
}

test("extension registers visible managed task tools without starting jobs during loading", () => {
  const h = harness();
  assert.deepEqual([...h.tools.keys()], ["orca_terminal", "bg_run", "bg_status", "bg_logs", "bg_kill", "orca_agent"]);
  assert.deepEqual([...h.commands.keys()], ["bg", "jobs", "tasks", "logs", "kill", "bg-rerun", "foreground-first"]);
  assert.deepEqual([...h.events.keys()], ["before_agent_start", "session_start", "session_shutdown"]);
});

test("foreground policy is additive, idempotent, and preserves existing guidelines", () => {
  const h = harness();
  const event = { systemPrompt: "base", systemPromptOptions: { promptGuidelines: ["existing"] } };
  h.events.get("before_agent_start")(event);
  h.events.get("before_agent_start")(event);
  assert.deepEqual(event.systemPromptOptions.promptGuidelines, ["existing", ...GUIDELINES]);
});

test("opaque upstream system prompt is preserved with policy appended", () => {
  const h = harness();
  const event = { systemPrompt: "opaque", systemPromptOptions: { forceSystemPrompt: "opaque", promptGuidelines: [] } };
  assert.match(h.events.get("before_agent_start")(event).systemPrompt, /^opaque\n/);
});

test("session lifecycle starts and stops monitoring without spurious notifications", () => {
  const h = harness();
  h.events.get("session_start")({}, h.ctx);
  h.events.get("session_shutdown")({}, h.ctx);
  assert.equal(h.notices.length, 0);
});

test("an embedding host (non-TUI mode) gets neither the Orca tools nor the policy", () => {
  const h = harness();
  let active = ["read", "bash", "bg_run", "orca_terminal", "orca_agent", "background_command"];
  const pi = h.pi;
  pi.getActiveTools = () => active;
  pi.setActiveTools = (names) => { active = names; };
  h.events.get("session_start")({}, { ...h.ctx, mode: "rpc" });
  assert.deepEqual(active, ["read", "bash", "background_command"]);
  const event = { systemPrompt: "base", systemPromptOptions: { promptGuidelines: [] } };
  h.events.get("before_agent_start")(event);
  assert.deepEqual(event.systemPromptOptions.promptGuidelines, []);
});

test("status command describes actual capabilities", async () => {
  const h = harness();
  await h.commands.get("foreground-first").handler("", h.ctx);
  assert.match(h.notices[0][0], /automatic completion follow-up/);
});

test("real Pi resource loader loads packaged entrypoint and survives reload without duplicates", async () => {
  const temp = await mkdtemp(join(tmpdir(), "pi-foreground-test-"));
  try {
    const loader = new DefaultResourceLoader({
      cwd: temp, agentDir: temp,
      settingsManager: SettingsManager.inMemory({ packages: [] }),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [fileURLToPath(new URL("../extensions/index.js", import.meta.url))],
    });
    for (let i = 0; i < 2; i++) {
      await loader.reload();
      const loaded = loader.getExtensions();
      assert.deepEqual(loaded.errors, []);
      assert.equal(loaded.extensions.length, 1);
      assert.deepEqual([...loaded.extensions[0].tools.keys()], ["orca_terminal", "bg_run", "bg_status", "bg_logs", "bg_kill", "orca_agent"]);
      assert.equal(loaded.extensions[0].commands.has("foreground-first"), true);
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
});
