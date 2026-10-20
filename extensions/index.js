import { Type } from "typebox";
import { GUIDELINES, launchVisible } from "../lib/policy.js";

const shared = {
  worktree: Type.Optional(Type.String({ description: "Explicit Orca workspace selector; defaults to path:<this session cwd>, never the selected UI tab." })),
  focus: Type.Optional(Type.Boolean({ description: "Switch focus to the new tab. Default false: visible tab without stealing focus." })),
};

export default function foregroundFirst(pi) {
  pi.on("before_agent_start", (event) => {
    const options = event.systemPromptOptions;
    for (const guideline of GUIDELINES) {
      if (!options.promptGuidelines.includes(guideline)) options.promptGuidelines.push(guideline);
    }
    // Respect an earlier extension's opaque prompt replacement.
    if (options.forceSystemPrompt) {
      return { systemPrompt: event.systemPrompt + "\n\n<foreground_first>\n" + GUIDELINES.join("\n") + "\n</foreground_first>" };
    }
  });

  pi.registerTool({
    name: "orca_terminal",
    label: "Visible Orca Terminal",
    description: "Open a user-confirmed Orca terminal for a persistent server/watcher or explicitly requested independent job. Routine commands stay in foreground bash. Returns a launch receipt, not command completion. Never launches a hidden fallback.",
    promptSnippet: "Open a visible Orca terminal after user confirmation; routine work stays foreground",
    parameters: Type.Object({
      title: Type.String({ minLength: 1, description: "Short human-readable tab title" }),
      command: Type.String({ minLength: 1, description: "Command executed by the target workspace's configured terminal shell" }),
      ...shared,
    }),
    execute: (_id, input, signal, _onUpdate, ctx) => launchVisible(pi, "terminal", input, ctx, signal),
  });

  pi.registerTool({
    name: "orca_agent",
    label: "Visible Orca Agent",
    description: "Launch a substantial, user-confirmed separate worker through Orca's native agent launch. Follows Orca Chat UI settings (chat or terminal); not a hidden delegate or automatic second-opinion call. Returns the exact handle and prompt-delivery receipt, not the worker's answer. Read orca-cli guidance before use.",
    promptSnippet: "Launch a user-confirmed native Orca worker, not a hidden background model",
    parameters: Type.Object({
      agent: Type.String({ minLength: 1, description: "Installed Orca agent id, e.g. pi, claude, or codex; use the user's choice" }),
      prompt: Type.String({ minLength: 1, description: "Self-contained task brief; parent conversation is not copied automatically" }),
      model: Type.Optional(Type.String({ minLength: 1, description: "Explicit model id accepted by the selected Orca agent; omitted uses Orca defaults" })),
      effort: Type.Optional(Type.String({ minLength: 1, description: "Requested effort; requires model" })),
      ...shared,
    }),
    execute: (_id, input, signal, _onUpdate, ctx) => launchVisible(pi, "agent", input, ctx, signal),
  });

  pi.on("session_start", (_event, ctx) => {
    if (pi.getAllTools().some((tool) => tool.name === "bg_run" || tool.name.startsWith("fusion_"))) {
      ctx.ui.notify("Foreground-first: another background-task extension is still loaded. Remove it and restart to avoid conflicting guidance.", "warning");
    }
  });

  pi.registerCommand("foreground-first", {
    description: "Explain foreground-first execution and visible Orca tools",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Foreground-first is active. Routine work uses normal Pi tools. orca_terminal and orca_agent require confirmation and open Orca-owned surfaces. No hidden task manager, model delegation, automatic wake-ups, or provider changes.", "info");
    },
  });
}
