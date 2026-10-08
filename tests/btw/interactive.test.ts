import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import { getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import btw from "../../extensions/btw.js";
import { deadline } from "../helpers/async.js";
import {
  captureTerminal,
  observeInteractive,
  openInteractive,
  rejectInteractiveExternalWork,
} from "../helpers/interactive.js";
import { assistantMessage, createPiResources, fixtureModel } from "../helpers/pi.js";
import { scriptedProvider, type Generation } from "../helpers/provider.js";

const request = Array.from(
  { length: 24 },
  (_, i) =>
    `OPTION_${String(i + 1).padStart(2, "0")}: Compare the reef rollout and rollback risks.`,
).join("\n");
const answer = Array.from(
  { length: 40 },
  (_, i) => `RESULT_${String(i + 1).padStart(2, "0")}: Rehearse this rollback checkpoint.`,
).join("\n\n");

describe("btw native reader", { concurrency: false }, () => {
  let directory: string;
  let failures: unknown[];
  let app: Awaited<ReturnType<typeof openInteractive>> | undefined;

  beforeEach(async () => {
    failures = [];
    rejectInteractiveExternalWork(failures);
    directory = await mkdtemp(path.join(os.tmpdir(), "tau-btw-reader-"));
  });

  afterEach(async () => {
    try {
      await app?.dispose();
      assert.deepEqual(failures, []);
    } finally {
      app = undefined;
      mock.restoreAll();
      syncBuiltinESMExports();
      await rm(directory, { recursive: true, force: true });
    }
  });

  for (const mode of ["default", "regular"] as const) {
    test(`${mode}: reads the complete request and answer, resizes and restores the draft`, async () => {
      const terminal = captureTerminal(80, 24);
      const observer = observeInteractive();
      const calls: Generation[] = [];
      const history = SessionManager.create(directory, path.join(directory, "sessions"));
      history.appendModelChange(fixtureModel.provider, fixtureModel.id);
      history.appendMessage({ role: "user", content: "Keep the reef online.", timestamp: 0 });
      history.appendMessage(assistantMessage("Older reef notes.\n\n".repeat(80)));
      const resources = await createPiResources(directory, getAgentDir(), [
        btw,
        observer.extension,
        scriptedProvider(fixtureModel, (call) => {
          calls.push(call);
          return assistantMessage(answer);
        }),
      ]);
      app = await openInteractive({ ...resources, sessionManager: history }, failures, mode);
      const { ctx, tui } = observer.get();
      assert.equal(tui.mode, mode === "default" ? "fullscreen" : "regular");
      terminal.send("ink");
      const before = await readFile(history.getSessionFile()!);
      const messages = structuredClone(app.session.messages);
      const command = app.session.prompt(`/btw ${request}`, { source: "interactive" });
      try {
        await terminal.waitForText("OPTION_01");
        const repaint = () => terminal.repaint(tui);
        const initial = repaint();
        for (const corner of ["╭", "╮", "╰", "╯"]) assert.ok(initial.includes(corner));
        assert.match(initial, /Enter\/Esc close/);
        assert.match(
          initial,
          /↑↓\/j\/k scroll · pageUp\/pageDown page · ctrl\+home\/ctrl\+end ends/,
        );
        assert.doesNotMatch(initial, /RESULT_40/);
        const seen = [initial];
        // Enumerate the finite document in pages, not a readiness/retry loop.
        for (let i = 0; i < 9; i++) {
          terminal.send("\x1b[6~");
          seen.push(repaint());
        }
        for (const [prefix, count] of [
          ["OPTION", 24],
          ["RESULT", 40],
        ] as const) {
          for (let i = 1; i <= count; i++) {
            assert.ok(
              seen.some((frame) => frame.includes(`${prefix}_${String(i).padStart(2, "0")}`)),
            );
          }
        }
        assert.match(seen.at(-1)!, /RESULT_40/);
        terminal.send("\x1b[5~");
        assert.doesNotMatch(repaint(), /RESULT_40/);
        terminal.send("\x1b[1;5F");
        assert.match(repaint(), /RESULT_40/);
        terminal.send("\x1b[1;5H");
        assert.match(repaint(), /OPTION_01/);
        const top = readingPosition(repaint());
        for (const key of ["j", "\x1b[B"]) terminal.send(key);
        assert.equal(readingPosition(repaint()), top + 2);
        for (const key of ["k", "\x1b[A"]) terminal.send(key);
        assert.equal(readingPosition(repaint()), top);

        terminal.resize(120, 30);
        let frame = repaint();
        for (const corner of ["╭", "╮", "╰", "╯"]) assert.ok(frame.includes(corner));
        terminal.send("\x1b[1;5F");
        assert.match(repaint(), /RESULT_40/);
        terminal.resize(120, 12); // Height-only shrink cannot reuse an oversized frame.
        repaint();
        terminal.send("\x1b[1;5F");
        frame = repaint();
        assert.match(frame, /RESULT_40/);
        assert.match(frame, /Enter\/Esc close/);
        assert.match(frame, /╰.*╯/);
        terminal.resize(120, 8);
        assert.match(repaint(), /Esc close.*Resize/);
        terminal.send("\x1b[1;5H"); // Tiny mode ignores Ctrl+Home and keeps the reading position.
        terminal.resize(120, 30);
        assert.match(repaint(), /RESULT_40/);
        terminal.send("\x1b[1;5H");
        assert.match(repaint(), /OPTION_01/);
        terminal.resize(30, 8);
        assert.match(repaint(), /Esc close.*Resize/);
      } finally {
        terminal.writes.length = 0;
        terminal.send("q");
        await deadline(command, "BTW command completion");
        terminal.resize(80, 24);
        await terminal.waitForText("ink");
      }
      assert.equal(ctx.ui.getEditorText(), "ink");
      assert.deepEqual(await readFile(history.getSessionFile()!), before);
      assert.deepEqual(app.session.messages, messages);
      assert.equal(app.session.pendingMessageCount, 0);
      assert.equal(calls.length, 1);
      terminal.send("!");
      assert.equal(ctx.ui.getEditorText(), "ink!", "close restores native editor focus");
    });
  }
});

function readingPosition(frame: string) {
  const match = frame.match(/Enter\/Esc close · (\d+)-\d+\/\d+/);
  assert.ok(match, "physical reader controls are visible");
  return Number(match[1]);
}
