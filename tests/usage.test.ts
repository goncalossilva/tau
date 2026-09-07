import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, mock, test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import {
  BorderedLoader,
  createAgentSession,
  getAgentDir,
  initTheme,
  ModelRuntime,
  SessionManager,
  type ExtensionFactory,
  type ExtensionUIContext,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  getKeybindings,
  TuiMainScreen,
  visibleWidth,
  type Component,
  type Terminal,
} from "@earendil-works/pi-tui";
import {
  assistantMessage,
  createPiResources,
  fixtureModel,
  isolatePiHome,
  uiBoundary,
} from "./helpers/pi.js";

const now = new Date("2026-06-15T12:00:00Z");
const codexUrl = "https://chatgpt.com/backend-api/wham/usage";
const creditsUrl = "https://openrouter.ai/api/v1/credits";
const keyUrl = "https://openrouter.ai/api/v1/key";

describe("usage", { concurrency: false }, () => {
  let home: Awaited<ReturnType<typeof isolatePiHome>>;
  let usage: ExtensionFactory;
  let directory: string;
  let app: Awaited<ReturnType<typeof openUsage>> | undefined;
  let failures: unknown[];
  let requests: Request[];
  let externalWork: Set<Promise<Response>>;
  let respond: (request: Request) => Promise<Response>;

  before(async () => {
    home = await isolatePiHome();
    usage = (await import("../extensions/usage/index.js")).default;
  });

  after(async () => home.dispose());

  beforeEach(async () => {
    failures = [];
    requests = [];
    externalWork = new Set();
    const rejectExternalWork = (...args: unknown[]): never => {
      failures.push(args);
      throw new Error("Unexpected external work in usage workflow");
    };
    respond = async (request) => rejectExternalWork(request.url);
    mock.method(globalThis, "fetch", (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      const work = respond(request).catch((error) => {
        if (error instanceof assert.AssertionError) failures.push(error);
        throw error;
      });
      externalWork.add(work);
      return work.finally(() => externalWork.delete(work));
    });
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
    mock.timers.enable({ apis: ["Date"], now });
    directory = await mkdtemp(path.join(os.tmpdir(), "tau-usage-"));
    await mkdir(getAgentDir(), { recursive: true });
  });

  afterEach(async () => {
    try {
      await app?.dispose();
      await Promise.allSettled(externalWork);
      assert.deepEqual(failures, [], "unexpected work and extension errors must not be swallowed");
    } finally {
      app = undefined;
      mock.restoreAll();
      mock.timers.reset();
      syncBuiltinESMExports();
      await rm(path.join(getAgentDir(), "sessions"), { recursive: true, force: true });
      await rm(path.join(getAgentDir(), "auth.json"), { force: true });
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("counts activity by date across a native fork without billing inherited work twice", async () => {
    const files = await forkedHistory(directory);
    const before = await Promise.all(files.map((file) => readFile(file)));
    app = await openUsage(usage, directory, failures, [], async (view) => {
      assert.match(view.text(), /Last 30 days: 1 sessions started · 720 tokens · \$7\.20/);
      assert.match(view.text(), /Tools\/summaries\s+150\s+\$1\.50/);
      assert.match(view.text(), /otter\/actual-model\s+300\s+\$3\.00/);
      view.press("1");
      assert.match(view.text(), /Last 7 days: 1 sessions started · 520 tokens · \$5\.20/);
      view.press("3");
      assert.match(view.text(), /Last 90 days: 2 sessions started · 820 tokens · \$8\.20/);
      view.press("2");
      view.press("\x1b[Z"); // Shift+Tab: tokens -> messages.
      assert.match(view.text(), /Last 30 days: 1 sessions started · 4 messages · \$7\.20/);
      view.press("\t");
      view.press("]");
      assert.match(view.text(), /History only · no live quota integration/);
      assert.match(view.text(), /Last 30 days: 1 sessions started · 570 tokens · \$5\.70/);
      assert.doesNotMatch(view.text(), /Tools\/summaries/);
      view.press("j"); // Attribute inherited activity to the parent project, not the fork.
      assert.match(view.text(), /pond\s+500\s+\$5\.00/);
      assert.match(view.text(), /burrow\s+70\s+\$0\.700/);
      for (const width of [36, 80, 140]) {
        for (const line of view.component.render(width)) assert.ok(visibleWidth(line) <= width);
      }
    });
    await app.run();
    assert.equal(
      app.session.messages.length,
      0,
      "interactive inspection does not enter conversation history",
    );
    await app.session.bindExtensions({
      mode: "print",
      uiContext: uiBoundary({}, failures),
      onError: (error) => failures.push(error),
    });
    const previous = structuredClone(app.session.sessionManager.getEntries());
    await app.run();
    const entries = app.session.sessionManager.getEntries();
    assert.deepEqual(entries.slice(0, previous.length), previous);
    assert.equal(entries.length, previous.length + 1);
    const summary = entries.at(-1)!;
    assert.equal(summary.type, "custom_message");
    if (summary.type !== "custom_message") throw new Error("Missing usage summary");
    assert.equal(summary.customType, "usage");
    assert.equal(summary.display, true);
    assert.equal(typeof summary.content, "string");
    assert.match(
      summary.content as string,
      /All providers · Last 30 days: 1 sessions started · 720 tokens · \$7\.20/,
    );
    assert.match(
      summary.content as string,
      /Last 30 days: 1 sessions started · 570 tokens · \$5\.70/,
    );
    assert.equal(app.session.pendingMessageCount, 0);
    assert.equal(requests.length, 0);
    assert.deepEqual(await Promise.all(files.map((file) => readFile(file))), before);
  });

  test("loads quota only on selection, normalizes reversed Codex windows, and reuses the snapshot", async () => {
    const response = deferred<Response>();
    respond = async (request) => {
      assert.equal(request.url, codexUrl);
      assert.equal(request.method, "GET");
      assert.equal(request.headers.get("authorization"), "Bearer fixture-openai-codex");
      assert.equal(request.headers.get("chatgpt-account-id"), "otter-account");
      return response.promise;
    };
    app = await openUsage(
      usage,
      directory,
      failures,
      ["openai-codex", "openrouter"],
      async (view) => {
        try {
          assert.equal(
            requests.length,
            0,
            "opening all-provider history must not contact quota services",
          );
          view.press("]");
          assert.match(view.text(), /Usage loading/);
          response.resolve(
            Response.json({
              plan_type: "team_plan",
              rate_limit: {
                primary_window: {
                  used_percent: "81",
                  limit_window_seconds: 604800,
                  reset_at: now.getTime() / 1000 + 86400,
                },
                secondary_window: {
                  used_percent: 23,
                  limit_window_seconds: 18000,
                  reset_at: now.getTime() / 1000 + 3600,
                },
              },
              credits: { balance: "12.50", has_credits: true },
            }),
          );
          await view.until(/Session \(5h\): 23% used/);
          assert.match(view.text(), /Week \(7d\): 81% used/);
          assert.match(view.text(), /resets in ~1h/);
          assert.match(view.text(), /resets in ~24h/);
          assert.match(view.text(), /Credits: \$12\.50/);
          assert.match(view.text(), /Usage · Team Plan/);
          view.press("[");
          view.press("]");
          assert.match(view.text(), /Session \(5h\): 23% used/);
          assert.equal(
            requests.length,
            1,
            "revisiting a loaded tab reuses its snapshot; unvisited OpenRouter stays offline",
          );
        } finally {
          response.resolve(Response.json({}));
        }
      },
    );
    await app.run();
    assert.equal(app.session.pendingMessageCount, 0);
    assert.deepEqual(app.session.messages, []);
  });

  describe("OpenRouter service degradation", () => {
    for (const { name, credits, keyStatus, expected, absent } of [
      {
        name: "retains account credits when the optional key endpoint is unsupported",
        credits: { data: { total_credits: "20", total_usage: "5" } },
        keyStatus: 404,
        expected: /Credits: 25% used · \$15\.00 \/ \$20\.00 remaining/,
        absent: /Usage unavailable/,
      },
      {
        name: "reports a key service outage instead of silently dropping its limits",
        credits: { data: { total_credits: 20, total_usage: 5 } },
        keyStatus: 503,
        expected: /Usage unavailable.*503/,
        absent: /Credits: 25% used/,
      },
      {
        name: "preserves a legitimate zero account balance",
        credits: { data: { total_credits: 0, total_usage: "0" } },
        keyStatus: 404,
        expected: /Balance: \$0\.0000/,
        absent: /Usage unavailable/,
      },
      {
        name: "preserves depleted credits rather than rejecting a zero remainder",
        credits: { data: { total_credits: "20", total_usage: 20 } },
        keyStatus: 404,
        expected: /Credits: 100% used · \$0\.0000 \/ \$20\.00 remaining/,
        absent: /Usage unavailable/,
      },
      {
        name: "rejects a malformed credits response instead of inventing a zero balance",
        credits: { data: { total_credits: "many clams", total_usage: 5 } },
        keyStatus: 404,
        expected: /Usage unavailable/,
        absent: /Balance: \$0/,
      },
    ]) {
      test(name, async () => {
        respond = async (request) => {
          assert.equal(request.method, "GET");
          assert.equal(request.headers.get("authorization"), "Bearer fixture-openrouter");
          if (request.url === creditsUrl) return Response.json(credits);
          assert.equal(request.url, keyUrl);
          return new Response("fixture service unavailable", { status: keyStatus });
        };
        app = await openUsage(usage, directory, failures, ["openrouter"], async (view) => {
          view.press("]");
          await view.until(/Usage unavailable|Credits:|Balance:/);
          assert.match(view.text(), expected);
          assert.doesNotMatch(view.text(), absent);
        });
        await app.run();
        assert.deepEqual(
          requests.map((request) => request.url).sort(),
          [creditsUrl, keyUrl].sort(),
        );
      });
    }

    for (const field of ["total_credits", "total_usage"] as const) {
      test(`rejects missing or invalid ${field} without presenting account credit`, async () => {
        for (const value of [undefined, null, "", "Infinity", -1]) {
          respond = async (request) => {
            assert.equal(request.headers.get("authorization"), "Bearer fixture-openrouter");
            if (request.url === creditsUrl)
              return Response.json({ data: { total_credits: 20, total_usage: 5, [field]: value } });
            assert.equal(request.url, keyUrl);
            return new Response(null, { status: 404 });
          };
          app = await openUsage(usage, directory, failures, ["openrouter"], async (view) => {
            view.press("]");
            await view.until(/Usage unavailable|Credits:|Balance:/);
            assert.match(view.text(), /Usage unavailable.*invalid credit totals/);
            assert.doesNotMatch(view.text(), /Credits:|Balance:/);
          });
          try {
            await app.run();
          } finally {
            await app.dispose();
            app = undefined;
          }
        }
        assert.equal(requests.length, 10, "each inspection loads only its two quota endpoints");
      });
    }
  });
});

/** Create and fork real Pi history at controlled dates; inherited tool/summary costs must count once. */
async function forkedHistory(directory: string) {
  mock.timers.setTime(new Date("2026-05-01T12:00:00Z").getTime());
  const parent = SessionManager.create(path.join(directory, "pond"));
  parent.appendModelChange("otter", "alias");
  parent.appendMessage({ role: "user", content: "Count the clams.", timestamp: Date.now() });
  parent.appendMessage(billedReply(100));
  mock.timers.setTime(new Date("2026-06-01T12:00:00Z").getTime());
  parent.appendMessage(billedReply(200));
  mock.timers.setTime(now.getTime());
  const latest = parent.appendMessage({ ...billedReply(300), responseModel: "actual-model" });
  parent.appendMessage({
    role: "toolResult",
    toolName: "clam-census",
    toolCallId: "census",
    content: [{ type: "text", text: "Forty clams accounted for." }],
    isError: false,
    timestamp: Date.now(),
    usage: billedUsage(40),
  });
  parent.appendCompaction(
    "Clam inventory summarized.",
    latest,
    9000,
    undefined,
    false,
    billedUsage(50),
  );
  parent.branchWithSummary(
    parent.getLeafId(),
    "No clam left behind.",
    undefined,
    false,
    billedUsage(60),
  );
  const fork = SessionManager.forkFrom(parent.getSessionFile()!, path.join(directory, "burrow"));
  fork.appendMessage(billedReply(70));
  return [parent.getSessionFile()!, fork.getSessionFile()!];
}

function billedReply(tokens: number) {
  return {
    ...assistantMessage("The otter's invoice."),
    provider: "otter",
    model: "alias",
    timestamp: Date.now(),
    usage: billedUsage(tokens),
  };
}

function billedUsage(tokens: number) {
  return {
    ...assistantMessage("").usage,
    input: tokens,
    totalTokens: tokens,
    cost: { ...assistantMessage("").usage.cost, input: tokens / 100, total: tokens / 100 },
  };
}

type UsageView = {
  component: Component;
  text(): string;
  press(key: string): void;
  until(pattern: RegExp): Promise<void>;
};

/** Dispatch /usage through a real Pi session. Only quota HTTP and custom-dialog mounting are adapted. */
async function openUsage(
  usage: ExtensionFactory,
  directory: string,
  failures: unknown[],
  providers: string[],
  inspect: (view: UsageView) => Promise<void>,
) {
  const resources = await createPiResources(directory, getAgentDir(), [usage]);
  if (providers.includes("openai-codex")) {
    const credentials = new InMemoryCredentialStore();
    const credential = {
      type: "oauth" as const,
      access: "fixture-openai-codex",
      refresh: "never-refresh",
      expires: now.getTime() + 86_400_000,
      accountId: "otter-account",
    };
    await credentials.modify("openai-codex", async () => credential);
    // Codex is OAuth-only. Keep native auth resolution and the extension's account lookup real.
    await writeFile(
      path.join(getAgentDir(), "auth.json"),
      JSON.stringify({ "openai-codex": credential }),
    );
    resources.modelRuntime = await ModelRuntime.create({
      credentials,
      modelsPath: null,
      modelsStorePath: path.join(directory, "models-store.json"),
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    await resources.modelRuntime.refresh({ providers: ["openai-codex"], allowNetwork: false });
  }
  for (const provider of providers) {
    if (provider !== "openai-codex")
      await resources.modelRuntime.setRuntimeApiKey(provider, `fixture-${provider}`);
    assert.equal(
      (await resources.modelRuntime.getAuth(provider))?.auth.apiKey,
      `fixture-${provider}`,
      "fixture auth resolves without login or refresh",
    );
  }
  const { session } = await createAgentSession({ ...resources, model: fixtureModel, tools: [] });
  const dispose = async () => {
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
    let inspectionError: unknown;
    const ui = usageDialogs(
      session.extensionRunner.getUIContext().theme,
      failures,
      async (view) => {
        try {
          await inspect(view);
        } catch (error) {
          inspectionError = error;
        }
      },
    );
    await session.bindExtensions({
      mode: "tui",
      uiContext: ui,
      onError: (error) => failures.push(error),
    });
    return {
      session,
      async run() {
        inspectionError = undefined;
        await session.prompt("/usage", { source: "interactive" });
        if (inspectionError) throw inspectionError;
        assert.deepEqual(failures, []);
      },
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

/** Mount real loader/dashboard components on a stopped real TUI, observing redraws rather than polling.
 * No CLI/PTY, physical rendering or app-only keybindings are exercised. Every dialog is closed on failure. */
function usageDialogs(
  theme: ExtensionUIContext["theme"],
  failures: unknown[],
  inspect: (view: UsageView) => Promise<void>,
) {
  const terminal = new Proxy({ columns: 140, rows: 40, showCursor() {}, stop() {} } as Terminal, {
    get(target, key) {
      if (key in target) return Reflect.get(target, key);
      const error = new Error(`Unexpected terminal operation: ${String(key)}`);
      failures.push(error);
      throw error;
    },
  });
  const tui = new TuiMainScreen(terminal);
  tui.stop();
  const keybindings = new Proxy(getKeybindings(), {
    get(target, key) {
      if (key in target) return Reflect.get(target, key);
      const error = new Error(`Unexpected app keybinding operation: ${String(key)}`);
      failures.push(error);
      throw error;
    },
  }) as KeybindingsManager;
  return uiBoundary(
    {
      theme,
      async custom<T>(factory: Parameters<ExtensionUIContext["custom"]>[0]) {
        const result = deferred<unknown>();
        let closed = false;
        const component = await factory(tui, theme, keybindings, (value) => {
          if (closed) failures.push(new Error("Usage dialog completed more than once"));
          closed = true;
          result.resolve(value);
        });
        try {
          if (!(component instanceof BorderedLoader)) {
            const view: UsageView = {
              component,
              text: () => component.render(140).map(stripVTControlCharacters).join("\n"),
              press(key) {
                assert.ok(component.handleInput);
                component.handleInput(key);
              },
              async until(pattern) {
                if (pattern.test(this.text())) return;
                const ready = deferred<void>();
                const render = tui.requestRender.bind(tui);
                const observer = mock.method(tui, "requestRender", () => {
                  render();
                  if (pattern.test(view.text())) ready.resolve();
                });
                try {
                  await deadline(ready.promise, "quota publication");
                } finally {
                  observer.mock.restore();
                }
              },
            };
            try {
              await inspect(view);
            } finally {
              if (!closed) view.press("q");
            }
          }
          return await deadline(result.promise as Promise<T>, "usage dialog completion");
        } finally {
          component.dispose?.();
        }
      },
    },
    failures,
  );
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** A deadline diagnoses missing completion; it never retries work or determines expected behavior. */
async function deadline<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out awaiting ${label}`)), 10_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
