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
  return { events, tools, commands, notices, ctx: { ui: { notify: (...args) => notices.push(args) } } };
}

test("extension registers only visible launch tools and no process/provider/timer machinery", () => {
  const h = harness();
  assert.deepEqual([...h.tools.keys()], ["orca_terminal", "orca_agent"]);
  assert.deepEqual([...h.commands.keys()], ["foreground-first"]);
  assert.deepEqual([...h.events.keys()], ["before_agent_start", "session_start"]);
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

test("warns about conflicting background extension, otherwise stays quiet", () => {
  const h = harness([{ name: "bg_run" }]);
  h.events.get("session_start")({}, h.ctx);
  assert.equal(h.notices.length, 1);
  assert.equal(h.notices[0][1], "warning");
  const clean = harness();
  clean.events.get("session_start")({}, clean.ctx);
  assert.equal(clean.notices.length, 0);
});

test("status command describes actual capabilities", async () => {
  const h = harness();
  await h.commands.get("foreground-first").handler("", h.ctx);
  assert.match(h.notices[0][0], /No hidden task manager/);
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
      assert.deepEqual([...loaded.extensions[0].tools.keys()], ["orca_terminal", "orca_agent"]);
      assert.equal(loaded.extensions[0].commands.has("foreground-first"), true);
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
});
