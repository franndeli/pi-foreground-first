// Runs INSIDE the visible Orca terminal, independently of the parent Pi process.
import { spawn } from "node:child_process";
import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { atomicJson, readJson } from "./task-store.js";

export async function runTask(dir) {
  const spec = readJson(join(dir, "spec.json"));
  if (!spec || spec.version !== 1 || !spec.command || !spec.token) throw new Error("Invalid task specification");
  // Never execute a task twice if its terminal command is accidentally replayed.
  const claim = openSync(join(dir, "runner.claim"), "wx", 0o600);
  closeSync(claim);
  let state = { id: spec.id, status: "starting", runnerPid: process.pid, updatedAt: Date.now() };
  const publish = (patch) => { state = { ...state, ...patch, updatedAt: Date.now() }; atomicJson(join(dir, "state.json"), state); };
  publish({});
  const gateDeadline = Date.now() + 45000;
  while (true) {
    if (Date.now() > spec.createdAt + 90000) { publish({ status: "failed", endedAt: Date.now(), exitCode: null, reason: "Launch authorization expired; command was not started" }); return; }
    if (readJson(join(dir, "stop.json"))) { publish({ status: "cancelled", endedAt: Date.now(), exitCode: null, reason: "Cancelled before command start" }); return; }
    const gate = readJson(join(dir, "start.json"));
    if (gate?.token === spec.token) break;
    if (Date.now() >= gateDeadline) { publish({ status: "failed", endedAt: Date.now(), exitCode: null, reason: "No verified visible-terminal launch approval; command was not started" }); return; }
    await new Promise((done) => setTimeout(done, 100));
  }
  const fd = openSync(join(dir, "output.log"), "a", 0o600);
  let child, heartbeat, stopPoll, timeout, forceKill, reason, bytes = 0, spawnError, closedPromise;
  let closed = false, fdClosed = false;
  const stop = (why) => {
    if (reason || closed) return;
    reason = why;
    if (!child?.pid) return;
    const signalGroup = (signal) => {
      try { process.kill(-child.pid, signal); }
      catch (error) { if (error.code !== "ESRCH") process.stderr.write("Could not signal task group: " + error.message + "\n"); }
    };
    signalGroup("SIGTERM");
    forceKill = setTimeout(() => signalGroup("SIGKILL"), 2000);
  };
  const signals = new Map(["SIGTERM", "SIGINT", "SIGHUP"].map((signal) => [signal, () => stop("cancelled")]));
  const terminalClosed = () => stop("cancelled");
  const guarded = (action) => {
    try { action(); } catch (error) { spawnError = error.message; stop("runner_error"); }
  };
  for (const [signal, listener] of signals) process.on(signal, listener);
  process.stdout.on("error", terminalClosed);
  process.stderr.on("error", terminalClosed);
  try {
    // A process group is used ONLY for cancelling our descendants. Output is
    // piped back to this visible terminal, never to a hidden task surface.
    child = spawn(spec.shell, ["-c", spec.command], { cwd: spec.cwd, env: process.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    closedPromise = new Promise((done) => child.once("close", (code, signal) => { closed = true; done({ code, signal }); }));
    const output = (chunk, stream) => {
      const remaining = Math.max(0, spec.maxOutputBytes - bytes);
      if (remaining) {
        const kept = chunk.subarray(0, remaining);
        writeSync(fd, kept); bytes += kept.length;
        stream.write(kept);
      }
      if (chunk.length > remaining) stop("output_limit");
    };
    child.stdout.on("data", (chunk) => guarded(() => output(chunk, process.stdout)));
    child.stderr.on("data", (chunk) => guarded(() => output(chunk, process.stderr)));
    child.on("error", (error) => { spawnError = error.message; });
    publish({ status: "running", startedAt: Date.now(), childPid: child.pid });
    heartbeat = setInterval(() => guarded(() => publish({ bytes })), 1000);
    stopPoll = setInterval(() => guarded(() => { if (readJson(join(dir, "stop.json"))) stop("cancelled"); }), 200);
    if (spec.timeoutSeconds) timeout = setTimeout(() => stop("timed_out"), spec.timeoutSeconds * 1000);
    const result = await closedPromise;
    for (const timer of [heartbeat, stopPoll, timeout, forceKill]) clearTimeout(timer);
    fsyncSync(fd); closeSync(fd); fdClosed = true;
    const status = reason === "cancelled" ? "cancelled" : reason === "timed_out" ? "timed_out" : reason || spawnError || result.code !== 0 ? "failed" : "completed";
    publish({ status, endedAt: Date.now(), exitCode: result.code, signal: result.signal, reason: spawnError ?? reason ?? null, bytes });
    process.stdout.write("\n[Pi task " + spec.id + ": " + status + "; exit " + result.code + "]\n");
  } catch (error) {
    // Storage/control failures must not abandon an owned live command group.
    stop("runner_error");
    if (closedPromise && !closed) await closedPromise;
    throw error;
  } finally {
    for (const timer of [heartbeat, stopPoll, timeout, forceKill]) clearTimeout(timer);
    if (!fdClosed) closeSync(fd);
    for (const [signal, listener] of signals) process.off(signal, listener);
    process.stdout.off("error", terminalClosed);
    process.stderr.off("error", terminalClosed);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runTask(process.argv[2]).catch((error) => { console.error("Task runner error:", error); process.exitCode = 1; });
}
