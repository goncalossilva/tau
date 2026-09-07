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
  ToolExecutionComponent,
  type BashToolDetails,
  type ExtensionFactory,
  type ExtensionUIContext,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  KeybindingsManager as TuiKeybindingsManager,
  TUI_KEYBINDINGS,
  TuiMainScreen,
  Text,
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

type EditorFactory = NonNullable<ReturnType<ExtensionUIContext["getEditorComponent"]>>;
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
 * Rows are mounted after mode changes: this does not test invalidation of already-settled transcript rows.
 */
async function openDisplay(
  cwd: string,
  failures: unknown[],
  calls: ToolCall[] = [],
  options: { mode?: "tui" | "print"; prefix?: string; extensions?: ExtensionFactory[] } = {},
) {
  const { mode = "tui", prefix, extensions = [] } = options;
  let requests = 0;
  let receivedResults: unknown[] = [];
  const provider: ExtensionFactory = (pi) => {
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
    model: fixtureModel,
    tools: ["read", "ls", "bash"],
  });
  // Capture the SDK-built executor before session_start installs display overrides.
  const originalBash = session.agent.state.tools.find((tool) => tool.name === "bash");
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    try {
      await session.abort();
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      await resources.settingsManager.flush();
    } finally {
      session.dispose();
    }
  };
  try {
    initTheme("dark", false);
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
    const keys = editorKeybindings();
    const previousFactory: EditorFactory = (tui, theme, keys) => new CustomEditor(tui, theme, keys);
    let factory: EditorFactory | undefined = previousFactory;
    let editor: EditorComponent = previousFactory(tui, theme, keys);
    let expanded = false;
    const notifications: { message: string; type: string | undefined }[] = [];
    const ui = uiBoundary(
      {
        getEditorComponent: () => factory,
        setEditorComponent: (next) => {
          const draft = editor.getExpandedText?.() ?? editor.getText();
          factory = next;
          editor = (next ?? previousFactory)(tui, theme, keys);
          editor.setText(draft);
        },
        setToolsExpanded: (value) => {
          expanded = value;
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
      dispose,
      originalBash,
      get editor() {
        return editor;
      },
      factory: () => factory,
      expanded: () => expanded,
      modelResults: () => receivedResults,
      row(name: string, args: unknown) {
        const row = new ToolExecutionComponent(
          name,
          "display-row",
          args,
          { showImages: false },
          session.getToolDefinition(name),
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
