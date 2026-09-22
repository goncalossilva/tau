import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { Socket } from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import {
  AgentSessionRuntime,
  createAgentSessionFromServices,
  getAgentDir,
  InteractiveMode,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import toolDisplayMode from "../../extensions/tool-display-mode.js";
import { deadline } from "../helpers/async.js";
import { assistantMessage, createPiResources, fixtureModel, isolatePiHome } from "../helpers/pi.js";
import { scriptedProvider } from "../helpers/provider.js";

// npm can install a separate public pi-tui instance under Pi. Patch the terminal Pi actually uses.
const requireFromPi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { ProcessTerminal }: typeof import("@earendil-works/pi-tui") = await import(
  requireFromPi.resolve("@earendil-works/pi-tui")
);

type ActivityPacket = {
  sessionKey: string;
  source: "subagent" | "review";
  text?: string;
  handled?: boolean;
};
const draft = "ink";
const summary = "2 subagents, review 1/3";
const widths = [100, 40, 12, 4];

describe("tool-display-mode InteractiveMode", { concurrency: false }, () => {
  let home: Awaited<ReturnType<typeof isolatePiHome>> | undefined;
  let app: Awaited<ReturnType<typeof openInteractive>> | undefined;
  let cwd: string;
  let failures: unknown[];
  let terminal: ReturnType<typeof captureTerminal>;
  let timers: ReturnType<typeof observeAnimationTimers>;
  let listeners: ReturnType<typeof nativeListeners>;

  beforeEach(async () => {
    home = await isolatePiHome();
    cwd = path.join(getAgentDir(), "octopus-office");
    await mkdir(cwd, { recursive: true });
    failures = [];
    rejectExternalWork(failures);
    terminal = captureTerminal();
    timers = observeAnimationTimers();
    listeners = nativeListeners();
  });

  afterEach(async () => {
    try {
      await app?.dispose();
      assert.equal(timers.size, 0, "native and background animation timers must be stopped");
      assert.deepEqual(
        nativeListeners(),
        listeners,
        "InteractiveMode must release native listeners",
      );
      assert.deepEqual(failures, [], "unexpected work and extension errors must not be swallowed");
    } finally {
      app = undefined;
      mock.restoreAll();
      mock.timers.reset();
      syncBuiltinESMExports();
      await home?.dispose();
      home = undefined;
    }
  });

  test("matches the native border animation and hands parent work off to background activity", async () => {
    app = await openInteractive(cwd, failures);
    terminal.send(draft);
    assert.equal(app.ctx.ui.getEditorText(), draft);
    assert.equal(app.ctx.mode, "tui");
    assert.equal(timers.size, 0);

    await app.startParent();
    assert.equal(timers.size, 1, "InteractiveMode owns the live parent spinner");
    // The reference is Pi's actual streaming indicator, instantiated by InteractiveMode.
    // Give it the same text as the later background indicator. No native renderer is copied.
    app.ctx.ui.setWorkingMessage(summary);
    const native = sampleAnimation(app.tui);
    assert.equal(native[0][0].plainTop.indexOf(summary), 5);
    assert.equal(native[0][0].plainTop, native[1][0].plainTop, "no animation before 80ms");
    assert.notEqual(native[1][0].top, native[2][0].top, "the native spinner advances at 80ms");
    assert.equal(native[0][0].top, native.at(-1)?.[0].top, "sample a complete default cycle");

    assert.equal(app.activity("subagent", "2 subagents").handled, true);
    assert.equal(app.activity("review", "review 1/3").handled, true);
    assertStatus(app.tui, `Working, ${summary}`);
    assert.equal(timers.size, 1, "activity annotates the native parent, not a second loader");

    app.ctx.ui.setToolsExpanded(true);
    assertStatus(app.tui, "Working");
    assert.ok(!editorBorder(app.tui, 100).plainTop.includes("subagents"));
    assert.equal(timers.size, 1, "expanded tools retain the native parent indicator");
    app.ctx.ui.setToolsExpanded(false);
    assertStatus(app.tui, `Working, ${summary}`);

    await app.finishParent();
    assert.equal(app.ctx.isIdle(), true);
    assert.equal(timers.size, 1, "settled parent hands off to one extension-owned loader");
    const background = sampleAnimation(app.tui);
    assert.deepEqual(
      background,
      native,
      "border bytes, placement, clipping and animation match Pi",
    );
    assertStatus(app.tui, summary);
    assert.ok(!editorBorder(app.tui, 100).plainTop.includes("Working"));
    assert.equal(app.ctx.ui.getEditorText(), draft);

    app.ctx.ui.setToolsExpanded(true);
    assertStatus(app.tui, undefined);
    assert.equal(timers.size, 0, "expansion stops the background loader");
    app.ctx.ui.setToolsExpanded(false);
    assertStatus(app.tui, summary);
    assert.equal(timers.size, 1, "collapsing restores still-running activity");
    app.activity("subagent");
    assertStatus(app.tui, "review 1/3");

    // Leave background work active to exercise shutdown, rather than first clearing its packet.
    await app.dispose();
    assert.deepEqual(app.shutdown, { reason: "quit", editorRestored: true, draft });
    assert.equal(timers.size, 0);
    assert.equal(terminal.started, false);
    const writes = terminal.writes.length;
    mock.timers.tick(800);
    assert.equal(terminal.writes.length, writes, "shutdown cannot animate or repaint");
  });
});

/** Real SDK runtime and InteractiveMode, with scripted generation and terminal/tool-discovery boundaries. */
async function openInteractive(cwd: string, failures: unknown[]) {
  let ctx!: ExtensionContext;
  let tui!: TUI;
  let events!: ExtensionAPI["events"];
  let shutdown: { reason: string; editorRestored: boolean; draft: string } | undefined;
  const entered = deferred();
  const release = deferred();
  let prompt: Promise<void> | undefined;
  const resources = await createPiResources(cwd, getAgentDir(), [
    toolDisplayMode,
    (pi) => {
      events = pi.events;
      pi.on("session_start", (_event, context) => {
        ctx = context;
        // A zero-row public widget exposes the owning TUI without replacing its editor or renderer.
        ctx.ui.setWidget("activity-test-observer", (screen) => {
          tui = screen;
          return { render: () => [], invalidate() {} };
        });
      });
      pi.on("session_shutdown", (event, context) => {
        shutdown = {
          reason: event.reason,
          editorRestored: context.ui.getEditorComponent() === undefined,
          draft: context.ui.getEditorText(),
        };
        context.ui.setWidget("activity-test-observer", undefined);
      });
    },
    scriptedProvider(fixtureModel, async () => {
      entered.resolve();
      await release.promise;
      return assistantMessage("The reef is quiet.");
    }),
  ]);
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
  const unsubscribeErrors = session.extensionRunner.onError((error) => failures.push(error));
  const runtime = new AgentSessionRuntime(session, services, async () => {
    throw new Error("Unexpected session replacement in activity presentation test");
  });
  const mode = new InteractiveMode(runtime, { tuiMode: "regular", initialThemeSetting: "dark" });
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    release.resolve();
    try {
      await prompt;
    } finally {
      // Same public teardown order as interactive quit, without terminating the test process.
      mode.stop();
      try {
        await runtime.dispose();
      } finally {
        unsubscribeErrors();
        await resources.settingsManager.flush();
      }
    }
  };
  try {
    await mode.init();
    return {
      ctx,
      tui,
      get shutdown() {
        return shutdown;
      },
      async startParent() {
        assert.equal(prompt, undefined);
        prompt = session.prompt("Tend the coral nursery.");
        await deadline(entered.promise, "scripted parent generation");
      },
      async finishParent() {
        release.resolve();
        await deadline(prompt!, "parent settlement");
      },
      activity(source: ActivityPacket["source"], text?: string) {
        const packet: ActivityPacket = {
          sessionKey: session.sessionFile ?? `session:${session.sessionId}`,
          source,
          text,
        };
        events.emit("tau:activity", packet);
        return packet;
      },
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

/** Observe just the two native editor borders and their position around the preserved draft. */
function editorBorder(tui: TUI, width: number) {
  const lines = tui.render(width);
  const plain = lines.map((line) => stripVTControlCharacters(line.replaceAll(CURSOR_MARKER, "")));
  const borderRows = plain.flatMap((line, row) => (line.startsWith("─") ? [row] : []));
  assert.equal(borderRows.length, 2, "only the native editor has borders in this fixture");
  const [topRow, bottomRow] = borderRows;
  assert.equal(
    plain
      .slice(topRow + 1, bottomRow)
      .map((line) => line.trim())
      .join(""),
    draft,
  );
  const top = lines[topRow];
  const bottom = lines[bottomRow];
  assert.match(stripVTControlCharacters(bottom), /^─+$/);
  assert.equal(visibleWidth(top), width);
  assert.equal(visibleWidth(bottom), width);
  return { top, bottom, editorHeight: bottomRow - topRow, plainTop: stripVTControlCharacters(top) };
}

function sampleAnimation(tui: TUI) {
  // 0, 79, 80, then every 80ms through a complete ten-frame native default cycle.
  return [0, 79, 1, ...Array<number>(9).fill(80)].map((elapsed) => {
    mock.timers.tick(elapsed);
    return widths.map((width) => editorBorder(tui, width));
  });
}

function assertStatus(tui: TUI, text: string | undefined) {
  tui.renderNow();
  const border = editorBorder(tui, 100).plainTop;
  if (text === undefined) assert.match(border, /^─+$/);
  else {
    assert.ok(border.includes(text), border);
    assert.equal(
      tui
        .render(100)
        .map(stripVTControlCharacters)
        .filter((line) => line.includes(text)).length,
      1,
      "activity appears only once, in the editor border",
    );
  }
}

/** Replace ProcessTerminal's physical input/output only. The TUI and all components still run. */
function captureTerminal() {
  let input: ((data: string) => void) | undefined;
  const state = {
    started: false,
    writes: [] as string[],
    send(data: string) {
      assert.ok(input, "the terminal must be started before sending input");
      input(data);
    },
  };
  mock.getter(ProcessTerminal.prototype, "columns", () => 100);
  mock.getter(ProcessTerminal.prototype, "rows", () => 40);
  mock.method(ProcessTerminal.prototype, "start", (onInput: (data: string) => void) => {
    state.started = true;
    input = onInput;
  });
  mock.method(ProcessTerminal.prototype, "stop", () => {
    state.started = false;
    input = undefined;
  });
  mock.method(ProcessTerminal.prototype, "drainInput", async () => {});
  mock.method(ProcessTerminal.prototype, "write", (data: string) => state.writes.push(data));
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
  return state;
}

/** Controlled clock plus live timer ownership checks, without mocking Loader or its native counterpart. */
function observeAnimationTimers() {
  mock.timers.enable({ apis: ["setInterval"] });
  const active = new Set<ReturnType<typeof setInterval>>();
  const set = globalThis.setInterval;
  const clear = globalThis.clearInterval;
  mock.method(globalThis, "setInterval", (...args: Parameters<typeof setInterval>) => {
    const timer = set(...args);
    active.add(timer);
    return timer;
  });
  mock.method(globalThis, "clearInterval", (timer: ReturnType<typeof setInterval>) => {
    active.delete(timer);
    clear(timer);
  });
  return active;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function nativeListeners() {
  return {
    signals: ["SIGTERM", "SIGHUP", "uncaughtException"].map((event) => process.rawListeners(event)),
    stdout: process.stdout.rawListeners("error"),
    stderr: process.stderr.rawListeners("error"),
    stdin: process.stdin.rawListeners("data"),
    resize: process.stdout.rawListeners("resize"),
  };
}

/** Pi's mandatory managed-tool startup probes are substituted, not executed or downloaded. */
function rejectExternalWork(failures: unknown[]) {
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
    ) {
      return {
        status: 0,
        signal: null,
        pid: 0,
        output: [],
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
      };
    }
    return reject(command, args);
  });
  for (const method of ["spawn", "exec", "execSync", "execFile", "execFileSync", "fork"] as const)
    mock.method(childProcess, method, reject);
  syncBuiltinESMExports();
}
