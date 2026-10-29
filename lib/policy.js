export const GUIDELINES = [
  "Foreground-first: use ordinary read, edit, write, and bash tools for routine work, tests, builds, and dependent steps. Duration alone is not a reason to delegate or detach work.",
  "Do not start hidden agents, Fusion workflows, nohup jobs, shell '&' jobs, or detached model calls as a substitute for foreground work. A second opinion is not automatically a background task.",
  "Use bg_run or orca_terminal for a persistent server/watcher, explicitly requested background job, or genuinely independent work. They use the same managed visible runner with automatic completion/failure notifications and follow-up; never launch both for the same job. A noninteractive agent CLI can also run as a managed visible command when explicitly requested.",
  "bg_run/orca_terminal launches start immediately without asking; orca_agent launches ask the user first. Launches return receipts, not completed work. Report the task id and terminal handle; continue independent work or yield for the automatic completion notification rather than polling. Use bg_status, bg_logs, and bg_kill for deliberate inspection or cancellation. Native interactive orca_agent tabs use the Orca orchestration workflow for return messages.",
  "Read the orca-cli skill before operating Orca. For supervised workers, read the orchestration skill and use its documented coordination; a native launch alone does not arrange automatic results.",
  "Outside Orca, keep work in the foreground. Do not silently substitute hidden shell processes when Orca is missing or cannot show a visible surface.",
];

export function resolveOrca(env = process.env, platform = process.platform) {
  if (env.ORCA_CLI_COMMAND?.trim()) return env.ORCA_CLI_COMMAND.trim();
  if (env.ORCA_DEV_REPO_ROOT) return "orca-dev";
  if (platform === "linux" && !env.ORCA_PANE_KEY && !env.ORCA_WORKTREE_ID) return "orca-ide";
  return "orca";
}

function nonempty(value, field) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0"))
    throw new Error(field + " must be a non-empty string without NUL bytes");
  return value;
}

export function buildLaunch(kind, input, cwd) {
  if (!["terminal", "agent"].includes(kind)) throw new Error("Unknown launch kind");
  const worktree = input.worktree === undefined ? "path:" + nonempty(cwd, "cwd") : nonempty(input.worktree, "worktree");
  const args = kind === "terminal"
    ? ["terminal", "create", "--title", nonempty(input.title, "title"), "--command", nonempty(input.command, "command")]
    : ["agent", "launch", "--agent", nonempty(input.agent, "agent"), "--prompt", nonempty(input.prompt, "prompt")];
  if (kind === "agent") {
    if (input.model !== undefined) args.push("--model", nonempty(input.model, "model"));
    if (input.effort !== undefined) {
      if (!input.model) throw new Error("effort requires an explicit model");
      args.push("--effort", nonempty(input.effort, "effort"));
    }
  }
  args.push("--worktree", worktree);
  if (input.focus === true) args.push("--focus");
  args.push("--json");
  return args;
}

const NO_RETRY = "Do not automatically launch again: the host may already have created a worker. Inspect Orca first; if the receipt includes an operationId, follow the Orca CLI replay procedure using that ID.";

export function interpretReceipt(kind, execution) {
  const raw = execution.stdout || "";
  let receipt;
  try { receipt = JSON.parse(raw); } catch {}
  const diagnostics = [raw, execution.stderr].filter(Boolean).join("\n");
  const fail = (message) => ({
    isError: true,
    content: [{ type: "text", text: message + "\n" + NO_RETRY + (diagnostics ? "\n\nCLI receipt/output:\n" + diagnostics : "") }],
    details: { kind, receipt, launchUnverified: true },
  });
  if (execution.killed || execution.code !== 0 || receipt?.ok !== true) {
    return fail("Orca launch failed or was interrupted; launch state is unverified.");
  }
  const result = receipt.result;
  if (kind === "terminal") {
    const terminal = result?.terminal;
    if (!terminal?.handle || terminal.surface !== "visible") {
      return fail("Orca did not confirm a visible terminal. Any returned handle may already exist; no hidden fallback was started by this extension.");
    }
    return {
      content: [{ type: "text", text: "Visible Orca terminal opened: " + terminal.handle + "\nCommand completion is not tracked by this tool.\n\n" + raw }],
      details: { kind, handle: terminal.handle, receipt },
    };
  }
  // agent launch returns the launch directly; worktree-create style receipts
  // can wrap it under launch. Accept both, never infer a legacy handle.
  const launch = result?.outcome ? result : result?.launch;
  const outcome = launch?.outcome;
  if (!outcome?.handle || !["structured", "terminal"].includes(outcome.kind)) {
    return fail("Orca did not return a supported native agent launch receipt. Update Orca if necessary.");
  }
  if (!["journaled", "handed-to-terminal"].includes(launch.prompt?.outcome)) {
    return fail("Orca created an agent surface but did not confirm prompt delivery. Do not resend blindly.");
  }
  return {
    content: [{ type: "text", text: "Orca agent opened (" + outcome.kind + "): " + outcome.handle + "\nPrompt: " + launch.prompt.outcome + ". This is a launch receipt, not a completed answer.\n\n" + raw }],
    details: { kind, handle: outcome.handle, receipt },
  };
}

export async function launchVisible(pi, kind, input, ctx, signal, env = process.env, platform = process.platform) {
  const args = buildLaunch(kind, input, ctx.cwd);
  if (signal?.aborted) throw new Error("Cancelled before launching Orca");
  if (!ctx.hasUI) throw new Error("Visible Orca launches require an interactive confirmation. In headless mode, use the Orca CLI explicitly; no process was started.");
  const summary = kind === "terminal"
    ? "Terminal: " + input.title + "\nCommand: " + input.command
    : "Agent: " + input.agent + "\nModel: " + (input.model ?? "Orca configured default") + "\nEffort: " + (input.effort ?? "default") + "\nPrompt: " + input.prompt;
  const target = input.worktree ?? "path:" + ctx.cwd;
  const approved = await ctx.ui.confirm("Open a visible Orca " + kind + "?", summary + "\nWorkspace: " + target + "\nThe process is owned by Orca and can continue after this Pi session ends.");
  if (!approved || signal?.aborted) {
    return { content: [{ type: "text", text: "Cancelled; no Orca process was started." }], details: { cancelled: true } };
  }
  const cli = resolveOrca(env, platform);
  try {
    const execution = await pi.exec(cli, args, { cwd: ctx.cwd, signal, timeout: 30000 });
    return interpretReceipt(kind, execution);
  } catch (error) {
    // Even a transport failure after submission can leave a live agent behind.
    return {
      isError: true,
      content: [{ type: "text", text: cli + ": " + String(error) + "\n" + NO_RETRY }],
      details: { kind, launchUnverified: true },
    };
  }
}
