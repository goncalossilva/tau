import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
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

const now = new Date("2026-06-15T12:00:00Z");
const quotaUrl = "https://api.anthropic.com/api/oauth/usage";
const lastRow = /reef-small\s+100\s+\$1\.00\s+33%/;

describe("usage InteractiveMode", { concurrency: false }, () => {
  let home: Awaited<ReturnType<typeof isolatePiHome>>;
  let usage: ExtensionFactory;
  let app: Awaited<ReturnType<typeof openInteractive>> | undefined;
  let failures: unknown[];
  let quota: Promise<Response>;
  let publishQuota: (response: Response) => void;

  before(async () => {
    home = await isolatePiHome();
    usage = (await import("../../extensions/usage/index.js")).default;
  });

  after(async () => home.dispose());

  beforeEach(() => {
    failures = [];
    rejectInteractiveExternalWork(failures);
    mock.timers.enable({ apis: ["Date"], now });
    quota = new Promise<Response>((resolve) => {
      publishQuota = resolve;
    });
    mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      try {
        assert.equal(request.url, quotaUrl);
        assert.equal(request.method, "GET");
        assert.equal(request.headers.get("authorization"), "Bearer fixture-anthropic");
      } catch (error) {
        failures.push(error);
        throw error;
      }
      return quota;
    });
  });

  afterEach(async () => {
    try {
      await app?.dispose();
      assert.deepEqual(failures, [], "unexpected external work and extension errors");
    } finally {
      app = undefined;
      mock.restoreAll();
      mock.timers.reset();
      syncBuiltinESMExports();
      await rm(path.join(getAgentDir(), "sessions"), { recursive: true, force: true });
      await rm(path.join(getAgentDir(), "auth.json"), { force: true });
      await rm(path.join(getAgentDir(), "keybindings.json"), { force: true });
    }
  });

  for (const mode of ["regular", "default"] as const) {
    test(`${mode}: bounded quota/history overlay preserves a tall transcript and draft`, async () => {
      const terminal = captureTerminal(80, 24);
      const observer = observeInteractive();
      const resources = await usageResources(usage, observer.extension, failures);
      if (mode === "default") {
        await writeFile(
          path.join(getAgentDir(), "keybindings.json"),
          JSON.stringify({
            "tui.altScreen.pageDown": "ctrl+d",
            "tui.altScreen.lineDown": "j",
          }),
        );
      }
      app = await openInteractive(resources, failures, mode);
      const { ctx, tui } = observer.get();
      assert.equal(tui.mode, mode === "default" ? "fullscreen" : "regular");
      const draft = "ink\nkeep my 🦑 draft exactly  ";
      ctx.ui.setEditorText(draft);
      const history = structuredClone(resources.sessionManager.getEntries());
      const messages = structuredClone(app.session.messages);
      const command = app.session.prompt("/usage", { source: "interactive" });
      const repaint = () => terminal.repaint(tui);
      try {
        await terminal.waitForText("Usage  [all]");
        terminal.send("]");
        await terminal.waitForText("Usage loading");
        terminal.send("\x1b[1;5F");
        const beforeQuota = repaint();
        assert.match(beforeQuota, lastRow);
        const offset = /q close · (\d+)–/.exec(beforeQuota)?.[1];
        assert.ok(offset && Number(offset) > 1, "scroll before live publication");
        publishQuota(quotaResponse());
        await terminal.waitForText("Extra usage:");
        assert.equal(
          /q close · (\d+)–/.exec(repaint())?.[1],
          offset,
          "live publication preserves the offset, not the old bottom",
        );
        terminal.send("\x1b[1;5H");
        const initial = repaint();
        assert.match(initial, /Session \(5h\): 11% used/);
        assert.match(initial, /q close/);
        assert.doesNotMatch(
          initial,
          lastRow,
          "both modes now show a bounded viewport, not full emission",
        );
        if (mode === "default") {
          assert.match(initial, /pageUp\/ctrl\+d scroll/, "reading hints reflect configured keys");
          terminal.send("\x1b[6~");
          assert.doesNotMatch(repaint(), lastRow, "replaced PageDown binding no longer scrolls");
          terminal.send("j");
          assert.match(
            repaint(),
            /q close · 2–/,
            "configured line scrolling precedes the view alias",
          );
          assert.match(repaint(), /\[model\]/);
        }
        terminal.send(mode === "default" ? "\x04" : "\x1b[6~");
        assert.match(
          repaint(),
          lastRow,
          "configured page action reads Usage rather than the parent transcript",
        );
        terminal.send("\x1b[1;5H");
        assert.match(repaint(), /Session \(5h\): 11% used/);
        terminal.send("\x1b[1;5F");
        assert.match(repaint(), lastRow);
        terminal.send("\x1b[5~");
        assert.match(repaint(), /Session \(5h\): 11% used/);
        terminal.send("\x1b[1;5F");
        for (const [columns, rows] of [
          [120, 30],
          [120, 16],
          [120, 30],
          [48, 18],
        ]) {
          terminal.resize(columns!, rows!);
          const resized = repaint();
          assert.match(resized, /q close/);
          terminal.send("\x1b[1;5F");
          assert.match(
            repaint(),
            lastRow,
            `last table row reachable after ${columns}×${rows} resize`,
          );
          terminal.send("\x1b[1;5H");
          assert.match(repaint(), /Session \(5h\): 11% used/);
        }
        terminal.resize(80, 24);
        repaint();
        terminal.send("\x1b[1;5F");
        assert.match(repaint(), lastRow);
        terminal.resize(26, 6); // Four chrome rows leave no document row.
        assert.match(repaint(), /q close · resize/);
        terminal.send("\x1b[1;5H"); // Hidden Ctrl+Home and view controls cannot move the document.
        terminal.send("j");
        terminal.resize(25, 7); // One column below the supported document width.
        assert.match(repaint(), /q close · resize/);
        terminal.resize(80, 24);
        assert.match(repaint(), lastRow, "tiny-size fallback preserves the reading position");
        if (mode === "default") {
          terminal.send("\x1b[102;6u"); // Native Ctrl+Shift+F transcript search.
          assert.match(repaint(), /Find in transcript/);
          terminal.send("peaceful");
          assert.match(repaint(), /\d+\/80/, "native search owns the parent transcript, not Usage");
          terminal.send("\x1b");
          assert.match(
            repaint(),
            lastRow,
            "closing native search restores Usage, not its parent editor",
          );
          terminal.send("\x1b[1;5H");
          assert.match(repaint(), /Session \(5h\): 11% used/);
          terminal.send("\x1b[1;5F");
        }
        terminal.send("\x1b[B");
        assert.match(repaint(), /\[cwd\]/);
        assert.match(
          repaint(),
          /Session \(5h\): 11% used/,
          "view navigation resets reading position",
        );
        terminal.send("\x1b[A");
        assert.match(repaint(), /\[model\]/);
        terminal.send("\t");
        assert.match(repaint(), /\[sess\]/);
        terminal.send("\x1b[C");
        assert.match(repaint(), /\[90d\]/);
        terminal.resize(26, 6);
        assert.match(repaint(), /q close · resize/);
      } finally {
        publishQuota(quotaResponse());
        terminal.send("q");
        await deadline(command, "Usage command completion");
      }
      assert.equal(ctx.ui.getEditorText(), draft);
      assert.deepEqual(resources.sessionManager.getEntries(), history);
      assert.deepEqual(app.session.messages, messages);
      assert.equal(app.session.pendingMessageCount, 0);
      terminal.resize(80, 24);
      assert.match(repaint(), /keep my 🦑 draft exactly/);
      terminal.send("!");
      assert.equal(ctx.ui.getEditorText(), `${draft}!`, "closing restores native editor focus");
    });
  }
});

function quotaResponse() {
  return Response.json({
    five_hour: { utilization: 11 },
    seven_day: { utilization: 22 },
    seven_day_sonnet: { utilization: 33 },
    extra_usage: {
      is_enabled: true,
      utilization: 44,
      monthly_limit: 10000,
      used_credits: 4400,
      currency: "USD",
    },
  });
}

/** Real on-disk usage records, with an unrelated tall parent transcript kept strictly in memory. */
async function usageResources(
  usage: ExtensionFactory,
  observer: ExtensionFactory,
  failures: unknown[],
) {
  const cwd = path.join(getAgentDir(), "reef");
  await mkdir(cwd, { recursive: true });
  const history = SessionManager.create(cwd, path.join(getAgentDir(), "sessions", "reef"));
  history.appendMessage({ role: "user", content: "Count reef tokens.", timestamp: now.getTime() });
  for (const [model, tokens, cost] of [
    ["reef-big", 200, 2],
    ["reef-small", 100, 1],
  ] as const) {
    const message = assistantMessage("Counted.");
    message.provider = "anthropic";
    message.model = model;
    message.timestamp = now.getTime();
    message.usage.input = message.usage.totalTokens = tokens;
    message.usage.cost.total = cost;
    history.appendMessage(message);
  }
  await writeFile(
    path.join(getAgentDir(), "auth.json"),
    JSON.stringify({
      anthropic: {
        type: "oauth",
        access: "fixture-anthropic",
        refresh: "never-refresh",
        expires: now.getTime() + 86_400_000,
      },
    }),
  );
  const resources = await createPiResources(cwd, getAgentDir(), [
    usage,
    observer,
    scriptedProvider(fixtureModel, () => {
      const error = new Error("Unexpected model generation");
      failures.push(error);
      throw error;
    }),
  ]);
  resources.sessionManager.appendMessage({
    role: "user",
    content: "Keep the squid's log.",
    timestamp: now.getTime(),
  });
  resources.sessionManager.appendMessage(
    assistantMessage(
      Array.from({ length: 80 }, (_, index) => `Log ${index}: another peaceful reef day.`).join(
        "\n\n",
      ),
    ),
  );
  await resources.modelRuntime.setRuntimeApiKey("anthropic", "fixture-anthropic");
  return resources;
}
