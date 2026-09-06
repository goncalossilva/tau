import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, mock, test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createAgentSession, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Editor, TuiMainScreen, type Terminal } from "@earendil-works/pi-tui";
import {
  assistantMessage,
  createPiResources,
  fixtureModel,
  isolatePiHome,
  uiBoundary,
} from "./helpers/pi.js";

const draft =
  "  Café stand-up / 日本語 🐙\n\n  The octopus fixed eight bugs and opened nine PRs.\nDo not give it production credentials.  ";

describe("stash", { concurrency: false }, () => {
  let home: Awaited<ReturnType<typeof isolatePiHome>> | undefined;
  let stashExtension: ExtensionFactory;
  let directory: string | undefined;
  let ui: Awaited<ReturnType<typeof openEditor>> | undefined;
  let failures: unknown[];

  before(async () => {
    home = await isolatePiHome();
    // Stash fixes its keybindings path at import time, after the suite's home is isolated.
    ({ default: stashExtension } = await import("../extensions/stash.js"));
  });

  after(async () => home?.dispose());

  beforeEach(async () => {
    failures = [];
    directory = await mkdtemp(path.join(os.tmpdir(), "tau-stash-"));
    const rejectExternalWork = () => {
      const error = new Error("Unexpected network request or subprocess in stash workflow");
      failures.push(error);
      throw error;
    };
    mock.method(globalThis, "fetch", rejectExternalWork);
    for (const method of [
      "spawn",
      "spawnSync",
      "exec",
      "execSync",
      "execFile",
      "execFileSync",
      "fork",
    ] as const)
      mock.method(childProcess, method, rejectExternalWork);
    syncBuiltinESMExports();
  });

  afterEach(async () => {
    try {
      await ui?.dispose();
      assert.deepEqual(failures, [], "unexpected work or errors must not be swallowed by Pi");
    } finally {
      ui = undefined;
      mock.restoreAll();
      syncBuiltinESMExports();
      if (directory) await rm(directory, { recursive: true, force: true });
      directory = undefined;
    }
  });

  describe("sending an interjection", () => {
    for (const [description, text] of [
      ["multiline draft", draft],
      ["large pasted draft", Array.from({ length: 30 }, (_, i) => `${i + 1}. ${draft}`).join("\n")],
    ]) {
      test(`preserves a ${description} until it is finished and submitted`, async () => {
        const finishedDraft = `${text}\nReady now.`;
        // Pi trims submitted messages, but must preserve whitespace in unsent drafts.
        ui = await openEditor(directory!, stashExtension, failures, [
          "One quick question first.",
          finishedDraft.trim(),
        ]);
        ui.paste(text);
        assert.equal(ui.editor.getExpandedText(), text);

        await ui.shortcut();
        assert.equal(ui.editor.getExpandedText(), "");
        assert.match(ui.status(), /stash.*alt\+x/i);
        ui.paste("One quick question first.");
        await ui.submit();

        assert.equal(ui.editor.getExpandedText(), text, "the complete unsent draft comes back");
        assert.equal(ui.status(), "");
        assert.deepEqual(userTexts(ui.session.messages), ["One quick question first."]);

        ui.editor.handleInput("\x05"); // End of line, including trailing spaces.
        ui.editor.handleInput("\x0a"); // Newline, not submit.
        ui.paste("Ready now.");
        assert.equal(ui.editor.getExpandedText(), finishedDraft);
        await ui.submit();
        assert.equal(ui.editor.getExpandedText(), "", "a consumed stash must not reappear");
        assert.deepEqual(userTexts(ui.session.messages), [
          "One quick question first.",
          finishedDraft.trim(),
        ]);
      });
    }
  });

  test("preserves an occupied editor on manual and automatic restoration, then recovers the stash", async () => {
    ui = await openEditor(directory!, stashExtension, failures, [
      "A question sent from another client.",
    ]);
    ui.paste(draft);
    await ui.shortcut();
    const inProgress = "Drafting an apology to the production database…";
    ui.paste(inProgress);

    await ui.shortcut();
    assert.equal(ui.editor.getExpandedText(), inProgress);
    assert.equal(ui.notifications.at(-1)?.type, "warning");
    assert.match(ui.notifications.at(-1)?.message ?? "", /send or clear/i);
    assert.match(ui.status(), /stash/i);

    // RPC input exercises Pi's prompt lifecycle without submitting the local editor.
    await ui.session.prompt("A question sent from another client.", { source: "rpc" });
    assert.equal(ui.editor.getExpandedText(), inProgress);
    assert.match(ui.status(), /stash/i);
    assert.deepEqual(userTexts(ui.session.messages), ["A question sent from another client."]);

    ui.editor.handleInput("\x15"); // Ctrl+U: clear the current line.
    assert.equal(ui.editor.getExpandedText(), "");
    await ui.shortcut();
    assert.equal(ui.editor.getExpandedText(), draft, "refusal must not discard the stash");
    assert.equal(ui.status(), "");
    assert.equal(ui.notifications.at(-1)?.type, "info");
    assert.match(ui.notifications.at(-1)?.message ?? "", /restored/i);
  });

  describe("reload recovery", () => {
    for (const [description, otherDraft] of [
      ["an empty editor", ""],
      ["another unfinished message", "Emergency agenda\n  The rubber duck wants equity.  "],
    ]) {
      test(`recovers the stash with ${description}, without sending or duplicating text`, async () => {
        ui = await openEditor(directory!, stashExtension, failures);
        ui.paste(draft);
        await ui.shortcut();
        ui.paste(otherDraft);

        await ui.session.reload();
        const recovered = otherDraft ? `${draft}\n\n${otherDraft}` : draft;
        assert.equal(ui.editor.getExpandedText(), recovered);
        assert.equal(ui.status(), "");
        assert.deepEqual(userTexts(ui.session.messages), []);

        await ui.session.reload();
        assert.equal(ui.editor.getExpandedText(), recovered, "recovery is not duplicated");
        await ui.shortcut();
        assert.equal(ui.editor.getExpandedText(), "", "the reloaded shortcut still works");
        await ui.shortcut();
        assert.equal(ui.editor.getExpandedText(), recovered);
        assert.equal(ui.status(), "");
      });
    }
  });
});

/**
 * Connect a real Pi session and Editor through a local UI bridge with scripted model replies.
 * The returned controls exercise registered shortcuts and editor submission, with explicit session cleanup.
 */
async function openEditor(
  directory: string,
  extension: ExtensionFactory,
  failures: unknown[],
  expectedPrompts: string[] = [],
) {
  const cwd = path.join(directory, "work");
  await mkdir(cwd);
  let requests = 0;
  const replies: ExtensionFactory = (pi) => {
    // Only generation is scripted; Pi owns prompt acceptance, context and lifecycle.
    pi.registerProvider(fixtureModel.provider, {
      api: fixtureModel.api,
      baseUrl: fixtureModel.baseUrl,
      apiKey: "fixture-only",
      models: [fixtureModel],
      streamSimple: (_model, context) => {
        try {
          assert.ok(requests < expectedPrompts.length, "unexpected model request");
          assert.deepEqual(userTexts(context.messages), expectedPrompts.slice(0, ++requests));
        } catch (error) {
          failures.push(error);
          throw error;
        }
        const stream = createAssistantMessageEventStream();
        const reply = assistantMessage("Acknowledged.");
        stream.push({ type: "start", partial: reply });
        stream.push({ type: "done", reason: "stop", message: reply });
        stream.end();
        return stream;
      },
    });
  };
  const resources = await createPiResources(cwd, path.join(directory, "agent"), [
    extension,
    replies,
  ]);
  const { session } = await createAgentSession({ ...resources, model: fixtureModel, tools: [] });
  const shutdown = async () => {
    try {
      await session.abort();
      await resources.settingsManager.flush();
    } finally {
      session.dispose();
    }
  };

  try {
    const editor = createEditor();
    const statuses = new Map<string, string>();
    const notifications: { message: string; type: string | undefined }[] = [];
    const uiContext = uiBoundary(
      {
        getEditorText: () => editor.getExpandedText(),
        setEditorText: (text) => editor.setText(text),
        setStatus: (key, text) => {
          if (text === undefined) statuses.delete(key);
          else statuses.set(key, text);
        },
        notify: (message, type) => {
          notifications.push({ message, type });
        },
      },
      failures,
    );
    await session.bindExtensions({
      uiContext,
      mode: "tui",
      onError: (error) => failures.push(error),
    });

    return {
      editor,
      session,
      notifications,
      status: () => [...statuses.values()].join("\n"),
      paste: (text: string) => editor.handleInput(`\x1b[200~${text}\x1b[201~`),
      async shortcut() {
        const runner = session.extensionRunner;
        const shortcut = runner.getShortcuts({}).get("alt+x");
        assert.ok(shortcut, "the documented stash shortcut is available");
        await shortcut.handler(runner.createContext());
      },
      async submit() {
        let submitted: Promise<void> | undefined;
        editor.onSubmit = (text) => {
          submitted = session.prompt(text, { source: "interactive" });
        };
        editor.handleInput("\r");
        assert.ok(submitted, "Enter submits the real editor");
        await submitted;
        assert.equal(session.getLastAssistantText(), "Acknowledged.");
      },
      async dispose() {
        await shutdown();
        assert.equal(requests, expectedPrompts.length);
      },
    };
  } catch (error) {
    await shutdown();
    throw error;
  }
}

/** Build a real Editor for input handling without starting or writing to a physical terminal. */
function createEditor() {
  const terminal = new Proxy({ columns: 80, rows: 24 } as Terminal, {
    get(target, key) {
      if (key in target) return Reflect.get(target, key);
      throw new Error(`Unexpected terminal operation: ${String(key)}`);
    },
  });
  const plain = (text: string) => text;
  return new Editor(new TuiMainScreen(terminal), {
    borderColor: plain,
    selectList: {
      selectedPrefix: plain,
      selectedText: plain,
      description: plain,
      scrollInfo: plain,
      noMatch: plain,
    },
  });
}

/** Extract user messages as text, accepting string or multipart text content but rejecting attachments. */
function userTexts(messages: readonly AgentMessage[]): string[] {
  return messages
    .filter((message) => message.role === "user")
    .map((message) => {
      if (typeof message.content === "string") return message.content;
      assert.ok(Array.isArray(message.content));
      return message.content
        .map((block) => {
          assert.equal(block.type, "text");
          return block.text;
        })
        .join("");
    });
}
