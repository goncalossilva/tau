import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { findPackageJSON } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

const oracle = path.join(
  path.dirname(findPackageJSON(import.meta.url)!),
  "skills/oracle/scripts/oracle",
);
const astra = "openai-codex/gpt-6-astra";
const sol = "openai-codex/gpt-5.6-sol";
const fable = "anthropic/claude-fable-5-1";
const gemini = "google/gemini-3.1-pro";
const prompt = "Review the moon café's launch checklist.";
const checklist = "Pack eight tiny espresso cups. 🐙\n";

describe("oracle model selection", () => {
  let directory: string;
  let cwd: string;
  let agentDir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "tau-oracle-"));
    cwd = path.join(directory, "moon café");
    const home = path.join(directory, "home");
    agentDir = path.join(home, ".pi", "agent");
    const bin = path.join(directory, "bin");
    await Promise.all([cwd, agentDir, bin].map((dir) => mkdir(dir, { recursive: true })));
    await writeFile(path.join(cwd, "checklist.txt"), checklist);
    await writeFile(path.join(bin, "pi"), fakePi, { mode: 0o755 });
    // Only the fixture Pi and the actual bundler's local utilities are reachable through PATH.
    for (const [name, executable] of Object.entries({
      node: process.execPath,
      bash: "/bin/bash",
      git: "/usr/bin/git",
      cat: "/bin/cat",
      sort: "/usr/bin/sort",
      stat: "/usr/bin/stat",
      wc: "/usr/bin/wc",
      tr: "/usr/bin/tr",
    })) {
      await symlink(executable, path.join(bin, name));
    }
    env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      PI_CODING_AGENT_DIR: agentDir,
      PATH: bin,
    };
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  for (const scenario of [
    { name: "both enabled", enabled: [sol, astra], expected: astra },
    { name: "neither enabled", enabled: [], expected: astra },
    { name: "only Sol enabled", enabled: [sol], expected: sol },
  ]) {
    test(`chooses the expected OpenAI oracle with ${scenario.name}`, async () => {
      await configure([sol, astra], scenario.enabled);
      const result = ask(["--current", fable]);
      assert.equal(result.model, scenario.expected);
      assert.match(result.input, /Review the moon café's launch checklist\./);
      assert.ok(
        result.input.includes(checklist),
        "the real file bundle reaches the selected model",
      );
    });
  }

  for (const scenario of [
    {
      name: "model rank before provider priority",
      models: [sol, "openai/gpt-6-astra"],
      expected: "openai/gpt-6-astra",
    },
    {
      name: "Codex provider priority for equally ranked Astra models",
      models: ["openai/gpt-6-astra", astra],
      expected: astra,
    },
  ]) {
    test(`preserves ${scenario.name}`, async () => {
      await configure(scenario.models, scenario.models);
      assert.equal(ask(["--current", fable]).model, scenario.expected);
    });
  }

  for (const scenario of [
    {
      name: "Fable first from Astra",
      current: astra,
      models: [astra, gemini, fable],
      expected: fable,
    },
    {
      name: "Gemini fallback from Astra",
      current: astra,
      models: [astra, gemini],
      expected: gemini,
    },
    {
      name: "OpenAI first from Gemini",
      current: gemini,
      models: [sol, astra, fable, gemini],
      expected: astra,
    },
    {
      name: "same-family fallback when no alternate family is available",
      current: astra,
      models: [sol, astra],
      expected: astra,
    },
  ]) {
    test(`preserves family order: ${scenario.name}`, async () => {
      await configure(scenario.models, [astra]);
      assert.equal(ask(["--current", scenario.current]).model, scenario.expected);
    });
  }

  test("honors an explicit Sol override despite enabled Astra and different-family preference", async () => {
    await configure([sol, astra, fable], [astra]);
    assert.equal(ask(["--current", astra, "--model", sol]).model, sol);
  });

  /** Use a disposable Pi configuration and a text catalog; discovery and authentication never run. */
  async function configure(models: string[], enabledModels: string[]) {
    await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ enabledModels }));
    const catalog = [
      "provider  model  context  max-out  thinking  images",
      ...models.map((spec) => `${spec.replace("/", "  ")}  200K  32K  yes  yes`),
      "",
    ].join("\n");
    await writeFile(path.join(directory, "catalog.txt"), catalog);
    env.ORACLE_TEST_CATALOG = path.join(directory, "catalog.txt");
  }

  /** Run the shipped wrapper and bundler, asserting the model actually passed to the fake print-mode Pi. */
  function ask(args: string[]): { model: string; input: string } {
    const result = spawnSync(
      process.execPath,
      [oracle, ...args, "-p", prompt, "--file", "checklist.txt"],
      {
        cwd,
        env,
        encoding: "utf8",
        timeout: 5000,
        killSignal: "SIGKILL",
      },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  }
});

/** Replace only Pi catalog output and model generation, rejecting any other CLI work. This is not live-Pi coverage. */
const fakePi = `#!/usr/bin/env node
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--list-models") {
  process.stdout.write(readFileSync(process.env.ORACLE_TEST_CATALOG, "utf8"));
} else {
  const allowed = new Set(["-p", "--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes"]);
  let model;
  let thinking;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--model") model = args[++index];
    else if (arg === "--thinking") thinking = args[++index];
    else assert.ok(allowed.delete(arg), "Unexpected Pi argument: " + arg);
  }
  assert.equal(allowed.size, 0, "Expected isolated print mode");
  assert.ok(model, "Expected an explicit model selection");
  assert.equal(thinking, "max");
  process.stdout.write(JSON.stringify({ model, input: readFileSync(0, "utf8") }));
}
`;
