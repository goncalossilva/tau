import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import { getCurrentSystemPrompt, getCurrentTools, type Tool } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SettingsManager,
  type AgentSession,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { assistantMessage, createPiResources, fixtureModel, isolatePiHome } from "../helpers/pi.js";
import { scriptedProvider, type Generation } from "../helpers/provider.js";

const defaults = [
  { id: "low", when: "mechanical searches and extraction" },
  { id: "medium", when: "bounded edits or tests" },
  { id: "high", when: "non-trivial implementation tasks" },
  { id: "xhigh", when: "resolving substantial uncertainty" },
];
type Guidance = { tool: Tool; prompt: string };

describe("subagent configuration", { concurrency: false }, () => {
  let home: Awaited<ReturnType<typeof isolatePiHome>>;
  let cwd: string;
  let configPath: string;
  let subagent: ExtensionFactory;
  let failures: unknown[];
  let sessions: AgentSession[];
  let previousChild: string | undefined;

  beforeEach(async () => {
    home = await isolatePiHome();
    cwd = await mkdtemp(path.join(os.tmpdir(), "tau-subagent-config-"));
    await mkdir(getAgentDir(), { recursive: true });
    configPath = path.join(getAgentDir(), "subagent.json");
    previousChild = process.env.TAU_SUBAGENT_CHILD;
    delete process.env.TAU_SUBAGENT_CHILD;
    subagent = (await import("../../extensions/subagent/index.js")).default;
    failures = [];
    sessions = [];
    const reject = (...args: unknown[]): never => {
      const error = new Error(`Unexpected external work: ${String(args[0])}`);
      failures.push(error);
      throw error;
    };
    mock.method(globalThis, "fetch", reject);
    for (const method of [
      "spawn",
      "spawnSync",
      "exec",
      "execSync",
      "execFile",
      "execFileSync",
      "fork",
    ] as const)
      mock.method(childProcess, method, reject);
    syncBuiltinESMExports();
  });

  afterEach(async () => {
    try {
      for (const session of sessions) {
        try {
          await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
          await session.abort();
          await session.waitForIdle();
        } finally {
          session.dispose();
        }
      }
      assert.deepEqual(failures, [], "extension errors and unexpected external work must surface");
    } finally {
      mock.restoreAll();
      syncBuiltinESMExports();
      if (previousChild === undefined) delete process.env.TAU_SUBAGENT_CHILD;
      else process.env.TAU_SUBAGENT_CHILD = previousChild;
      await rm(cwd, { recursive: true, force: true });
      await home.dispose();
    }
  });

  test("missing and empty agent configuration retain defaults and ignore project-local files", async () => {
    await mkdir(path.join(cwd, ".pi"));
    for (const location of [cwd, path.join(cwd, ".pi")])
      await writeFile(path.join(location, "subagent.json"), "not agent-global configuration");
    const app = await open();
    const missing = await app.observe();
    for (const text of guidanceText(missing)) {
      for (const { id, when } of defaults) {
        const line = recommendation(text, id);
        assert.ok(line.includes(when));
        assert.ok(line.includes(`thinking=${JSON.stringify(id)}`));
        assert.doesNotMatch(line, /model=/);
      }
      assertOrder(
        text,
        defaults.map(({ id }) => id),
      );
    }
    const schema = missing.tool.parameters;
    assert.ok("properties" in schema && typeof schema.properties === "object" && schema.properties);
    assert.deepEqual(Object.keys(schema.properties).sort(), [
      "action",
      "goal",
      "id",
      "message",
      "model",
      "prompt",
      "thinking",
    ]);
    for (const { when } of defaults)
      assert.ok(!JSON.stringify(missing.tool.parameters).includes(when));

    await configure([]);
    await app.session.reload();
    const empty = await app.observe();
    assert.equal(empty.tool.description, missing.tool.description);
    assert.equal(empty.prompt, missing.prompt);
    assert.deepEqual(empty.tool.parameters, missing.tool.parameters);
  });

  test("merges built-ins by id and appends independent model, thinking, and inheritance recommendations", async () => {
    const app = await open();
    const original = await app.observe();
    const additions = [
      { id: "espresso", when: "Calibrate the grinder", model: "unavailable/lab/espresso-v2" },
      { id: "nap", when: "Count sheep", thinking: "off" },
      { id: "crumb", when: "Sort crumbs", model: "snack/crumb", thinking: "minimal" },
      { id: "reuse-model", when: "Reuse the oven", model: "inherit" },
      { id: "reuse-thinking", when: "Reuse the timer", thinking: "inherit" },
      { id: "reuse-both", when: "Reuse the recipe", model: "inherit", thinking: "inherit" },
    ];
    await configure([
      { id: "high", thinking: "max" },
      { id: " low ", model: " snack/quick/v1 " },
      { id: "xhigh" },
      { id: "medium", when: " Toast rye bread " },
      ...additions.map((entry) => ({ ...entry, id: ` ${entry.id} `, when: ` ${entry.when} ` })),
    ]);
    await app.session.reload();
    const merged = await app.observe();
    assert.deepEqual(
      merged.tool.parameters,
      original.tool.parameters,
      "configuration is guidance only",
    );
    for (const text of guidanceText(merged)) {
      const low = recommendation(text, "low");
      assert.ok(low.includes(defaults[0].when));
      assert.match(low, /thinking="low"/);
      assert.ok(low.includes('model="snack/quick/v1"'));
      const medium = recommendation(text, "medium");
      assert.ok(medium.includes("Toast rye bread"));
      assert.ok(!medium.includes(defaults[1].when));
      assert.match(medium, /thinking="medium"/);
      assert.ok(recommendation(text, "high").includes(defaults[2].when));
      assert.match(recommendation(text, "high"), /thinking="max"/);
      assert.equal(
        recommendation(text, "xhigh"),
        recommendation(original.tool.description, "xhigh"),
      );
      assertOrder(
        text,
        [...defaults, ...additions].map(({ id }) => id),
      );
      for (const entry of additions) {
        const line = recommendation(text, entry.id);
        assert.ok(line.includes(entry.when));
        assert.ok(!line.includes(` ${entry.when} `), "surrounding whitespace is normalized");
        for (const field of ["model", "thinking"] as const) {
          const value = entry[field];
          if (value === "inherit") assert.match(line, new RegExp(`omit ${field} to inherit`));
          else if (value === undefined) assert.ok(!line.includes(field));
          else assert.ok(line.includes(`${field}=${JSON.stringify(value)}`));
        }
      }
    }
  });

  test("disabled recommendations disappear from every guidance surface without disabling the tool", async () => {
    const disabled = [
      ...defaults.map(({ id }) => ({ id, enabled: false })),
      { id: "secret", when: "Guard the secret biscuit", model: "snack/secret", enabled: false },
    ];
    await configure([
      ...disabled,
      { id: "visible", when: "Count visible biscuits", thinking: "low", enabled: true },
    ]);
    const app = await open();
    const filtered = await app.observe();
    for (const text of guidanceText(filtered)) {
      assert.ok(recommendation(text, "visible").includes("Count visible biscuits"));
      assert.doesNotMatch(text, /Guard the secret biscuit|snack\/secret/);
      for (const { when } of defaults) assert.ok(!text.includes(when));
    }
    for (const { when } of defaults)
      assert.ok(!JSON.stringify(filtered.tool.parameters).includes(when));

    await configure(disabled);
    await app.session.reload();
    const none = await app.observe();
    assert.equal(none.tool.name, "subagent");
    for (const text of guidanceText(none)) {
      assert.doesNotMatch(text, /Subagent recommendation "/);
      for (const { when } of defaults) assert.ok(!text.includes(when));
    }
  });

  test("rereads only on reload, restores removed defaults, and keeps simultaneous sessions independent", async () => {
    const first = await open();
    const baseline = await first.observe();
    await configure([
      { id: "low", when: "Inspect the macaroon constellation", model: "stars/map" },
    ]);
    assert.equal((await first.observe()).tool.description, baseline.tool.description);
    await first.session.reload();
    const configured = await first.observe();
    for (const text of guidanceText(configured)) assert.match(text, /macaroon constellation/);
    const secondCwd = path.join(cwd, "second bakery");
    await mkdir(secondCwd);
    const second = await open(secondCwd);
    assert.equal((await second.observe()).tool.description, configured.tool.description);

    await rm(configPath);
    assert.equal((await first.observe()).tool.description, configured.tool.description);
    await first.session.reload();
    const restored = await first.observe();
    assert.equal(restored.tool.description, baseline.tool.description);
    assert.equal(restored.prompt, baseline.prompt);
    assert.equal((await second.observe()).tool.description, configured.tool.description);
    const third = await open();
    assert.equal((await third.observe()).tool.description, baseline.tool.description);
    await second.session.reload();
    const secondRestored = await second.observe();
    assert.equal(secondRestored.tool.description, baseline.tool.description);
    for (const text of guidanceText(secondRestored))
      assert.doesNotMatch(text, /macaroon constellation/);
  });

  test("child loading bypasses an invalid parent configuration and registers no delegation tool", async () => {
    await writeFile(configPath, "{ definitely not JSON");
    process.env.TAU_SUBAGENT_CHILD = "1";
    const app = await open();
    await app.session.prompt("Describe your assignment.");
    const context = app.generations.at(-1)!.context;
    assert.equal(app.session.getToolDefinition("subagent"), undefined);
    assert.ok(!getCurrentTools(context.messages).some(({ name }) => name === "subagent"));
    assert.match(
      getCurrentSystemPrompt(context.messages),
      /Stay within its scope and do not delegate further/,
    );
    await app.session.reload();
    await app.session.prompt("Keep working within scope.");
    assert.equal(app.session.getToolDefinition("subagent"), undefined);
    assert.ok(!app.session.getActiveToolNames().includes("subagent"));
  });

  const invalid: { name: string; value?: unknown; raw?: string; error: RegExp }[] = [
    { name: "invalid JSON", raw: "[{", error: /JSON|property|position/i },
    { name: "object root", value: {}, error: /array/i },
    { name: "null root", value: null, error: /array/i },
    ...[null, [], 42].map((value) => ({
      name: `non-object entry ${JSON.stringify(value)}`,
      value: [value],
      error: /entry 1.*object/i,
    })),
    {
      name: "unknown field",
      value: [{ id: "low", models: "snack/crumb" }],
      error: /entry 1.*models/i,
    },
    { name: "missing id", value: [{ thinking: "high" }], error: /entry 1.*id/i },
    {
      name: "duplicate normalized id",
      value: [{ id: "low" }, { id: " low " }],
      error: /entry 2.*duplicate.*low/i,
    },
    ...["id", "when", "model", "thinking"].flatMap((field) =>
      [null, 17, " \t "].map((value) => ({
        name: `${field} rejects ${JSON.stringify(value)}`,
        value: [{ id: "low", [field]: value }],
        error: new RegExp(`entry 1.*${field}`, "i"),
      })),
    ),
    ...["quick", "/quick", "snack/", "snack/a model", "snack name/model"].map((model) => ({
      name: `invalid model ${model}`,
      value: [{ id: "low", model }],
      error: /entry 1.*model/i,
    })),
    {
      name: "unknown thinking",
      value: [{ id: "low", thinking: "turbo" }],
      error: /entry 1.*thinking/i,
    },
    ...[null, "false", 0].map((enabled) => ({
      name: `non-boolean enabled ${JSON.stringify(enabled)}`,
      value: [{ id: "low", enabled }],
      error: /entry 1.*enabled/i,
    })),
    {
      name: "custom missing when",
      value: [{ id: "macaroon", model: "snack/crumb" }],
      error: /entry 1.*when/i,
    },
    {
      name: "custom missing settings",
      value: [{ id: "macaroon", when: "Bake macaroons" }],
      error: /entry 1.*model.*thinking/i,
    },
    {
      name: "disabled custom missing when",
      value: [{ id: "macaroon", thinking: "low", enabled: false }],
      error: /entry 1.*when/i,
    },
    {
      name: "disabled custom missing settings",
      value: [{ id: "macaroon", when: "Bake macaroons", enabled: false }],
      error: /entry 1.*model.*thinking/i,
    },
  ];
  for (const { name, value, raw, error } of invalid) {
    test(`fails extension loading with actionable diagnostics for ${name}`, async () => {
      await writeFile(configPath, raw ?? JSON.stringify(value));
      const loader = resourceLoader(cwd, [subagent]);
      await loader.reload();
      const result = loader.getExtensions();
      assert.equal(result.errors.length, 1, "invalid configuration must fail extension loading");
      assert.ok(result.errors[0].error.includes(configPath), result.errors[0].error);
      assert.match(result.errors[0].error, error);
      assert.equal(
        result.extensions.length,
        0,
        "a failed extension cannot register a partial tool",
      );
    });
  }

  async function configure(value: unknown) {
    await writeFile(configPath, JSON.stringify(value));
  }

  async function open(sessionCwd = cwd) {
    return openSession(sessionCwd, subagent, sessions, failures);
  }
});

/** Observe actual model declarations and effective prompt. Only generation is substituted. */
async function openSession(
  cwd: string,
  subagent: ExtensionFactory,
  sessions: AgentSession[],
  failures: unknown[],
) {
  const generations: Generation[] = [];
  const resources = await createPiResources(cwd, getAgentDir(), []);
  // The shared fixture replaces the system prompt. Use native prompt construction to observe tool guidelines.
  resources.resourceLoader = resourceLoader(
    cwd,
    [
      subagent,
      scriptedProvider(fixtureModel, (generation) => {
        generations.push(generation);
        return assistantMessage("The biscuits are accounted for.");
      }),
    ],
    resources.settingsManager,
  );
  await resources.resourceLoader.reload();
  assert.deepEqual(resources.resourceLoader.getExtensions().errors, []);
  resources.settingsManager.setProjectTrusted(true);
  const { session } = await createAgentSession({
    ...resources,
    model: fixtureModel,
    tools: process.env.TAU_SUBAGENT_CHILD === "1" ? [] : ["subagent"],
  });
  sessions.push(session);
  await session.bindExtensions({ mode: "print", onError: (error) => failures.push(error) });
  return {
    session,
    generations,
    async observe() {
      const before = generations.length;
      await session.prompt("Review the available delegation guidance.");
      assert.equal(generations.length, before + 1);
      const { messages } = generations.at(-1)!.context;
      const tool = getCurrentTools(messages).find(({ name }) => name === "subagent");
      assert.ok(tool, "the parent exposes the subagent tool");
      return { tool, prompt: getCurrentSystemPrompt(messages) };
    },
  };
}

function resourceLoader(
  cwd: string,
  extensions: ExtensionFactory[],
  settingsManager = SettingsManager.inMemory(),
) {
  return new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: extensions,
  });
}

function guidanceText(guidance: Guidance) {
  return [guidance.tool.description, guidance.prompt];
}

function recommendation(text: string, id: string): string {
  const lines = text
    .split("\n")
    .filter((line) => line.includes(`recommendation ${JSON.stringify(id)} (`));
  assert.equal(lines.length, 1, `one effective recommendation for ${id}`);
  return lines[0].trim().replace(/^- /, "");
}

function assertOrder(text: string, ids: string[]) {
  const positions = ids.map((id) => text.indexOf(recommendation(text, id)));
  assert.ok(positions.every((position, index) => index === 0 || position > positions[index - 1]));
}
