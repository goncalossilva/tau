import { spawn } from "node:child_process"
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent"
import { SessionManager } from "@mariozechner/pi-coding-agent"

const TERMINAL_FLAG = "branch-term"
const TMUX_LAYOUT_FLAG = "tmux-layout"

type TmuxLayout = "window" | "split-right" | "split-down"

const TMUX_LAYOUT_CONFIG: Record<
  TmuxLayout,
  {
    label: string
    commandArgs: (cwd: string, command: string) => string[]
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
}

function getStringFlag(pi: ExtensionAPI, flagName: string): string | undefined {
  const value = pi.getFlag(`--${flagName}`)
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function parseTmuxLayout(value: string | undefined): TmuxLayout | undefined {
  if (!value) return undefined
  const normalized = value.trim().toLowerCase()
  if (normalized in TMUX_LAYOUT_CONFIG) {
    return normalized as TmuxLayout
  }
  return undefined
}

function parseBranchArgs(args: string): { tmuxLayout?: TmuxLayout; error?: string } {
  const tokens = args
    .trim()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)

  if (tokens.length === 0) return {}

  if (tokens.length === 1) {
    const shorthandLayout = parseTmuxLayout(tokens[0])
    if (shorthandLayout) return { tmuxLayout: shorthandLayout }

    if (tokens[0].startsWith("layout=")) {
      const explicitLayout = parseTmuxLayout(tokens[0].slice("layout=".length))
      if (explicitLayout) return { tmuxLayout: explicitLayout }
    }
  }

  return { error: "Usage: /branch [window|split-right|split-down] or /branch layout=<window|split-right|split-down>" }
}

function renderTerminalCommand(template: string, cwd: string, sessionFile: string): string {
  let command = template
  command = command.split("{cwd}").join(cwd)

  if (command.includes("{command}")) {
    const piCommand = `pi --session ${shellQuote(sessionFile)}`
    command = command.split("{command}").join(piCommand)
  }

  if (command.includes("{session}")) {
    command = command.split("{session}").join(sessionFile)
  }

  if (template.includes("{command}") || template.includes("{session}")) {
    return command
  }

  return `${command} ${sessionFile}`
}

function spawnDetached(command: string, args: string[], onError?: (error: Error) => void): void {
  const child = spawn(command, args, { detached: true, stdio: "ignore" })
  child.unref()
  if (onError) child.on("error", onError)
}

function shellQuote(value: string): string {
  if (value.length === 0) return "''"
  return `'${value.replace(/'/g, "'\\''")}'`
}

function notifyManualResume(ctx: ExtensionCommandContext, command: string): void {
  if (!ctx.hasUI) return

  ctx.ui.notify("Open a new terminal window or split, then paste", "info")
  ctx.ui.notify(command, "info")
}

export default function (pi: ExtensionAPI) {
  pi.registerFlag(TERMINAL_FLAG, {
    description:
      "Command to open a new terminal. Use {cwd} for working directory and optional {command} for the pi command.",
    type: "string",
  })

  pi.registerFlag(TMUX_LAYOUT_FLAG, {
    description:
      "When inside tmux, choose where branch/worktree sessions open: window (default), split-right, or split-down.",
    type: "string",
  })

  pi.registerCommand("branch", {
    description: "Fork current session into tmux (window/split) or show a resume command",
    handler: async (args, ctx) => {
      await ctx.waitForIdle()

      const parsedArgs = parseBranchArgs(args)
      if (parsedArgs.error) {
        if (ctx.hasUI) ctx.ui.notify(parsedArgs.error, "warning")
        return
      }

      const sessionFile = ctx.sessionManager.getSessionFile()
      if (!sessionFile) {
        if (ctx.hasUI) ctx.ui.notify("Session is not persisted. Restart without --no-session.", "error")
        return
      }

      const leafId = ctx.sessionManager.getLeafId()
      if (!leafId) {
        if (ctx.hasUI) ctx.ui.notify("No messages yet. Nothing to branch.", "error")
        return
      }

      const forkManager = SessionManager.open(sessionFile)
      const forkFile = forkManager.createBranchedSession(leafId)
      if (!forkFile) {
        throw new Error("Failed to create branched session")
      }

      const resumeCommand = `cd ${shellQuote(ctx.cwd)} && pi --session ${shellQuote(forkFile)}`

      const terminalFlag = getStringFlag(pi, TERMINAL_FLAG)
      if (terminalFlag) {
        const command = renderTerminalCommand(terminalFlag, ctx.cwd, forkFile)
        spawnDetached("bash", ["-lc", command], (error) => {
          if (ctx.hasUI) {
            ctx.ui.notify(`Terminal command failed: ${error.message}`, "error")
            notifyManualResume(ctx, resumeCommand)
          }
        })
        if (ctx.hasUI) ctx.ui.notify("Opened fork in new terminal", "info")
        return
      }

      if (process.env.TMUX) {
        const rawTmuxLayout = getStringFlag(pi, TMUX_LAYOUT_FLAG)
        const tmuxLayout = parsedArgs.tmuxLayout ?? (rawTmuxLayout ? parseTmuxLayout(rawTmuxLayout) : "window")

        if (!tmuxLayout) {
          if (ctx.hasUI) {
            ctx.ui.notify(
              `Invalid --${TMUX_LAYOUT_FLAG}: ${rawTmuxLayout}. Using window. Valid values: window, split-right, split-down`,
              "warning",
            )
          }
        }

        const resolvedLayout = tmuxLayout ?? "window"
        const layoutConfig = TMUX_LAYOUT_CONFIG[resolvedLayout]
        const tmuxCommand = `pi --session ${shellQuote(forkFile)}`
        const result = await pi.exec("tmux", layoutConfig.commandArgs(ctx.cwd, tmuxCommand))
        if (result.code !== 0) {
          if (ctx.hasUI) {
            const details = result.stderr || result.stdout || "tmux command failed"
            ctx.ui.notify(`tmux failed: ${details}`, "warning")
            notifyManualResume(ctx, resumeCommand)
          }
          return
        }

        if (ctx.hasUI) ctx.ui.notify(`Opened fork in new tmux ${layoutConfig.label}`, "info")
        return
      }

      notifyManualResume(ctx, resumeCommand)
    },
  })
}
