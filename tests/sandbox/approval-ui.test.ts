import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import {
  createAgentSession,
  initTheme,
  type ExtensionUIContext,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  KeybindingsManager as TuiKeys,
  ScrollView,
  Text,
  TUI_KEYBINDINGS,
  TuiAltScreen,
  VStack,
  type Component,
  type Terminal,
} from "@earendil-works/pi-tui";
import {
  formatUnsandboxedApproval,
  showUnsandboxedApproval,
} from "../../extensions/sandbox/permissions/unsandboxed.js";
import { deadline } from "../helpers/async.js";
import { createPiResources, fixtureModel, uiBoundary } from "../helpers/pi.js";

describe("sandbox approval dock", () => {
  let cwd: string;
  let view: Awaited<ReturnType<typeof openApprovalDock>> | undefined;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), "tau-approval-dock-"));
  });

  afterEach(async () => {
    try {
      await view?.dispose();
    } finally {
      view = undefined;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("short approvals use normal choice styling without review clutter and restore the draft", async () => {
    view = await openApprovalDock(cwd, false);
    const draft = view.editor.render(view.terminal.columns);
    const heading = "Run once outside sandbox?";
    const command = String.raw`printf '"otter parade"\n'`;
    const title = formatUnsandboxedApproval(command, path.join(os.homedir(), "otter den"));
    const { result: approval } = await view.open(title);
    const frame = view.frame();
    const rendered = frame.join("\n");
    assert.equal(view.screen.hasOverlay(), false);
    assert.equal([...rendered.matchAll(/Run once outside sandbox\?/g)].length, 1, rendered);
    assert.equal(frame.filter((line) => /^─+$/.test(line.trim())).length, 2, rendered);
    assert.ok(
      frame.some((line) => line.startsWith(` ${heading}`)),
      rendered,
    );
    const headingRow = frame.findIndex((line) => line.trim() === heading);
    assert.deepEqual(
      frame.slice(headingRow, headingRow + 6).map((line) => line.trimEnd()),
      [
        ` ${heading}`,
        "",
        " ~/otter den",
        ` $ ${command}`,
        "",
        " This command and its descendants get host filesystem and network access.",
      ],
    );
    assert.ok(view.output().includes(view.theme.fg("text", `$ ${command}`)));
    assert.ok(view.output().includes(view.theme.fg("dim", "~/otter den")));
    assert.ok(
      frame.some((line) => /^ → Deny\s*$/.test(line)),
      rendered,
    );
    assert.ok(
      frame.some((line) => /^ {3}Run once outside sandbox\s*$/.test(line)),
      rendered,
    );
    assert.doesNotMatch(rendered, /[█│]|Lines \d+-\d+ of \d+|review lines|top\/end|ctrl\+page/i);

    view.key("\x1b[1;5H");
    assert.match(view.frame().join("\n"), /ctrl\+pageup\/ctrl\+pagedown review lines/i);
    view.key("\x1b[B");
    const selected = view.frame();
    assert.ok(selected.some((line) => /^ → Run once outside sandbox\s*$/.test(line)));
    assert.doesNotMatch(selected.join("\n"), /review lines|top\/end|ctrl\+page/i);
    view.key("\r");
    assert.equal(await approval, "Run once outside sandbox");
    assert.deepEqual(view.editor.render(view.terminal.columns), draft);
    assert.ok(view.frame().some((line) => line.trim() === "Unsent otter draft"));
  });

  test("shortens only the home directory and its descendants while preserving shell text", () => {
    const home = os.homedir();
    const command = String.raw`printf '%s\n' "otter's den"`;
    for (const [directory, displayed] of [
      [home, "~"],
      [path.join(home, "otter den"), "~/otter den"],
      [path.join(`${home}-lookout`, "otter den"), path.join(`${home}-lookout`, "otter den")],
    ] as const) {
      const lines = formatUnsandboxedApproval(command, directory).split("\n");
      assert.deepEqual(lines, [
        "Run once outside sandbox?",
        "",
        displayed,
        `$ ${command}`,
        "",
        "This command and its descendants get host filesystem and network access.",
      ]);
    }
  });

  test("renders multiline commands and visibly escapes path, terminal, and bidi controls", async () => {
    const directory = path.join(os.homedir(), "otter\n\x1b[31m\u202eden");
    const command =
      "printf '\"otter\"\\n'\nprintf '\t\r\x1b[31m\x07\u0085\u202e\u2066\u2028\u2029'";
    const displayed = [
      String.raw`~/otter\u000a\u001b[31m\u202eden`,
      String.raw`$ printf '"otter"\n'`,
      String.raw`printf '\u0009\u000d\u001b[31m\u0007\u0085\u202e\u2066\u2028\u2029'`,
    ];
    const title = formatUnsandboxedApproval(command, directory);
    assert.deepEqual(title.split("\n").slice(1, -1), ["", ...displayed, ""]);

    view = await openApprovalDock(cwd, false);
    const { result: approval } = await view.open(title);
    view.frame();
    view.key("\x1b[1;5H");
    view.key("\x1b[6;5~");
    for (const line of displayed) {
      view.key("\x1b[6;5~");
      const frame = view.frame();
      assert.ok(
        frame.some((row) => row.trimEnd() === ` ${line}`),
        frame.join("\n"),
      );
    }
    view.key("\x1b");
    assert.equal(await deadline(approval, "Escape dismissal"), undefined);
  });

  for (const constrained of [false, true]) {
    test(`reviews every command line below the transcript in a ${constrained ? "three-row" : "roomy"} dock`, async () => {
      view = await openApprovalDock(cwd, constrained);
      const lines = Array.from(
        { length: 45 },
        (_, index) => `printf 'otter-${index.toString().padStart(2, "0")}\\n'`,
      );
      const { result: approval } = await view.open(lines.join("\n"));
      let frame = view.frame();
      const denyRow = frame.findIndex((line) => line.includes("→ Deny"));
      const transcriptRow = frame.findIndex((line) => line.includes("Otter transcript"));
      assert.ok(transcriptRow >= 0 && denyRow > transcriptRow, frame.join("\n"));
      assert.equal(view.screen.hasOverlay(), false);
      if (constrained) assert.equal(denyRow, view.terminal.rows - 2);
      else {
        assert.match(frame.join("\n"), /ctrl\+pageup\/ctrl\+pagedown review lines/i);
        assert.match(frame.join("\n"), /ctrl\+home\/ctrl\+end top\/end/i);
      }

      view.key("\x1b[1;5H");
      for (let index = 0; index < lines.length; index++) {
        frame = view.frame();
        assert.ok(
          frame.some((line) => line.includes(lines[index]!)),
          `Review line ${index} missing:\n${frame.join("\n")}`,
        );
        if (index + 1 < lines.length) view.key("\x1b[6;5~");
      }
      view.key("\x1b[B");
      frame = view.frame();
      assert.ok(
        frame.some((line) => line.includes("→ Run once outside sandbox")),
        frame.join("\n"),
      );
      view.key("\r");
      assert.equal(await approval, "Run once outside sandbox");
      assert.ok(view.frame().some((line) => line.includes("Unsent otter draft")));
    });
  }

  test("resizing resets approval to Deny and cancellation preserves an existing overlay", async () => {
    view = await openApprovalDock(cwd, true);
    const { result: approval } = await view.open("printf 'otter parade'");
    view.frame();
    view.key("\x1b[B");
    assert.ok(view.frame().some((line) => line.includes("→ Run once outside sandbox")));
    view.terminal.columns -= 10;
    assert.ok(view.frame().some((line) => line.includes("→ Deny")));
    view.key("\r");
    assert.equal(await approval, "Deny");

    const overlay = view.screen.showOverlay(new Text("Otter lookout", 0, 0), {
      width: 20,
      anchor: "top-right",
    });
    try {
      const controller = new AbortController();
      const { result: cancelled } = await view.open("printf 'keep lookout'", controller.signal);
      view.frame();
      controller.abort();
      assert.equal(await cancelled, undefined);
      assert.equal(view.screen.hasOverlay(), true);
      assert.ok(view.frame().some((line) => line.includes("Otter lookout")));
      const { result: escaped } = await view.open("printf 'escape hatch'");
      view.frame();
      view.key("\x1b");
      assert.equal(await deadline(escaped, "Escape dismissal"), undefined);
      assert.equal(view.screen.hasOverlay(), true);
    } finally {
      overlay.hide();
    }
  });

  test("advertised Ctrl+PageDown reviews while ordinary PageDown retains transcript scrolling", async () => {
    view = await openApprovalDock(cwd, true);
    const { result: approval } = await view.open("first otter\nsecond otter\nthird otter");
    view.frame();
    view.key("\x1b[1;5F");
    view.frame();
    view.key("\x1b[5;5~");
    const before = view.frame();
    assert.ok(before.some((line) => line.includes("second otter")));
    assert.ok(!before.some((line) => line.includes("third otter")));
    view.key("\x1b[H");
    assert.ok(view.frame()[0]!.includes("Otter transcript 0"));
    view.key("\x1b[6~");
    const transcriptScrolled = view.frame();
    assert.ok(transcriptScrolled[0]!.includes("Otter transcript 1"));
    assert.ok(!transcriptScrolled.some((line) => line.includes("third otter")));
    view.key("\x1b[6;5~");
    const reviewed = view.frame();
    assert.ok(reviewed.some((line) => line.includes("third otter")));
    assert.equal(reviewed[0], transcriptScrolled[0]);
    view.key("\x1b");
    assert.equal(await deadline(approval, "Escape dismissal"), undefined);
  });
});

/** Real Pi context and fullscreen layout. Only custom-dialog mounting and terminal I/O are substituted.
 * The plain editor Container intentionally mirrors Pi's opaque dock boundary, including its three-row minimum. */
async function openApprovalDock(cwd: string, constrained: boolean) {
  const resources = await createPiResources(cwd, path.join(cwd, "agent"), []);
  const { session } = await createAgentSession({ ...resources, model: fixtureModel, tools: [] });
  const errors: unknown[] = [];
  let output = "";
  let input!: (data: string) => void;
  const terminal = new Proxy(
    {
      columns: 120,
      rows: 30,
      write(data: string) {
        output += data;
      },
      start(onInput: (data: string) => void) {
        input = onInput;
      },
      stop() {},
      hideCursor() {},
      showCursor() {},
    },
    {
      get(target, key) {
        if (key in target) return Reflect.get(target, key);
        const error = new Error(`Unexpected terminal operation: ${String(key)}`);
        errors.push(error);
        throw error;
      },
    },
  );
  const screen = new TuiAltScreen(terminal as unknown as Terminal, false, undefined, {
    mouse: false,
  });
  const editor = new Text("Unsent otter draft", 0, 0);
  const editorContainer = new Container();
  editorContainer.addChild(editor);
  const dock = new VStack([
    ...(constrained
      ? [{ component: new Text(Array(25).fill("Other dock content").join("\n"), 0, 0), shrink: 0 }]
      : []),
    { component: editorContainer, shrink: 1, minSize: 3 },
    { component: new Text("Otter footer", 0, 0), shrink: 1, minSize: 1 },
  ]);
  screen.setLayoutRoot(
    new VStack([
      {
        component: new ScrollView(
          new Text(
            Array.from({ length: 40 }, (_, index) => `Otter transcript ${index}`).join("\n"),
            0,
            0,
          ),
          {
            primary: true,
            follow: "end",
          },
        ),
        basis: 0,
        grow: 1,
        shrink: 1,
        minSize: 1,
      },
      { component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
    ]),
  );
  let mounted = deferred<void>();
  let close: (() => void) | undefined;
  let component: (Component & { dispose?(): void }) | undefined;
  let active: Promise<string | undefined> | undefined;
  initTheme("dark", false);
  const theme = session.extensionRunner.getUIContext().theme;
  const keys = new TuiKeys(TUI_KEYBINDINGS) as KeybindingsManager;
  const custom: ExtensionUIContext["custom"] = async (factory, options) => {
    assert.equal(options?.overlay, undefined, "Approval must mount in the editor dock");
    const completion = deferred<Parameters<Parameters<typeof factory>[3]>[0]>();
    let closed = false;
    const done: Parameters<typeof factory>[3] = (value) => {
      if (closed) return;
      closed = true;
      editorContainer.clear();
      editorContainer.addChild(editor);
      screen.setFocus(editor);
      component?.dispose?.();
      component = undefined;
      completion.resolve(value);
    };
    close = () => done(undefined as Parameters<typeof done>[0]);
    component = await factory(screen, theme, keys, done);
    if (!closed) {
      editorContainer.clear();
      editorContainer.addChild(component);
      screen.setFocus(component);
    }
    mounted.resolve();
    return completion.promise;
  };
  try {
    await session.bindExtensions({
      mode: "tui",
      onError: (error) => errors.push(error),
      uiContext: uiBoundary({ theme, custom }, errors),
    });
    screen.start();
  } catch (error) {
    screen.stop({ preserveScreen: true });
    session.dispose();
    throw error;
  }
  return {
    screen,
    terminal,
    editor,
    theme,
    output: () => output,
    async open(title: string, signal?: AbortSignal) {
      mounted = deferred<void>();
      active = showUnsandboxedApproval(session.extensionRunner.createContext(), title, signal);
      await deadline(
        Promise.race([
          mounted.promise,
          active.then(() => assert.fail("Approval closed before mounting")),
        ]),
        "approval dock mount",
      );
      // Wrap the promise so awaiting mount does not await the human decision.
      return { result: active };
    },
    key(data: string) {
      input(data);
    },
    frame() {
      output = "";
      screen.renderNow(true);
      const rows = Array<string>(terminal.rows).fill("");
      const matches = [
        // eslint-disable-next-line no-control-regex -- Decode the renderer's terminal protocol.
        ...output.matchAll(/\x1b\[(\d+);1H\x1b\[2K([\s\S]*?)(?=\x1b\[\d+;\d+H|\x1b\[\?25[hl]|$)/g),
      ];
      assert.equal(
        matches.length,
        terminal.rows,
        "Expected a complete positioned fullscreen frame",
      );
      for (const match of matches) rows[Number(match[1]) - 1] = stripVTControlCharacters(match[2]!);
      return rows;
    },
    async dispose() {
      try {
        close?.();
        await active;
        await session.abort();
        await resources.settingsManager.flush();
      } finally {
        screen.stop({ preserveScreen: true });
        session.dispose();
      }
      assert.deepEqual(errors, []);
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
