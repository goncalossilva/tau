import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import {
  CURRENT_SESSION_VERSION,
  SessionManager,
  highlightCode,
  type SessionHeader,
} from "@mariozechner/pi-coding-agent";
import { Box, Text } from "@mariozechner/pi-tui";

const TERMINAL_FLAG = "branch-term";
const TMUX_LAYOUT_FLAG = "branch-tmux-layout";
const BRANCH_MESSAGE_TYPE = "branch-term-message";
const MANUAL_RESUME_INTRO =
  "Branch session ready. Run this command in a separate terminal or tmux pane";

type TmuxLayout = "window" | "split-right" | "split-down";
type CommandMessageDetails = {
  intro: string;
  command: string;
  copiedToClipboard: boolean;
};

const TMUX_LAYOUT_CONFIG: Record<
  TmuxLayout,
  {
    label: string;
    commandArgs: (cwd: string, command: string) => string[];
  }
> = {
  window: {
    label: "window",
    commandArgs: (cwd, command) => ["new-window", "-c", cwd, "-n", "branch", command],
  },
  "split-right": {
    label: "split (right)",
    commandArgs: (cwd, command) => ["split-window", "-h", "-c", cwd, command],
  },
  "split-down": {
    label: "split (down)",
    commandArgs: (cwd, command) => ["split-window", "-v", "-c", cwd, command],
  },
};

function getStringFlag(pi: ExtensionAPI, flagName: string): string | undefined {
  const value = pi.getFlag(`--${flagName}`);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseTmuxLayout(value: string | undefined): TmuxLayout | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized in TMUX_LAYOUT_CONFIG) {
    return normalized as TmuxLayout;
  }
  return undefined;
}

function parseBranchArgs(args: string): { tmuxLayout?: TmuxLayout; error?: string } {
  const tokens = args
    .trim()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);

  if (tokens.length === 0) return {};

  if (tokens.length === 1) {
    const shorthandLayout = parseTmuxLayout(tokens[0]);
    if (shorthandLayout) return { tmuxLayout: shorthandLayout };

    if (tokens[0].startsWith("layout=")) {
      const explicitLayout = parseTmuxLayout(tokens[0].slice("layout=".length));
      if (explicitLayout) return { tmuxLayout: explicitLayout };
    }
  }

  return {
    error:
      "Usage: /branch [window|split-right|split-down] or /branch layout=<window|split-right|split-down>",
  };
}

function getBranchArgumentCompletions(
  prefix: string,
): Array<{ value: string; label: string }> | null {
  const trimmed = prefix.trim().toLowerCase();
  if (trimmed.includes(" ")) return null;

  const layouts = Object.keys(TMUX_LAYOUT_CONFIG) as TmuxLayout[];
  const options = [
    ...layouts.map((layout) => ({ value: layout, label: layout })),
    ...layouts.map((layout) => ({ value: `layout=${layout}`, label: `layout=${layout}` })),
  ];
  const matches = options.filter((option) => option.label.startsWith(trimmed));
  if (!matches.length) return null;

  return matches;
}

function renderTerminalCommand(template: string, cwd: string, sessionFile: string): string {
  let command = template;
  command = command.split("{cwd}").join(cwd);

  if (command.includes("{command}")) {
    const piCommand = `pi --session ${shellQuote(sessionFile)}`;
    command = command.split("{command}").join(piCommand);
  }

  if (command.includes("{session}")) {
    command = command.split("{session}").join(sessionFile);
  }

  if (template.includes("{command}") || template.includes("{session}")) {
    return command;
  }

  return `${command} ${sessionFile}`;
}

function spawnDetached(command: string, args: string[], onError?: (error: Error) => void): void {
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
  if (onError) child.on("error", onError);
}

function shellQuote(value: string): string {
  if (value.length === 0) return "''";
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function escapeForDoubleQuotes(value: string): string {
  return value.replace(/(["\\$`!])/g, "\\$1");
}

function shellQuoteCompact(value: string): string {
  const home = process.env.HOME;
  if (!home) return shellQuote(value);

  if (value === home) return "$HOME";

  if (value.startsWith(`${home}/`)) {
    const suffix = value.slice(home.length + 1);
    return `"$HOME/${escapeForDoubleQuotes(suffix)}"`;
  }

  return shellQuote(value);
}

function parseSessionIdFromFile(sessionFile: string): string | undefined {
  const fileName = path.basename(sessionFile, ".jsonl");
  const separatorIndex = fileName.lastIndexOf("_");
  if (separatorIndex <= 0) return undefined;

  const candidate = fileName.slice(separatorIndex + 1);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(candidate)
    ? candidate
    : undefined;
}

function formatResumeSessionArgument(sessionFile: string): string {
  const sessionId = parseSessionIdFromFile(sessionFile);
  if (sessionId) return sessionId;

  return shellQuoteCompact(sessionFile);
}

function runClipboardCommand(command: string, args: string[], text: string): boolean {
  try {
    const result = spawnSync(command, args, {
      input: text,
      stdio: ["pipe", "ignore", "ignore"],
      timeout: 3000,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

function copyToClipboard(text: string): boolean {
  if (process.platform === "darwin") {
    return runClipboardCommand("pbcopy", [], text);
  }

  if (process.platform === "win32") {
    return runClipboardCommand("clip", [], text);
  }

  if (process.platform === "linux") {
    return (
      runClipboardCommand("wl-copy", [], text) ||
      runClipboardCommand("xclip", ["-selection", "clipboard"], text) ||
      runClipboardCommand("xsel", ["--clipboard", "--input"], text)
    );
  }

  return false;
}

function formatCommandMessageIntro(intro: string, copiedToClipboard: boolean): string {
  return `${intro}${copiedToClipboard ? " (copied to clipboard)" : ""}:`;
}

function showCommandMessage(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  intro: string,
  command: string,
): void {
  const copiedToClipboard = copyToClipboard(command);
  if (!ctx.hasUI) {
    console.log(formatCommandMessageIntro(intro, copiedToClipboard));
    console.log(command);
    return;
  }

  pi.sendMessage({
    customType: BRANCH_MESSAGE_TYPE,
    content: intro,
    display: true,
    details: {
      intro,
      command,
      copiedToClipboard,
    } satisfies CommandMessageDetails,
  });
}

function hasValidSessionFile(sessionFile: string): boolean {
  if (!fs.existsSync(sessionFile)) return false;

  try {
    const firstLine = fs.readFileSync(sessionFile, "utf8").split("\n", 1)[0]?.trim();
    if (!firstLine) return false;

    const header = JSON.parse(firstLine) as Partial<SessionHeader>;
    return header.type === "session" && typeof header.id === "string";
  } catch {
    return false;
  }
}

function createFreshSessionFile(cwd: string, sessionDir: string): string {
  fs.mkdirSync(sessionDir, { recursive: true });

  const sessionId = randomUUID();
  const timestamp = new Date().toISOString();
  const fileTimestamp = timestamp.replace(/[:.]/g, "-");
  const sessionFile = path.join(sessionDir, `${fileTimestamp}_${sessionId}.jsonl`);
  const header: SessionHeader = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: sessionId,
    timestamp,
    cwd,
  };

  fs.writeFileSync(sessionFile, `${JSON.stringify(header)}\n`);
  return sessionFile;
}

export default function (pi: ExtensionAPI) {
  pi.registerMessageRenderer(BRANCH_MESSAGE_TYPE, (message, _options, theme) => {
    const details = message.details as CommandMessageDetails | undefined;
    if (!details || typeof details.intro !== "string" || typeof details.command !== "string") {
      return new Text(typeof message.content === "string" ? message.content : "", 0, 0);
    }

    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    box.addChild(
      new Text(
        [
          theme.fg(
            "customMessageText",
            formatCommandMessageIntro(details.intro, details.copiedToClipboard),
          ),
          "",
          highlightCode(details.command, "bash").join("\n"),
        ].join("\n"),
        0,
        0,
      ),
    );
    return box;
  });

  pi.registerFlag(TERMINAL_FLAG, {
    description:
      "Command to open a new terminal. Use {cwd} for working directory and optional {command} for the pi command.",
    type: "string",
  });

  pi.registerFlag(TMUX_LAYOUT_FLAG, {
    description:
      "When inside tmux, choose where branch sessions open: window (default), split-right, or split-down.",
    type: "string",
  });

  pi.registerCommand("branch", {
    description: "Fork current session into tmux (window/split) or show a resume command",
    getArgumentCompletions: getBranchArgumentCompletions,
    handler: async (args, ctx) => {
      const parsedArgs = parseBranchArgs(args);
      if (parsedArgs.error) {
        if (ctx.hasUI) ctx.ui.notify(parsedArgs.error, "warning");
        return;
      }

      if (!ctx.isIdle()) {
        if (ctx.hasUI) ctx.ui.notify("Queued /branch", "info");
        await ctx.waitForIdle();
      }

      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) {
        if (ctx.hasUI)
          ctx.ui.notify("Session is not persisted. Restart without --no-session.", "error");
        return;
      }

      const leafId = ctx.sessionManager.getLeafId();
      const hasAssistantReply = ctx.sessionManager
        .getEntries()
        .some((entry) => entry.type === "message" && entry.message.role === "assistant");

      let forkFile: string;
      if (leafId && hasValidSessionFile(sessionFile)) {
        const forkManager = SessionManager.open(sessionFile);
        const branchedSessionFile = forkManager.createBranchedSession(leafId);
        if (!branchedSessionFile) {
          throw new Error("Failed to create branched session");
        }
        forkFile = branchedSessionFile;
      } else {
        if (hasAssistantReply) {
          throw new Error(`Current session file is missing or invalid: ${sessionFile}`);
        }

        const message = "Current session has no persisted history yet. Opening a fresh session.";
        if (ctx.hasUI) ctx.ui.notify(message, "warning");
        else console.log(message);

        forkFile = createFreshSessionFile(ctx.cwd, ctx.sessionManager.getSessionDir());
      }

      const resumeCommand = `cd ${shellQuoteCompact(ctx.cwd)} && pi --session ${formatResumeSessionArgument(forkFile)}`;

      const terminalFlag = getStringFlag(pi, TERMINAL_FLAG);
      if (terminalFlag) {
        const command = renderTerminalCommand(terminalFlag, ctx.cwd, forkFile);
        spawnDetached("bash", ["-lc", command], (error) => {
          if (ctx.hasUI) {
            ctx.ui.notify(`Terminal command failed: ${error.message}`, "error");
          } else {
            console.error(`Terminal command failed: ${error.message}`);
          }
          showCommandMessage(pi, ctx, MANUAL_RESUME_INTRO, resumeCommand);
        });
        if (ctx.hasUI) ctx.ui.notify("Opened fork in new terminal", "info");
        return;
      }

      if (process.env.TMUX) {
        const rawTmuxLayout = getStringFlag(pi, TMUX_LAYOUT_FLAG);
        const tmuxLayout =
          parsedArgs.tmuxLayout ?? (rawTmuxLayout ? parseTmuxLayout(rawTmuxLayout) : "window");

        if (!tmuxLayout) {
          if (ctx.hasUI) {
            ctx.ui.notify(
              `Invalid --${TMUX_LAYOUT_FLAG}: ${rawTmuxLayout}. Using window. Valid values: window, split-right, split-down`,
              "warning",
            );
          }
        }

        const resolvedLayout = tmuxLayout ?? "window";
        const layoutConfig = TMUX_LAYOUT_CONFIG[resolvedLayout];
        const tmuxCommand = `pi --session ${shellQuote(forkFile)}`;
        const result = await pi.exec("tmux", layoutConfig.commandArgs(ctx.cwd, tmuxCommand));
        if (result.code !== 0) {
          const details = result.stderr || result.stdout || "tmux command failed";
          if (ctx.hasUI) {
            ctx.ui.notify(`tmux failed: ${details}`, "warning");
          } else {
            console.error(`tmux failed: ${details}`);
          }
          showCommandMessage(pi, ctx, MANUAL_RESUME_INTRO, resumeCommand);
          return;
        }

        if (ctx.hasUI) ctx.ui.notify(`Opened fork in new tmux ${layoutConfig.label}`, "info");
        return;
      }

      showCommandMessage(pi, ctx, MANUAL_RESUME_INTRO, resumeCommand);
    },
  });
}
