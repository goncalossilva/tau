import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, mock, test } from "node:test";
import {
  getAgentDir,
  SessionManager,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { deadline } from "../helpers/async.js";
import {
  captureTerminal,
  observeInteractive,
  openInteractive,
  rejectInteractiveExternalWork,
} from "../helpers/interactive.js";
import { assistantMessage, createPiResources, fixtureModel, isolatePiHome } from "../helpers/pi.js";
import { scriptedProvider } from "../helpers/provider.js";

const question = Array.from({ length: 8 }, (_, i) => `QUESTION_${i + 1}: Which reef lane?`).join(
  "\n",
);
const context = Array.from(
  { length: 26 },
  (_, i) => `CONTEXT_${i + 1}: Keep the café online.`,
).join("\n");
const answerLines = Array.from({ length: 18 }, (_, i) => `  ANSWER_${i + 1}: café 🐙  `);
const keys = {
  pageUp: "\x1b[5~",
  pageDown: "\x1b[6~",
  answerUp: "\x1b[5;5~",
  answerDown: "\x1b[6;5~",
};

describe("answer InteractiveMode", { concurrency: false }, () => {
  let home: Awaited<ReturnType<typeof isolatePiHome>>;
  let answer: ExtensionFactory;
  let app: Awaited<ReturnType<typeof openInteractive>> | undefined;
  let failures: unknown[];

  before(async () => {
    home = await isolatePiHome();
    answer = (await import("../../extensions/answer.js")).default;
  });

  after(async () => home.dispose());

  beforeEach(() => {
    failures = [];
    rejectInteractiveExternalWork(failures);
  });

  afterEach(async () => {
    try {
      await app?.dispose();
      assert.deepEqual(failures, [], "unexpected external work and extension errors");
    } finally {
      app = undefined;
      mock.restoreAll();
      syncBuiltinESMExports();
      await rm(path.join(getAgentDir(), "sessions"), { recursive: true, force: true });
    }
  });

  for (const mode of ["default", "regular"] as const) {
    test(`${mode}: reads long questions separately from native answers and preserves cancellation`, async () => {
      const terminal = captureTerminal(80, 24);
      const observer = observeInteractive();
      const cwd = path.join(getAgentDir(), "reef");
      await mkdir(cwd, { recursive: true });
      const history = SessionManager.create(cwd, path.join(getAgentDir(), "sessions"));
      history.appendModelChange(fixtureModel.provider, fixtureModel.id);
      history.appendMessage({ role: "user", content: "Plan the reef migration.", timestamp: 0 });
      history.appendMessage(assistantMessage("Which migration lane? Who approves the release?"));
      let requests = 0;
      const resources = await createPiResources(cwd, getAgentDir(), [
        answer,
        observer.extension,
        scriptedProvider(fixtureModel, () => {
          try {
            assert.equal(++requests, 1, "only extraction, never a cancelled answering turn");
            return assistantMessage(
              JSON.stringify({
                questions: [
                  { question, context },
                  { question: `FINAL_QUESTION: Approve release?\n${question}`, context },
                ],
              }),
            );
          } catch (error) {
            failures.push(error);
            throw error;
          }
        }),
      ]);
      resources.sessionManager = history;
      app = await openInteractive(resources, failures, mode);
      const { ctx, tui } = observer.get();
      assert.equal(tui.mode, mode === "default" ? "fullscreen" : "regular");
      const draft = "ink\nkeep my 🦑 draft exactly  ";
      ctx.ui.setEditorText(draft);
      const before = await readFile(history.getSessionFile()!);
      const messages = structuredClone(app.session.messages);
      const repaint = () => terminal.repaint(tui);
      const press = (key: string) => {
        terminal.send(key);
        return repaint();
      };
      const command = app.session.prompt("/answer", { source: "interactive" });
      try {
        await terminal.waitForText("Questions");
        const initial = repaint();
        assert.match(initial, /QUESTION_1:/);
        assert.match(initial, /Read question: pageUp\/pageDown/);
        assert.match(initial, /Esc cancel/);
        assertFrame(initial);
        assert.doesNotMatch(initial, /CONTEXT_26:/, "both modes use a bounded reading region");
        const readingFrames = [initial];
        // Exhaust the known 37-row reading document by pages, not timing retries.
        for (let page = 0; page < 8; page++) readingFrames.push(press(keys.pageDown));
        assert.match(readingFrames.at(-1)!, /CONTEXT_26:/);
        for (const line of [...question.split("\n"), ...context.split("\n")]) {
          assert.ok(
            readingFrames.some((frame) => frame.includes(line)),
            `${line} is physically reachable`,
          );
        }
        for (let page = 0; page < 8; page++) press(keys.pageUp);
        assert.match(repaint(), /QUESTION_1:/);
        assert.match(press("\x1b[B"), /FINAL_QUESTION/, "empty-editor Down still changes question");
        assert.match(press("\x1b[A"), /QUESTION_1:/);
        terminal.send(`\x1b[200~${answerLines.join("\n")}\x1b[201~`);
        press("\t");
        const expanded = press("\x1b[Z");
        assert.match(expanded, /ANSWER_18:/);
        assert.doesNotMatch(expanded, /paste #/, "navigation restores expanded paste bytes");
        assert.match(expanded, /QUESTION_1:/, "question navigation resets reading position");
        terminal.resize(42, 8);
        // The native editor also grows when rows increase. Its current measured height
        // cannot promise an exact resize target for an expanded multi-page answer.
        assert.match(repaint(), /more rows/);
        terminal.resize(80, 24);
        assert.match(repaint(), /ANSWER_18:/);
        const paged = press(keys.pageDown);
        assert.doesNotMatch(paged, /QUESTION_1:/);
        assert.match(paged, /ANSWER_18:/, "plain paging does not move the answer cursor");
        const readingMarkers = (frame: string) => frame.match(/(?:QUESTION|CONTEXT)_\d+:/g);
        const answerFrames = [paged];
        for (let page = 0; page < 3; page++) {
          const frame = press(keys.answerUp);
          assert.deepEqual(readingMarkers(frame), readingMarkers(paged));
          answerFrames.push(frame);
        }
        assert.match(answerFrames.at(-1)!, /ANSWER_1:/);
        for (let page = 0; page < 3; page++) answerFrames.push(press(keys.answerDown));
        assert.match(answerFrames.at(-1)!, /ANSWER_18:/);
        for (const line of answerLines) {
          assert.ok(
            answerFrames.some((frame) => frame.includes(line)),
            `expanded bytes reachable: ${JSON.stringify(line)}`,
          );
        }
        for (const key of ["\x1b[H", "\x1b[F", "\x1b[A", "\x1b[B"]) {
          assert.deepEqual(
            readingMarkers(press(key)),
            readingMarkers(paged),
            "ordinary editor navigation leaves the question viewport alone",
          );
        }
        // Width and height-only resizing remeasure the native editor without cropping it.
        for (const [columns, rows] of [
          [120, 30],
          [120, 20],
          [120, 30],
          [42, 30],
          [80, 24],
        ]) {
          terminal.resize(columns!, rows!);
          const resized = repaint();
          assertFrame(resized);
          assert.match(resized, /ANSWER_18:/);
          assert.match(resized, /Esc[\s\S]*cancel/);
        }
        press("\x1b[13;2u"); // Native Shift+Enter adds a newline, not question navigation.
        terminal.send("KEPT_NEWLINE");
        press("\t");
        assert.match(press("\x1b[Z"), /KEPT_NEWLINE/);
        assert.match(press("\r"), /FINAL_QUESTION/);
        const confirmation = press("\r");
        assert.match(confirmation, /Submit all answers\?/);
        assert.match(confirmation, /Esc\/n back/);
        assertFrame(confirmation);
        for (const [columns, rows] of [
          [120, 30],
          [120, 14],
          [42, 24],
          [80, 24],
        ]) {
          terminal.resize(columns!, rows!);
          const resized = repaint();
          assertFrame(resized);
          assert.match(resized, /Submit all answers\?/);
          assert.match(resized, /Esc\/n back/);
        }
        // Hidden editing and confirmation cannot accept input while either dimension is unusable.
        for (const [columns, rows] of [
          [41, 24],
          [80, 8],
        ]) {
          terminal.resize(columns!, rows!);
          assert.match(repaint(), /Resize to 42\+ columns/);
          terminal.send("INVISIBLE");
          terminal.send("y");
          terminal.send("\r");
          terminal.send("n");
          terminal.resize(80, 24);
          assert.match(repaint(), /Submit all answers\?/);
          assert.equal(requests, 1);
        }
        assert.doesNotMatch(press("n"), /Submit all answers\?/);
        assert.match(press("\x1b[Z"), /KEPT_NEWLINE/);
        assert.doesNotMatch(repaint(), /INVISIBLE/);
        terminal.resize(80, 8);
        assert.match(repaint(), /Resize/);
      } finally {
        terminal.send("\x1b");
        terminal.send("\x1b"); // Also closes safely if an assertion failed during confirmation.
        await deadline(command, "Answer command completion");
      }
      assert.equal(ctx.ui.getEditorText(), draft);
      assert.deepEqual(await readFile(history.getSessionFile()!), before);
      assert.deepEqual(app.session.messages, messages);
      assert.equal(app.session.pendingMessageCount, 0);
      assert.equal(requests, 1);
      terminal.resize(80, 24);
      assert.match(repaint(), /keep my 🦑 draft exactly/);
      terminal.send("!");
      assert.equal(ctx.ui.getEditorText(), `${draft}!`, "closing restores native editor focus");
    });
  }
});

/** Physical repaint bytes must include both complete horizontal borders, not only source render rows. */
function assertFrame(frame: string) {
  assert.match(frame, /╭─+╮/);
  assert.match(frame, /╰─+╯/);
}
