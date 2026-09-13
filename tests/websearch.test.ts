import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs, { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, afterEach, before, beforeEach, describe, mock, test } from "node:test";
import undici from "undici";
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
  id: "gpt-5.6-luna",
  baseUrl: "https://codex.websearch.invalid/backend-api",
};
const currentCodex = { ...codex, id: "gpt-cafe" };
const codex55 = { ...codex, id: "gpt-5.5" };
const claudeUrl = `${claude.baseUrl}/v1/messages`;
const geminiUrl = `${gemini.baseUrl}/interactions`;
const codexUrl = `${codex.baseUrl}/codex/responses`;
const geminiAppUrl = "https://gemini.google.com/app";
const browserGeminiUrl =
  "https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate";
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
    mock.method(undici, "fetch", globalThis.fetch as typeof undici.fetch);
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

  for (const route of ["pi:anthropic", "pi:openai-codex"]) {
    test(`cancels an in-flight ${route} search without trying another model or route`, async () => {
      await writeFile(configPath, JSON.stringify({ routes: [route, "pi:gemini"] }));
      const started = completion();
      let released = false;
      respond = async (request) => {
        assert.equal(request.url, route === "pi:anthropic" ? claudeUrl : codexUrl);
        started.resolve();
        try {
          return await untilAborted(request.signal);
        } finally {
          released = true;
        }
      };
      app = await openSearch(directory, websearch, failures, { codexModels: [codex, codex55] });
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
  }

  for (const { name, mainModel, codexModels, expectedModels } of [
    {
      name: "current Luna is not retried",
      mainModel: codex,
      codexModels: [codex, codex55],
      expectedModels: [codex.id, codex55.id],
    },
    {
      name: "Luna first when the main model is not Codex",
      mainModel: claude,
      codexModels: [currentCodex, codex55, codex],
      expectedModels: [codex.id, codex55.id],
    },
    {
      name: "catalog-unavailable Luna is skipped",
      mainModel: currentCodex,
      codexModels: [currentCodex, codex55],
      expectedModels: [currentCodex.id, codex55.id],
    },
  ]) {
    test(`falls back only from unavailable Codex models: ${name}`, async () => {
      await writeFile(configPath, JSON.stringify({ routes: ["pi:openai-codex"] }));
      const models: string[] = [];
      respond = async (request) => {
        assert.equal(request.url, codexUrl);
        const payload = (await request.json()) as { model: string };
        models.push(payload.model);
        assert.equal(payload.model, expectedModels[models.length - 1]);
        if (models.length < expectedModels.length) {
          return Response.json(
            { error: { code: "model_not_found", message: "This model is out chasing moonfish." } },
            { status: 404 },
          );
        }
        return codexStream(answer, "completed");
      };
      app = await openSearch(directory, websearch, failures, { mainModel, codexModels });
      const result = await app.search(query);
      assert.equal(result.isError, false);
      assert.deepEqual(result.content, [{ type: "text", text: answer }]);
      assert.equal(result.details.route, "pi:openai-codex");
      assert.deepEqual(models, expectedModels);
      assert.equal(app.session.model?.id, mainModel.id);
      assert.ok(app.contexts.every(({ model }) => model.id === mainModel.id));
    });
  }

  for (const { name, stopAfter } of [
    { name: "the next primary route succeeds", stopAfter: 2 },
    {
      name: "all routes exhaust after bounded model attempts, without repeating the browser",
      stopAfter: 9,
    },
  ]) {
    test(`visits routes before alternate models: ${name}`, async () => {
      await firefoxProfiles(directory, databases);
      await writeFile(
        configPath,
        JSON.stringify({
          routes: ["pi:anthropic", "pi:gemini", "pi:openai-codex", "firefox:gemini"],
          profiles: { firefox: "z-octopus" },
        }),
      );
      const strongerClaude = { ...claude, id: "claude-stronger", reasoning: true };
      const strongerGemini = { ...gemini, id: "gemini-stronger", reasoning: true };
      const expected = [
        [claudeUrl, strongerClaude.id],
        [geminiUrl, strongerGemini.id],
        [codexUrl, currentCodex.id],
        [geminiAppUrl, null],
        [browserGeminiUrl, null],
        [claudeUrl, claude.id],
        [geminiUrl, gemini.id],
        [codexUrl, codex.id],
        [codexUrl, codex55.id],
      ].slice(0, stopAfter);
      const visited: Array<[string, string | null]> = [];
      respond = async (request) => {
        const browser = request.url === geminiAppUrl || request.url === browserGeminiUrl;
        const model = browser ? null : ((await request.json()) as { model: string }).model;
        visited.push([request.url, model]);
        assert.deepEqual(visited.at(-1), expected[visited.length - 1]);
        if (request.url === geminiAppUrl) return new Response('{"SNlM0e":"kelp-access-token"}');
        if (stopAfter === 2 && visited.length === stopAfter) {
          return Response.json({ outputs: [{ type: "text", text: answer }] });
        }
        if (browser) return new Response("The kelp gateway is down", { status: 503 });
        if (request.url === codexUrl && model === currentCodex.id) {
          return Response.json(
            {
              detail: `The '${model}' model is not supported when using Codex with a ChatGPT account.`,
            },
            { status: 400 },
          );
        }
        // Gemini Interactions errors: https://ai.google.dev/gemini-api/docs/api-errors.
        const error =
          request.url === claudeUrl
            ? { type: "error", error: { type: "not_found_error", message: `model: ${model}` } }
            : request.url === geminiUrl
              ? {
                  error: {
                    code: "model_not_found",
                    message: `Model ${model} not found.`,
                  },
                }
              : {
                  error: {
                    code: "model_not_found",
                    message: "This model is out chasing moonfish.",
                  },
                };
        return Response.json(error, { status: 404 });
      };
      app = await openSearch(directory, websearch, failures, {
        mainModel: currentCodex,
        codexModels: [currentCodex, codex, codex55],
        claudeModels: [strongerClaude, claude, { ...claude, id: "claude-tiny", contextWindow: 1 }],
        geminiModels: [strongerGemini, gemini, { ...gemini, id: "gemini-tiny", contextWindow: 1 }],
      });
      const result = await app.search(query);
      assert.equal(result.isError, stopAfter !== 2);
      if (stopAfter === 2) {
        assert.deepEqual(result.content, [{ type: "text", text: answer }]);
        assert.equal(result.details.route, "pi:gemini");
      }
      assert.deepEqual(visited, expected);
      assert.equal(app.session.model?.id, currentCodex.id);
      assert.ok(app.contexts.every(({ model }) => model.id === currentCodex.id));
    });
  }

  for (const { route, url, mainModel, status, error } of [
    {
      route: "pi:openai-codex",
      url: codexUrl,
      mainModel: currentCodex,
      status: 401,
      error: { error: { code: "invalid_api_key", message: "The kelp account cannot search." } },
    },
    {
      route: "pi:openai-codex",
      url: codexUrl,
      mainModel: currentCodex,
      status: 404,
      error: { detail: "Not Found" },
    },
    {
      route: "pi:anthropic",
      url: claudeUrl,
      mainModel: claude,
      status: 403,
      error: {
        type: "error",
        error: { type: "permission_error", message: "The kelp account cannot search." },
      },
    },
    {
      route: "pi:gemini",
      url: geminiUrl,
      mainModel: gemini,
      status: 429,
      error: {
        error: {
          code: "quota_exceeded",
          message: "The kelp account has exhausted its quota.",
        },
      },
    },
  ]) {
    test(`does not revisit ${route} after non-model ${status} failure while another route retries`, async () => {
      const retryCodex = route !== "pi:openai-codex";
      const retryRoute = retryCodex ? "pi:openai-codex" : "pi:anthropic";
      const retryUrl = retryCodex ? codexUrl : claudeUrl;
      const retryModels = retryCodex ? [codex.id, codex55.id] : ["claude-stronger", claude.id];
      await writeFile(configPath, JSON.stringify({ routes: [route, retryRoute] }));
      const visited: Array<[string, string]> = [];
      respond = async (request) => {
        const { model } = (await request.json()) as { model: string };
        visited.push([request.url, model]);
        if (request.url === url) return Response.json(error, { status });
        assert.equal(request.url, retryUrl);
        if (model === retryModels[0]) {
          return Response.json(
            retryCodex
              ? {
                  error: {
                    code: "model_not_found",
                    message: "This model is out chasing moonfish.",
                  },
                }
              : { type: "error", error: { type: "not_found_error", message: `model: ${model}` } },
            { status: 404 },
          );
        }
        return retryCodex
          ? codexStream(answer, "completed")
          : Response.json({ content: [{ type: "text", text: answer }] });
      };
      app = await openSearch(directory, websearch, failures, {
        mainModel,
        codexModels: [currentCodex, codex, codex55],
        geminiModels: [gemini, { ...gemini, id: "gemini-stronger", reasoning: true }],
      });
      const result = await app.search(query);
      assert.equal(result.isError, false);
      assert.deepEqual(result.content, [{ type: "text", text: answer }]);
      assert.equal(result.details.route, retryRoute);
      assert.deepEqual(visited, [
        [url, mainModel.id],
        [retryUrl, retryModels[0]],
        [retryUrl, retryModels[1]],
      ]);
    });
  }

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
      app = await openSearch(directory, websearch, failures, { codexModels: [codex, codex55] });
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

  for (const ending of [
    "primary",
    "alternate",
    "completed-then-completed",
    "completed-then-unfinished",
    "missing-status",
    "rpc-error",
    "top-level-error",
    "malformed-nested",
    "malformed-final",
    "empty-final",
  ] as const) {
    test(
      ending === "primary"
        ? "uses pinned Firefox with URL-scoped Gemini cookies, unchanged SQLite/WAL bytes, and secret-free history"
        : `handles ${ending} Gemini browser snapshots without blessing partial research`,
      async () => {
        const files = await firefoxProfiles(directory, databases);
        const before =
          ending === "primary" ? await Promise.all(files.map((file) => readFile(file))) : [];
        await writeFile(
          configPath,
          JSON.stringify({ routes: ["firefox:gemini"], profiles: { firefox: "z-octopus" } }),
        );
        respond = (request) => {
          if (request.url === geminiAppUrl)
            return new Response(
              '<script>window.WIZ_global_data={"SNlM0e":"kelp-access-token"}</script>',
            );
          assert.equal(request.url, browserGeminiUrl);
          return geminiSnapshots(answer, ending);
        };
        app = await openSearch(directory, websearch, failures);
        const result = await app.search(query);
        const complete =
          ending === "primary" || ending === "alternate" || ending === "completed-then-completed";
        assert.equal(result.isError, !complete);
        if (complete) {
          assert.deepEqual(result.content, [{ type: "text", text: answer }]);
          assert.deepEqual(result.details, {
            route: "firefox:gemini",
            backend: "gemini",
            authSource: "firefox",
            browserName: "Firefox",
            profile: "z-octopus",
            sources: 1,
          });
        } else {
          assert.doesNotMatch(JSON.stringify(result), /Grounding|Researching the kelp menu/);
          assert.ok(!JSON.stringify(result).includes(answer), "failed research must not leak text");
        }
        assert.doesNotMatch(JSON.stringify(result), /Earlier kelp answer/);
        assert.deepEqual(
          requests.map((request) => request.url),
          [geminiAppUrl, browserGeminiUrl],
        );
        assert.deepEqual(app.contexts[1].context.messages.at(-1)?.content, result.content);

        if (ending === "primary") {
          assert.equal(
            requests[0].headers.get("cookie"),
            "session=google-app; __Secure-1PSID=google-octopus; __Secure-1PSIDTS=google-timestamp; session=google-root",
          );
          assert.equal(
            requests[1].headers.get("cookie"),
            "session=google-generation; __Secure-1PSID=google-octopus; __Secure-1PSIDTS=google-timestamp; session=google-root",
          );
          assert.equal(requests[1].method, "POST");
          const body = new URLSearchParams(await requests[1].text());
          assert.equal(body.get("at"), "kelp-access-token");
          const envelope = JSON.parse(body.get("f.req")!) as [null, string];
          const prompt = JSON.parse(envelope[1]) as [[string]];
          assert.ok(prompt[0][0].includes(query));
          assert.deepEqual(
            await Promise.all(files.map((file) => readFile(file))),
            before,
            "reading the pinned profile must preserve both profiles' SQLite and WAL bytes",
          );
          const persisted = SessionManager.open(app.session.sessionFile!).buildSessionContext()
            .messages;
          assert.deepEqual(
            persisted.findLast((message) => message.role === "toolResult"),
            JSON.parse(JSON.stringify(result)),
          );
          assert.doesNotMatch(
            await readFile(app.session.sessionFile!, "utf8"),
            /kelp-access-token|google-octopus|google-timestamp|google-decoy|google-app|google-generation|google-root|decoy-secret/,
          );
        }
      },
    );
  }

  for (const route of ["firefox:openai-codex", "chromium:openai-codex"]) {
    test(`rejects removed route ${route} before contacting any provider`, async () => {
      const config = Buffer.from(JSON.stringify({ routes: ["pi:anthropic", route] }));
      await writeFile(configPath, config);
      app = await openSearch(directory, websearch, failures);
      const result = await app.search(query);
      assert.equal(result.isError, true);
      const error = JSON.stringify(result.content);
      assert.ok(error.includes(route));
      assert.match(error, /removed/i);
      assert.ok(error.includes("pi:openai-codex"));
      assert.ok(error.includes("/login"));
      assert.deepEqual(requests, [], "invalid config must not silently fall back to valid routes");
      assert.deepEqual(
        await readFile(configPath),
        config,
        "migration must not rewrite user configuration",
      );
    });
  }

  test("cancels Gemini browser search without contacting the next Pi route", async () => {
    await firefoxProfiles(directory, databases);
    await writeFile(
      configPath,
      JSON.stringify({
        routes: ["firefox:gemini", "pi:gemini"],
        profiles: { firefox: "z-octopus" },
      }),
    );
    const started = completion();
    let released = false;
    respond = async (request) => {
      if (request.url === geminiAppUrl) return new Response('{"SNlM0e":"kelp-access-token"}');
      assert.equal(request.url, browserGeminiUrl);
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
      [geminiAppUrl, browserGeminiUrl],
      "cancellation must not contact the Pi fallback",
    );
  });
});

/** Real Pi session/tool dispatch and durable history; only main-model generation is scripted.
 * Search providers retain production auth resolution, request construction and response parsing. */
async function openSearch(
  directory: string,
  websearch: ExtensionFactory,
  failures: unknown[],
  {
    mainModel = claude,
    codexModels = [codex],
    claudeModels = [claude, { ...claude, id: "claude-stronger", reasoning: true }],
    geminiModels = [gemini],
  }: {
    mainModel?: Model<string>;
    codexModels?: Model<string>[];
    claudeModels?: Model<string>[];
    geminiModels?: Model<string>[];
  } = {},
) {
  const contexts: { model: Model<string>; context: Context }[] = [];
  let calls = 0;
  const providers: ExtensionFactory = (pi) => {
    for (const model of [claude, gemini, codex]) {
      pi.registerProvider(model.provider, {
        api: model.api,
        baseUrl: model.baseUrl,
        apiKey: `${model.provider}-fixture-key`,
        headers: { "x-cafe-gateway": "octopus" },
        models: model === claude ? claudeModels : model === codex ? codexModels : geminiModels,
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
    model: mainModel,
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

/** Google RPC wire frames with cumulative candidate snapshots, not parsed provider objects.
 * These scripted bytes cover the observed response schema, not live Google compatibility. */
function geminiSnapshots(
  text: string,
  ending:
    | "primary"
    | "alternate"
    | "completed-then-completed"
    | "completed-then-unfinished"
    | "missing-status"
    | "rpc-error"
    | "top-level-error"
    | "malformed-nested"
    | "malformed-final"
    | "empty-final",
) {
  const snapshot = (value: string, status: number | undefined, alternate = false) => {
    const candidate: unknown[] = [];
    candidate[alternate ? 22 : 1] = [value];
    if (status !== undefined) candidate[8] = [status];
    const payload: unknown[] = [];
    payload[4] = [candidate];
    return ["wrb.fr", null, JSON.stringify(payload)];
  };
  const frames: unknown[] = [snapshot("Grounding", 1), snapshot("Researching the kelp menu", 1)];
  if (ending === "primary" || ending === "alternate")
    frames.push(snapshot(text, 2, ending === "alternate"));
  if (ending === "completed-then-completed" || ending === "completed-then-unfinished") {
    frames.push(snapshot("Earlier kelp answer", 2));
    frames.push(snapshot(text, ending === "completed-then-completed" ? 2 : 1));
  }
  if (ending === "missing-status") frames.push(snapshot(text, undefined));
  if (ending === "empty-final") {
    frames.push(snapshot(text, 2));
    frames.push(snapshot(" \n\t", 2));
  }
  if (ending === "rpc-error") {
    frames.push(snapshot(text, 2));
    const errorFrame: unknown[] = ["wrb.fr", null, null];
    errorFrame[5] = [null, null, [[null, [1037]]]];
    frames.push(errorFrame);
  }
  if (ending === "top-level-error") {
    frames.push(snapshot(text, 2));
    frames.push(["er", null, 1037]);
  }
  if (ending === "malformed-nested") {
    frames.push(snapshot(text, 2));
    frames.push(["wrb.fr", null, '{"kelp":']);
  }
  if (ending === "malformed-final") frames.push(snapshot(text, 2));
  const json = JSON.stringify(frames);
  const payload = ending === "malformed-final" ? `${json.slice(0, -1)},["wrb.fr",null,` : json;
  return new Response(`)]}'\n${payload}\n`, {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
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
      ["session", "google-root", "gemini.google.com", "/"],
      ["session", "google-app", "gemini.google.com", "/app"],
      ["session", "google-generation", "gemini.google.com", "/_/BardChatUi"],
      ["wrong-app-path", "decoy-secret", "gemini.google.com", "/ap"],
      ["wrong-generation-path", "decoy-secret", "gemini.google.com", "/_/BardChatU"],
      ["sibling-host", "decoy-secret", "accounts.google.com", "/"],
      ["lookalike", "decoy-secret", "evilgoogle.com", "/"],
      ["unrelated", "decoy-secret", ".cafe.example", "/"],
      [
        "__Secure-1PSID",
        name === "a-decoy" ? "google-decoy" : "google-octopus",
        ".google.com",
        "/",
      ],
      ["__Secure-1PSIDTS", "google-timestamp", ".google.com", "/"],
    ])
      insert.run(cookie, value, host, cookiePath);
    files.push(file, `${file}-wal`);
  }
  await writeFile(path.join(firefoxDirectory(), "profiles.ini"), sections.join("\n"));
  return files;
}
