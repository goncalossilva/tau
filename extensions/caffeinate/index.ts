/** Keep the system awake during agent runs without inhibiting display sleep. */

import { spawn } from "node:child_process";
import { platform } from "node:os";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

interface InhibitCommand {
  command: string;
  args: string[];
  waitForStdin: boolean;
}

export default function (pi: ExtensionAPI) {
  let inhibitor: ReturnType<typeof startInhibitor> | undefined;
  let releasing = Promise.resolve();
  let shutdown = false;
  let warned = false;

  pi.on("agent_start", async (_event, ctx) => {
    await releasing;
    if (shutdown || inhibitor) return;
    const command = inhibitCommand();
    if (!command) return;
    try {
      inhibitor = startInhibitor(command, ctx.cwd, (reason) => warn(ctx, reason));
    } catch (error) {
      warn(ctx, error instanceof Error ? error.message : String(error));
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!shutdown && ctx.isIdle()) await release();
  });

  pi.on("session_shutdown", async () => {
    shutdown = true;
    await release();
  });

  async function release() {
    if (inhibitor) {
      releasing = inhibitor.stop();
      inhibitor = undefined;
    }
    await releasing;
  }

  function warn(ctx: ExtensionContext, reason: string) {
    if (shutdown || warned) return;
    warned = true;
    const message = `Caffeinate: sleep prevention unavailable. ${stripVTControlCharacters(reason)}`;
    try {
      if (ctx.hasUI) {
        ctx.ui.notify(message, "warning");
        return;
      }
    } catch {
      // A missing UI must not turn an optional inhibitor failure into an uncaught error.
    }
    console.warn(message);
  }
}

function inhibitCommand(): InhibitCommand | undefined {
  switch (platform()) {
    case "darwin":
      return {
        command: "/usr/bin/caffeinate",
        args: ["-i", "-w", String(process.pid)],
        waitForStdin: false,
      };
    case "linux":
      return {
        command: "systemd-inhibit",
        args: [
          "--what=sleep",
          "--mode=block",
          "--who=Pi",
          "--why=Pi agent is running",
          "--",
          "cat",
        ],
        waitForStdin: true,
      };
  }
}

/** Own the inhibitor through close; a parent PID watch or stdin EOF also releases it if Pi exits. */
function startInhibitor(command: InhibitCommand, cwd: string, onFailure: (reason: string) => void) {
  const child = spawn(command.command, command.args, {
    cwd,
    detached: true,
    stdio: ["pipe", "ignore", "pipe"],
  });
  let stderr = "";
  let error: string | undefined;
  let stopped = false;
  let closed = false;
  let escalation: NodeJS.Timeout | undefined;
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(0, 2048);
  });
  child.on("error", (cause: Error) => {
    error = cause.message;
  });
  child.stdin.on("error", (cause: Error) => {
    error = cause.message;
  });
  const completion = new Promise<void>((resolve) => {
    child.once("close", (code, signal) => {
      closed = true;
      clearTimeout(escalation);
      if (!stopped) {
        onFailure(
          error || stderr.trim() || `${command.command} exited unexpectedly (${signal ?? code}).`,
        );
      }
      resolve();
    });
  });

  return {
    stop() {
      if (!stopped && !closed) {
        stopped = true;
        child.stdin.end();
        if (!command.waitForStdin) sendSignal("SIGTERM");
        escalation = setTimeout(() => sendSignal("SIGKILL"), 500);
      }
      return completion;
    },
  };

  function sendSignal(signal: "SIGTERM" | "SIGKILL") {
    if (closed || child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ESRCH") child.kill(signal);
    }
  }
}
