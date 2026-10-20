import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";

export const TERMINAL_STATES = new Set(["completed", "failed", "cancelled", "timed_out", "interrupted"]);
export const DEFAULT_OUTPUT_LIMIT = 20 * 1024 * 1024;
export const MAX_LOG_READ = 50 * 1024;
export const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + "." + randomUUID() + ".tmp";
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(value) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
  if (process.platform !== "win32") {
    const dir = openSync(dirname(path), "r");
    try { fsyncSync(dir); } finally { closeSync(dir); }
  }
}
export function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error; // Malformed or unreadable records must never become invented success.
  }
}
export function sessionRoot(cwd, sessionId) {
  if (!sessionId) throw new Error("A Pi session id is required for managed tasks");
  return join(resolve(cwd), ".pi", "foreground-tasks", createHash("sha256").update(sessionId).digest("hex").slice(0, 24));
}
export function taskPath(root, id) {
  if (!TASK_ID.test(id)) throw new Error("Use the exact task UUID returned by bg_run or /bg");
  return join(root, id);
}
export function createTask(root, input) {
  const id = randomUUID();
  const dir = taskPath(root, id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const spec = { ...input, version: 1, id, token: randomUUID(), createdAt: Date.now() };
  atomicJson(join(dir, "spec.json"), spec);
  return { dir, spec };
}
export function snapshot(root, id, now = Date.now()) {
  const dir = taskPath(root, id), spec = readJson(join(dir, "spec.json"));
  if (!spec || spec.id !== id || spec.version !== 1) throw new Error("Unknown or invalid task: " + id);
  const state = readJson(join(dir, "state.json"));
  const launch = readJson(join(dir, "launch.json"));
  const recovery = readJson(join(dir, "recovery.json"));
  let current = state && TERMINAL_STATES.has(state.status) ? state : recovery ?? state ?? { status: "starting" };
  if (state && !recovery && !TERMINAL_STATES.has(state.status) && now - state.updatedAt > 15000) {
    try { process.kill(state.runnerPid, 0); current = { ...state, status: "unresponsive" }; }
    catch (error) {
      if (error.code === "ESRCH") {
        current = { status: "interrupted", endedAt: now, exitCode: null, reason: "Task runner exited without a final record; command outcome is unknown." };
        atomicJson(join(dir, "recovery.json"), current);
      } else current = { ...state, status: "unresponsive" };
    }
  } else if (!state && !recovery && now - spec.createdAt > 90000) {
    current = { status: "failed", endedAt: now, exitCode: null, reason: "Runner did not publish a start record before its launch authorization expired; command was not started." };
    atomicJson(join(dir, "recovery.json"), current);
  }
  return { id, name: spec.name, command: spec.command, cwd: spec.cwd, createdAt: spec.createdAt,
    ...current, handle: launch?.handle, outputPath: join(dir, "output.log"),
    notifyOnCompletion: spec.notifyOnCompletion, triggerOnCompletion: spec.triggerOnCompletion };
}
export function listTasks(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((id) => TASK_ID.test(id)).map((id) => snapshot(root, id)).sort((a, b) => b.createdAt - a.createdAt);
}
export function readLogs(root, id, maxBytes = 16000) {
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_LOG_READ) throw new Error("maxBytes must be 1..51200");
  const task = snapshot(root, id);
  let fd;
  try {
    fd = openSync(task.outputPath, "r");
    const size = statSync(task.outputPath).size;
    const start = Math.max(0, size - maxBytes), buffer = Buffer.alloc(Math.min(size, maxBytes));
    const bytes = readSync(fd, buffer, 0, buffer.length, start);
    // Skip a partial leading UTF-8 sequence when tailing.
    let offset = 0;
    if (start) while (offset < bytes && (buffer[offset] & 0xc0) === 0x80) offset++;
    return { taskId: id, outputPath: task.outputPath, truncated: start > 0, bytes: size, text: buffer.subarray(offset, bytes).toString("utf8") };
  } catch (error) {
    if (error.code === "ENOENT") return { taskId: id, outputPath: task.outputPath, bytes: 0, truncated: false, text: "" };
    throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
}
export function requestStop(root, id) {
  const task = snapshot(root, id);
  if (TERMINAL_STATES.has(task.status)) throw new Error("Task is already terminal: " + task.status);
  atomicJson(join(taskPath(root, id), "stop.json"), { id, requestedAt: Date.now() });
  return { ...task, stopRequested: true };
}
