// Opt-in integration test: creates and closes only its own Orca terminals.
// ORCA_SMOKE=1 npm run test:smoke
// ORCA_SMOKE=1 ORCA_SMOKE_AGENT=pi npm run test:smoke  (makes one model call)
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { resolveOrca } from "../lib/policy.js";

if (process.env.ORCA_SMOKE !== "1") throw new Error("Set ORCA_SMOKE=1 to authorize creating a real terminal. ORCA_SMOKE_AGENT=pi additionally authorizes one live agent/model test.");
const exec = promisify(execFile);
const cli = resolveOrca();
const cwd = process.env.ORCA_SMOKE_CWD || process.cwd();
const temp = await mkdtemp(join(tmpdir(), "pi-foreground-smoke-"));
const handles = new Set();
const call = async (args) => JSON.parse((await exec(cli, [...args, "--json"], { cwd, timeout: 150000 })).stdout);
try {
  const loader = new DefaultResourceLoader({
    cwd: temp, agentDir: temp, settingsManager: SettingsManager.inMemory({ packages: [] }),
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: [fileURLToPath(new URL("../extensions/index.js", import.meta.url))],
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  const tools = loaded.extensions[0].tools;
  const ctx = { cwd, hasUI: true, ui: { confirm: async () => true } }; // Explicit opt-in above authorizes only this test.
  const launch = async (name, args) => {
    const result = await tools.get(name).definition.execute("smoke", args, undefined, undefined, ctx);
    const receipt = result.details?.receipt?.result;
    const handle = result.details?.handle || receipt?.terminal?.handle || receipt?.outcome?.handle || receipt?.launch?.outcome?.handle;
    if (handle?.startsWith("term_")) handles.add(handle);
    assert.notEqual(result.isError, true, JSON.stringify(result));
    console.log(name, JSON.stringify(result.details));
    return handle;
  };
  const terminal = await launch("orca_terminal", {
    title: "Normal shell task smoke test",
    command: "printf 'NORMAL_TASK_STARTED\\n'; for step in 1 2 3 4 5; do printf 'NORMAL_TASK_PROGRESS_%s\\n' \"$step\"; sleep 2; done; printf 'ORCA_FOREGROUND_TERMINAL_OK\\n'",
  });
  // Prove the tool returns while an ordinary shell command is still running,
  // then observe streamed progress and completion without launching a model.
  let observedRunning = false;
  let visibleOutput = false;
  const progress = new Set();
  const terminalDeadline = Date.now() + 30000;
  while (Date.now() < terminalDeadline) {
    const read = await call(["terminal", "read", "--terminal", terminal]);
    const lines = read.result?.terminal?.tail?.map((line) => line.trim()) ?? [];
    visibleOutput = lines.includes("ORCA_FOREGROUND_TERMINAL_OK");
    if (lines.includes("NORMAL_TASK_STARTED") && !visibleOutput && !observedRunning) {
      observedRunning = true;
      console.log("PASS: launch returned while ordinary shell job was still running (no agent/model)");
    }
    for (const line of lines) {
      if (/^NORMAL_TASK_PROGRESS_[1-5]$/.test(line) && !progress.has(line)) {
        progress.add(line);
        console.log("Visible output:", line);
      }
    }
    if (visibleOutput) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal(observedRunning, true, "Expected to observe an ordinary job still running after tool return");
  assert.equal(progress.size, 5, "Expected all five progress markers from the shell job");
  assert.equal(visibleOutput, true, "Expected command completion output in real Orca terminal");
  console.log("PASS: real Pi-loaded orca_terminal -> concurrent normal job -> live progress -> completion");

  if (process.env.ORCA_SMOKE_AGENT) {
    const handle = await launch("orca_agent", {
      agent: process.env.ORCA_SMOKE_AGENT,
      prompt: "Authorized integration smoke test. Reply with exactly ORCA_FOREGROUND_AGENT_OK and nothing else. Do not call tools, modify files, or start other processes.",
    });
    if (!handle.startsWith("term_")) throw new Error("Agent opened as a chat: launch verified, but this smoke script only verifies reply/cleanup for terminal-mode agents. Inspect and close the returned chat manually.");
    // A freshly launched TUI can be idle before its initial prompt is consumed.
    // Wait for observable reply content, not just an initial idle state. This
    // bounded test-only readiness loop never resends the accepted prompt.
    const deadline = Date.now() + 120000;
    let replied = false;
    let lastRead;
    while (Date.now() < deadline) {
      lastRead = await call(["terminal", "read", "--terminal", handle]);
      replied = lastRead.result?.terminal?.tail?.some((line) => line.trim() === "ORCA_FOREGROUND_AGENT_OK");
      if (replied) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    assert.ok(replied, "Expected completed agent reply; last terminal read: " + JSON.stringify(lastRead));
    console.log("PASS: real Pi-loaded orca_agent tool -> native visible agent -> delivered prompt -> model reply");
  }
} finally {
  const failures = [];
  for (const handle of handles) {
    try {
      const closed = await call(["terminal", "close", "--terminal", handle]);
      assert.equal(closed.result?.close?.ptyKilled, true);
      console.log("Closed owned smoke terminal:", handle);
    } catch (error) { failures.push(handle + ": " + error); }
  }
  await rm(temp, { recursive: true, force: true });
  if (failures.length) throw new Error("Manual smoke-terminal cleanup needed: " + failures.join("; "));
}
