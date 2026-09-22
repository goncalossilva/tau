import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { createAssistantMessageEventStream, type ToolCall } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createReadToolDefinition,
  CustomEditor,
  DEFAULT_MAX_LINES,
  getAgentDir,
  initTheme,
  SessionManager,
  ToolExecutionComponent,
  type BashToolDetails,
  type ExtensionAPI,
  type ExtensionFactory,
  type ExtensionUIContext,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  KeybindingsManager as TuiKeybindingsManager,
  Loader,
  TUI_KEYBINDINGS,
  TuiMainScreen,
  Text,
  truncateToWidth,
  visibleWidth,
  type Component,
  type EditorComponent,
  type Terminal,
} from "@earendil-works/pi-tui";
import toolDisplayMode from "../extensions/tool-display-mode.js";
import {
  assistantMessage,
  createPiResources,
  fixtureModel,
  isolatePiHome,
  uiBoundary,
} from "./helpers/pi.js";
import { scriptedProvider } from "./helpers/provider.js";

type EditorFactory = NonNullable<ReturnType<ExtensionUIContext["getEditorComponent"]>>;
type StatusEditor = EditorComponent &
  Pick<CustomEditor, "embedWorkingStatus" | "setWorkingStatusIndicator">;
type ActivityPacket = {
  sessionKey: string;
  source: "subagent" | "review";
  text?: string;
  handled?: boolean;
};
const ledger = "Café release manifest 🐙\nRestore the jellyfish database.\nNever deploy on a dare.";

describe("tool-display-mode", { concurrency: false }, () => {
  let home: Awaited<ReturnType<typeof isolatePiHome>> | undefined;
  let app: Awaited<ReturnType<typeof openDisplay>> | undefined;
  let cwd: string;
  let failures: unknown[];
  let finishWrites: () => Promise<void>;
  let allowedCommands: Set<string>;

  beforeEach(async () => {
    failures = [];
    allowedCommands = new Set();
    home = await isolatePiHome();
    cwd = path.join(getAgentDir(), "work");
    await fs.mkdir(cwd, { recursive: true });
    finishWrites = observeFileCompletion();
    const reject = () => {
      const error = new Error("Unexpected network request or subprocess in display workflow");
      failures.push(error);
      throw error;
    };
    mock.method(globalThis, "fetch", reject);
    const spawn = childProcess.spawn;
    mock.method(childProcess, "spawn", (...args: Parameters<typeof spawn>) => {
      const [command, argv, options] = args;
      // Only the exact harmless shell fixture may run, in the owning disposable session cwd.
      if (
        (command === "/bin/bash" || command === "bash") &&
        Array.isArray(argv) &&
        argv.length === 2 &&
        argv[0] === "-c" &&
        allowedCommands.has(argv[1]) &&
        options?.cwd === cwd
      )
        return spawn(...args);
      return reject();
    });
    for (const method of [
      "spawnSync",
      "exec",
      "execSync",
      "execFile",
      "execFileSync",
      "fork",
    ] as const)
      mock.method(childProcess, method, reject);
    syncBuiltinESMExports();
  });

  afterEach(async () => {
    try {
      try {
        await app?.dispose();
      } finally {
        await finishWrites?.();
      }
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

  test("cycles a remapped shortcut, preserves a pasted draft, and reloads the saved preference", async () => {
    app = await openDisplay(cwd, failures);
    const draft = `  ${Array.from({ length: 30 }, () => ledger).join("\n")}  `;
    app.editor.handleInput(`\x1b[200~${draft}\x1b[201~`);
    assert.equal(app.editor.getExpandedText?.(), draft);
    assert.equal(app.expanded(), false);

    app.editor.handleInput("\x0f"); // Ctrl+O is no longer the configured expansion shortcut.
    assert.deepEqual(app.notifications, []);
    for (const mode of ["expanded", "minimal", "collapsed", "expanded", "minimal"]) {
      app.editor.handleInput("\x1bo"); // Alt+O, parsed by the real keybinding manager.
      await finishWrites();
      assert.equal(
        app.editor.getExpandedText?.(),
        draft,
        "changing display cannot consume a draft",
      );
      assert.equal(app.expanded(), mode === "expanded");
      assert.deepEqual(JSON.parse(await fs.readFile(configPath(), "utf8")), { mode });
      const row = app.row("read", { path: "manifest.txt" });
      row.updateResult({ content: [{ type: "text", text: ledger }], isError: false });
      const view = screen(row);
      if (mode === "expanded") {
        for (const line of ledger.split("\n")) assert.ok(view.includes(line), view);
      } else {
        assert.ok(!view.includes("Restore the jellyfish database."));
        assert.equal(view.includes("↳ 3 lines"), mode === "minimal");
      }
    }

    await app.session.reload();
    assert.equal(app.editor.getExpandedText?.(), draft);
    assert.equal(app.expanded(), false);
    const restored = app.row("read", { path: "manifest.txt" });
    restored.updateResult({ content: [{ type: "text", text: ledger }], isError: false });
    assert.match(screen(restored), /↳ 3 lines/);
    app.editor.handleInput("\x1bo");
    await finishWrites();
    assert.deepEqual(JSON.parse(await fs.readFile(configPath(), "utf8")), { mode: "collapsed" });
    assert.deepEqual(app.session.messages, [], "display preferences never enter model history");

    await app.dispose();
    assert.equal(app.factory(), app.previousFactory, "shutdown restores the preceding editor");
    assert.equal(app.editor.getExpandedText?.(), draft);
    let submitted: string | undefined;
    app.editor.onSubmit = (text) => {
      submitted = text;
    };
    app.editor.handleInput("\r");
    assert.equal(
      submitted,
      draft.trim(),
      "the restored real editor can still submit the whole paste",
    );
  });

  test("reuses row-local components through updates and native/minimal mode transitions", async () => {
    app = await openDisplay(cwd, failures);
    const fixtures = [
      ["read", { path: "menu.txt" }, "Soup of the day.\nChocolate éclair.", "2 lines"],
      ["bash", { command: "printf 'cake'" }, "Chocolate cake.\nLemon cake.", "2 lines"],
      ["bash", { command: "printf 'tea'" }, "Earl Grey.\nOolong.", "2 lines"],
      [
        "grep",
        { pattern: "éclair" },
        "menu.txt:1: Chocolate éclair.\nmenu.txt:2: Coffee éclair.",
        "2 lines",
      ],
      ["find", { pattern: "*.txt" }, "pastry.txt\ncake.txt", "2 paths"],
      ["ls", { path: "." }, "pastry.txt\ncake.txt", "2 entries"],
    ] as const;
    const rows = fixtures.map(([name, args, text, summary]) => {
      const definition = app!.session.getToolDefinition(name);
      assert.ok(
        definition?.renderCall && definition.renderResult,
        `${name}: display renderers are registered`,
      );
      // Observe the public renderer boundary; Pi still owns component reuse and row composition.
      const renderCall = mock.fn(definition.renderCall);
      const renderResult = mock.fn(definition.renderResult);
      const row = app!.row(name, args, { ...definition, renderCall, renderResult });
      row.updateResult({ content: [{ type: "text", text }], isError: false });
      return {
        name,
        row,
        text,
        summary,
        renderCall,
        renderResult,
        callComponent: renderCall.mock.calls.at(-1)!.result,
        nativeComponent: renderResult.mock.calls.at(-1)!.result,
      };
    });
    assert.equal(new Set(rows.map((row) => row.nativeComponent)).size, rows.length);

    for (const [index, mode] of [
      "collapsed",
      "expanded",
      "minimal",
      "collapsed",
      "expanded",
      "minimal",
      "collapsed",
    ].entries()) {
      if (index > 0) {
        app.editor.handleInput("\x1bo");
        await finishWrites();
      }
      for (const entry of rows) {
        const {
          name,
          row,
          text,
          summary,
          renderCall,
          renderResult,
          callComponent,
          nativeComponent,
        } = entry;
        row.setExpanded(app.expanded());
        const component = renderResult.mock.calls.at(-1)!.result;
        assert.equal(
          renderCall.mock.calls.at(-1)!.result,
          callComponent,
          `${name}: reuse the call component in every mode`,
        );
        if (mode !== "minimal")
          assert.equal(
            component,
            nativeComponent,
            `${name}: retain the native result component across mode changes`,
          );
        const result = { content: [{ type: "text" as const, text }], isError: false };
        row.updateResult(result, true);
        assert.equal(
          renderResult.mock.calls.at(-1)!.result,
          component,
          `${name}: reuse the result component for streaming updates`,
        );
        if (mode === "minimal") assert.match(screen(row), /running\.\.\./);
        row.updateResult(result);
        row.invalidate();
        assert.equal(
          renderResult.mock.calls.at(-1)!.result,
          component,
          `${name}: reuse the result component at completion and redraw`,
        );
        const view = screen(row);
        if (mode === "minimal") assert.ok(view.includes(`↳ ${summary}`), view);
        if (mode === "expanded")
          for (const line of text.split("\n")) assert.ok(view.includes(line), view);
        for (const width of [40, 100])
          assert.ok(row.render(width).every((line) => visibleWidth(line) <= width));
        for (const rendered of [...renderCall.mock.calls, ...renderResult.mock.calls]) {
          assert.equal(
            rendered.error,
            undefined,
            "native renderer errors must not silently fall back to plain text",
          );
        }
      }
    }
  });

  test("reuses minimal Bash output while preserving native elapsed time and timer cleanup", async () => {
    await fs.writeFile(configPath(), '{"mode":"minimal"}\n');
    app = await openDisplay(cwd, failures);
    const definition = app.session.getToolDefinition("bash");
    assert.ok(definition?.renderResult);
    const renderResult = mock.fn(definition.renderResult);
    mock.timers.enable({ apis: ["Date", "setInterval"], now: 1000 });
    const row = app.row(
      "bash",
      { command: "printf 'croissants'" },
      { ...definition, renderResult },
    );
    try {
      row.markExecutionStarted();
      row.updateResult({ content: [{ type: "text", text: "Proofing..." }], isError: false }, true);
      const component = renderResult.mock.calls.at(-1)!.result;
      const beforeTick = renderResult.mock.callCount();
      mock.timers.tick(2000);
      assert.ok(
        renderResult.mock.callCount() > beforeTick,
        "native elapsed-time updates remain active in minimal mode",
      );
      assert.equal(renderResult.mock.calls.at(-1)!.result, component);
      assert.match(screen(row), /running\.\.\./);

      row.updateResult({
        content: [{ type: "text", text: "Croissants are ready." }],
        isError: false,
      });
      assert.equal(renderResult.mock.calls.at(-1)!.result, component);
      assert.match(screen(row), /↳ 1 line/);
      const settled = renderResult.mock.callCount();
      mock.timers.tick(5000);
      assert.equal(
        renderResult.mock.callCount(),
        settled,
        "completion in minimal mode stops the native timer",
      );

      app.editor.handleInput("\x1bo");
      await finishWrites();
      row.setExpanded(app.expanded());
      assert.match(screen(row), /Croissants are ready\./);
      assert.match(
        screen(row),
        /Took 2\.0s/,
        "returning to native output keeps the original duration",
      );
      for (const rendered of renderResult.mock.calls) assert.equal(rendered.error, undefined);
    } finally {
      row.updateResult({ content: [], isError: false });
      mock.timers.reset();
    }
  });

  for (const editorMode of ["default", "embedded", "standalone"] as const) {
    test(`preserves native working-status placement with the ${editorMode} editor`, async () => {
      app = await openDisplay(cwd, failures, [], { editorMode });
      const draft = "Do not microwave the croissants.";
      app.editor.setText(draft);
      // Adapt Pi's status-attachment boundary; the actual border is rendered by CustomEditor.
      const indicator = {
        renderInBorder: (width: number) => truncateToWidth("⠋ Working", width, ""),
        renderSpinnerInBorder: (width: number) => truncateToWidth("⠋", width, ""),
      } as NonNullable<Parameters<CustomEditor["setWorkingStatusIndicator"]>[0]>;
      for (const reload of [false, true]) {
        if (reload) await app.session.reload();
        const editor = app.editor as EditorComponent &
          Pick<CustomEditor, "embedWorkingStatus" | "setWorkingStatusIndicator">;
        assert.equal(editor.embedWorkingStatus, editorMode !== "standalone");
        editor.setWorkingStatusIndicator(indicator);
        for (const width of [10, 40, 100]) {
          const lines = editor.render(width).map(stripVTControlCharacters);
          assert.ok(lines.every((line) => visibleWidth(line) <= width));
          if (width >= 40) assert.equal(lines[0].includes("Working"), editorMode !== "standalone");
        }
        assert.equal(editor.getText(), draft);
        editor.setWorkingStatusIndicator(undefined);
        assert.doesNotMatch(screen(editor), /Working/);
      }
      await app.dispose();
      assert.equal(app.factory(), app.previousFactory);
      assert.equal(app.editor.getText(), draft);
      assert.doesNotMatch(screen(app.editor), /Working/);
    });
  }

  for (const editorMode of ["default", "embedded"] as const) {
    test(`combines idle child activity in the ${editorMode} editor with native animation and expansion`, async () => {
      app = await openDisplay(cwd, failures, [], {
        editorMode,
        persistent: editorMode === "default",
      });
      assert.equal(Boolean(app.session.sessionFile), editorMode === "default");
      const intervals = observeAnimationTimers();
      const draft = `  ${ledger}  `;
      app.editor.handleInput(`\x1b[200~${draft}\x1b[201~`);
      assert.equal(intervals.active.size, 0, "an idle session has no background animation");
      assert.equal(app.activity("review", "review 3/6 complete").handled, true);
      assert.equal(app.activity("subagent", "2 subagents").handled, true);
      const label = "2 subagents, review 3/6 complete";
      assert.match(screen(app.editor), /2 subagents, review 3\/6 complete/);
      assert.doesNotMatch(screen(app.editor), /Working/);
      assert.equal(intervals.active.size, 1, "both sources share one background animation");

      const reference = new Loader(
        app.tui,
        (text) => text,
        (text) => text,
        label,
      );
      try {
        for (const elapsed of [0, 79, 1, 80, 720, 80]) {
          mock.timers.tick(elapsed);
          const status = screen(reference).trim();
          const lines: string[] = app.display.render(100).map(stripVTControlCharacters);
          assert.ok(lines[0].startsWith(`── ${status} `), lines[0]);
          assert.equal(lines.filter((line) => line.includes(label)).length, 1);
          assert.equal(app.editor.getExpandedText?.(), draft);
        }
      } finally {
        reference.stop();
      }

      assert.notEqual(app.activity("subagent", "99 subagents", "session:other-café").handled, true);
      const sessionKey = app.session.sessionFile ?? `session:${app.session.sessionId}`;
      for (const packet of [
        null,
        {},
        { sessionKey, source: "subagent", text: 12 },
        { sessionKey, source: "unknown", text: "not activity" },
      ])
        app.emitActivity(packet);
      assert.match(screen(app.editor), /2 subagents, review 3\/6 complete/);
      app.editor.handleInput("\x0f");
      assert.equal(app.ui.getToolsExpanded(), false, "the old shortcut does not expand");
      app.editor.handleInput("\x1bo");
      await finishWrites();
      assert.equal(app.ui.getToolsExpanded(), true);
      assert.notEqual(app.activity("subagent", "2 subagents").handled, true);
      assert.doesNotMatch(screen(app.editor), /subagents|review/);
      assert.equal(intervals.active.size, 0, "expanded detail does not leave a background spinner");

      app.editor.handleInput("\x1bo");
      await finishWrites();
      assert.equal(app.ui.getToolsExpanded(), false);
      assert.equal(app.activity("review", "\x1b[31mreview\n4/6 complete\x1b[0m").handled, true);
      assert.match(screen(app.editor), /2 subagents, review 4\/6 complete/);
      assert.equal(app.editor.getExpandedText?.(), draft);
      app.ui.setToolsExpanded(true);
      assert.doesNotMatch(screen(app.editor), /subagents|review/);
      assert.equal(intervals.active.size, 0);
      app.ui.setToolsExpanded(false);
      assert.match(screen(app.editor), /2 subagents, review 4\/6 complete/);
      assert.equal(intervals.active.size, 1);

      app.activity("subagent");
      assert.match(screen(app.editor), /review 4\/6 complete/);
      assert.doesNotMatch(screen(app.editor), /subagent/);
      app.activity("review");
      assert.doesNotMatch(screen(app.editor), /subagents|review|Working/);
      assert.equal(intervals.active.size, 0, "clearing the last source stops the animation");
      const settled = app.redraw.mock.callCount();
      mock.timers.tick(8000);
      assert.equal(app.redraw.mock.callCount(), settled);
      assert.equal(app.editor.getExpandedText?.(), draft);
    });
  }

  for (const cleanupTiming of ["before", "after"] as const) {
    test(`keeps Pi's native indicator owned by Pi when cleanup happens ${cleanupTiming} settling`, async () => {
      const started = deferred<void>();
      const reply = deferred<string>();
      app = await openDisplay(cwd, failures, [], {
        editorMode: "embedded",
        extensions: [
          scriptedProvider(fixtureModel, async () => {
            started.resolve();
            return assistantMessage(await reply.promise);
          }),
        ],
      });
      const intervals = observeAnimationTimers();
      const draft = `  ${ledger}  `;
      app.editor.handleInput(`\x1b[200~${draft}\x1b[201~`);
      app.activity("review", "review 3/6 complete");
      app.activity("subagent", "2 subagents");
      const prompt = app.session.prompt("Keep the sourdough starter company.");
      let native: WorkingIndicatorFixture | undefined;
      try {
        await started.promise;
        assert.equal(app.session.isIdle, false);
        native = new WorkingIndicatorFixture(app.tui, "Working");
        const dispose = mock.method(native, "dispose");
        app.attachNative(native);
        assert.equal(app.workingMessages.at(-1), "Working, 2 subagents, review 3/6 complete");
        assert.match(screen(app.editor), /◐ Working, 2 subagents, review 3\/6 complete/);
        assert.equal(intervals.active.size, 0, "the child spinner stops when Pi owns the status");
        assert.equal(dispose.mock.callCount(), 0);

        app.ui.setToolsExpanded(true);
        assert.match(screen(app.editor), /◐ Working/);
        assert.doesNotMatch(screen(app.editor), /subagents|review/);
        assert.equal(app.workingMessages.at(-1), undefined);
        app.ui.setToolsExpanded(false);
        assert.match(screen(app.editor), /◐ Working, 2 subagents, review 3\/6 complete/);
        assert.equal(dispose.mock.callCount(), 0, "expansion must not dispose Pi's indicator");

        if (cleanupTiming === "after") {
          reply.resolve("The starter is thriving.");
          await prompt;
        }
        native.dispose();
        const attachment = mock.method(app.editor as StatusEditor, "setWorkingStatusIndicator");
        app.attachNative(undefined);
        assert.ok(
          attachment.mock.calls.some(({ arguments: [indicator] }) => indicator === undefined),
          "Pi clears its attachment with undefined even when child activity remains",
        );
        app.activity("review", "review 4/6 complete");
        assert.doesNotMatch(screen(app.editor), /◐|Working/);
        if (cleanupTiming === "before") assert.doesNotMatch(screen(app.editor), /subagents|review/);
        else assert.match(screen(app.editor), /2 subagents, review 4\/6 complete/);
        assert.equal(
          intervals.active.size,
          cleanupTiming === "before" ? 0 : 1,
          "only an idle parent can transfer child activity to a background spinner",
        );
        reply.resolve("The starter is thriving.");
        await prompt;
        assert.equal(app.session.isIdle, true);
        assert.match(screen(app.editor), /2 subagents, review 4\/6 complete/);
        assert.doesNotMatch(screen(app.editor), /◐|Working/);
        assert.equal(intervals.active.size, 1);
        app.activity("review");
        app.activity("subagent");
        assert.doesNotMatch(screen(app.editor), /◐|Working|subagents|review/);
        assert.equal(intervals.active.size, 0);
        assert.equal(app.editor.getExpandedText?.(), draft);
      } finally {
        reply.resolve("The starter is thriving.");
        await prompt;
        native?.dispose();
      }
    });
  }

  for (const mode of ["tui", "print"] as const) {
    test(`keeps opt-out editors on the unhandled activity path in ${mode} mode`, async () => {
      app = await openDisplay(cwd, failures, [], { editorMode: "standalone", mode });
      const intervals = observeAnimationTimers();
      for (const source of ["review", "subagent"] as const)
        assert.notEqual(
          app.activity(source, source === "review" ? "review 3/6 complete" : "2 subagents").handled,
          true,
        );
      assert.doesNotMatch(screen(app.editor), /Working|review|subagents/);
      assert.equal(intervals.active.size, 0);
      assert.ok(app.workingMessages.every((message) => message === undefined));
      await app.dispose();
    });
  }

  test("suspends idle activity during an approval prompt and cleans up on reload and shutdown", async () => {
    app = await openDisplay(cwd, failures, [], { editorMode: "default" });
    const intervals = observeAnimationTimers();
    const draft = Array.from({ length: 30 }, () => ledger).join("\n");
    app.editor.setText(draft);
    app.activity("subagent", "2 subagents");
    for (const width of [4, 10, 40, 100]) {
      const lines = app.editor.render(width).map(stripVTControlCharacters);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      if (width >= 40) assert.match(lines[0], /↑ \d+ more/);
    }
    await app.session.extensionRunner.emit({
      type: "ui_prompt_start",
      reason: "ui_prompt",
      kind: "confirm",
      title: "Feed the kraken?",
    });
    assert.notEqual(app.activity("review", "review 3/6 complete").handled, true);
    assert.doesNotMatch(screen(app.editor), /subagents|review/);
    assert.equal(intervals.active.size, 0);
    await app.session.extensionRunner.emit({
      type: "ui_prompt_end",
      reason: "ui_prompt",
      kind: "confirm",
    });
    app.editor.setText("Feed the kraken after lunch.");
    assert.match(screen(app.editor), /2 subagents, review 3\/6 complete/);
    assert.equal(intervals.active.size, 1);

    await app.session.reload();
    assert.equal(app.editor.getText(), "Feed the kraken after lunch.");
    assert.doesNotMatch(screen(app.editor), /subagents|review/);
    assert.equal(intervals.active.size, 0, "reload disposes the former coordinator's timer");
    assert.equal(app.activity("subagent", "1 subagent").handled, true);
    assert.match(screen(app.editor), /1 subagent/);
    assert.equal(intervals.active.size, 1, "reloaded coordinator has only one listener/animation");
    await app.dispose();
    assert.equal(app.factory(), app.previousFactory);
    assert.equal(app.editor.getText(), "Feed the kraken after lunch.");
    assert.equal(intervals.active.size, 0);
    const settled = app.redraw.mock.callCount();
    mock.timers.tick(8000);
    assert.equal(app.redraw.mock.callCount(), settled, "disposal leaves no scheduled redraws");
  });

  test("releases detached editor activity without consuming a replacement editor's draft", async () => {
    app = await openDisplay(cwd, failures, [], { editorMode: "embedded" });
    const intervals = observeAnimationTimers();
    app.editor.setText(ledger);
    app.activity("subagent", "2 subagents");
    assert.equal(intervals.active.size, 1);
    const replacement: EditorFactory = (tui, theme, keys) =>
      new CustomEditor(tui, theme, keys, { embedWorkingStatus: true });
    app.ui.setEditorComponent(replacement);
    assert.doesNotMatch(screen(app.display), /subagents/);
    assert.equal(
      intervals.active.size,
      0,
      "the empty observer releases the detached editor's animation",
    );
    assert.notEqual(app.activity("review", "review 3/6 complete").handled, true);
    assert.equal(app.editor.getText(), ledger);
    await app.dispose();
    assert.equal(
      app.factory(),
      replacement,
      "shutdown cannot replace an editor owned by another extension",
    );
    assert.equal(app.editor.getText(), ledger);
    assert.equal(intervals.active.size, 0);
  });

  for (const replacementMode of ["detached", "forwarding"] as const) {
    test(`releases coordinator ownership during parent work with a ${replacementMode} replacement editor`, async () => {
      const started = deferred<void>();
      const reply = deferred<string>();
      app = await openDisplay(cwd, failures, [], {
        editorMode: "embedded",
        extensions: [
          scriptedProvider(fixtureModel, async () => {
            started.resolve();
            return assistantMessage(await reply.promise);
          }),
        ],
      });
      const intervals = observeAnimationTimers();
      app.editor.setText(ledger);
      app.activity("subagent", "2 subagents");
      const prompt = app.session.prompt("Keep the octopus out of the espresso machine.");
      let native: WorkingIndicatorFixture | undefined;
      try {
        await started.promise;
        const attachment = mock.method(CustomEditor.prototype, "setWorkingStatusIndicator");
        native = new WorkingIndicatorFixture(app.tui, "Working");
        const dispose = mock.method(native, "dispose");
        app.attachNative(native);
        const originalBase = attachment.mock.calls.find(
          ({ arguments: [indicator] }) => indicator === native,
        )?.this;
        assert.ok(originalBase, "observe the original CustomEditor attachment boundary");
        assert.match(screen(app.display), /◐ Working, 2 subagents/);
        const previousEditor = app.editor;
        const replacement: EditorFactory =
          replacementMode === "detached"
            ? (tui, theme, keys) => new CustomEditor(tui, theme, keys, { embedWorkingStatus: true })
            : // Another extension can keep the old editor mounted behind its own forwarding wrapper.
              () =>
                new Proxy(previousEditor, {
                  get(target, key) {
                    const value = Reflect.get(target, key);
                    return typeof value === "function" ? value.bind(target) : value;
                  },
                });
        app.ui.setEditorComponent(replacement);
        assert.match(screen(app.display), /◐ Working/);
        assert.doesNotMatch(screen(app.display), /subagents/);
        assert.equal(
          dispose.mock.callCount(),
          0,
          "ownership loss cannot dispose a still-live native indicator",
        );
        assert.equal(app.editor.getText(), ledger);
        assert.equal(intervals.active.size, 0);
        const releasedAt = attachment.mock.callCount();

        // Pi cleans up only the currently mounted editor after disposing its native indicator.
        native.dispose();
        app.attachNative(undefined);
        reply.resolve("The espresso machine is safe.");
        await prompt;
        assert.equal(app.session.isIdle, true);
        assert.notEqual(app.activity("review", "review 3/6 complete").handled, true);
        assert.doesNotMatch(screen(app.display), /◐|Working|subagents|review/);
        await app.dispose();
        assert.equal(app.factory(), replacement);
        assert.equal(app.editor.getText(), ledger);
        assert.equal(intervals.active.size, 0);
        const laterOriginalAttachments = attachment.mock.calls
          .slice(releasedAt)
          .filter((call) => call.this === originalBase);
        if (replacementMode === "detached") {
          assert.deepEqual(
            laterOriginalAttachments,
            [],
            "no lifecycle, activity, render, or shutdown callback may touch the detached base",
          );
        } else {
          assert.ok(
            laterOriginalAttachments.length > 0,
            "the mounted forwarding editor still receives native cleanup",
          );
          assert.ok(
            laterOriginalAttachments.every(({ arguments: [indicator] }) => indicator === undefined),
            "the forwarding wrapper cannot revive the disposed native indicator",
          );
        }
      } finally {
        reply.resolve("The espresso machine is safe.");
        await prompt;
        native?.dispose();
      }
    });
  }

  test("leaves manual compaction status alone and resumes child activity after cancellation", async () => {
    const started = deferred<void>();
    const release = deferred<void>();
    const compaction: ExtensionFactory = (pi) => {
      pi.on("session_before_compact", async () => {
        started.resolve();
        await release.promise;
        return { cancel: true };
      });
    };
    app = await openDisplay(cwd, failures, [], {
      editorMode: "embedded",
      extensions: [compaction],
    });
    const intervals = observeAnimationTimers();
    app.session.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
    for (const text of ["The kraken ordered twelve croissants.", "Bring extra butter."]) {
      app.session.sessionManager.appendMessage({ role: "user", content: text, timestamp: 0 });
      app.session.sessionManager.appendMessage(assistantMessage("On the way."));
    }
    app.activity("review", "review 3/6 complete");
    assert.equal(intervals.active.size, 1);
    const compacting = app.session.compact();
    const cancelled = assert.rejects(compacting, /Compaction cancelled/);
    try {
      await Promise.race([started.promise, compacting]);
      // Native compaction has a standalone status and clears the editor attachment.
      app.attachNative(undefined);
      assert.equal(app.session.isIdle, false);
      assert.notEqual(app.activity("subagent", "2 subagents").handled, true);
      assert.doesNotMatch(screen(app.display), /subagents|review|Working/);
      assert.equal(intervals.active.size, 0);
    } finally {
      release.resolve();
      await cancelled;
    }
    assert.equal(app.session.isIdle, true);
    assert.match(screen(app.display), /2 subagents, review 3\/6 complete/);
    assert.equal(intervals.active.size, 1);
    await app.dispose();
    assert.equal(intervals.active.size, 0);
  });

  test("does not replace native retry status with idle child activity", async () => {
    let requests = 0;
    app = await openDisplay(cwd, failures, [], {
      editorMode: "embedded",
      extensions: [
        scriptedProvider(fixtureModel, () => {
          assert.equal(++requests, 1, "cancellation must not start another request");
          return {
            ...assistantMessage(""),
            stopReason: "error",
            errorMessage: "503: The kraken ate the router.",
          };
        }),
      ],
    });
    const intervals = observeAnimationTimers();
    app.session.settingsManager.applyOverrides({
      retry: { enabled: true, maxRetries: 1, baseDelayMs: 10000 },
    });
    const retry = deferred<void>();
    const unsubscribe = app.session.subscribe((event) => {
      if (event.type === "auto_retry_start") retry.resolve();
    });
    app.activity("subagent", "2 subagents");
    const prompt = app.session.prompt("Ask the kraken to leave the router alone.");
    try {
      await Promise.race([
        retry.promise,
        prompt.then(() => {
          throw new Error("Expected automatic retry");
        }),
      ]);
      app.attachNative(undefined);
      assert.equal(app.session.isIdle, false);
      assert.notEqual(app.activity("review", "review 3/6 complete").handled, true);
      assert.doesNotMatch(screen(app.display), /subagents|review|Working/);
      assert.equal(intervals.active.size, 0, "retry is not an idle-parent background phase");
    } finally {
      await app.session.abort();
      await prompt;
      unsubscribe();
    }
    assert.equal(requests, 1);
    assert.equal(app.session.isIdle, true);
    assert.match(screen(app.display), /2 subagents, review 3\/6 complete/);
    await app.dispose();
    assert.equal(intervals.active.size, 0);
  });

  test("summarizes real limited reads and directory listings without changing model-visible results", async () => {
    await fs.writeFile(configPath(), '{"mode":" MINIMAL "}\n');
    await fs.writeFile(path.join(cwd, "manifest.txt"), ledger);
    await fs.mkdir(path.join(cwd, "empty"));
    const calls = [
      call("read", { path: "manifest.txt", limit: 2 }),
      call("ls", { path: ".", limit: 1 }),
      call("ls", { path: "empty" }),
      call("read", { path: "missing-octopus.txt" }),
    ];
    app = await openDisplay(cwd, failures, calls);
    await app.session.prompt("Inspect the café manifest and directories.");
    const results = app.session.messages.filter((message) => message.role === "toolResult");
    assert.equal(results.length, 4);
    assert.deepEqual(results[0].content, [
      {
        type: "text",
        text: "Café release manifest 🐙\nRestore the jellyfish database.\n\n[1 more lines in file. Use offset=3 to continue.]",
      },
    ]);
    assert.deepEqual(results[1].content, [
      {
        type: "text",
        text: "empty/\n\n[1 entries limit reached. Use limit=2 for more]",
      },
    ]);
    assert.deepEqual(results[2].content, [{ type: "text", text: "(empty directory)" }]);
    assert.equal(results[3].isError, true);
    assert.deepEqual(
      app.modelResults(),
      results.map((result) => result.content),
    );
    const failed = app.row("read", calls[3].arguments);
    failed.updateResult(results[3]);
    assert.match(screen(failed), /ENOENT/);
    assert.doesNotMatch(screen(failed), /↳|running\.\.\./);
    assert.equal(app.session.getLastAssistantText(), "Inspection complete.");
    for (const [index, summary] of [
      [0, "↳ 2 lines"],
      [1, "↳ 1 entry"],
      [2, "↳ 0 entries"],
    ] as const) {
      const row = app.row(calls[index].name, calls[index].arguments);
      row.updateResult(results[index]);
      assert.ok(screen(row).includes(summary), `Expected ${summary}: ${screen(row)}`);
      assert.doesNotMatch(screen(row), /Use (offset|limit)=/);
    }
  });

  test("preserves an existing read override's access boundary and result rendering", async () => {
    await fs.writeFile(configPath(), '{"mode":"minimal"}\n');
    await fs.writeFile(path.join(cwd, "manifest.txt"), ledger);
    const restrictedRead: ExtensionFactory = (pi) => {
      const read = createReadToolDefinition(cwd);
      pi.registerTool({
        ...read,
        async execute(id, args, signal, onUpdate, ctx) {
          if (args.path !== "public.txt") throw new Error("Café access policy: private manifest");
          return read.execute(id, args, signal, onUpdate, ctx);
        },
        renderResult(_result, _options, theme) {
          return new Text(theme.fg("error", "Read access denied — ask the café owner."), 0, 0);
        },
      });
    };
    app = await openDisplay(cwd, failures, [call("read", { path: "manifest.txt" })], {
      extensions: [restrictedRead],
    });
    await app.session.prompt("Inspect the private manifest.");
    const result = app.session.messages.find((message) => message.role === "toolResult");
    assert.ok(result);
    assert.equal(
      result.isError,
      true,
      "display customization must not bypass an existing executor",
    );
    assert.deepEqual(result.content, [
      { type: "text", text: "Café access policy: private manifest" },
    ]);
    assert.deepEqual(app.modelResults(), [result.content]);
    const row = app.row("read", { path: "manifest.txt" });
    row.updateResult(result);
    assert.match(screen(row), /Read access denied — ask the café owner\./);
    assert.doesNotMatch(screen(row), /↳/);
  });

  for (const truncated of [false, true]) {
    test(`counts bracketed command output ${truncated ? "with" : "without"} native truncation`, async () => {
      await fs.writeFile(configPath(), '{"mode":"minimal"}\n');
      const output = `${truncated ? "early row\n".repeat(DEFAULT_MAX_LINES) : ""}manifest\n\n[1,\n2]`;
      const command = `printf '%s' '${output}'`;
      allowedCommands.add(command);
      app = await openDisplay(cwd, failures, [call("bash", { command })]);
      let outputPath: string | undefined;
      try {
        await app.session.prompt("Print the manifest array.");
        const result = app.session.messages.find((message) => message.role === "toolResult");
        assert.ok(result);
        const details = result.details as BashToolDetails | undefined;
        outputPath = details?.fullOutputPath;
        assert.equal(result.isError, false);
        assert.deepEqual(app.modelResults(), [result.content]);
        if (truncated) {
          assert.ok(outputPath);
          assert.equal(await fs.readFile(outputPath, "utf8"), output);
        } else {
          assert.equal(outputPath, undefined);
          assert.deepEqual(result.content, [{ type: "text", text: output }]);
        }
        const row = app.row("bash", { command });
        row.updateResult(result);
        assert.ok(
          screen(row).includes(`↳ ${truncated ? DEFAULT_MAX_LINES : 4} lines`),
          "count command output, not its notice, without discarding bracketed content",
        );
      } finally {
        if (outputPath) await fs.rm(outputPath);
      }
    });
  }

  for (const mode of ["tui", "print"] as const) {
    test(
      `preserves configured shell execution in ${mode} mode`,
      { todo: mode === "tui" ? "https://github.com/goncalossilva/tau/issues/17" : false },
      async () => {
        const command = "printf '%s' \"${TAU_DISPLAY_MENU-unseasoned}\"";
        const prefix = "export TAU_DISPLAY_MENU=croissant;";
        // Both native and accidentally replaced executors are harmless; allow their exact commands.
        app = await openDisplay(cwd, failures, [], { mode, prefix });
        allowedCommands.add(command);
        allowedCommands.add(`${prefix}\n${command}`);
        assert.ok(app.originalBash);
        const baseline = await app.originalBash.execute("native-shell-settings", { command });
        assert.deepEqual(baseline.content, [{ type: "text", text: "croissant" }]);
        const displayed = app.session.agent.state.tools.find((tool) => tool.name === "bash");
        assert.ok(displayed);
        const result = await displayed.execute("shell-settings", { command });
        assert.deepEqual(
          result.content,
          [{ type: "text", text: "croissant" }],
          "a display-only extension must not drop shellCommandPrefix",
        );
      },
    );
  }
});

/**
 * Bind real Pi lifecycle, tools and components to an in-process display surface, not a CLI/PTY.
 * Model generation and UI mounting are adapted; native tool results reach the next model request.
 * Expansion redraws are driven explicitly through native row methods, not InteractiveMode.
 * Working attachment and widget mounting/disposal are adapted at public UI boundaries.
 * Draft transfer intentionally uses expanded text, unlike native InteractiveMode's getText().
 */
async function openDisplay(
  cwd: string,
  failures: unknown[],
  calls: ToolCall[] = [],
  options: {
    mode?: "tui" | "print";
    prefix?: string;
    extensions?: ExtensionFactory[];
    editorMode?: "default" | "embedded" | "standalone";
    persistent?: boolean;
  } = {},
) {
  const { mode = "tui", prefix, extensions = [], editorMode = "standalone" } = options;
  let requests = 0;
  let receivedResults: unknown[] = [];
  let events: ExtensionAPI["events"];
  const provider: ExtensionFactory = (pi) => {
    events = pi.events;
    pi.registerProvider(fixtureModel.provider, {
      api: fixtureModel.api,
      baseUrl: fixtureModel.baseUrl,
      apiKey: "fixture-only",
      models: [fixtureModel],
      streamSimple: (_model, context) => {
        if (!calls.length || requests >= 2) {
          const error = new Error("Unexpected model request");
          failures.push(error);
          throw error;
        }
        const reply =
          requests++ === 0
            ? { ...assistantMessage(""), content: calls, stopReason: "toolUse" as const }
            : assistantMessage("Inspection complete.");
        if (requests === 2)
          receivedResults = context.messages
            .filter((message) => message.role === "toolResult")
            .map((message) => structuredClone(message.content));
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "start", partial: reply });
        stream.push({
          type: "done",
          reason: reply.stopReason as "stop" | "toolUse",
          message: reply,
        });
        stream.end();
        return stream;
      },
    });
  };
  const resources = await createPiResources(cwd, getAgentDir(), [
    toolDisplayMode,
    provider,
    ...extensions,
  ]);
  resources.settingsManager.applyOverrides({ shellPath: "/bin/bash", shellCommandPrefix: prefix });
  const { session } = await createAgentSession({
    ...resources,
    sessionManager: options.persistent
      ? SessionManager.create(cwd, path.join(getAgentDir(), "sessions"))
      : resources.sessionManager,
    model: fixtureModel,
    tools: ["read", "ls", "bash", "grep", "find"],
  });
  // Capture the SDK-built executor before session_start installs display overrides.
  const originalBash = session.agent.state.tools.find((tool) => tool.name === "bash");
  let disposed = false;
  let nativeWorking: WorkingIndicatorFixture | undefined;
  const widgets = new Map<string, Component & { dispose?(): void }>();
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    try {
      await session.abort();
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      await resources.settingsManager.flush();
    } finally {
      nativeWorking?.dispose();
      for (const widget of widgets.values()) widget.dispose?.();
      widgets.clear();
      session.dispose();
    }
  };
  try {
    initTheme("dark", false);
    const displayTheme = session.extensionRunner.getUIContext().theme;
    const plain = (text: string) => text;
    const theme = {
      borderColor: plain,
      selectList: {
        selectedPrefix: plain,
        selectedText: plain,
        description: plain,
        scrollInfo: plain,
        noMatch: plain,
      },
    };
    const terminal = new Proxy({ columns: 100, rows: 30, showCursor() {}, stop() {} } as Terminal, {
      get(target, key) {
        if (key in target) return Reflect.get(target, key);
        const error = new Error(`Unexpected terminal operation: ${String(key)}`);
        failures.push(error);
        throw error;
      },
    });
    const tui = new TuiMainScreen(terminal);
    tui.stop(); // Disable scheduled terminal writes; renders below are explicit.
    const redraw = mock.method(tui, "requestRender");
    const keys = editorKeybindings();
    const defaultFactory: EditorFactory = (tui, theme, keys) =>
      new CustomEditor(tui, theme, keys, { embedWorkingStatus: true });
    const previousFactory: EditorFactory | undefined =
      editorMode === "default"
        ? undefined
        : (tui, theme, keys) =>
            new CustomEditor(tui, theme, keys, { embedWorkingStatus: editorMode === "embedded" });
    let factory: EditorFactory | undefined = previousFactory;
    let editor: EditorComponent = (previousFactory ?? defaultFactory)(tui, theme, keys);
    let expanded = false;
    const workingMessages: (string | undefined)[] = [];
    const notifications: { message: string; type: string | undefined }[] = [];
    const ui = uiBoundary(
      {
        getEditorComponent: () => factory,
        setEditorComponent: (next) => {
          // SDK surface preserves expanded drafts. Native InteractiveMode copies getText() and
          // loses collapsed-paste metadata on replacement, outside these display-mode assertions.
          const draft = editor.getExpandedText?.() ?? editor.getText();
          factory = next;
          editor = (next ?? defaultFactory)(tui, theme, keys);
          editor.setText(draft);
          if (nativeWorking) {
            const statusEditor = editor as Partial<StatusEditor>;
            if (statusEditor.embedWorkingStatus)
              statusEditor.setWorkingStatusIndicator?.(nativeWorking);
          }
        },
        setWidget: (key, content) => {
          assert.equal(key, "tool-display-activity");
          widgets.get(key)?.dispose?.();
          widgets.delete(key);
          if (content)
            widgets.set(
              key,
              typeof content === "function"
                ? content(tui, displayTheme)
                : new Text(content.join("\n"), 0, 0),
            );
        },
        getToolsExpanded: () => expanded,
        setToolsExpanded: (value) => {
          expanded = value;
        },
        setWorkingMessage: (message) => {
          workingMessages.push(message);
          nativeWorking?.setMessage(message ?? "Working");
        },
        get theme() {
          return displayTheme;
        },
        notify: (message, type) => {
          notifications.push({ message, type });
        },
      },
      failures,
    );
    await session.bindExtensions({
      uiContext: mode === "tui" ? ui : undefined,
      mode,
      onError: (error) => failures.push(error),
    });
    return {
      session,
      previousFactory,
      notifications,
      workingMessages,
      ui,
      tui,
      redraw,
      display: {
        render(width: number) {
          const lines = [...widgets.values()].flatMap((widget) => widget.render(width));
          assert.deepEqual(lines, [], "the activity observer must not add a visible widget row");
          return editor.render(width);
        },
        invalidate() {
          for (const widget of widgets.values()) widget.invalidate();
          editor.invalidate();
        },
      },
      dispose,
      originalBash,
      get editor() {
        return editor;
      },
      factory: () => factory,
      expanded: () => expanded,
      modelResults: () => receivedResults,
      activity(
        source: ActivityPacket["source"],
        text?: string,
        sessionKey = session.sessionFile ?? `session:${session.sessionId}`,
      ) {
        const packet: ActivityPacket = { sessionKey, source, text };
        events.emit("tau:activity", packet);
        return packet;
      },
      emitActivity(packet: unknown) {
        events.emit("tau:activity", packet);
      },
      // Model only InteractiveMode's attachment/message boundary, not its private status classes.
      attachNative(indicator: WorkingIndicatorFixture | undefined) {
        nativeWorking = indicator;
        if (indicator) indicator.setMessage(workingMessages.at(-1) ?? "Working");
        (editor as StatusEditor).setWorkingStatusIndicator(indicator);
      },
      row(name: string, args: unknown, definition = session.getToolDefinition(name)) {
        const row = new ToolExecutionComponent(
          name,
          "display-row",
          args,
          { showImages: false },
          definition,
          tui,
          cwd,
        );
        row.setArgsComplete();
        row.setExpanded(expanded);
        return row;
      },
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

/** Adapt the existing native attachment boundary without importing Pi's private status components. */
class WorkingIndicatorFixture extends Loader {
  readonly kind = "working";
  private label: string;
  private disposed = false;

  constructor(tui: TuiMainScreen, message: string) {
    // A distinct static native indicator detects replacement by the default background spinner.
    super(
      tui,
      (text) => text,
      (text) => text,
      message,
      { frames: ["◐"] },
    );
    this.label = message;
  }

  override setMessage(message: string) {
    assert.equal(this.disposed, false, "a disposed native loader cannot be updated");
    this.label = message;
    super.setMessage(message);
  }

  renderInBorder(width: number) {
    assert.equal(this.disposed, false, "a disposed native loader cannot be rendered");
    return truncateToWidth(`${this.getRenderedIndicator()} ${this.label}`, width, "");
  }

  renderSpinnerInBorder(width: number) {
    assert.equal(this.disposed, false, "a disposed native loader cannot be rendered");
    return truncateToWidth(this.getRenderedIndicator(), width, "");
  }

  dispose() {
    this.disposed = true;
    this.stop();
  }
}

/** Track real Loader interval allocation under Node's controlled clock, including stopped timers. */
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
  return { active };
}

/** Pi's app manager is type-only at the package root. Use its public TUI base with the documented editor bindings. */
function editorKeybindings(): KeybindingsManager {
  return new TuiKeybindingsManager(
    {
      ...TUI_KEYBINDINGS,
      "app.tools.expand": { defaultKeys: "ctrl+o" },
      "app.interrupt": { defaultKeys: "escape" },
      "app.exit": { defaultKeys: "ctrl+d" },
      "app.clipboard.pasteImage": { defaultKeys: "ctrl+v" },
    },
    { "app.tools.expand": "alt+o" },
  ) as KeybindingsManager;
}

/** Observe completion of real disk operations because the extension's fire-and-forget saves expose no awaitable handle. */
function observeFileCompletion() {
  const pending: Promise<unknown>[] = [];
  for (const method of ["mkdir", "writeFile"] as const) {
    const original = fs[method];
    mock.method(fs, method, (...args: unknown[]) => {
      const operation = Reflect.apply(original, fs, args) as Promise<unknown>;
      pending.push(operation);
      return operation;
    });
  }
  syncBuiltinESMExports();
  return async () => {
    while (pending.length) await Promise.allSettled(pending.splice(0));
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function configPath() {
  return path.join(getAgentDir(), "tool-display-mode.json");
}

function call(name: string, args: Record<string, unknown>): ToolCall {
  return { type: "toolCall", id: `${name}-${JSON.stringify(args)}`, name, arguments: args };
}

function screen(component: Component) {
  return component
    .render(100)
    .map(stripVTControlCharacters)
    .map((line) => line.trimEnd())
    .join("\n");
}
