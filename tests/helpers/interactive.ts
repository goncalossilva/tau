import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { Socket } from "node:net";
import { mock } from "node:test";
import { stripVTControlCharacters } from "node:util";
import {
  AgentSessionRuntime,
  createAgentSessionFromServices,
  InteractiveMode,
  type ExtensionContext,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { deadline } from "./async.js";
import { type createPiResources, fixtureModel } from "./pi.js";

const requireFromPi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { ProcessTerminal }: typeof import("@earendil-works/pi-tui") = await import(
  requireFromPi.resolve("@earendil-works/pi-tui")
);

/** Substitute physical I/O only. Native layout, overlays, focus and input priority stay real. */
export function captureTerminal(columns: number, rows: number) {
  let input: ((data: string) => void) | undefined;
  let resize: (() => void) | undefined;
  const writes: string[] = [];
  const waiters = new Map<string, () => void>();
  mock.getter(ProcessTerminal.prototype, "columns", () => columns);
  mock.getter(ProcessTerminal.prototype, "rows", () => rows);
  mock.method(
    ProcessTerminal.prototype,
    "start",
    (onInput: (data: string) => void, onResize: () => void) => {
      input = onInput;
      resize = onResize;
    },
  );
  mock.method(ProcessTerminal.prototype, "stop", () => {
    input = undefined;
    resize = undefined;
  });
  mock.method(ProcessTerminal.prototype, "drainInput", async () => {});
  mock.method(ProcessTerminal.prototype, "write", (data: string) => {
    writes.push(data);
    const plain = stripVTControlCharacters(data);
    for (const [text, resolve] of waiters) if (plain.includes(text)) resolve();
  });
  for (const method of [
    "moveBy",
    "hideCursor",
    "showCursor",
    "clearLine",
    "clearFromCursor",
    "clearScreen",
    "setTitle",
    "setProgress",
  ] as const)
    mock.method(ProcessTerminal.prototype, method, () => {});
  return {
    writes,
    get started() {
      return input !== undefined;
    },
    send(data: string) {
      assert.ok(input, "terminal must be running");
      input(data);
    },
    resize(newColumns: number, newRows: number) {
      columns = newColumns;
      rows = newRows;
      assert.ok(resize, "terminal must be running");
      resize();
    },
    repaint(tui: TUI) {
      writes.length = 0;
      tui.renderNow(true);
      return writes.map(stripVTControlCharacters).join("");
    },
    async waitForText(text: string) {
      if (writes.some((data) => stripVTControlCharacters(data).includes(text))) return;
      try {
        await deadline(
          new Promise<void>((resolve) => waiters.set(text, resolve)),
          `terminal output: ${text}`,
        );
      } finally {
        waiters.delete(text);
      }
    },
  };
}

/** Capture public session context and TUI through a zero-row widget, without inspecting host internals. */
export function observeInteractive() {
  let ctx: ExtensionContext | undefined;
  let tui: TUI | undefined;
  const extension: ExtensionFactory = (pi) => {
    pi.on("session_start", (_event, context) => {
      ctx = context;
      ctx.ui.setWidget("interactive-test-observer", (screen) => {
        tui = screen;
        return { render: () => [], invalidate() {} };
      });
    });
    pi.on("session_shutdown", () => ctx?.ui.setWidget("interactive-test-observer", undefined));
  };
  return {
    extension,
    get() {
      assert.ok(ctx && tui, "interactive session must be initialized");
      return { ctx, tui };
    },
  };
}

/** Start the real application with caller-owned isolated resources and history. */
export async function openInteractive(
  resources: Awaited<ReturnType<typeof createPiResources>>,
  failures: unknown[],
  modeName: "default" | "regular" = "default",
) {
  resources.settingsManager.setTheme("dark");
  resources.settingsManager.setQuietStartup(true);
  resources.settingsManager.setShowTerminalProgress(false);
  await resources.settingsManager.flush();
  const services = { ...resources, diagnostics: [] };
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: resources.sessionManager,
    model: fixtureModel,
    noTools: "all",
  });
  const unsubscribe = session.extensionRunner.onError((error) => failures.push(error));
  const runtime = new AgentSessionRuntime(session, services, async () => {
    const error = new Error("Unexpected session replacement");
    failures.push(error);
    throw error;
  });
  const mode = new InteractiveMode(runtime, {
    ...(modeName === "regular" ? { tuiMode: "regular" as const } : {}),
    initialThemeSetting: "dark",
  });
  const dispose = async () => {
    try {
      await session.abort();
    } finally {
      mode.stop();
      try {
        await runtime.dispose();
      } finally {
        unsubscribe();
        await resources.settingsManager.flush();
      }
    }
  };
  try {
    await mode.init();
    return { session, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

/** Reject all external work except Pi's exact startup executable probes. Owners may stub required HTTP. */
export function rejectInteractiveExternalWork(failures: unknown[]) {
  const reject = (...args: unknown[]): never => {
    const error = new Error(`Unexpected external work: ${String(args[0])}`);
    failures.push(error);
    throw error;
  };
  mock.method(globalThis, "fetch", reject);
  mock.method(Socket.prototype, "connect", reject);
  mock.method(childProcess, "spawnSync", (command: string, args: string[], options: unknown) => {
    if (
      (command === "fd" || command === "rg") &&
      JSON.stringify(args) === '["--version"]' &&
      JSON.stringify(options) === '{"stdio":"pipe"}'
    )
      return {
        status: 0,
        signal: null,
        pid: 0,
        output: [],
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
      };
    return reject(command, args);
  });
  for (const method of ["spawn", "exec", "execSync", "execFile", "execFileSync", "fork"] as const)
    mock.method(childProcess, method, reject);
  syncBuiltinESMExports();
}
