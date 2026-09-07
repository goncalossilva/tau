import assert from "node:assert/strict";
import childProcess from "node:child_process";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { lock } from "proper-lockfile";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { Model } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  getAgentDir,
  initTheme,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import openaiVerbosity from "../extensions/openai-verbosity.js";
import { createPiResources, fixtureModel, isolatePiHome, uiBoundary } from "./helpers/pi.js";
import { preferenceChild } from "./helpers/preferences.js";

const reply = '{"crew":"café octopus 🐙"}';
const format = {
  type: "json_schema",
  name: "crew_manifest",
  strict: true,
  schema: {
    type: "object",
    properties: { crew: { type: "string" } },
    required: ["crew"],
    additionalProperties: false,
  },
};

describe("openai-verbosity", { concurrency: false }, () => {
  let home: Awaited<ReturnType<typeof isolatePiHome>> | undefined;
  let configPath: string;
  let sessions: Awaited<ReturnType<typeof openSession>>[];
  let failures: unknown[];
  let transport: ReturnType<typeof providerTransport>;
  let children: ReturnType<typeof preferenceChild>[];

  beforeEach(async () => {
    sessions = [];
    children = [];
    failures = [];
    home = await isolatePiHome();
    configPath = path.join(getAgentDir(), "openai-verbosity.json");
    await mkdir(getAgentDir(), { recursive: true });
    transport = providerTransport(failures);
    mock.method(globalThis, "fetch", transport.fetch);
    const rejectSubprocess = () => {
      const error = new Error("Unexpected subprocess in verbosity workflow");
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
      mock.method(childProcess, method, rejectSubprocess);
    syncBuiltinESMExports();
  });

  afterEach(async () => {
    try {
      const shutdowns = await Promise.allSettled([
        ...children.map((child) => child.stop()),
        ...sessions.map((session) => session.dispose()),
      ]);
      assert.deepEqual(
        shutdowns.filter((result) => result.status === "rejected"),
        [],
      );
      assert.deepEqual(failures, [], "unexpected work and extension errors must surface");
    } finally {
      mock.restoreAll();
      syncBuiltinESMExports();
      await home?.dispose();
      home = undefined;
    }
  });

  for (const [api, id] of [
    ["openai-completions", "gpt-6-mini"],
    ["openai-responses", "gpt-5.4"],
  ] as const) {
    test(`${api}: persists a choice, preserves structured output, and returns to upstream defaults`, async () => {
      const model = verbosityModel(id, api);
      const unsupported = verbosityModel("gpt-50", api);
      const app = await openSession([model, unsupported], failures);
      sessions.push(app);
      assert.equal(app.status(), undefined);
      const history = structuredClone(app.session.messages);

      await app.session.prompt("/verbosity  HiGh  ");
      assert.equal(app.status(), "high");
      assert.equal(app.notices.at(-1)?.type, "info");
      assert.deepEqual(await readConfig(configPath), {
        models: { [`${model.provider}/${id}`]: "high" },
      });
      assert.deepEqual(app.session.messages, history, "commands do not enter model context");
      assert.equal(transport.requests.length, 0, "setting verbosity must not call a model");
      assertPayload(await transport.prompt(app, model), model, "high");

      await app.session.reload();
      assert.equal(app.status(), "high", "reload restores the persisted choice");
      assertPayload(await transport.prompt(app, model), model, "high");

      const saved = await readFile(configPath);
      await app.session.prompt("/verbosity high tide");
      assert.equal(app.notices.at(-1)?.type, "error");
      assert.equal(app.status(), "high");
      assert.deepEqual(await readFile(configPath), saved);

      await app.session.setModel(unsupported);
      assert.equal(app.status(), undefined, "model switches must clear stale status");
      await app.session.prompt("/verbosity low");
      assert.equal(app.notices.at(-1)?.type, "warning");
      assert.deepEqual(await readFile(configPath), saved);
      assertPayload(await transport.prompt(app, unsupported), unsupported, "medium");

      await app.session.setModel(model);
      assert.equal(app.status(), "high");
      await app.session.prompt("/verbosity auto");
      assert.equal(app.status(), undefined);
      assert.deepEqual(await readConfig(configPath), {
        models: { [`${model.provider}/${id}`]: "auto" },
      });
      assertPayload(await transport.prompt(app, model), model, "medium");
      await app.session.reload();
      assert.equal(app.status(), undefined);
      assertPayload(await transport.prompt(app, model), model, "medium");
    });
  }

  test("resolves provider-specific preferences before shared defaults and reloads file edits", async () => {
    const reef = verbosityModel("gpt-5.4", "openai-responses");
    const moon = { ...reef, provider: "verbosity-moon" };
    const models = { "gpt-5.4": "low", "verbosity-reef/gpt-5.4": "high" };
    await writeFile(configPath, JSON.stringify({ models }));
    const app = await openSession([reef, moon], failures);
    sessions.push(app);

    assert.equal(app.status(), "high");
    assertPayload(await transport.prompt(app, reef), reef, "high");
    await app.session.setModel(moon);
    assert.equal(app.status(), "low");
    assertPayload(await transport.prompt(app, moon), moon, "low");
    await app.session.setModel(reef);
    assert.equal(app.status(), "high");
    assert.deepEqual(await readConfig(configPath), { models }, "selection never rewrites defaults");

    await writeFile(
      configPath,
      JSON.stringify({ models: { ...models, "verbosity-reef/gpt-5.4": "medium" } }),
    );
    await app.session.reload();
    assert.equal(app.status(), "medium");
    assertPayload(await transport.prompt(app, reef), reef, "medium");
    await app.session.setModel(moon);
    assert.equal(app.status(), "low");
    assertPayload(await transport.prompt(app, moon), moon, "low");
  });

  test("a failed save keeps the last effective choice and allows recovery", async () => {
    const model = verbosityModel("gpt-5.4", "openai-responses");
    const app = await openSession([model], failures);
    sessions.push(app);
    await app.session.prompt("/verbosity low");
    const saved = await readFile(configPath);
    const backup = `${configPath}.backup`;
    await rename(configPath, backup);
    await mkdir(configPath); // A real, portable EISDIR failure, even when tests run as root.

    await app.session.prompt("/verbosity high");
    assert.equal(app.notices.at(-1)?.type, "error");
    assert.ok(app.notices.at(-1)?.message.includes(configPath));
    assert.equal(app.status(), "low", "an unpersisted choice must not be advertised as active");
    assert.deepEqual(await readFile(backup), saved);
    assertPayload(await transport.prompt(app, model), model, "low");

    await rm(configPath, { recursive: true });
    await rename(backup, configPath);
    await app.session.prompt("/verbosity medium");
    assert.equal(app.notices.at(-1)?.type, "info");
    assert.equal(app.status(), "medium");
    assert.deepEqual(await readConfig(configPath), {
      models: { "verbosity-reef/gpt-5.4": "medium" },
    });
    await app.session.reload();
    assertPayload(await transport.prompt(app, model), model, "medium");
  });

  for (const exactOverride of [false, true]) {
    test(`commands stay provider-local with a shared default${exactOverride ? " and exact override" : ""}`, async () => {
      const reef = verbosityModel("gpt-5.4", "openai-responses");
      const moon = { ...reef, provider: "verbosity-moon" };
      await writeFile(
        configPath,
        JSON.stringify({
          models: {
            "gpt-5.4": "low",
            ...(exactOverride
              ? { "verbosity-reef/gpt-5.4": "high", " verbosity-reef/gpt-5.4 ": "high" }
              : {}),
          },
        }),
      );
      const app = await openSession([reef, moon], failures);
      sessions.push(app);
      await app.session.prompt("/verbosity high");
      assertPayload(await transport.prompt(app, reef), reef, "high");
      assert.equal((await readConfig(configPath)).models["gpt-5.4"], "low");
      await app.session.prompt("/verbosity auto");
      assert.equal(app.status(), undefined);
      assertPayload(await transport.prompt(app, reef), reef, "medium");
      await app.session.setModel(moon);
      assert.equal(app.status(), "low");
      assertPayload(await transport.prompt(app, moon), moon, "low");
      await app.session.reload();
      assertPayload(await transport.prompt(app, moon), moon, "low");
      await app.session.setModel(reef);
      assert.equal(app.status(), undefined);
      assertPayload(await transport.prompt(app, reef), reef, "medium");
      assert.deepEqual(await readConfig(configPath), {
        models: {
          "gpt-5.4": "low",
          "verbosity-reef/gpt-5.4": "auto",
          ...(exactOverride ? { " verbosity-reef/gpt-5.4 ": "high" } : {}),
        },
      });
    });
  }

  test("independent children merge fresh preferences under contention through a file symlink", async () => {
    const reef = verbosityModel("gpt-5.4", "openai-responses");
    const moon = { ...reef, provider: "verbosity-moon" };
    const initial = {
      note: "Keep the café 🐙",
      models: { untouched: "future-mode", "gpt-5.4": "low" },
    };
    await writeFile(configPath, JSON.stringify(initial));
    const alias = path.join(getAgentDir(), "alias");
    await mkdir(alias);
    await symlink(configPath, path.join(alias, "openai-verbosity.json"));
    const first = preferenceChild({
      extension: new URL("../extensions/openai-verbosity.js", import.meta.url).href,
      command: "verbosity",
      agentDir: getAgentDir(),
      model: reef,
    });
    children.push(first);
    const second = preferenceChild({
      extension: new URL("../extensions/openai-verbosity.js", import.meta.url).href,
      command: "verbosity",
      agentDir: alias,
      model: moon,
    });
    children.push(second);
    await Promise.all([first.ready(), second.ready()]);
    const release = await lock(configPath);
    const auto = first.start("command", "auto");
    const high = second.start("command", "high");
    try {
      await Promise.all([auto.wait("contended"), high.wait("contended")]);
      await writeFile(
        configPath,
        JSON.stringify({ ...initial, models: { ...initial.models, late: "medium" } }),
      );
    } finally {
      await release();
    }
    const [reset, enabled] = await Promise.all([auto.wait(), high.wait()]);
    assert.equal(reset.notices?.at(-1)?.type, "info");
    assert.equal(reset.status, undefined);
    assert.equal((reset.payload as { text: { verbosity: string } }).text.verbosity, "medium");
    assert.equal(enabled.status, "high");
    assert.deepEqual(await readConfig(configPath), {
      ...initial,
      models: {
        ...initial.models,
        "verbosity-reef/gpt-5.4": "auto",
        "verbosity-moon/gpt-5.4": "high",
        late: "medium",
      },
    });
    assert.equal((await lstat(path.join(alias, "openai-verbosity.json"))).isSymbolicLink(), true);
    assert.deepEqual(
      (await readdir(getAgentDir())).filter(
        (name) => name.endsWith(".tmp") || name.endsWith(".lock"),
      ),
      [],
    );
  });

  test("a child refuses damaged configuration and cleans a failed atomic publication before retrying", async () => {
    const model = verbosityModel("gpt-5.4", "openai-responses");
    const original = JSON.stringify({
      models: { "verbosity-reef/gpt-5.4": "low", "gpt-5.4": "high" },
    });
    await writeFile(configPath, original);
    const child = preferenceChild({
      extension: new URL("../extensions/openai-verbosity.js", import.meta.url).href,
      command: "verbosity",
      agentDir: getAgentDir(),
      model,
    });
    children.push(child);
    await child.ready();
    for (const damaged of ['{"models":', '{"models":[]}']) {
      await writeFile(configPath, damaged);
      const result = await child.start("command", "auto").wait();
      assert.equal(result.notices?.at(-1)?.type, "error");
      assert.equal(result.status, "low");
      assert.equal((result.payload as { text: { verbosity: string } }).text.verbosity, "low");
      assert.equal(await readFile(configPath, "utf8"), damaged);
      assert.deepEqual(
        (await readdir(getAgentDir())).filter(
          (name) => name.endsWith(".tmp") || name.endsWith(".lock"),
        ),
        [],
      );
    }
    await writeFile(configPath, original);
    await child.start("pause-rename").wait();
    const saving = child.start("command", "auto");
    try {
      await saving.wait("rename-ready");
      assert.equal(
        await readFile(configPath, "utf8"),
        original,
        "unpublished writes leave the old file intact",
      );
      assert.equal(
        (await readdir(getAgentDir())).filter((name) => name.endsWith(".tmp")).length,
        1,
      );
      await rename(configPath, `${configPath}.backup`);
      await mkdir(configPath);
    } finally {
      child.start("resume-rename");
    }
    const failed = await saving.wait();
    assert.equal(failed.notices?.at(-1)?.type, "error");
    assert.equal(failed.status, "low");
    assert.equal((failed.payload as { text: { verbosity: string } }).text.verbosity, "low");
    assert.equal(await readFile(`${configPath}.backup`, "utf8"), original);
    assert.deepEqual(
      (await readdir(getAgentDir())).filter(
        (name) => name.endsWith(".tmp") || name.endsWith(".lock"),
      ),
      [],
    );
    await rm(configPath, { recursive: true });
    await rename(`${configPath}.backup`, configPath);
    const recovered = await child.start("command", "auto").wait();
    assert.equal(recovered.notices?.at(-1)?.type, "info");
    assert.equal(recovered.status, undefined);
    assert.deepEqual(await readConfig(configPath), {
      models: { "verbosity-reef/gpt-5.4": "auto", "gpt-5.4": "high" },
    });
    assert.equal((await child.start("reload").wait()).status, undefined);
  });

  test("a child reports lock contention without changing its live choice and recovers a dead owner's stale lock", async () => {
    const model = verbosityModel("gpt-5.4", "openai-responses");
    await writeFile(configPath, JSON.stringify({ models: { "verbosity-reef/gpt-5.4": "low" } }));
    const options = {
      extension: new URL("../extensions/openai-verbosity.js", import.meta.url).href,
      command: "verbosity",
      agentDir: getAgentDir(),
      model,
    };
    const holder = preferenceChild(options);
    children.push(holder);
    const writer = preferenceChild(options);
    children.push(writer);
    await Promise.all([holder.ready(), writer.ready()]);
    await holder.start("lock", configPath).wait();
    const saved = await readFile(configPath);
    const failed = await writer.start("command", "high").wait();
    assert.equal(failed.notices?.at(-1)?.type, "error");
    assert.equal(failed.status, "low");
    assert.deepEqual(await readFile(configPath), saved);
    await holder.kill();
    await utimes(`${configPath}.lock`, new Date(0), new Date(0));
    const recovered = await writer.start("command", "high").wait();
    assert.equal(recovered.notices?.at(-1)?.type, "info");
    assert.equal(recovered.status, "high");
    assert.equal((recovered.payload as { text: { verbosity: string } }).text.verbosity, "high");
    assert.deepEqual(
      (await readdir(getAgentDir())).filter(
        (name) => name.endsWith(".tmp") || name.endsWith(".lock"),
      ),
      [],
    );
  });

  test("two already-open sessions preserve each other's unrelated saved preferences", async () => {
    const reef = verbosityModel("gpt-5.4", "openai-responses");
    const moon = verbosityModel("gpt-6-mini", "openai-completions");
    const first = await openSession([reef], failures);
    sessions.push(first);
    const second = await openSession([moon], failures);
    sessions.push(second);

    await first.session.prompt("/verbosity low");
    assert.deepEqual(await readConfig(configPath), {
      models: { "verbosity-reef/gpt-5.4": "low" },
    });
    await second.session.prompt("/verbosity high");
    assert.equal(first.status(), "low");
    assert.equal(second.status(), "high");
    assert.deepEqual(
      await readConfig(configPath),
      {
        models: {
          "verbosity-reef/gpt-5.4": "low",
          "verbosity-reef/gpt-6-mini": "high",
        },
      },
      "a later save must not erase another session's successfully persisted model choice",
    );
    await first.session.reload();
    assertPayload(await transport.prompt(first, reef), reef, "low");
  });
});

/** Real Pi command dispatch, model selection and reload; only status/notification output is adapted. */
async function openSession(models: Model<string>[], failures: unknown[]) {
  const cwd = path.join(getAgentDir(), "work");
  await mkdir(cwd, { recursive: true });
  const providers: ExtensionFactory = (pi) => {
    for (const provider of new Set(models.map((model) => model.provider))) {
      pi.registerProvider(provider, {
        baseUrl: models[0].baseUrl,
        apiKey: "fixture-only-not-a-real-key",
        models: models.filter((model) => model.provider === provider),
      });
    }
  };
  const resources = await createPiResources(cwd, getAgentDir(), [openaiVerbosity, providers]);
  const { session } = await createAgentSession({ ...resources, model: models[0], tools: [] });
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
    const statuses = new Map<string, string | undefined>();
    const notices: { message: string; type: string | undefined }[] = [];
    await session.bindExtensions({
      mode: "tui",
      onError: (error) => failures.push(error),
      uiContext: uiBoundary(
        {
          theme: session.extensionRunner.getUIContext().theme,
          setStatus: (key, text) => statuses.set(key, text),
          notify: (message, type) => notices.push({ message, type }),
        },
        failures,
      ),
    });
    return {
      session,
      notices,
      status() {
        const text = statuses.get("openai-verbosity");
        return text === undefined ? undefined : stripVTControlCharacters(text);
      },
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

function verbosityModel(id: string, api: "openai-completions" | "openai-responses"): Model<string> {
  return {
    ...fixtureModel,
    id,
    api,
    provider: "verbosity-reef",
    baseUrl: "https://verbosity.invalid/v1",
    samplingParams:
      api === "openai-completions"
        ? {
            verbosity: "medium",
            response_format: {
              type: "json_schema",
              json_schema: { name: format.name, strict: format.strict, schema: format.schema },
            },
          }
        : { text: { format, verbosity: "medium" } },
  };
}

/** Substitute only HTTP: native Pi/OpenAI serializers and SSE parsers run unchanged, with one request allowed per prompt. */
function providerTransport(failures: unknown[]) {
  const requests: Record<string, unknown>[] = [];
  let expected: Model<string> | undefined;
  return {
    requests,
    async fetch(input: string | URL | Request, init?: RequestInit) {
      try {
        assert.ok(expected, "unexpected provider request (including retries)");
        const model = expected;
        expected = undefined;
        const request = new Request(input, init);
        assert.equal(
          request.url,
          `${model.baseUrl}/${model.api === "openai-completions" ? "chat/completions" : "responses"}`,
        );
        assert.equal(request.method, "POST");
        const payload = (await request.json()) as Record<string, unknown>;
        assert.equal(payload.model, model.id);
        requests.push(payload);
        return sseReply(model);
      } catch (error) {
        failures.push(error);
        throw error;
      }
    },
    async prompt(app: Awaited<ReturnType<typeof openSession>>, model: Model<string>) {
      assert.equal(expected, undefined);
      const count = requests.length;
      expected = model;
      try {
        await app.session.prompt("Name the café's night crew 🐙.");
        await app.session.waitForIdle();
        assert.deepEqual(failures, []);
        assert.equal(requests.length, count + 1);
        const answer = app.session.messages.at(-1);
        assert.ok(answer?.role === "assistant");
        assert.equal(answer.stopReason, "stop");
        assert.equal(
          app.session.getLastAssistantText(),
          reply,
          "the native provider must finish successfully",
        );
        return requests[count];
      } finally {
        expected = undefined;
      }
    },
  };
}

/** Minimal successful wire replies; no model generation, account access or network sockets. */
function sseReply(model: Model<string>) {
  const events =
    model.api === "openai-completions"
      ? [
          {
            id: "chat-crew",
            object: "chat.completion.chunk",
            created: 0,
            model: model.id,
            choices: [
              { index: 0, delta: { role: "assistant", content: reply }, finish_reason: null },
            ],
          },
          {
            id: "chat-crew",
            object: "chat.completion.chunk",
            created: 0,
            model: model.id,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          },
        ]
      : [
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { id: "msg-crew", type: "message", role: "assistant", content: [] },
          },
          { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: reply },
          {
            type: "response.completed",
            response: { id: "resp-crew", status: "completed", output: [] },
          },
        ];
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n",
    {
      headers: { "content-type": "text/event-stream" },
    },
  );
}

function assertPayload(payload: Record<string, unknown>, model: Model<string>, verbosity: string) {
  assert.equal(payload.model, model.id);
  assert.equal(payload.stream, true);
  if (model.api === "openai-completions") {
    assert.equal(payload.verbosity, verbosity);
    assert.deepEqual(payload.response_format, {
      type: "json_schema",
      json_schema: { name: format.name, strict: format.strict, schema: format.schema },
    });
    assert.equal(payload.text, undefined, "Chat Completions verbosity belongs at the top level");
  } else {
    assert.deepEqual(payload.text, { format, verbosity }, "preserve the structured-output schema");
    assert.equal(payload.verbosity, undefined, "Responses verbosity belongs inside text");
  }
  assert.ok(JSON.stringify(payload).includes("Name the café's night crew 🐙."));
}

async function readConfig(configPath: string) {
  return JSON.parse(await readFile(configPath, "utf8"));
}
