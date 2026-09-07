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
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  getAgentDir,
  initTheme,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import fast from "../extensions/fast.js";
import { createPiResources, fixtureModel, isolatePiHome, uiBoundary } from "./helpers/pi.js";
import { preferenceChild } from "./helpers/preferences.js";

const primary: Model<"openai-completions"> = {
  ...fixtureModel,
  provider: "fast-cafe",
  id: "octopus",
  api: "openai-completions",
  baseUrl: "https://fast.invalid/v1",
  samplingParams: {
    service_tier: "flex",
    temperature: 0.25,
    metadata: { ticket: "café 🐙\nKeep the espresso warm." },
  },
};
const other = { ...primary, provider: "fast-bistro" };
const unsupported: Model<"anthropic-messages"> = {
  ...fixtureModel,
  provider: "fast-unsupported",
  api: "anthropic-messages",
};

describe("fast", { concurrency: false }, () => {
  let home: Awaited<ReturnType<typeof isolatePiHome>> | undefined;
  let clients: Awaited<ReturnType<typeof openFast>>[];
  let failures: unknown[];
  let wire: ReturnType<typeof completionTransport>;
  let configPath: string;
  let children: ReturnType<typeof preferenceChild>[];

  beforeEach(async () => {
    clients = [];
    children = [];
    failures = [];
    home = await isolatePiHome();
    configPath = path.join(getAgentDir(), "fast.json");
    await mkdir(getAgentDir(), { recursive: true });
    wire = completionTransport(failures);
    mock.method(globalThis, "fetch", wire.fetch);
    const rejectProcess = () => {
      const error = new Error("Unexpected subprocess in fast workflow");
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
  });

  afterEach(async () => {
    try {
      const cleanup = await Promise.allSettled([
        ...children.map((child) => child.stop()),
        ...clients.map((client) => client.dispose()),
      ]);
      for (const result of cleanup) {
        if (result.status === "rejected") failures.push(result.reason);
      }
      assert.deepEqual(failures, [], "unexpected work and extension errors must surface");
    } finally {
      mock.restoreAll();
      syncBuiltinESMExports();
      await home?.dispose();
      home = undefined;
    }
  });

  test("persists the selected model's toggle, restores it on reload, and leaves other models and payload fields alone", async () => {
    const untouched = { [key(unsupported)]: "fast" };
    await writeFile(configPath, JSON.stringify({ models: untouched }));
    const client = await openFast(primary, wire, failures);
    clients.push(client);
    assert.equal(client.status(), undefined);
    assert.equal((await client.request()).service_tier, "flex");

    await client.command("/fast  EnAbLeD ");
    assert.equal(client.status(), "fast");
    assert.deepEqual(await config(configPath), {
      models: { ...untouched, [key(primary)]: "fast" },
    });
    assert.equal((await client.request()).service_tier, "priority");
    await client.session.reload();
    assert.equal(client.status(), "fast");
    assert.equal((await client.request()).service_tier, "priority");

    await client.session.setModel(other);
    assert.equal(client.status(), undefined, "same ID on another provider is not opted in");
    assert.equal((await client.request()).service_tier, "flex");
    const saved = await readFile(configPath);
    await client.session.setModel(unsupported);
    assert.equal(client.status(), undefined);
    await client.command("/fast on");
    assert.equal(client.notifications.at(-1)?.type, "warning");
    assert.deepEqual(await readFile(configPath), saved);
    const payload = { messages: [], service_tier: "auto", metadata: { octopus: 8 } };
    assert.deepEqual(
      await client.session.extensionRunner.emitBeforeProviderRequest(payload),
      payload,
      "unsupported APIs are never rewritten",
    );

    await client.session.setModel(primary);
    assert.equal(client.status(), "fast");
    await client.command("/fast");
    assert.equal(client.status(), undefined);
    assert.equal((await client.request()).service_tier, "flex", "off preserves the model's tier");
    assert.deepEqual(await config(configPath), {
      models: { ...untouched, [key(primary)]: "auto" },
    });
    await client.session.reload();
    assert.equal(client.status(), undefined);
    assert.equal((await client.request()).service_tier, "flex");
  });

  test("reports a failed save without claiming the new mode, and recovers after the file obstruction is removed", async () => {
    await writeFile(configPath, JSON.stringify({ models: { [key(primary)]: "fast" } }));
    const client = await openFast(primary, wire, failures);
    clients.push(client);
    const saved = await readFile(configPath);
    await client.command("/fast turbo");
    assert.equal(client.notifications.at(-1)?.type, "error");
    assert.deepEqual(await readFile(configPath), saved, "invalid input must not write settings");

    const backup = `${configPath}.backup`;
    await rename(configPath, backup);
    await mkdir(configPath); // A real EISDIR failure, independent of user privileges.
    await client.command("/fast disabled");
    assert.equal(client.notifications.at(-1)?.type, "error");
    assert.ok(client.notifications.at(-1)?.message.includes(configPath));
    assert.equal(client.status(), "fast", "failed persistence must not publish an off status");
    assert.equal((await client.request()).service_tier, "priority");
    assert.deepEqual(await readFile(backup), saved);

    await rm(configPath, { recursive: true });
    await rename(backup, configPath);
    await client.command("/fast disabled");
    assert.equal(client.notifications.at(-1)?.type, "info");
    assert.equal(client.status(), undefined);
    assert.equal((await client.request()).service_tier, "flex");
    assert.deepEqual(await config(configPath), { models: { [key(primary)]: "auto" } });
    await client.session.reload();
    assert.equal((await client.request()).service_tier, "flex");
  });

  test("preserves independent preferences saved by two already-open sessions", async () => {
    const first = await openFast(primary, wire, failures);
    clients.push(first);
    const second = await openFast(other, wire, failures);
    clients.push(second);

    await first.command("/fast on");
    assert.deepEqual(await config(configPath), { models: { [key(primary)]: "fast" } });
    await second.command("/fast on");
    assert.deepEqual(
      await config(configPath),
      { models: { [key(primary)]: "fast", [key(other)]: "fast" } },
      "a later save must merge, not erase the other session's preference",
    );
    await first.session.reload();
    await second.session.reload();
    assert.equal((await first.request()).service_tier, "priority");
    assert.equal((await second.request()).service_tier, "priority");
  });

  test("independent children merge fresh preferences under contention through a file symlink", async () => {
    const initial = { note: "Keep the café 🐙", models: { untouched: "future-mode" } };
    await writeFile(configPath, JSON.stringify(initial));
    const alias = path.join(getAgentDir(), "alias");
    await mkdir(alias);
    await symlink(configPath, path.join(alias, "fast.json"));
    const first = preferenceChild({
      extension: new URL("../extensions/fast.js", import.meta.url).href,
      command: "fast",
      agentDir: getAgentDir(),
      model: primary,
    });
    children.push(first);
    const second = preferenceChild({
      extension: new URL("../extensions/fast.js", import.meta.url).href,
      command: "fast",
      agentDir: alias,
      model: other,
    });
    children.push(second);
    await Promise.all([first.ready(), second.ready()]);
    const release = await lock(configPath);
    const toggle = first.start("command");
    const enable = second.start("command", "on");
    try {
      await Promise.all([toggle.wait("contended"), enable.wait("contended")]);
      // Both sessions cached no fast preference. The toggle must use this fresh choice under the lock.
      await writeFile(
        configPath,
        JSON.stringify({
          ...initial,
          models: { ...initial.models, [key(primary)]: "fast", late: "auto" },
        }),
      );
    } finally {
      await release();
    }
    const [toggled, enabled] = await Promise.all([toggle.wait(), enable.wait()]);
    assert.equal(toggled.notices?.at(-1)?.type, "info");
    assert.equal(toggled.status, undefined);
    assert.equal((toggled.payload as { service_tier: string }).service_tier, "flex");
    assert.equal(enabled.status, "fast");
    assert.deepEqual(await config(configPath), {
      ...initial,
      models: { ...initial.models, [key(primary)]: "auto", [key(other)]: "fast", late: "auto" },
    });
    assert.equal((await lstat(path.join(alias, "fast.json"))).isSymbolicLink(), true);
    assert.deepEqual(
      (await readdir(getAgentDir())).filter(
        (name) => name.endsWith(".tmp") || name.endsWith(".lock"),
      ),
      [],
    );
  });

  test("a child refuses damaged configuration and cleans a failed atomic publication before retrying", async () => {
    const original = JSON.stringify({ models: { [key(primary)]: "fast", octopus: "fast" } });
    await writeFile(configPath, original);
    const child = preferenceChild({
      extension: new URL("../extensions/fast.js", import.meta.url).href,
      command: "fast",
      agentDir: getAgentDir(),
      model: primary,
    });
    children.push(child);
    await child.ready();
    for (const damaged of ['{"models":', '{"models":[]}']) {
      await writeFile(configPath, damaged);
      const result = await child.start("command", "off").wait();
      assert.equal(result.notices?.at(-1)?.type, "error");
      assert.equal(result.status, "fast");
      assert.equal((result.payload as { service_tier: string }).service_tier, "priority");
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
    const saving = child.start("command", "off");
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
    assert.equal(failed.status, "fast");
    assert.equal((failed.payload as { service_tier: string }).service_tier, "priority");
    assert.equal(await readFile(`${configPath}.backup`, "utf8"), original);
    assert.deepEqual(
      (await readdir(getAgentDir())).filter(
        (name) => name.endsWith(".tmp") || name.endsWith(".lock"),
      ),
      [],
    );
    await rm(configPath, { recursive: true });
    await rename(`${configPath}.backup`, configPath);
    const recovered = await child.start("command", "off").wait();
    assert.equal(recovered.notices?.at(-1)?.type, "info");
    assert.equal(recovered.status, undefined);
    assert.deepEqual(await config(configPath), {
      models: { [key(primary)]: "auto", octopus: "fast" },
    });
    assert.equal((await child.start("reload").wait()).status, undefined);
  });

  test("a child reports lock contention without changing its live choice and recovers a dead owner's stale lock", async () => {
    await writeFile(configPath, JSON.stringify({ models: { [key(primary)]: "fast" } }));
    const options = {
      extension: new URL("../extensions/fast.js", import.meta.url).href,
      command: "fast",
      agentDir: getAgentDir(),
      model: primary,
    };
    const holder = preferenceChild(options);
    children.push(holder);
    const writer = preferenceChild(options);
    children.push(writer);
    await Promise.all([holder.ready(), writer.ready()]);
    await holder.start("lock", configPath).wait();
    const saved = await readFile(configPath);
    const failed = await writer.start("command", "off").wait();
    assert.equal(failed.notices?.at(-1)?.type, "error");
    assert.equal(failed.status, "fast");
    assert.deepEqual(await readFile(configPath), saved);
    await holder.kill();
    await utimes(`${configPath}.lock`, new Date(0), new Date(0));
    const recovered = await writer.start("command", "off").wait();
    assert.equal(recovered.notices?.at(-1)?.type, "info");
    assert.equal(recovered.status, undefined);
    assert.equal((recovered.payload as { service_tier: string }).service_tier, "flex");
    assert.deepEqual(
      (await readdir(getAgentDir())).filter(
        (name) => name.endsWith(".tmp") || name.endsWith(".lock"),
      ),
      [],
    );
  });

  for (const exactOverride of [false, true]) {
    test(`turns off only the current provider when a shared default${exactOverride ? " and exact override" : ""} exists`, async () => {
      await writeFile(
        configPath,
        JSON.stringify({
          models: {
            [primary.id]: "fast",
            ...(exactOverride ? { [key(primary)]: "fast", [` ${key(primary)} `]: "fast" } : {}),
          },
        }),
      );
      const client = await openFast(primary, wire, failures);
      clients.push(client);
      assert.equal((await client.request()).service_tier, "priority");
      await client.command("/fast off");
      const selectedTier = (await client.request()).service_tier;
      const selectedStatus = client.status();
      await client.session.setModel(other);
      const otherTier = (await client.request()).service_tier;
      await client.session.reload();
      const restoredOtherTier = (await client.request()).service_tier;
      await client.session.setModel(primary);
      const restoredSelectedTier = (await client.request()).service_tier;

      assert.deepEqual(
        { selectedTier, selectedStatus, otherTier, restoredOtherTier, restoredSelectedTier },
        {
          selectedTier: "flex",
          selectedStatus: undefined,
          otherTier: "priority",
          restoredOtherTier: "priority",
          restoredSelectedTier: "flex",
        },
        "one off command must stop this provider's priority requests without changing the shared default",
      );
      assert.deepEqual(await config(configPath), {
        models: {
          [primary.id]: "fast",
          [key(primary)]: "auto",
          ...(exactOverride ? { [` ${key(primary)} `]: "fast" } : {}),
        },
      });
      await client.command("/fast");
      assert.equal((await client.request()).service_tier, "priority");
    });
  }
});

/**
 * Use Pi's real command dispatcher, reload lifecycle, model runtime and Chat Completions serializer.
 * Only status/notification delivery and HTTP are adapted; this is not CLI/PTY or live billing coverage.
 */
async function openFast(
  model: Model<Api>,
  wire: ReturnType<typeof completionTransport>,
  failures: unknown[],
) {
  const before: Record<string, unknown>[] = [];
  const provider: ExtensionFactory = (pi) => {
    for (const model of [primary, other, unsupported]) {
      pi.registerProvider(model.provider, {
        api: model.api,
        baseUrl: model.baseUrl,
        apiKey: "fixture-only",
        models: [model],
      });
    }
    pi.on("before_provider_request", (event) => {
      before.push(JSON.parse(JSON.stringify(event.payload)));
    });
  };
  const cwd = path.join(getAgentDir(), "work");
  await mkdir(cwd, { recursive: true });
  const resources = await createPiResources(cwd, getAgentDir(), [provider, fast]);
  const { session } = await createAgentSession({ ...resources, model, tools: [] });
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
    const notifications: { message: string; type: string | undefined }[] = [];
    await session.bindExtensions({
      mode: "tui",
      onError: (error) => failures.push(error),
      uiContext: uiBoundary(
        {
          theme: session.extensionRunner.getUIContext().theme,
          setStatus: (key, value) => statuses.set(key, value),
          notify: (message, type) => notifications.push({ message, type }),
        },
        failures,
      ),
    });
    return {
      session,
      notifications,
      status: () => {
        const value = statuses.get("fast");
        return value === undefined ? undefined : stripVTControlCharacters(value);
      },
      async command(text: string) {
        const history = structuredClone(session.sessionManager.getEntries());
        const requests = wire.requests.length;
        await session.prompt(text, { source: "interactive" });
        await session.waitForIdle();
        assert.deepEqual(
          session.sessionManager.getEntries(),
          history,
          "commands stay out of history",
        );
        assert.equal(wire.requests.length, requests, "commands must not call the model");
        assert.deepEqual(failures, []);
      },
      async request() {
        wire.allowRequest();
        const count = wire.requests.length;
        await session.prompt("Keep the café open.\nNo octopus overtime. 🐙");
        await session.waitForIdle();
        assert.deepEqual(failures, []);
        assert.equal(wire.requests.length, count + 1);
        assert.equal(session.getLastAssistantText(), "Espresso ready. 🐙");
        const payload = wire.requests.at(-1)!;
        assert.equal(payload.model, session.model?.id);
        assert.deepEqual(
          payload,
          { ...before.at(-1), service_tier: payload.service_tier },
          "fast may change only service_tier in the serialized request",
        );
        return payload;
      },
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

/** Allow one explicitly requested HTTP call at a time and feed native Pi/OpenAI parsing a finite SSE reply. */
function completionTransport(failures: unknown[]) {
  const requests: Record<string, unknown>[] = [];
  let allowed = false;
  return {
    requests,
    allowRequest() {
      assert.equal(allowed, false, "the previous request must complete first");
      allowed = true;
    },
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      try {
        const request = new Request(input, init);
        assert.equal(allowed, true, "unexpected HTTP request");
        allowed = false;
        assert.equal(request.url, "https://fast.invalid/v1/chat/completions");
        assert.equal(request.method, "POST");
        assert.equal(request.headers.get("authorization"), "Bearer fixture-only");
        const payload = await request.json();
        assert.ok(payload && typeof payload === "object" && !Array.isArray(payload));
        requests.push(payload as Record<string, unknown>);
        const chunk = {
          id: "espresso-reply",
          object: "chat.completion.chunk",
          created: 0,
          model: "octopus",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "Espresso ready. 🐙" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
        };
        return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
          headers: { "content-type": "text/event-stream" },
        });
      } catch (error) {
        failures.push(error);
        throw error;
      }
    },
  };
}

function key(model: Pick<Model<Api>, "provider" | "id">) {
  return `${model.provider}/${model.id}`;
}

async function config(configPath: string): Promise<{ models: Record<string, string> }> {
  return JSON.parse(await readFile(configPath, "utf8"));
}
