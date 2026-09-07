import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs, { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, afterEach, before, beforeEach, describe, mock, test } from "node:test";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  getAgentDir,
  SessionManager,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { assistantMessage, createPiResources, fixtureModel, isolatePiHome } from "./helpers/pi.js";

const claude = {
  ...fixtureModel,
  provider: "anthropic",
  api: "anthropic-messages",
  id: "claude-cafe",
  baseUrl: "https://claude.websearch.invalid",
};
const gemini = {
  ...fixtureModel,
  provider: "google",
  api: "google-generative-ai",
  id: "gemini-cafe",
  baseUrl: "https://gemini.websearch.invalid/v1beta",
};
const codex = {
  ...fixtureModel,
  provider: "openai-codex",
  api: "openai-codex-responses",
  id: "gpt-cafe",
  baseUrl: "https://codex.websearch.invalid/backend-api",
};
const claudeUrl = `${claude.baseUrl}/v1/messages`;
const geminiUrl = `${gemini.baseUrl}/interactions`;
const codexUrl = `${codex.baseUrl}/codex/responses`;
const browserCodexUrl = "https://chatgpt.com/backend-api/codex/responses";
const sessionUrl = "https://chatgpt.com/api/auth/session";
const query = "Café 🐙 release notes?\nPrefer the official changelog.";
const answer = "The café now serves kelp. [Release notes](https://cafe.example/releases)";

describe("websearch", { concurrency: false }, () => {
  let home: Awaited<ReturnType<typeof isolatePiHome>>;
  let directory: string;
  let configPath: string;
  let tempDirectory: string;
  let websearch: ExtensionFactory;
  let app: Awaited<ReturnType<typeof openSearch>> | undefined;
  let failures: unknown[];
  let requests: Request[];
  let respond: (request: Request) => Response | Promise<Response>;
  let databases: DatabaseSync[];

  before(async () => {
    home = await isolatePiHome();
    configPath = path.join(getAgentDir(), "websearch.json");
    await mkdir(getAgentDir(), { recursive: true });
  });

  beforeEach(async () => {
    failures = [];
    requests = [];
    databases = [];
    respond = (request) => {
      const error = new Error(`Unexpected HTTP request: ${request.method} ${request.url}`);
      failures.push(error);
      throw error;
    };
    mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      try {
        return await respond(request);
      } catch (error) {
        if (error instanceof assert.AssertionError) failures.push(error);
        throw error;
      }
    });
    const rejectProcess = () => {
      const error = new Error("Unexpected subprocess in websearch workflow");
      failures.push(error);
      throw error;
    };
    for (const method of [
      "spawn",
      "spawnSync",
      "exec",
      "execSync",
      "execFile",
      "execFileSync",
      "fork",
    ] as const)
      mock.method(childProcess, method, rejectProcess);
    syncBuiltinESMExports();
    // Config and Chromium paths are captured at import time, after home and unsafe-work isolation.
    websearch = (await import("../extensions/websearch/index.js")).default;
    directory = await mkdtemp(path.join(os.homedir(), "websearch-"));
    tempDirectory = path.join(directory, "tmp");
    await mkdir(tempDirectory);
    mock.method(os, "tmpdir", () => tempDirectory);
    await writeFile(configPath, JSON.stringify({ routes: ["pi:anthropic"] }));
  });

  afterEach(async () => {
    try {
      await app?.dispose();
      assert.deepEqual(failures, [], "unexpected work must not be swallowed as route fallback");
    } finally {
      app = undefined;
      for (const db of databases) db.close();
      mock.restoreAll();
      syncBuiltinESMExports();
      await rm(directory, { recursive: true, force: true });
      await rm(firefoxDirectory(), { recursive: true, force: true });
      await rm(configPath, { force: true });
    }
  });

  after(async () => {
    await home?.dispose();
  });

  test("falls through a failed route, keeps citations, and rereads config without switching the main model", async () => {
    await writeFile(configPath, JSON.stringify({ routes: ["pi:anthropic", "pi:gemini"] }));
    respond = (request) => {
      if (request.url === claudeUrl)
        return new Response("The kelp gateway is down", { status: 503 });
      assert.equal(request.url, geminiUrl);
      return Response.json({
        outputs: [
          {
            type: "text",
            text: answer,
            annotations: [
              { source: "https://cafe.example/releases", title: "Release notes" },
              { url: "https://cafe.example/menu", title: "Menu" },
              { url: "https://cafe.example/menu", title: "Duplicate menu" },
              { source: "not-a-url" },
            ],
          },
        ],
      });
    };
    app = await openSearch(directory, websearch, failures);
    const first = await app.search(query);
    const expected = `${answer}\n\nSources:\n- [Menu](https://cafe.example/menu)`;
    assert.equal(first.isError, false);
    assert.deepEqual(first.content, [{ type: "text", text: expected }]);
    assert.partialDeepStrictEqual(first.details, {
      route: "pi:gemini",
      backend: "gemini",
      authSource: "pi",
      sources: 2,
    });
    assert.deepEqual(
      requests.map((request) => request.url),
      [claudeUrl, geminiUrl],
    );
    const claudeRequest = (await requests[0].json()) as {
      model: string;
      tools: unknown;
      messages: { content: string }[];
    };
    assert.equal(
      claudeRequest.model,
      claude.id,
      "prefer the current model over a stronger candidate",
    );
    assert.deepEqual(claudeRequest.tools, [
      { type: "web_search_20250305", name: "web_search", max_uses: 5 },
    ]);
    assert.ok(claudeRequest.messages[0].content.includes(query));
    assert.equal(requests[0].headers.get("x-api-key"), "anthropic-fixture-key");
    assert.equal(requests[0].headers.get("x-cafe-gateway"), "octopus");
    const geminiRequest = (await requests[1].json()) as {
      model: string;
      tools: unknown;
      input: string;
    };
    assert.equal(geminiRequest.model, gemini.id);
    assert.deepEqual(geminiRequest.tools, [{ type: "google_search" }]);
    assert.ok(geminiRequest.input.includes(query));
    assert.equal(requests[1].headers.get("x-goog-api-key"), "google-fixture-key");

    await writeFile(configPath, JSON.stringify({ routes: ["pi:anthropic"] }));
    respond = (request) => {
      assert.equal(request.url, claudeUrl);
      return new Response("The kelp gateway is still down", { status: 503 });
    };
    const second = await app.search("Anything else on the menu?");
    assert.equal(second.isError, true);
    assert.match(JSON.stringify(second.content), /kelp gateway is still down/);
    assert.equal(requests.length, 3, "a removed fallback must not receive the next query");
    assert.equal(app.session.model?.id, claude.id);
    assert.ok(app.contexts.every(({ model }) => model.id === claude.id));
    assert.deepEqual(app.contexts[1].context.messages.at(-1)?.content, first.content);
    const persisted = SessionManager.open(app.session.sessionFile!).buildSessionContext().messages;
    assert.deepEqual(
      persisted.filter((message) => message.role === "toolResult"),
      JSON.parse(JSON.stringify([first, second])),
    );
  });

  for (const { name, text, truncatedBy, error = false, sources = false } of [
    { name: "exact small text", text: `${answer}\r\n\r\n  A tab:\t🦑 café.`, truncatedBy: null },
    {
      name: "exact line and byte caps",
      text: `🦑${"x".repeat(DEFAULT_MAX_BYTES - 4 - (DEFAULT_MAX_LINES - 1) * 3)}\n${Array(
        DEFAULT_MAX_LINES - 1,
      )
        .fill("é")
        .join("\n")}`,
      truncatedBy: null,
    },
    {
      name: "line truncation including appended sources",
      text: Array(DEFAULT_MAX_LINES).fill("🦑 kelp").join("\n"),
      truncatedBy: "lines",
      sources: true,
    },
    {
      name: "byte truncation at UTF-8 line boundaries",
      text: Array(100).fill("🦑é".repeat(100)).join("\n"),
      truncatedBy: "bytes",
    },
    { name: "oversized UTF-8 first line", text: "🦑é".repeat(10000), truncatedBy: "bytes" },
    {
      name: "oversized provider error",
      text: "Kelp gateway says 🦑\n".repeat(3000),
      truncatedBy: "lines",
      error: true,
    },
  ]) {
    test(`limits model-visible output: ${name}`, async () => {
      await writeFile(configPath, JSON.stringify({ routes: ["pi:gemini"] }));
      respond = (request) => {
        assert.equal(request.url, geminiUrl);
        return error
          ? new Response(text, { status: 503 })
          : Response.json({
              outputs: [
                {
                  type: "text",
                  text,
                  annotations: sources ? [{ url: "https://cafe.example/menu", title: "Menu" }] : [],
                },
              ],
            });
      };
      const fullText = error
        ? `503 \n${text}`
        : text + (sources ? "\n\nSources:\n- [Menu](https://cafe.example/menu)" : "");
      app = await openSearch(directory, websearch, failures);
      const result = await app.search(query);
      assert.equal(result.isError, error);
      assert.equal(result.content.length, 1);
      const block = result.content[0];
      assert.ok(block.type === "text");
      assert.ok(
        Buffer.byteLength(block.text, "utf8") <= DEFAULT_MAX_BYTES,
        "notice must fit byte cap too",
      );
      assert.ok(block.text.split("\n").length <= DEFAULT_MAX_LINES, "notice must fit line cap too");
      assert.equal(
        Buffer.from(block.text, "utf8").toString("utf8"),
        block.text,
        "no split surrogate pairs",
      );
      assert.doesNotMatch(block.text, /\uFFFD/);
      assert.deepEqual(app.contexts[1].context.messages.at(-1)?.content, result.content);
      const sessionFile = app.session.sessionFile!;
      const persisted = SessionManager.open(sessionFile).buildSessionContext().messages;
      assert.deepEqual(
        persisted.findLast((message) => message.role === "toolResult"),
        JSON.parse(JSON.stringify(result)),
      );
      const description = app.contexts[0].context.tools?.find(
        ({ name }) => name === "websearch",
      )?.description;
      assert.match(description ?? "", /2000 lines.*50\.0KB/);

      if (truncatedBy === null) {
        assert.equal(block.text, fullText, "within-limit content must be byte-exact");
        assert.equal(result.details.truncation, undefined);
        assert.equal(result.details.fullOutputPath, undefined);
        assert.deepEqual(await readdir(tempDirectory), [], "no unnecessary output file");
      } else {
        const noticeStart = block.text.lastIndexOf("\n\n[Output truncated");
        assert.ok(noticeStart >= 0, "model must see a truncation notice");
        const preview = block.text.slice(0, noticeStart);
        assert.ok(fullText.startsWith(preview), "preview preserves an exact prefix");
        assert.ok(
          preview === "" || fullText[preview.length] === "\n",
          "native head truncation keeps whole lines",
        );
        if (name === "oversized UTF-8 first line") assert.equal(preview, "");
        else assert.ok(preview.length > 0, "retain useful research when complete lines fit");
        const fullOutputPath = block.text.slice(
          block.text.lastIndexOf("Full output saved to: ") + "Full output saved to: ".length,
          -1,
        );
        assert.ok(path.isAbsolute(fullOutputPath));
        assert.equal(path.dirname(path.dirname(fullOutputPath)), tempDirectory);
        assert.deepEqual(await readFile(fullOutputPath), Buffer.from(fullText, "utf8"));
        assert.equal((await stat(fullOutputPath)).mode & 0o777, 0o600);
        assert.equal((await stat(path.dirname(fullOutputPath))).mode & 0o777, 0o700);
        if (!error) {
          assert.equal(result.details.fullOutputPath, fullOutputPath);
          assert.partialDeepStrictEqual(result.details.truncation, {
            truncated: true,
            truncatedBy,
            totalBytes: Buffer.byteLength(fullText),
            totalLines: fullText.split("\n").length,
            outputBytes: Buffer.byteLength(preview),
            outputLines: preview ? preview.split("\n").length : 0,
            firstLineExceedsLimit: preview === "",
          });
          assert.equal(
            result.details.truncation.content,
            undefined,
            "do not duplicate output in details",
          );
        }
        assert.ok(
          Buffer.byteLength(JSON.stringify(result.details)) < 2048,
          "metadata must remain small",
        );
        assert.ok(
          !(await readFile(sessionFile, "utf8")).includes(JSON.stringify(fullText).slice(1, -1)),
          "full output belongs in its file, not durable history",
        );
        await app.dispose();
        app = undefined;
        assert.deepEqual(
          await readFile(fullOutputPath),
          Buffer.from(fullText, "utf8"),
          "published output survives session shutdown",
        );
      }
    });
  }

  for (const outcome of ["failed", "cancelled"] as const) {
    test(`removes ${outcome} partial output files before settling`, async () => {
      const started = completion();
      const realWriteFile = fs.writeFile;
      let partialPath: string | undefined;
      let released = false;
      mock.method(fs, "writeFile", async (...args: Parameters<typeof fs.writeFile>) => {
        const [file, , options] = args;
        if (typeof file !== "string" || !file.startsWith(tempDirectory + path.sep))
          return realWriteFile(...args);
        partialPath = file;
        await realWriteFile(file, "Unpublished kelp", options);
        started.resolve();
        try {
          if (outcome === "failed") throw new Error("Kelp disk is full");
          assert.ok(options && typeof options === "object" && options.signal);
          return await untilAborted(options.signal);
        } catch (error) {
          if (error instanceof assert.AssertionError) failures.push(error);
          throw error;
        } finally {
          released = true;
        }
      });
      syncBuiltinESMExports();
      respond = (request) => {
        assert.equal(request.url, claudeUrl);
        return Response.json({ content: [{ type: "text", text: "🦑\n".repeat(3000) }] });
      };
      app = await openSearch(directory, websearch, failures);
      const run = app.session.prompt(query);
      try {
        await Promise.race([
          started.promise,
          run.then(() => assert.fail("output write never started")),
        ]);
        if (outcome === "cancelled") {
          assert.ok(partialPath);
          assert.equal(await readFile(partialPath, "utf8"), "Unpublished kelp");
          await app.session.abort();
        }
        await run;
        await app.session.waitForIdle();
        assert.equal(released, true);
        assert.ok(partialPath);
        assert.deepEqual(
          await readdir(tempDirectory),
          [],
          "no failed directory or partial file remains",
        );
        const result = app.session.messages.findLast((message) => message.role === "toolResult");
        assert.ok(result && result.role === "toolResult");
        assert.equal(result.isError, true);
        assert.ok(
          !JSON.stringify(result).includes("Full output saved"),
          "never publish failed writes",
        );
        if (outcome === "failed") assert.match(JSON.stringify(result.content), /Kelp disk is full/);
        assert.equal(app.session.pendingMessageCount, 0);
        assert.equal(app.contexts.length, outcome === "cancelled" ? 1 : 2);
      } finally {
        await app.session.abort();
        await run;
      }
    });
  }

  test("cancels an in-flight Pi search without contacting the next configured route", async () => {
    await writeFile(configPath, JSON.stringify({ routes: ["pi:anthropic", "pi:gemini"] }));
    const started = completion();
    let released = false;
    respond = async (request) => {
      assert.equal(request.url, claudeUrl);
      started.resolve();
      try {
        return await untilAborted(request.signal);
      } finally {
        released = true;
      }
    };
    app = await openSearch(directory, websearch, failures);
    const run = app.session.prompt(query);
    try {
      await Promise.race([started.promise, run.then(() => assert.fail("search never started"))]);
    } finally {
      await app.session.abort();
      await run;
    }
    await app.session.waitForIdle();
    assert.equal(released, true, "abort must join the outstanding HTTP operation");
    assert.equal(requests.length, 1);
    assert.equal(app.contexts.length, 1, "no answer turn after cancellation");
    assert.equal(app.session.pendingMessageCount, 0);
    const result = app.session.messages.find((message) => message.role === "toolResult");
    assert.ok(result && result.role === "toolResult");
    assert.equal(result.isError, true);
  });

  for (const ending of [
    "completed",
    "done",
    "failed",
    "disconnected",
    "item-only",
    "incomplete",
    "failed-status",
    "missing-status",
  ] as const) {
    test(`handles a ${ending} Codex stream without losing text or blessing partial research`, async () => {
      await writeFile(configPath, JSON.stringify({ routes: ["pi:openai-codex"] }));
      respond = (request) => {
        assert.equal(request.url, codexUrl);
        return codexStream(answer, ending);
      };
      app = await openSearch(directory, websearch, failures);
      const result = await app.search(query);
      assert.equal(requests.length, 1);
      const payload = (await requests[0].json()) as {
        model: string;
        store: boolean;
        stream: boolean;
        tools: unknown;
        input: { content: string }[];
      };
      assert.equal(payload.model, codex.id);
      assert.equal(payload.store, false);
      assert.equal(payload.stream, true);
      assert.deepEqual(payload.tools, [{ type: "web_search" }]);
      assert.ok(payload.input[0].content.includes(query));
      assert.equal(requests[0].headers.get("authorization"), "Bearer openai-codex-fixture-key");
      assert.equal(
        result.isError,
        ending !== "completed" && ending !== "done",
        "unfinished research is not a successful search result",
      );
      if (ending === "completed" || ending === "done") {
        assert.deepEqual(result.content, [{ type: "text", text: answer }]);
        assert.equal(result.details.sources, 1);
        assert.equal(result.details.route, "pi:openai-codex");
      } else {
        assert.ok(
          !JSON.stringify(result).includes(answer),
          "partial research must not leak into errors or details",
        );
        if (ending === "failed")
          assert.match(JSON.stringify(result.content), /Kelp quota exhausted/);
      }
      assert.deepEqual(app.contexts[1].context.messages.at(-1)?.content, result.content);
      const persisted = SessionManager.open(app.session.sessionFile!).buildSessionContext()
        .messages;
      assert.deepEqual(
        persisted.findLast((message) => message.role === "toolResult"),
        JSON.parse(JSON.stringify(result)),
      );
    });
  }

  test("uses only the pinned Firefox profile and URL-scoped cookies, preserving the live WAL database", async () => {
    const files = await firefoxProfiles(directory, databases);
    const before = await Promise.all(files.map((file) => readFile(file)));
    await writeFile(
      configPath,
      JSON.stringify({ routes: ["firefox:openai-codex"], profiles: { firefox: "z-octopus" } }),
    );
    respond = (request) => {
      if (request.url === sessionUrl)
        return Response.json({
          accessToken: "browser-fixture-token",
          user: { email: "octopus@cafe.example" },
        });
      assert.equal(request.url, browserCodexUrl);
      return codexStream(answer, "completed");
    };
    app = await openSearch(directory, websearch, failures);
    const result = await app.search(query);
    assert.equal(result.isError, false);
    assert.deepEqual(result.content, [{ type: "text", text: answer }]);
    assert.deepEqual(result.details, {
      route: "firefox:openai-codex",
      backend: "openai-codex",
      authSource: "firefox",
      browserName: "Firefox",
      profile: "z-octopus",
      accountLabel: "octopus@cafe.example",
      sources: 1,
    });
    assert.deepEqual(
      requests.map((request) => request.url),
      [sessionUrl, browserCodexUrl],
    );
    assert.equal(requests[0].headers.get("cookie"), "session=narrow-octopus; session=root-octopus");
    assert.equal(
      requests[1].headers.get("cookie"),
      null,
      "browser cookies never accompany the bearer-authenticated search",
    );
    assert.equal(requests[1].headers.get("authorization"), "Bearer browser-fixture-token");
    assert.deepEqual(await Promise.all(files.map((file) => readFile(file))), before);
    const history = await readFile(app.session.sessionFile!, "utf8");
    assert.doesNotMatch(history, /browser-fixture-token|narrow-octopus|root-octopus|decoy-secret/);
  });

  test("cancels browser search without trying more preferred models", async () => {
    await firefoxProfiles(directory, databases);
    await writeFile(
      configPath,
      JSON.stringify({
        routes: ["firefox:openai-codex", "pi:gemini"],
        profiles: { firefox: "z-octopus" },
      }),
    );
    const started = completion();
    let released = false;
    respond = async (request) => {
      if (request.url === sessionUrl)
        return Response.json({ accessToken: "browser-fixture-token" });
      assert.equal(request.url, browserCodexUrl);
      // Record even already-aborted attempts: transport rejects them, but they are still unwanted retries.
      if (request.signal.aborted) return untilAborted(request.signal);
      started.resolve();
      try {
        return await untilAborted(request.signal);
      } finally {
        released = true;
      }
    };
    app = await openSearch(directory, websearch, failures);
    const run = app.session.prompt(query);
    try {
      await Promise.race([
        started.promise,
        run.then(() => assert.fail("browser search never started")),
      ]);
    } finally {
      await app.session.abort();
      await run;
    }
    await app.session.waitForIdle();
    assert.equal(released, true);
    assert.equal(app.contexts.length, 1);
    assert.equal(app.session.pendingMessageCount, 0);
    const result = app.session.messages.findLast((message) => message.role === "toolResult");
    assert.ok(result && result.role === "toolResult");
    assert.equal(result.isError, true);
    assert.deepEqual(
      requests.map((request) => request.url),
      [sessionUrl, browserCodexUrl],
      "cancellation must not retry another browser model or route",
    );
  });
});

/** Real Pi session/tool dispatch and durable history; only main-model generation is scripted.
 * Search providers retain production auth resolution, request construction and response parsing. */
async function openSearch(directory: string, websearch: ExtensionFactory, failures: unknown[]) {
  const contexts: { model: Model<string>; context: Context }[] = [];
  let calls = 0;
  const providers: ExtensionFactory = (pi) => {
    for (const model of [claude, gemini, codex]) {
      pi.registerProvider(model.provider, {
        api: model.api,
        baseUrl: model.baseUrl,
        apiKey: `${model.provider}-fixture-key`,
        headers: { "x-cafe-gateway": "octopus" },
        models:
          model === claude
            ? [claude, { ...claude, id: "claude-stronger", reasoning: true }]
            : [model],
        streamSimple: (selected, context) => {
          contexts.push({
            model: selected,
            context: {
              ...context,
              messages: structuredClone(context.messages),
              tools: context.tools?.map(({ name, description, parameters }) => ({
                name,
                description,
                parameters,
              })),
            },
          });
          const last = context.messages.at(-1);
          let reply: AssistantMessage;
          if (last?.role === "user") {
            const query =
              typeof last.content === "string"
                ? last.content
                : last.content
                    .filter((block) => block.type === "text")
                    .map((block) => block.text)
                    .join("\n");
            reply = {
              ...assistantMessage(""),
              stopReason: "toolUse",
              content: [
                {
                  type: "toolCall",
                  id: `search-${++calls}`,
                  name: "websearch",
                  arguments: { query },
                },
              ],
            };
          } else if (last?.role === "toolResult") {
            reply = assistantMessage("Research received.");
          } else {
            const error = new Error("Unexpected main-model request in websearch workflow");
            failures.push(error);
            throw error;
          }
          reply = { ...reply, api: selected.api, provider: selected.provider, model: selected.id };
          const stream = createAssistantMessageEventStream();
          stream.push({ type: "start", partial: reply });
          assert.ok(reply.stopReason === "stop" || reply.stopReason === "toolUse");
          stream.push({ type: "done", reason: reply.stopReason, message: reply });
          stream.end();
          return stream;
        },
      });
    }
  };
  const resources = await createPiResources(directory, getAgentDir(), [websearch, providers]);
  const { session } = await createAgentSession({
    ...resources,
    sessionManager: SessionManager.create(directory, path.join(directory, "sessions")),
    model: claude,
    tools: ["websearch"],
  });
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
    await session.bindExtensions({ mode: "print", onError: (error) => failures.push(error) });
    return {
      session,
      contexts,
      dispose,
      async search(query: string) {
        const before = contexts.length;
        await session.prompt(query);
        await session.waitForIdle();
        assert.deepEqual(failures, []);
        assert.deepEqual(
          session.messages.filter(
            (message) => message.role === "assistant" && message.stopReason === "error",
          ),
          [],
          "main-model fixture must complete normally",
        );
        assert.equal(contexts.length - before, 2, "one tool-calling turn and one answering turn");
        const result = session.messages.findLast((message) => message.role === "toolResult");
        assert.ok(result && result.role === "toolResult");
        return result;
      },
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

/** Finite HTTP response bytes split inside UTF-8 and CRLF boundaries, not parsed provider objects. */
function codexStream(
  text: string,
  ending:
    | "completed"
    | "done"
    | "failed"
    | "disconnected"
    | "item-only"
    | "incomplete"
    | "failed-status"
    | "missing-status",
) {
  const events: unknown[] =
    ending === "item-only"
      ? [{ type: "response.output_item.done", item: { content: [{ type: "output_text", text }] } }]
      : [{ type: "response.output_text.delta", delta: text }];
  if (ending === "completed" || ending === "done")
    events.push({ type: `response.${ending}`, response: { status: "completed" } });
  if (ending === "incomplete")
    events.push({ type: "response.incomplete", response: { status: "incomplete" } });
  if (ending === "failed-status" || ending === "missing-status")
    events.push({
      type: "response.completed",
      response: ending === "failed-status" ? { status: "failed" } : {},
    });
  if (ending === "failed")
    events.push({
      type: "response.failed",
      response: { error: { message: "Kelp quota exhausted" } },
    });
  const bytes = Buffer.from(
    events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join(""),
  );
  let offset = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset === bytes.length) controller.close();
        else controller.enqueue(bytes.subarray(offset, ++offset));
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

/** Hold only the substituted HTTP operation; native session abort owns its lifetime. */
function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

function completion() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function firefoxDirectory() {
  assert.ok(
    process.platform === "darwin" || process.platform === "linux",
    "Firefox fixtures require a supported Tau platform",
  );
  return process.platform === "darwin"
    ? path.join(os.homedir(), "Library", "Application Support", "Firefox")
    : path.join(os.homedir(), ".mozilla", "firefox");
}

/** Disposable Firefox profiles with open WAL databases: cookie reads must snapshot, not alter the browser.
 * The alphabetically first profile is a decoy; no browser process or credential store is used. */
async function firefoxProfiles(directory: string, databases: DatabaseSync[]) {
  await mkdir(firefoxDirectory(), { recursive: true });
  const files: string[] = [];
  const sections: string[] = [];
  for (const [index, name] of ["a-decoy", "z-octopus"].entries()) {
    const profile = path.join(directory, name);
    await mkdir(profile);
    sections.push(`[Profile${index}]\nName=${name}\nIsRelative=0\nPath=${profile}\n`);
    const file = path.join(profile, "cookies.sqlite");
    const db = new DatabaseSync(file);
    databases.push(db);
    db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE moz_cookies (name TEXT, value TEXT, host TEXT, path TEXT, isSecure INTEGER, expiry INTEGER)",
    );
    const insert = db.prepare("INSERT INTO moz_cookies VALUES (?, ?, ?, ?, 1, 4102444800)");
    for (const [cookie, value, host, cookiePath] of [
      ["session", name === "a-decoy" ? "decoy-secret" : "root-octopus", ".chatgpt.com", "/"],
      ["session", "narrow-octopus", "chatgpt.com", "/api/auth"],
      ["wrong-path", "secret", "chatgpt.com", "/api/authentication"],
      ["wrong-host", "secret", "other.chatgpt.com", "/"],
      ["lookalike", "secret", "evilchatgpt.com", "/"],
      ["unrelated", "secret", ".google.com", "/"],
    ])
      insert.run(cookie, value, host, cookiePath);
    files.push(file, `${file}-wal`);
  }
  await writeFile(path.join(firefoxDirectory(), "profiles.ini"), sections.join("\n"));
  return files;
}
