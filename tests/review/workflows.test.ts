import assert from "node:assert/strict";
import { Type } from "typebox";
import childProcess, { type ChildProcess, type SpawnOptions } from "node:child_process";
import { once } from "node:events";
import fs, { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import timers, { setImmediate } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import {
  contentText,
  getCurrentTools,
  type AssistantMessage,
  type ImageContent,
  type JsonObject,
  type Model,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  defineTool,
  CustomEditor,
  getSelectListTheme,
  initTheme,
  SessionManager,
  type ExtensionFactory,
  type ExtensionUIContext,
  type KeybindingsManager as AppKeybindingsManager,
  type TerminalInputHandler,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  getKeybindings,
  isKeyRelease,
  setKeybindings,
  KeybindingsManager,
  TUI_KEYBINDINGS,
  TuiMainScreen,
  Text,
  visibleWidth,
  type Component,
  type Terminal,
} from "@earendil-works/pi-tui";
import review from "../../extensions/review/index.js";
import subagent from "../../extensions/subagent/index.js";
import type {
  FocusFinding,
  ReviewMessageDetails,
  ReviewExecution,
} from "../../extensions/review/schema.js";
import { assistantMessage, createPiResources, getPiCliPath, uiBoundary } from "../helpers/pi.js";
import { alternateReviewModel, providerPath, reviewModel } from "./provider.js";
import { startLlamaRouter } from "./llama.js";
import { scriptedProvider, type Generation } from "../helpers/provider.js";
import { holdShellWork } from "../helpers/shell.js";
import { deadline } from "../helpers/async.js";
import { openSelector } from "../helpers/dialog.js";

const spawn = childProcess.spawn;
const execFileSync = childProcess.execFileSync;
const finding: FocusFinding = {
  priority: "P1",
  location: "café.ts:1",
  finding: "The octopus accepts expired tickets | after midnight.\nGuests enter for free.",
  suggestion: "Reject expired tickets before opening the gate.",
};
const image: ImageContent = {
  type: "image",
  mimeType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNocDjwHwAFRAKAb2WvNQAAAABJRU5ErkJggg==",
};
const allFocuses = ["general", "security", "reuse", "quality", "testing", "efficiency"];

describe("review", { concurrency: false }, () => {
  let directory: string;
  let cwd: string;
  let agentDir: string;
  let previousAgentDir: string | undefined;
  let app: Awaited<ReturnType<typeof openReview>> | undefined;
  let failures: unknown[];
  let children: { process: ChildProcess; closed: Promise<unknown>; hasClosed: boolean }[];
  let generations: ChildGeneration[];
  let respond: (request: ChildGeneration) => AssistantMessage | Promise<AssistantMessage>;
  let responderWork: Promise<void>[];
  let shellCommand: string | undefined;
  let llama: Awaited<ReturnType<typeof startLlamaRouter>> | undefined;
  let isolation: { args: string[]; tools: string[]; commands: string[]; activeTools: string[] }[];

  beforeEach(async () => {
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    failures = [];
    children = [];
    generations = [];
    responderWork = [];
    shellCommand = undefined;
    llama = undefined;
    isolation = [];
    directory = await mkdtemp(path.join(os.tmpdir(), "tau-review-workflows-"));
    agentDir = path.join(directory, "agent");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await mkdir(agentDir, { recursive: true });
    cwd = path.join(directory, "work");
    await mkdir(path.join(cwd, ".pi"), { recursive: true });
    await writeFile(path.join(cwd, "café.ts"), "export const acceptsExpired = true;\n");
    await writeFile(
      path.join(cwd, "REVIEW_GUIDELINES.md"),
      "Keep café tickets valid; preserve $& literally.\n",
    );
    git(cwd, "init", "-b", "main");
    git(cwd, "add", ".");
    git(
      cwd,
      "-c",
      "user.name=Octopus",
      "-c",
      "user.email=octopus@example.invalid",
      "commit",
      "-m",
      "Open the café",
    );
    respond = () => {
      throw new Error("Unexpected review generation");
    };
    const reject = (...args: unknown[]) => {
      const error = new Error(`Unexpected external work: ${String(args[0])}`);
      failures.push(error);
      throw error;
    };
    mock.method(globalThis, "fetch", reject);
    for (const method of [
      "spawnSync",
      "exec",
      "execSync",
      "execFile",
      "execFileSync",
      "fork",
    ] as const) {
      mock.method(childProcess, method, reject);
    }
    const cli = await getPiCliPath();
    // Resolve `pi` to the pinned executable and add only the offline provider/network guard.
    // Git and the child's JSON protocol, native tools and durable sessions remain real.
    mock.method(childProcess, "spawn", (command: string, args: string[], options: SpawnOptions) => {
      assert.equal(options.cwd, cwd, "repository work belongs to the owning session cwd");
      if (command === "git") {
        let subcommand = args[0];
        if (subcommand === "--no-optional-locks") {
          assert.deepEqual(args.slice(0, 3), [
            "--no-optional-locks",
            "-c",
            "diff.autoRefreshIndex=false",
          ]);
          subcommand = args[3];
        }
        if (
          [
            "rev-parse",
            "branch",
            "diff",
            "ls-files",
            "hash-object",
            "status",
            "symbolic-ref",
            "merge-base",
          ].includes(subcommand)
        ) {
          return spawn(command, args, options);
        }
      }
      if (command !== "pi") return reject(command);
      if (!args.includes("rpc")) {
        for (const flag of [
          "--no-extensions",
          "--no-skills",
          "--no-prompt-templates",
          "--no-themes",
        ])
          assert.ok(args.includes(flag));
        assert.equal(args.includes("builtin:llama.cpp"), Boolean(llama));
      }
      assert.ok(Array.isArray(options.stdio));
      const rpc = args[0] === "--mode" && args[1] === "rpc";
      const proc = spawn(
        process.execPath,
        rpc
          ? [
              cli,
              ...args,
              "--offline",
              "--no-extensions",
              "--no-context-files",
              "--no-skills",
              "--no-prompt-templates",
              "--no-themes",
              "--extension",
              providerPath,
            ]
          : [
              cli,
              ...args.slice(0, -1),
              "--extension",
              providerPath,
              "--no-context-files",
              args.at(-1)!,
            ],
        {
          ...options,
          env: {
            ...options.env,
            PI_CODING_AGENT_DIR: rpc
              ? options.env?.PI_CODING_AGENT_DIR
              : path.join(directory, "child-agent"),
            ...(shellCommand ? { TAU_REVIEW_TEST_BASH: shellCommand } : {}),
            ...(llama ? { TAU_REVIEW_LLAMA_URL: llama.url } : {}),
          },
          stdio: rpc ? options.stdio : [...options.stdio, "ipc"],
        },
      );
      const closed = once(proc, "close");
      const child = { process: proc, closed, hasClosed: false };
      void closed.then(
        () => {
          child.hasClosed = true;
        },
        (error) => failures.push(error),
      );
      children.push(child);
      proc.on(
        "message",
        (
          message: Generation & {
            type: string;
            error?: string;
            tools: string[];
            commands: string[];
            activeTools: string[];
          },
        ) => {
          if (message.type === "isolation") {
            isolation.push({
              args,
              tools: message.tools,
              commands: message.commands,
              activeTools: message.activeTools,
            });
            return;
          }
          if (message.type !== "generation") {
            failures.push(message);
            return;
          }
          const request = { ...message, args, process: proc };
          generations.push(request);
          const work = Promise.resolve()
            .then(() => respond(request))
            .then((reply) => {
              if (proc.connected) proc.send(reply);
            })
            .catch((error) => {
              failures.push(error);
              if (proc.connected)
                proc.send({
                  ...assistantMessage(""),
                  stopReason: "error",
                  errorMessage: String(error),
                });
            });
          responderWork.push(work);
        },
      );
      return proc;
    });
    syncBuiltinESMExports();
  });

  afterEach(async () => {
    try {
      try {
        await app?.dispose();
      } finally {
        for (const child of children) {
          if (child.process.exitCode === null && child.process.signalCode === null)
            child.process.kill("SIGKILL");
        }
        await Promise.all(children.map((child) => child.closed));
        await Promise.all(responderWork);
      }
      assert.deepEqual(failures, [], "unexpected work and extension errors must surface");
    } finally {
      app = undefined;
      mock.restoreAll();
      syncBuiltinESMExports();
      try {
        await llama?.dispose();
      } finally {
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        await rm(directory, { recursive: true, force: true });
      }
    }
  });

  test("isolates native llama.cpp focus and dedup workers while retaining the selected provider", async () => {
    let focusCount = 0;
    const reply = (tools: string[]): { tool?: string; payload: JsonObject } => {
      if (tools.includes("submit_review"))
        return {
          tool: "submit_review",
          payload: {
            findings: [{ ...finding, finding: `${finding.finding} Focus ${++focusCount}.` }],
          },
        };
      assert.deepEqual(tools, []);
      return { payload: { groups: [{ ids: [1, 2], reason: "same expiry check" }] } };
    };
    llama = await startLlamaRouter(directory, cwd, failures, (request) =>
      reply(request.tools?.map((tool) => tool.function.name) ?? []),
    );
    const model = await llama.discover();
    const agentDir = path.join(directory, "child-agent");
    const marker = path.join(directory, "unrelated-activation");
    await mkdir(path.join(agentDir, "extensions"), { recursive: true });
    await writeFile(
      path.join(agentDir, "extensions", "unrelated.ts"),
      `import { writeFileSync } from 'node:fs'; export default function () { writeFileSync(${JSON.stringify(marker)}, 'extension'); }`,
    );
    await writeFile(
      path.join(agentDir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          unrelated: {
            command: process.execPath,
            args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'mcp')`],
            exposure: "codemode",
          },
        },
      }),
    );
    app = await openReview(directory, cwd, failures, [], undefined, undefined, undefined, model);
    await app.run("/review commit HEAD focus=general,security");
    assert.equal(
      app.report().details.findings.length,
      1,
      "deduplication must execute, not fall back silently",
    );
    assert.equal(focusCount, 2);
    assert.equal(isolation.length, 3, "two focus children and one dedup child");
    for (const worker of isolation) {
      if (worker.args.includes("--no-tools")) assert.deepEqual(worker.activeTools, []);
      else assert.ok(worker.activeTools.includes("submit_review"));
      assert.ok(!worker.activeTools.includes("submit_triage"));
      assert.ok(!worker.tools.includes("codemode") && !worker.tools.includes("tool_search"));
      assert.ok(!worker.commands.includes("mcp"));
      assert.ok(!worker.activeTools.includes("subagent"));
      assert.ok(!worker.commands.includes("review") && !worker.commands.includes("triage"));
      assert.ok(worker.commands.includes("llama"));
    }
    assert.equal(
      llama.requests.length,
      3,
      "submission terminates each worker without another inference",
    );
    assert.equal(app.mainRequests.length, 0);
    await assert.rejects(readFile(marker), { code: "ENOENT" });
  });

  test("runs every saved model against every saved focus with normalized defaults", async () => {
    const patterns = [`${reviewModel.provider}/${reviewModel.id}:off`, "octo*:high"];
    const focuses = ["general", "security"];
    await writeFile(
      path.join(agentDir, "review.json"),
      JSON.stringify({
        models: [`  ${patterns[0]}  `, patterns[1], patterns[0]],
        focuses: [" General \t", " SECURITY ", "general"],
      }),
    );
    respond = ({ args, model, context }) => {
      assertReviewPrompt(
        contentText(context.messages.find((message) => message.role === "user")!.content),
        "diff",
      );
      const thinking = model.provider === reviewModel.provider ? "off" : "high";
      assert.equal(args[args.indexOf("--model") + 1], `${model.provider}/${model.id}:${thinking}`);
      return submit([]);
    };
    app = await openReview(
      directory,
      cwd,
      failures,
      [],
      undefined,
      undefined,
      undefined,
      reviewModel,
      {
        extensions: [
          scriptedProvider(alternateReviewModel, () => {
            throw new Error("Review must not generate in the main session");
          }),
        ],
        tools: [],
      },
    );
    await app.run("/review commit HEAD");

    assert.deepEqual(
      app.report().details.focusStatus.map(({ model, focus, ok }) => [model, focus, ok]),
      patterns.flatMap((pattern) => focuses.map((focus) => [pattern, focus, true])),
    );
    const signature = JSON.parse(app.report().details.request.signature);
    assert.deepEqual(signature.models, [...patterns].sort());
    assert.deepEqual(signature.focuses, focuses);
    assert.equal(generations.length, 4, "duplicates must not add matrix workers");
    for (const model of [reviewModel, alternateReviewModel]) {
      const requests = generations.filter((request) => request.model.provider === model.provider);
      assert.equal(requests.length, 2);
      assert.ok(requests.every((request) => request.model.id === model.id));
      assert.equal(
        requests.filter((request) => request.args.at(-1)!.includes("specializing in security"))
          .length,
        1,
      );
    }
    assert.deepEqual(app.report().details.findings, []);
    assert.equal(app.mainRequests.length, 0);
  });

  test("overrides saved settings independently and normalizes config and CLI aliases", async () => {
    const configPath = path.join(agentDir, "review.json");
    const primary = `${reviewModel.provider}/${reviewModel.id}`;
    const alternate = `${alternateReviewModel.provider}/${alternateReviewModel.id}`;
    await writeFile(configPath, JSON.stringify({ models: [alternate], focuses: ["security"] }));
    app = await openConfiguredReview();
    const savedSignature = await runConfiguredReview("", [alternate], ["security"]);
    await writeFile(
      configPath,
      JSON.stringify({ model: [` ${alternate} `, alternate], focus: [" Security ", "security"] }),
    );
    assert.equal(await runConfiguredReview("", [alternate], ["security"]), savedSignature);
    const modelOverride = await runConfiguredReview(`models=${primary}`, [primary], ["security"]);
    assert.equal(
      await runConfiguredReview(`model=${primary}`, [primary], ["security"]),
      modelOverride,
    );
    const focusOverride = await runConfiguredReview("focuses=general", [alternate], ["general"]);
    assert.equal(
      await runConfiguredReview("focus=general", [alternate], ["general"]),
      focusOverride,
    );
  });

  test("reloads live edits and clears saved settings for omitted defaults", async () => {
    const configPath = path.join(agentDir, "review.json");
    const primary = `${reviewModel.provider}/${reviewModel.id}`;
    const alternate = `${alternateReviewModel.provider}/${alternateReviewModel.id}`;
    await writeFile(configPath, JSON.stringify({ models: [alternate], focuses: ["security"] }));
    app = await openConfiguredReview();
    await runConfiguredReview("focuses=all", [alternate], allFocuses);
    await writeFile(configPath, JSON.stringify({ models: [primary], focuses: ["testing"] }));
    await runConfiguredReview("", [primary], ["testing"]);

    await app.session.setModel(alternateReviewModel);
    for (const config of [undefined, {}, { models: [] }, { model: [] }]) {
      if (config === undefined) await rm(configPath);
      else await writeFile(configPath, JSON.stringify(config));
      await runConfiguredReview("", [], allFocuses);
    }
  });

  test("reloads partial configs and their aliases without retaining omitted settings", async () => {
    const configPath = path.join(agentDir, "review.json");
    const primary = `${reviewModel.provider}/${reviewModel.id}`;
    app = await openConfiguredReview();
    await app.session.setModel(alternateReviewModel);
    await writeFile(configPath, JSON.stringify({ focuses: ["quality"] }));
    const focusOnly = await runConfiguredReview("", [], ["quality"]);
    await writeFile(configPath, JSON.stringify({ focus: ["quality"] }));
    assert.equal(await runConfiguredReview("", [], ["quality"]), focusOnly);

    await writeFile(configPath, JSON.stringify({ models: [primary] }));
    const modelOnly = await runConfiguredReview("", [primary], allFocuses);
    await writeFile(configPath, JSON.stringify({ model: [primary] }));
    assert.equal(await runConfiguredReview("", [primary], allFocuses), modelOnly);

    await writeFile(configPath, JSON.stringify({ focuses: [" Security ", " ALL ", "all"] }));
    await runConfiguredReview("", [], allFocuses);
  });

  test("reuses bare and context-only fixes but matches explicit fixes against effective defaults", async () => {
    const configPath = path.join(agentDir, "review.json");
    const primary = `${reviewModel.provider}/${reviewModel.id}`;
    const alternate = `${alternateReviewModel.provider}/${alternateReviewModel.id}`;
    await writeFile(path.join(cwd, "new-ticket.txt"), "The octopus needs an auto-scoped review.\n");
    await writeFile(configPath, JSON.stringify({ models: [alternate], focuses: ["general"] }));
    respond = () => submit([]);
    app = await openReview(
      directory,
      cwd,
      failures,
      [],
      undefined,
      undefined,
      undefined,
      reviewModel,
      {
        extensions: [
          scriptedProvider(alternateReviewModel, () => {
            throw new Error("Review must not generate in the main session");
          }),
        ],
        tools: [],
      },
    );
    await app.run("/review");
    const saved = app.report();
    await writeFile(configPath, JSON.stringify({ models: [primary], focuses: ["security"] }));
    for (const command of ["/fix", '/fix context="Keep the café open 🐙"']) {
      await app.session.prompt(command);
      await app.settle();
      assert.equal(
        generations.length,
        1,
        "implicit fixes retain the last report despite changed defaults",
      );
      assert.deepEqual(app.report(), saved);
    }

    await app.session.prompt("/fix focus=general");
    await app.settle();
    assert.equal(generations.length, 2, "explicit focus compares the effective defaults");
    const fresh = app.report();
    assert.deepEqual(JSON.parse(fresh.details.request.signature).models, [primary]);
    await app.session.prompt('/fix focus=general context="Preserve the garnish"');
    await app.settle();
    assert.equal(generations.length, 2, "unchanged defaults match without another paid review");
    assert.deepEqual(app.report(), fresh);

    await app.session.prompt("/fix auto");
    await app.settle();
    assert.equal(generations.length, 3, "explicit target compares the effective focus default");
    assert.deepEqual(JSON.parse(app.report().details.request.signature).focuses, ["security"]);
    const security = app.report();
    await app.session.prompt('/fix auto context="Preserve the garnish"');
    await app.settle();
    assert.equal(generations.length, 3, "unchanged saved focuses match without another review");
    assert.deepEqual(app.report(), security);

    await writeFile(configPath, JSON.stringify({ models: [primary], focuses: ["testing"] }));
    await app.session.prompt("/fix auto");
    await app.settle();
    assert.equal(generations.length, 4, "changing only default focuses refreshes an explicit fix");
    assert.deepEqual(JSON.parse(app.report().details.request.signature).focuses, ["testing"]);

    await writeFile(configPath, JSON.stringify({ models: [alternate], focuses: ["testing"] }));
    await app.session.prompt("/fix auto");
    await app.settle();
    assert.equal(generations.length, 5, "explicit target also compares effective model defaults");
    assert.deepEqual(JSON.parse(app.report().details.request.signature).models, [alternate]);
    await app.session.prompt(`/fix auto models=${primary}`);
    await app.settle();
    assert.equal(generations.length, 6, "explicit models still use the saved focus default");
    const signature = JSON.parse(app.report().details.request.signature);
    assert.deepEqual(signature.models, [primary]);
    assert.deepEqual(signature.focuses, ["testing"]);
    const savedTesting = app.report();
    await writeFile(configPath, JSON.stringify({ model: [primary], focus: ["testing"] }));
    for (const command of [
      "/fix auto",
      `/fix auto model=${primary} focus=testing`,
      `/fix auto models=${primary} focuses=testing`,
    ]) {
      await app.session.prompt(command);
      await app.settle();
      assert.equal(generations.length, 6, "aliases reuse the same effective review request");
      assert.deepEqual(app.report(), savedTesting);
    }
    assert.equal(app.reports().length, 6);
    assert.equal(app.mainRequests.length, 0, "clean reports never queue a fix generation");
    assert.ok(app.notifications.some(({ message }) => /Nothing to fix/.test(message)));
  });

  test("validates the whole config unless both settings are explicit, without affecting help or triage", async () => {
    const configPath = path.join(agentDir, "review.json");
    const primary = `${reviewModel.provider}/${reviewModel.id}`;
    app = await openReview(directory, cwd, failures);
    const invalid = [
      "{",
      "null",
      "[]",
      '"octopus"',
      JSON.stringify({ models: reviewModel.id }),
      JSON.stringify({ model: reviewModel.id }),
      JSON.stringify({ focusses: ["general"] }),
      ...[null, {}, 7, [7], [" \t"], ["reply,octopus"]].flatMap((models) =>
        ["models", "model"].map((field) => JSON.stringify({ [field]: models })),
      ),
      ...[
        { models: [primary], model: [reviewModel.id] },
        { models: [primary], model: [primary] },
        { models: [primary], model: null },
        { models: null, model: [primary] },
        { focuses: ["general"], focus: ["security"] },
        { focuses: ["general"], focus: ["general"] },
        { focuses: ["general"], focus: null },
        { focuses: null, focus: ["general"] },
      ].map((config) => JSON.stringify(config)),
      ...[
        [],
        null,
        {},
        "security",
        7,
        [7],
        [" \t"],
        ["octopus"],
        ["general", "octopus"],
        ["all", "octopus"],
        ["general,security"],
        ["all,"],
      ].flatMap((focuses) =>
        ["focuses", "focus"].map((field) =>
          JSON.stringify({ models: [primary], [field]: focuses }),
        ),
      ),
    ];
    for (const config of invalid) {
      await writeFile(configPath, config);
      for (const command of [
        "/review commit HEAD",
        `/review commit HEAD models=${primary}`,
        "/fix focus=general",
      ]) {
        const before = app.notifications.length;
        await app.session.prompt(command);
        await app.settle();
        const notices = app.notifications.slice(before);
        assert.equal(notices.length, 1, `${command}: ${config}`);
        assert.equal(notices[0].type, "error", `${command}: ${config}`);
        assert.ok(notices[0].message.includes(`Invalid review config at ${configPath}:`), config);
        assert.equal(children.length, 0, "invalid defaults must not start workers");
        assert.equal(app.reports().length, 0);
      }
    }
    await app.session.prompt('/review commit HEAD focus=general models=""');
    await app.settle();
    assert.equal(
      app.notifications.at(-1)!.type,
      "error",
      "empty CLI models do not bypass defaults",
    );
    const errors = app.notifications.filter(({ type }) => type === "error").length;
    for (const command of ["/review help", "/fix help", "/fix loop help", "/triage help"]) {
      await app.session.prompt(command);
      await app.settle();
      const entry: SessionEntry = app.reports().at(-1)!;
      assert.equal(entry.type, "custom_message");
      assert.equal((entry.details as { kind: string }).kind, "help");
    }
    assert.equal(children.length, 0);
    await app.session.prompt("/triage not-an-octopus-pr");
    await app.settle();
    assert.match(app.notifications.at(-1)!.message, /Invalid PR reference/);
    assert.equal(app.notifications.at(-1)!.message.includes(configPath), false);

    respond = () => submit([]);
    for (const config of [invalid.at(-1)!, "{"]) {
      await writeFile(configPath, config);
      const before = generations.length;
      await app.run(`/review commit HEAD focus=general models=${primary}`);
      await app.session.prompt(`/fix commit HEAD focus=general models=${primary}`);
      await app.settle();
      assert.equal(
        generations.length - before,
        1,
        "both overrides bypass invalid defaults and then match the report",
      );
    }
    assert.equal(app.notifications.filter(({ type }) => type === "error").length, errors + 1);
    assert.equal(app.mainRequests.length, 0);
  });

  test("aggregates partial reviews, retries missing submission in the same session, and durably deduplicates findings", async () => {
    await writeFile(path.join(cwd, "new-ticket.txt"), "The jellyfish brought a +1.\n");
    const secondary = {
      ...finding,
      priority: "P2" as const,
      location: "new-ticket.txt:1",
      finding: "A guest count is missing.",
      suggestion: "Count the +1.",
    };
    respond = ({ args, context }) => {
      const initialPrompt = args.at(-1)!;
      if (args.includes("--no-tools")) {
        assert.match(app!.view(), /^ Review · [\u2800-\u28ff] deduplicating/u);
        assert.equal(app!.lines().length, 1, "finalization uses the same compact heading");
        assert.match(app!.activity()!, /^review deduplicating/);
        app!.handleActivity(true);
        assert.deepEqual(app!.lines(), [], "deduplication participates in collapsed activity");
        app!.ui.setToolsExpanded(true);
        assert.match(app!.view(), /^ Review · [\u2800-\u28ff] deduplicating/u);
        app!.ui.setToolsExpanded(false);
        app!.handleActivity(false);
        return assistantMessage('{"groups":[{"ids":[1,2],"reason":"same expiry check"}]}');
      }
      if (initialPrompt.includes("specializing in security"))
        return submit([{ ...finding, priority: "P0" }]);
      if (initialPrompt.includes("specializing in test"))
        return {
          ...assistantMessage(""),
          stopReason: "error",
          errorMessage: "Fixture gateway unavailable",
        };
      if (context.messages.filter((m) => m.role === "user").length > 1)
        return submit([secondary, finding]);
      if (context.messages.at(-1)?.role === "toolResult")
        return assistantMessage("Inspected the café; forgot to submit.");
      return toolCall("read", { path: "café.ts" });
    };
    app = await openReview(directory, cwd, failures);
    const indexBefore = await readFile(path.join(cwd, ".git", "index"));
    await app.run(
      '/review uncommitted focus=general,security,testing context="Keep $& and 🐙 intact"',
    );

    assert.equal(app.activities[0].text, "review preparing");
    assert.equal(app.activity(), undefined);
    assert.ok(
      app.activities.slice(0, -1).every(({ text }) => text !== undefined),
      "task and dedup progress stops must not clear the whole review operation",
    );
    assert.ok(app.activities.some(({ text }) => text === "review"));
    assert.ok(
      app.activities.every(
        ({ sessionKey }) => sessionKey === app!.session.sessionManager.getSessionFile(),
      ),
    );
    const report = app.report();
    assert.equal(report.details.scope.mode, "working-tree");
    assert.equal(report.details.staleness, undefined);
    assert.deepEqual(
      report.details.execution!.lanes.map((lane) => lane.status),
      ["completed", "completed", "failed"],
    );
    assert.ok(
      report.details.execution!.lanes.every(
        (lane) => lane.elapsedMs !== null && lane.elapsedMs >= 0,
      ),
    );
    assert.deepEqual(
      report.details.focusStatus.map(({ focus, ok }) => [focus, ok]),
      [
        ["general", true],
        ["security", true],
        ["testing", false],
      ],
    );
    assert.deepEqual(report.details.findings, [
      { ...finding, priority: "P0", focus: "security, general", model: reviewModel.id },
      { ...secondary, focus: "general", model: reviewModel.id },
    ]);
    assert.match(report.content, /2 of 3 reviews completed/);
    assert.match(report.content, /Fixture gateway unavailable/);
    assert.ok(
      report.content.includes("tickets \\| after midnight. Guests"),
      "table escaping must not corrupt cells",
    );
    const retry = generations.find(
      (request) => request.context.messages.filter((m) => m.role === "user").length === 2,
    )!;
    assert.ok(retry, "missing submission triggers one retry");
    const first = generations.find(
      (request) =>
        request.process !== retry.process && request.args.includes(sessionPath(retry.args)),
    )!;
    assert.ok(first, "retry resumes the same durable focus session");
    assert.ok(
      retry.context.messages.some(
        (m) => m.role === "toolResult" && contentText(m.content).includes("acceptsExpired = true"),
      ),
      "retry retains the real read result",
    );
    for (const request of generations.filter((r) => !r.args.includes("--no-tools"))) {
      const prompt = contentText(request.context.messages.find((m) => m.role === "user")!.content);
      assertReviewPrompt(prompt, "diff");
      assert.match(prompt, /review untracked files as additions/);
      assert.ok(prompt.includes("Keep $& and 🐙 intact"));
      assert.ok(prompt.includes("Keep café tickets valid; preserve $& literally."));
      assert.equal(
        request.context.messages[0].role,
        "system",
        "retain the raw provider transcript",
      );
      assert.deepEqual(
        getCurrentTools(request.context.messages)
          .map((t) => t.name)
          .sort(),
        ["bash", "find", "grep", "ls", "read", "submit_review"],
      );
    }
    assert.equal(
      generations.length,
      6,
      "read, prose, retry, two other focuses and dedup; no post-submit paid turn",
    );
    assert.equal(app.mainRequests.length, 0, "a review report does not trigger the main model");
    assert.deepEqual(await readFile(path.join(cwd, ".git", "index")), indexBefore);
    assert.equal(
      await readFile(path.join(cwd, "new-ticket.txt"), "utf8"),
      "The jellyfish brought a +1.\n",
    );
    for (const request of generations.filter((r) => r.args.includes("--session"))) {
      await assert.rejects(
        readFile(sessionPath(request.args)),
        { code: "ENOENT" },
        "completed focus sessions are cleaned up",
      );
    }
  });

  test("persists monotonic lane execution across retries, consolidation and native export", async () => {
    let clock = 50_000;
    let turns = 0;
    let preparationDelayed = false;
    mock.method(performance, "now", () => clock);
    const remove = fs.rm;
    mock.method(fs, "rm", async (...args: Parameters<typeof fs.rm>) => {
      if (/^tau-review-[^-]+$/.test(path.basename(String(args[0])))) clock += 50;
      return remove(...args);
    });
    const sleep = timers.setTimeout;
    mock.method(
      timers,
      "setTimeout",
      (ms: number, value: unknown, options?: { signal?: AbortSignal; ref?: boolean }) => {
        if (ms >= 400 && ms <= 600) {
          clock += 500;
          return Promise.resolve(value);
        }
        return sleep(ms, value, options);
      },
    );
    syncBuiltinESMExports();
    respond = ({ args, context }) => {
      if (args.includes("--no-tools")) {
        clock += 1_000_000; // Consolidation must not extend a settled lane.
        return assistantMessage('{"groups":[]}');
      }
      clock += 125;
      if (++turns === 1)
        return {
          ...assistantMessage(""),
          stopReason: "error",
          errorMessage: "Lock file is already being held",
        };
      if (context.messages.filter((m) => m.role === "user").length === 1)
        return assistantMessage("The octopus forgot to submit.");
      return submit([
        finding,
        { ...finding, location: "other.ts:2", finding: "A different concern." },
      ]);
    };
    app = await openReview(directory, cwd, failures, [], async () => {
      preparationDelayed = true;
      clock += 100_000; // Admission/discovery delay must not enter a lane sample.
      return [reviewModel];
    });
    await app.run("/review commit HEAD focus=general");
    const execution = app.report().details.execution!;
    assert.equal(execution.schema, "tau.review.execution.v1");
    assert.equal(execution.lanes.length, 1, "submission retries are one lane, not extra samples");
    assert.deepEqual(
      execution.lanes.map(({ status, elapsedMs }) => [status, elapsedMs]),
      [["completed", 975]],
    );
    assert.deepEqual(execution.lanes[0], {
      laneId: "1",
      requestedModel: `${reviewModel.provider}/${reviewModel.id}:off`,
      model: reviewModel.id,
      executionModels: [`${reviewModel.provider}/${reviewModel.id}:off`],
      focus: "general",
      status: "completed",
      elapsedMs: 975,
    });
    const entries = SessionManager.open(app.session.sessionFile!).getBranch();
    assert.ok(
      entries.some(
        (e) =>
          e.type === "custom" &&
          e.customType === "review-execution" &&
          JSON.stringify(e.data) === JSON.stringify(execution),
      ),
    );
    const exported = await app.session.exportToHtml(path.join(directory, "review.html"));
    const html = await readFile(exported, "utf8");
    assert.ok(preparationDelayed, "the controlled preparation delay was exercised");
    const encoded = html.match(
      /<script id="session-data" type="application\/json">\s*([\s\S]*?)\s*<\/script>/,
    );
    assert.ok(encoded, "native HTML export contains session data");
    assert.ok(
      Buffer.from(encoded[1], "base64").toString("utf8").includes(JSON.stringify(execution)),
    );
    await app.run("/review commit HEAD focus=general");
    assert.notEqual(app.report().details.execution!.roundId, execution.roundId);
  });

  test("keeps the previous report reusable after a cancelled diagnostic round", async () => {
    await writeFile(path.join(agentDir, "review.json"), JSON.stringify({ focuses: ["general"] }));
    respond = () => submit([]);
    app = await openReview(directory, cwd, failures);
    await app.run("/review commit HEAD");
    const ready = deferred<void>();
    const release = deferred<AssistantMessage>();
    respond = () => {
      ready.resolve();
      return release.promise;
    };
    const end = app.nextEnd();
    await app.session.prompt("/review commit HEAD");
    await deadline(ready.promise, "diagnostic round readiness");
    app.confirmInterrupt();
    await deadline(end, "diagnostic round cancellation");
    release.resolve(submit([]));
    await app.settle();
    const count = generations.length;
    await app.session.prompt("/fix");
    await app.settle();
    assert.equal(
      generations.length,
      count,
      "diagnostic entries must not trigger a replacement review",
    );
    assert.equal(app.reports().length, 1);
  });

  test("retains the actual fallback model when cancellation interrupts retry backoff", async () => {
    app = await openConfiguredReview();
    await app.session.setModel(alternateReviewModel);
    app.session.setThinkingLevel("high");
    await app.run(
      `/review commit HEAD focus=general model=${reviewModel.provider}/${reviewModel.id}`,
    );
    const clamped = app.report().details.execution!.lanes[0];
    assert.equal(clamped.requestedModel, `${reviewModel.provider}/${reviewModel.id}:high`);
    assert.deepEqual(clamped.executionModels, [`${reviewModel.provider}/${reviewModel.id}:off`]);
    const backoff = deferred<void>();
    const sleep = timers.setTimeout;
    mock.method(
      timers,
      "setTimeout",
      (ms: number, value: unknown, options?: { signal?: AbortSignal; ref?: boolean }) => {
        const pending = sleep(ms, value, options);
        if (ms >= 400 && ms <= 600) backoff.resolve();
        return pending;
      },
    );
    syncBuiltinESMExports();
    respond = ({ args }) => ({
      ...assistantMessage(""),
      stopReason: "error",
      errorMessage: args[args.indexOf("--model") + 1].endsWith(":high")
        ? "Reasoning high is not supported"
        : "Lock file is already being held",
    });
    const end = app.nextEnd();
    await app.session.prompt("/review commit HEAD focus=general");
    await deadline(backoff.promise, "fallback retry readiness");
    app.confirmInterrupt();
    assert.equal((await deadline(end, "fallback retry cancellation")).outcome, "cancelled");
    await app.settle();
    const entry = SessionManager.open(app.session.sessionFile!)
      .getBranch()
      .filter((e) => e.type === "custom" && e.customType === "review-execution")
      .at(-1);
    assert.ok(entry?.type === "custom");
    const [lane] = (entry.data as ReviewExecution).lanes;
    const selector = `${alternateReviewModel.provider}/${alternateReviewModel.id}`;
    assert.deepEqual(lane.executionModels, [`${selector}:high`, `${selector}:medium`]);
    assert.equal(lane.requestedModel, `${selector}:high`);
    assert.equal(lane.model, `${alternateReviewModel.id}:medium`);
    assert.equal(lane.status, "cancelled");
    assert.ok(lane.elapsedMs !== null && lane.elapsedMs >= 0);
  });

  test("persists settled siblings when terminal cleanup throws", async () => {
    respond = () => submit([]);
    app = await openReview(directory, cwd, failures);
    const remove = fs.rm;
    let rejected = false;
    mock.method(fs, "rm", async (...args: Parameters<typeof fs.rm>) => {
      if (!rejected && /^tau-review-[^-]+$/.test(path.basename(String(args[0])))) {
        rejected = true;
        await remove(...args);
        throw new Error("Fixture terminal cleanup failure");
      }
      return remove(...args);
    });
    syncBuiltinESMExports();
    const end = app.nextEnd();
    await app.session.prompt("/review commit HEAD focus=general,security");
    assert.equal((await deadline(end, "cleanup failure")).outcome, "failed");
    await app.settle();
    const entry = SessionManager.open(app.session.sessionFile!)
      .getBranch()
      .filter((e) => e.type === "custom" && e.customType === "review-execution")
      .at(-1);
    assert.ok(entry?.type === "custom");
    const lanes = (entry.data as ReviewExecution).lanes;
    assert.deepEqual(lanes.map((l) => l.status).sort(), ["completed", "failed"]);
    assert.ok(lanes.every((l) => l.elapsedMs !== null && l.elapsedMs >= 0));
    assert.equal(app.reports().length, 0, "the original round failure still propagates");
  });

  test("retains null timing for lanes rejected before execution", async () => {
    app = await openReview(directory, cwd, failures);
    const end = app.nextEnd();
    await app.session.prompt(
      `/review commit HEAD focus=general model=${reviewModel.provider}/${reviewModel.id}:high`,
    );
    assert.equal((await deadline(end, "unsupported reasoning")).outcome, "failed");
    await app.settle();
    assert.equal(generations.length, 0);
    const report = app.reports().at(-1)!;
    assert.ok(report.type === "custom_message");
    const details = report.details as { kind: string; execution: ReviewExecution };
    assert.equal(details.kind, "failure");
    assert.deepEqual(
      details.execution.lanes.map(({ status, elapsedMs }) => [status, elapsedMs]),
      [["failed", null]],
    );
  });

  test("recovers a rejected submission in the same worker", async () => {
    respond = ({ context }) => {
      if (generations.length === 1)
        return toolCall("submit_review", { findings: "The octopus forgot the array." });
      const rejected = context.messages.at(-1);
      assert.ok(rejected?.role === "toolResult" && rejected.isError);
      assert.equal(rejected.toolName, "submit_review");
      assert.deepEqual(rejected.details, {});
      return submit([finding]);
    };
    app = await openReview(directory, cwd, failures);
    await app.run("/review commit HEAD focus=general");

    assert.deepEqual(app.report().details.findings, [
      { ...finding, focus: "general", model: reviewModel.id },
    ]);
    assert.equal(generations.length, 2, "one rejected call and one corrected submission");
    assert.equal(children.length, 1, "correction needs no resumed retry");
    assert.equal(app.mainRequests.length, 0);
    await assert.rejects(readFile(sessionPath(generations[0].args)), { code: "ENOENT" });
  });

  test("retries a rejected submission in the same saved session", async () => {
    const rawArguments = '{"findings":[],"';
    respond = ({ context }) => {
      if (context.messages.filter((message) => message.role === "user").length > 1)
        return submit([finding]);
      if (context.messages.at(-1)?.role === "toolResult")
        return assistantMessage("The octopus forgot to correct its submission.");
      return {
        ...assistantMessage(""),
        stopReason: "toolUse",
        content: [
          {
            type: "toolCall",
            id: "rejected-submit",
            name: "submit_review",
            arguments: {},
            argumentsError: `Malformed final arguments:\n${rawArguments}`,
          },
        ],
      };
    };
    app = await openReview(directory, cwd, failures);
    await app.run("/review commit HEAD focus=general");

    assert.deepEqual(app.report().details.findings, [
      { ...finding, focus: "general", model: reviewModel.id },
    ]);
    assert.equal(generations.length, 3, "rejection, final prose, then resumed submission");
    assert.equal(children.length, 2, "no successful submission triggers one resumed retry");
    const first = generations[0];
    const retry = generations[2];
    assert.notEqual(retry.process, first.process);
    assert.equal(sessionPath(retry.args), sessionPath(first.args));
    const rejected = retry.context.messages.find(
      (message) => message.role === "toolResult" && message.isError,
    );
    assert.ok(rejected?.role === "toolResult");
    assert.equal(rejected.toolName, "submit_review");
    assert.deepEqual(rejected.details, {});
    assert.ok(contentText(rejected.content).includes(rawArguments));
    assert.equal(app.mainRequests.length, 0);
    await assert.rejects(readFile(sessionPath(first.args)), { code: "ENOENT" });
  });

  test("rejects two successful submissions", async () => {
    respond = () => ({
      ...assistantMessage(""),
      stopReason: "toolUse",
      content: [
        {
          type: "toolCall",
          id: "first-submit",
          name: "submit_review",
          arguments: { findings: [] },
        },
        {
          type: "toolCall",
          id: "second-submit",
          name: "submit_review",
          arguments: { findings: [] },
        },
      ],
    });
    app = await openReview(directory, cwd, failures);
    const end = app.nextEnd();
    await app.session.prompt("/review commit HEAD focus=general");
    assert.equal((await deadline(end, "duplicate submissions")).outcome, "failed");
    await app.settle();

    const report = app.reports().at(-1);
    assert.ok(report?.type === "custom_message");
    assert.equal((report.details as { kind: string }).kind, "failure");
    assert.match(String(report.content), /called submit_review 2 times/);
    assert.equal(generations.length, 1, "successful submissions terminate the native tool batch");
    assert.equal(children.length, 1, "duplicate submissions must not trigger a retry");
    assert.equal(app.mainRequests.length, 0);
    await assert.rejects(readFile(sessionPath(generations[0].args)), { code: "ENOENT" });
  });

  for (const { target, mode, policy, focuses } of [
    {
      target: "branch main",
      mode: "branch-diff",
      policy: "diff",
      focuses: ["general", "security"],
    },
    {
      target: "commit HEAD",
      mode: "commit",
      policy: "diff",
      focuses: ["general", "security"],
    },
    {
      target: "folder café.ts",
      mode: "folder",
      policy: "snapshot",
      focuses: ["general", "security", "reuse", "quality", "testing", "efficiency"],
    },
    {
      target:
        'custom "Review the café.ts snapshot only; omit adjacent follow-ups and preserve $&."',
      mode: "custom",
      policy: "custom",
      focuses: ["general", "security"],
    },
  ] as const) {
    test(`routes ${mode} scope policy and explicit guidance to its reviewers`, async () => {
      git(cwd, "switch", "-c", "night-shift");
      await writeFile(
        path.join(cwd, "café.ts"),
        "export const acceptsExpired = true; // The lights are on.\n",
      );
      git(cwd, "add", "café.ts");
      git(
        cwd,
        "-c",
        "user.name=Octopus",
        "-c",
        "user.email=octopus@example.invalid",
        "commit",
        "-m",
        "Keep the café lit",
      );
      const base = git(cwd, "rev-parse", "main").trim();
      const guidelines = "Only review café.ts. Omit follow-ups outside that file. Preserve $&.";
      await writeFile(path.join(cwd, "REVIEW_GUIDELINES.md"), `${guidelines}\n`);
      // The provider checks delivered scope/contract instructions, not whether a model can judge severity.
      respond = ({ context }) => {
        const prompt = contentText(context.messages.find((m) => m.role === "user")!.content);
        assertReviewPrompt(prompt, policy);
        assert.ok(prompt.includes(guidelines));
        assert.ok(prompt.includes("Do not broaden the selected paths 🐙"));
        if (mode === "branch-diff") assert.ok(prompt.includes(`git diff ${base}..HEAD`));
        if (mode === "commit") assert.ok(prompt.includes("git show --stat --patch HEAD"));
        if (mode === "folder") {
          assert.match(prompt, /snapshot review of selected paths \(not a diff\)/);
          assert.match(prompt, /Paths:\n  - café.ts/);
        }
        if (mode === "custom")
          assert.ok(
            prompt.includes(
              "Review the café.ts snapshot only; omit adjacent follow-ups and preserve $&.",
            ),
          );
        return submit([]);
      };
      app = await openReview(directory, cwd, failures);
      await app.run(
        `/review ${target} focus=${focuses.join(",")} context="Do not broaden the selected paths 🐙"`,
      );

      const report = app.report();
      assert.equal(report.details.scope.mode, mode);
      assert.deepEqual(report.details.findings, []);
      assert.deepEqual(
        report.details.focusStatus.map(({ focus, ok }) => [focus, ok]),
        focuses.map((focus) => [focus, true]),
      );
      assert.equal(generations.length, focuses.length, "submission terminates each reviewer");
      assert.equal(app.mainRequests.length, 0);
    });
  }

  test("refuses a freshly stale fix, then reuses that report on explicit rerun without losing fix context", async () => {
    await writeFile(path.join(cwd, "new-ticket.txt"), "Before review\n");
    respond = async () => {
      await writeFile(path.join(cwd, "new-ticket.txt"), "Changed while reviewing\n");
      return submit([finding]);
    };
    app = await openReview(directory, cwd, failures, [
      toolCall("edit", {
        path: "café.ts",
        edits: [{ oldText: "acceptsExpired = true", newText: "acceptsExpired = false" }],
      }),
      assistantMessage("Expiry validation restored."),
    ]);
    await app.session.prompt('/fix uncommitted focus=general context="Keep the café open"');
    await app.settle();
    const report = app.report();
    assert.equal(report.details.staleness?.status, "stale");
    assert.equal(
      app.mainRequests.length,
      0,
      "a fresh stale review must not apply fixes automatically",
    );
    assert.equal(
      await readFile(path.join(cwd, "café.ts"), "utf8"),
      "export const acceptsExpired = true;\n",
    );
    assert.ok(
      app.notifications.some(
        (notice) => notice.type === "warning" && /No fixes were applied/.test(notice.message),
      ),
    );

    await app.session.prompt(
      '/fix uncommitted focus=general context="Preserve $&; no octopus overtime"',
    );
    await app.settle();
    assert.equal(
      generations.length,
      1,
      "context-only changes do not invalidate a matching last report",
    );
    assert.equal(app.mainRequests.length, 2);
    const fixPrompt = contentText(app.mainRequests[0].context.messages.at(-1)!.content);
    assert.ok(fixPrompt.includes("Preserve $&; no octopus overtime"));
    assert.ok(fixPrompt.includes(JSON.stringify(finding.finding)));
    assert.match(fixPrompt, /"status": "stale"/);
    assert.ok(
      app.notifications.some(
        (notice) => notice.type === "warning" && /Last review is stale/.test(notice.message),
      ),
    );
    assert.equal(
      await readFile(path.join(cwd, "café.ts"), "utf8"),
      "export const acceptsExpired = false;\n",
    );
    assert.equal(
      await readFile(path.join(cwd, "new-ticket.txt"), "utf8"),
      "Changed while reviewing\n",
    );
    assert.deepEqual(app.report(), report, "fixing does not rewrite the persisted review worklist");
  });

  for (const later of ["usage", "conversation", "context_edit"] as const) {
    test(`reopens a review followed by ${later} without looking past later context`, async () => {
      respond = () => submit([finding]);
      app = await openReview(directory, cwd, failures);
      await app.run("/review commit HEAD focus=general");
      const report = app.report();
      const reportEntry = app.reports().at(-1)!;
      const history = app.session.sessionManager;
      if (later === "conversation") {
        history.appendMessage({
          role: "user",
          content: "Now inspect the night shift.",
          timestamp: 1,
        });
        history.appendMessage(assistantMessage("The night shift needs a fresh review."));
      } else if (later === "context_edit") {
        history.appendContextEdit(reportEntry.id, null);
      }
      const usage = ["cache_warm", "octopus_receipt"].map((kind) =>
        history.appendUsage(kind, reviewModel.provider, reviewModel.id, {
          ...assistantMessage("").usage,
          cacheRead: 42,
          totalTokens: 42,
        }),
      );
      const sessionFile = app.session.sessionFile!;
      const before = await readFile(sessionFile);
      await app.dispose();
      app = await openReview(
        directory,
        cwd,
        failures,
        later === "usage" ? [assistantMessage("Finding deferred; no files changed.")] : [],
        undefined,
        undefined,
        sessionFile,
      );
      assert.deepEqual(await readFile(sessionFile), before, "reopening preserves the raw history");
      assert.deepEqual(app.report(), report);
      assert.deepEqual(app.session.sessionManager.getBranch().slice(-2), usage);
      respond = () => submit([]);

      await app.session.prompt("/fix commit HEAD focus=general");
      await app.settle();

      assert.equal(generations.length, later === "usage" ? 1 : 2);
      assert.equal(app.mainRequests.length, later === "usage" ? 1 : 0);
      const reopened = SessionManager.open(sessionFile).getBranch();
      assert.deepEqual(
        reopened.find((entry) => entry.id === reportEntry.id),
        reportEntry,
      );
      assert.deepEqual(
        reopened.filter((entry) => entry.type === "usage"),
        usage,
      );
      assert.deepEqual((await readFile(sessionFile)).subarray(0, before.length), before);
      if (later === "usage") {
        assert.deepEqual(app.report(), report, "usage does not trigger a paid reviewer rerun");
        assert.ok(
          contentText(app.mainRequests[0].context.messages.at(-1)!.content).includes(
            JSON.stringify(finding.finding),
          ),
        );
      } else {
        assert.equal(app.reports().length, 2, "later context requires a fresh review");
        assert.deepEqual(app.report().details.findings, []);
      }
    });
  }

  for (const dirty of [false, true]) {
    test(`stops a commit-scoped no-op fix loop with a ${dirty ? "dirty" : "clean"} repository`, async () => {
      if (dirty) {
        await writeFile(path.join(cwd, "new-ticket.txt"), "The jellyfish brought a +1.\n");
        await writeFile(
          path.join(cwd, "café.ts"),
          "export const acceptsExpired = true; // staged\n",
        );
        git(cwd, "add", "café.ts");
        await writeFile(
          path.join(cwd, "café.ts"),
          "export const acceptsExpired = true; // working\n",
        );
      }
      let reviews = 0;
      // A second clean report bounds the defective loop without accepting an extra review.
      respond = () => {
        assert.ok(++reviews <= 2, "unexpected extra review");
        return submit(reviews === 1 ? [finding] : []);
      };
      app = await openReview(directory, cwd, failures, [
        assistantMessage("Finding deferred; no files changed."),
      ]);
      const before = git(cwd, "status", "--porcelain=v1");
      const indexBefore = await readFile(path.join(cwd, ".git", "index"));
      const workingBefore = await readFile(path.join(cwd, "café.ts"));
      const sessionFile = app.session.sessionFile!;
      const historyBefore = SessionManager.open(sessionFile).getBranch();
      const modelBefore = app.session.model;
      const thinkingBefore = app.session.thinkingLevel;
      await app.session.prompt("/fix loop commit HEAD focus=general");
      await app.settle();

      assert.equal(app.mainRequests.length, 1);
      assert.equal(git(cwd, "status", "--porcelain=v1"), before);
      assert.deepEqual(await readFile(path.join(cwd, ".git", "index")), indexBefore);
      assert.deepEqual(await readFile(path.join(cwd, "café.ts")), workingBefore);
      if (dirty)
        assert.equal(
          await readFile(path.join(cwd, "new-ticket.txt"), "utf8"),
          "The jellyfish brought a +1.\n",
        );
      assert.equal(reviews, 1, "a no-op fix must stop before paying for another review");
      assert.equal(app.reports().length, 1);
      assert.equal(app.report().details.staleness, undefined);
      assert.equal(app.session.sessionFile, sessionFile);
      assert.deepEqual(
        SessionManager.open(sessionFile).getBranch().slice(0, historyBefore.length),
        historyBefore,
      );
      assert.deepEqual(app.session.model, modelBefore);
      assert.equal(app.session.thinkingLevel, thinkingBefore);
      assert.ok(
        app.notifications.some((notice) => /made no repository changes/.test(notice.message)),
      );
    });
  }

  test("preserves index bytes when reviewing a file restored to its indexed contents", async () => {
    respond = () => submit([]);
    app = await openReview(directory, cwd, failures);
    const indexBefore = await readFile(path.join(cwd, ".git", "index"));
    const original = await readFile(path.join(cwd, "café.ts"));
    await writeFile(path.join(cwd, "café.ts"), "The octopus made a temporary edit.\n");
    await writeFile(path.join(cwd, "café.ts"), original);
    await fs.utimes(path.join(cwd, "café.ts"), 0, 0);
    await writeFile(path.join(cwd, "new-ticket.txt"), "Keep a reviewable untracked file.\n");
    await app.run("/review uncommitted focus=general");
    assert.deepEqual(await readFile(path.join(cwd, "café.ts")), original);
    assert.deepEqual(await readFile(path.join(cwd, ".git", "index")), indexBefore);
  });

  for (const phase of ["tool", "retry", "assistant-abort"] as const) {
    test(`stops a fix loop after an edit and ${phase} cancellation, then accepts a fresh fix`, async () => {
      await writeFile(path.join(cwd, "new-ticket.txt"), "Keep the café open.\n");
      const toolStarted = deferred<void>();
      const toolCancelled = deferred<void>();
      const cleanup = deferred<void>();
      const retryStarted = deferred<void>();
      let reviews = 0;
      let fresh = false;
      respond = ({ args }) => {
        if (args.at(-1)!.includes("specializing in security"))
          return fresh
            ? submit([])
            : {
                ...assistantMessage(""),
                stopReason: "error",
                errorMessage: "Fixture security reviewer unavailable",
              };
        reviews++;
        // A clean report bounds the old defective loop without accepting the extra review.
        return submit(reviews === 1 || (fresh && reviews === 2) ? [finding] : []);
      };
      app = await openReview(
        directory,
        cwd,
        failures,
        [
          toolCall("edit", {
            path: "café.ts",
            edits: [{ oldText: "acceptsExpired = true", newText: "acceptsExpired = false" }],
          }),
          phase === "tool"
            ? toolCall("lifeboat", {})
            : {
                ...assistantMessage(""),
                stopReason: phase === "retry" ? "error" : "aborted",
                errorMessage: phase === "retry" ? "529 overloaded" : "Fixture generation cancelled",
              },
          toolCall("edit", {
            path: "café.ts",
            edits: [
              {
                oldText: "acceptsExpired = false",
                newText: "acceptsExpired = false /* checked */",
              },
            ],
          }),
          assistantMessage("Fresh fix completed."),
        ],
        undefined,
        undefined,
        undefined,
        reviewModel,
        {
          tools: phase === "tool" ? ["lifeboat"] : [],
          extensions:
            phase === "tool"
              ? [
                  (pi) => {
                    pi.registerTool(
                      defineTool({
                        name: "lifeboat",
                        label: "Lifeboat",
                        description: "Inspect the lifeboat after fixing the gate.",
                        parameters: Type.Object({}),
                        execute: async (_id, _args, signal) => {
                          assert.ok(signal);
                          const onAbort = () => toolCancelled.resolve();
                          signal.addEventListener("abort", onAbort, { once: true });
                          toolStarted.resolve();
                          try {
                            await cleanup.promise;
                            signal.throwIfAborted();
                            return {
                              content: [{ type: "text", text: "Lifeboat inspected." }],
                              details: {},
                            };
                          } finally {
                            signal.removeEventListener("abort", onAbort);
                          }
                        },
                      }),
                    );
                  },
                ]
              : [],
        },
      );
      app.settingsManager.applyOverrides({
        retry: { enabled: phase === "retry", maxRetries: 1, baseDelayMs: 60_000 },
      });
      const settlements: boolean[] = [];
      const reasons: string[] = [];
      const unsubscribe = app.session.subscribe((event) => {
        if (event.type === "auto_retry_start") retryStarted.resolve();
        if (event.type === "agent_end")
          reasons.push(
            event.messages.findLast((message) => message.role === "assistant")!.stopReason,
          );
        if (event.type === "agent_settled") settlements.push(event.aborted);
      });
      const indexBefore = await readFile(path.join(cwd, ".git", "index"));
      const draft = "Unsent café garnish notes 🐙";
      app.ui.setEditorText(draft);
      let finished = false;
      const fix = app.session.prompt("/fix loop uncommitted focus=general,security").then(() => {
        finished = true;
      });
      try {
        if (phase !== "assistant-abort") {
          await deadline(
            phase === "tool" ? toolStarted.promise : retryStarted.promise,
            "fix cancellation readiness",
          );
          assert.equal(
            await readFile(path.join(cwd, "café.ts"), "utf8"),
            "export const acceptsExpired = false;\n",
          );
          if (phase === "retry") assert.equal(app.session.isRetrying, true);
          const abort = app.session.abort();
          if (phase === "tool") {
            await deadline(toolCancelled.promise, "fix tool cancellation");
            await setImmediate();
            assert.equal(finished, false, "fix completion joins tool cleanup");
            assert.deepEqual(settlements, []);
            assert.equal(reviews, 1);
            cleanup.resolve();
          }
          await deadline(abort, "fix abort completion");
        }
        await deadline(fix, "cancelled fix loop");
        await app.settle();
        assert.deepEqual(settlements, [phase !== "assistant-abort"]);
        assert.deepEqual(reasons, [phase === "retry" ? "error" : "aborted"]);
        assert.equal(reviews, 1, "an aborted fix must not pay for another review");
        assert.equal(generations.length, 2);
        assert.equal(app.reports().length, 1);
        assert.equal(
          app.report().details.findings.length,
          1,
          "cancellation does not publish a clean report",
        );
        assert.equal(app.mainRequests.length, 2);
        assert.ok(app.notifications.some(({ message }) => /fix pass was aborted/.test(message)));
        assert.equal(
          app.notifications.some(({ message }) =>
            /continuing with a fresh review|Nothing to fix|Fix pass used partial/.test(message),
          ),
          false,
        );
        assert.equal(
          await readFile(path.join(cwd, "café.ts"), "utf8"),
          "export const acceptsExpired = false;\n",
        );
        assert.deepEqual(await readFile(path.join(cwd, ".git", "index")), indexBefore);
        assert.equal(app.ui.getEditorText(), draft);
        assert.equal(app.session.pendingMessageCount, 0);

        fresh = true;
        await deadline(
          app.session.prompt("/fix loop uncommitted focus=general,security"),
          "fresh fix loop",
        );
        await app.settle();
        assert.deepEqual(settlements, [phase !== "assistant-abort", false]);
        assert.equal(reviews, 3, "fresh fix can continue to its clean review");
        assert.equal(generations.length, 6);
        assert.equal(app.mainRequests.length, 4);
        assert.deepEqual(app.report().details.findings, []);
        assert.ok(app.notifications.some(({ message }) => /Nothing to fix/.test(message)));
        assert.equal(
          await readFile(path.join(cwd, "café.ts"), "utf8"),
          "export const acceptsExpired = false /* checked */;\n",
        );
        assert.deepEqual(await readFile(path.join(cwd, ".git", "index")), indexBefore);
        assert.equal(app.ui.getEditorText(), draft);
      } finally {
        cleanup.resolve();
        await app.session.abort();
        await deadline(fix, "fix cleanup");
        unsubscribe();
      }
    });
  }

  for (const { scope, file, expectedReviews } of [
    { scope: "commit HEAD", file: "café.ts", expectedReviews: 2 },
    { scope: "uncommitted", file: "new-ticket.ts", expectedReviews: 2 },
    { scope: "folder .", file: "new-ticket.ts", expectedReviews: 2 },
    { scope: "commit HEAD", file: "new-ticket.ts", expectedReviews: 1 },
  ]) {
    test(`honors ${scope} scope after a native fix edits ${file}`, async () => {
      await writeFile(path.join(cwd, "new-ticket.ts"), "export const acceptsExpired = true;\n");
      const guidelines = "The octopus staged these guidelines; keep them intact.\n";
      await writeFile(path.join(cwd, "REVIEW_GUIDELINES.md"), guidelines);
      git(cwd, "add", "REVIEW_GUIDELINES.md");
      const indexBefore = await readFile(path.join(cwd, ".git", "index"));
      const trackedDiffBefore = git(cwd, "diff", "HEAD");
      const keepsDefaults = scope === "commit HEAD" && file === "café.ts";
      const savedModel = `${alternateReviewModel.provider}/${alternateReviewModel.id}`;
      if (keepsDefaults)
        await writeFile(
          path.join(agentDir, "review.json"),
          JSON.stringify({ models: [savedModel], focuses: ["general"] }),
        );
      let reviews = 0;
      respond = async ({ model }) => {
        assert.ok(++reviews <= 2, "unexpected extra review");
        if (keepsDefaults) {
          assert.equal(
            model.provider,
            alternateReviewModel.provider,
            "a fix loop retains its initial defaults",
          );
          await writeFile(
            path.join(agentDir, "review.json"),
            JSON.stringify({ models: [reviewModel.id], focuses: ["security", "testing"] }),
          );
        }
        assert.equal(
          await readFile(path.join(cwd, file), "utf8"),
          `export const acceptsExpired = ${reviews === 1 ? "true" : "false"};\n`,
          "the follow-up reviewer sees the actual native edit",
        );
        return submit(reviews === 1 ? [{ ...finding, location: `${file}:1` }] : []);
      };
      app = await openReview(
        directory,
        cwd,
        failures,
        [
          toolCall("edit", {
            path: file,
            edits: [{ oldText: "acceptsExpired = true", newText: "acceptsExpired = false" }],
          }),
          assistantMessage("Expiry validation restored."),
        ],
        undefined,
        undefined,
        undefined,
        reviewModel,
        {
          extensions: keepsDefaults
            ? [
                scriptedProvider(alternateReviewModel, () => {
                  throw new Error("Review must not generate in the main session");
                }),
              ]
            : [],
          tools: [],
        },
      );
      await app.session.prompt(`/fix loop ${scope}${keepsDefaults ? "" : " focus=general"}`);
      await app.settle();

      assert.equal(app.mainRequests.length, 2, "one native edit and its concluding model turn");
      assert.equal(
        reviews,
        expectedReviews,
        "only scope-relevant changes trigger follow-up review",
      );
      assert.equal(app.reports().length, expectedReviews);
      if (keepsDefaults) {
        for (const report of app.reports()) {
          assert.equal(report.type, "custom_message");
          const details = report.details as ReviewMessageDetails;
          const signature = JSON.parse(details.request.signature);
          assert.deepEqual(signature.models, [savedModel]);
          assert.deepEqual(signature.focuses, ["general"]);
          assert.deepEqual(
            details.focusStatus.map(({ focus }) => focus),
            ["general"],
          );
        }
        assert.deepEqual(JSON.parse(await readFile(path.join(agentDir, "review.json"), "utf8")), {
          models: [reviewModel.id],
          focuses: ["security", "testing"],
        });
      }
      assert.equal(app.report().details.staleness, undefined);
      assert.equal(app.report().details.findings.length, expectedReviews === 2 ? 0 : 1);
      assert.equal(
        await readFile(path.join(cwd, file), "utf8"),
        "export const acceptsExpired = false;\n",
      );
      const untouched = file === "café.ts" ? "new-ticket.ts" : "café.ts";
      assert.equal(
        await readFile(path.join(cwd, untouched), "utf8"),
        "export const acceptsExpired = true;\n",
      );
      assert.deepEqual(await readFile(path.join(cwd, ".git", "index")), indexBefore);
      assert.equal(await readFile(path.join(cwd, "REVIEW_GUIDELINES.md"), "utf8"), guidelines);
      if (file === "new-ticket.ts")
        assert.equal(git(cwd, "diff", "HEAD"), trackedDiffBefore, "only untracked content changed");
      assert.equal(app.session.pendingMessageCount, 0);
      assert.ok(
        app.notifications.some((notice) =>
          expectedReviews === 2
            ? /continuing with a fresh review/.test(notice.message)
            : /made no repository changes/.test(notice.message),
        ),
      );
    });
  }

  test("keeps a quiet heading and aligned focus statuses readable at wide and narrow widths", async () => {
    await writeFile(path.join(cwd, "new-ticket.txt"), "Review every angle of the café.\n");
    const focuses = ["general", "security", "reuse", "quality", "testing", "efficiency"];
    const replies = focuses.map(() => deferred<AssistantMessage>());
    const ready = deferred<void>();
    let received = 0;
    respond = ({ context }) => {
      assertReviewPrompt(
        contentText(context.messages.find((m) => m.role === "user")!.content),
        "diff",
      );
      const reply = replies[received++];
      assert.ok(reply, "only the requested reviewers may generate");
      if (received === 1) ready.resolve();
      return reply.promise;
    };
    app = await openReview(directory, cwd, failures);
    try {
      const end = app.nextEnd();
      await app.session.prompt(`/review uncommitted focus=${focuses.join(",")}`);
      await deadline(ready.promise, "review provider readiness");
      assert.match(app.view(), /^ Review · 0\/6 complete/);
      assert.equal(app.lines().length, 1);
      assert.ok(app.lines()[0].includes(app.ui.theme.fg("muted", "Review · 0/6 complete")));
      assert.equal(app.activity(), "review 0/6 complete");
      app.handleActivity(true);
      assert.deepEqual(app.lines(), [], "only negotiated collapsed headings are hidden");
      app.handleActivity(false);
      assert.match(
        app.view(),
        /^ Review · 0\/6 complete/,
        "nonembedding editors retain the header",
      );
      app.handleActivity(true);
      app.ui.setToolsExpanded(true);
      assert.equal(app.lines().length, 2, "wide reviews keep one row per model");
      assert.match(app.view().split("\n")[1], /^   \S/);
      const row = app.lines()[1];
      const spinner = stripVTControlCharacters(row).match(/[\u2800-\u28ff]/u)![0];
      assert.ok(row.includes(app.ui.theme.fg("accent", spinner)));
      assert.ok(row.includes(app.ui.theme.fg("text", "general")));
      const modelLabel = stripVTControlCharacters(row).trimStart().split(/ {2,}/)[0];
      assert.ok(modelLabel.includes(reviewModel.id));
      assert.ok(row.includes(app.ui.theme.fg("dim", modelLabel)));
      for (const width of [1, 10, 40, 80, 160])
        assert.ok(app.lines(width).every((line) => visibleWidth(line) <= width));
      for (const focus of focuses) assert.ok(app.view(40).includes(focus), app.view(40));
      assert.doesNotMatch(app.view(), /─/, "no extra border competes with the editor");

      replies[0].resolve({
        ...assistantMessage(""),
        stopReason: "error",
        errorMessage: "Fixture reviewer failed.",
      });
      await app.waitForView((view) => view.includes("1/6 complete · 1 failed"));
      assert.ok(app.lines().some((line) => line.includes(app!.ui.theme.fg("error", "✕"))));
      replies[1].resolve(submit([]));
      await app.waitForView((view) => view.includes("2/6 complete · 1 failed"));
      assert.ok(app.lines().some((line) => line.includes(app!.ui.theme.fg("success", "✓"))));
      app.ui.setToolsExpanded(false);
      app.handleActivity(false);
      assert.equal(app.lines().length, 1);
      assert.match(app.view(), /^ Review · 2\/6 complete · 1 failed/);
      app.handleActivity(true);
      assert.deepEqual(app.lines(), []);
      assert.equal(app.activity(), "review 2/6 complete · 1 failed");
      assert.equal(app.press("\x1b"), true);
      const obsolete = app.confirmations.at(-1)!;
      for (const reply of replies.slice(2)) reply.resolve(submit([]));
      assert.equal((await deadline(end, "review completion")).outcome, "success");
      await app.settle();
      assert.equal(obsolete.signal?.aborted, true, "completed work dismisses its confirmation");
      assert.equal(app.tui.getFocusedComponent(), app.editor);
      assert.equal(app.view(), "");
      assert.equal(app.activity(), undefined);
    } finally {
      for (const reply of replies) reply.resolve(submit([]));
    }
  });

  test("retains queued text and images after confirmed cancellation until the next user message", async () => {
    const ready = deferred<void>();
    const release = deferred<AssistantMessage>();
    respond = () => {
      ready.resolve();
      return release.promise;
    };
    app = await openReview(directory, cwd, failures, [
      assistantMessage("Resuming the café request."),
      assistantMessage("Just water, noted."),
    ]);
    app.handleActivity(true);
    try {
      const end = app.nextEnd();
      await app.session.prompt("/review commit HEAD focus=general");
      await deadline(ready.promise, "queued review readiness");
      assert.equal(app.activity(), "review 0/1 complete");
      assert.deepEqual(app.lines(), []);
      await app.session.prompt("Keep the café open 🐙", { source: "interactive", images: [image] });
      app.ui.setEditorText("Unsent garnish notes");
      app.press("\x1b");
      app.press("\x1b[1;3A");
      assert.equal(app.ui.getEditorText(), "Unsent garnish notes");
      app.press("\x1b");
      await app.settle();
      assert.equal(app.mainRequests.length, 0);
      assert.ok(children.every((child) => !child.hasClosed));
      getKeybindings().setUserBindings({ "app.interrupt": "alt+up" });
      app.press("\x1b[1;3A");
      assert.equal(
        app.confirmations.length,
        2,
        "interrupt takes priority over dequeue on a shared key",
      );
      app.press("\r");
      assert.equal((await deadline(end, "queued review cancellation")).outcome, "cancelled");
      assert.equal(app.activity(), undefined);
      await app.settle();
      assert.equal(
        app.mainRequests.length,
        0,
        "confirmation must not restart the parent with queued input",
      );
      assert.equal(app.ui.getEditorText(), "Unsent garnish notes");
      assert.match(app.queuedInput(), /Keep the café open.*1 image/s);
      assert.match(app.queuedInput(), /next message/);

      await app.session.prompt("Continue", { source: "interactive" });
      assert.deepEqual(app.mainRequests[0].context.messages.at(-1)?.content, [
        { type: "text", text: "Keep the café open 🐙\n\nContinue" },
        image,
      ]);
      assert.equal(app.queuedInput(), "");
      await app.session.prompt("Just water", { source: "interactive" });
      assert.deepEqual(app.mainRequests[1].context.messages.at(-1)?.content, [
        { type: "text", text: "Just water" },
      ]);
    } finally {
      release.resolve(submit([]));
    }
  });

  for (const order of ["before", "after"] as const) {
    test(`uses one confirmation for Review and Subagent with Subagent loaded ${order} Review`, async () => {
      const workerReady = deferred<void>();
      const reviewReady = deferred<void>();
      const workerReply = deferred<AssistantMessage>();
      const reviewReply = deferred<AssistantMessage>();
      respond = (request) => {
        if (request.args[0] === "--mode" && request.args[1] === "rpc") {
          workerReady.resolve();
          return workerReply.promise;
        }
        reviewReady.resolve();
        return reviewReply.promise;
      };
      app = await openReview(
        directory,
        cwd,
        failures,
        [
          toolCall("subagent", {
            action: "start",
            goal: "Watch the café",
            prompt: "Wait for instructions.",
          }),
          assistantMessage("Delegated."),
        ],
        undefined,
        order,
      );
      try {
        await app.session.prompt("Delegate the café watch.");
        await deadline(workerReady.promise, "overlapping subagent readiness");
        const end = app.nextEnd();
        await app.session.prompt("/review commit HEAD focus=general");
        await deadline(reviewReady.promise, "overlapping review readiness");
        assert.equal(app.press("\x1b"), true);
        assert.equal(app.confirmations.length, 1);
        assert.equal(app.confirmations[0].title, "Cancel all ongoing work?");
        app.press("\x1b");
        await app.settle();
        assert.ok(children.every((child) => !child.hasClosed));
        assert.equal(app.mainRequests.length, 2);

        assert.equal(app.press("\x1b"), true);
        assert.equal(
          app.confirmations.length,
          2,
          "there is one dialog per interrupt, not per extension",
        );
        if (order === "after") {
          reviewReply.resolve(submit([]));
          assert.equal(
            (await deadline(end, "review finishing during confirmation")).outcome,
            "success",
          );
          await app.settle();
          assert.notEqual(
            app.tui.getFocusedComponent(),
            app.editor,
            "remaining child work keeps the confirmation open",
          );
          assert.equal(app.confirmations.at(-1)?.signal?.aborted, false);
        }
        app.press("\r");
        if (order === "before")
          assert.equal((await deadline(end, "overlapping cancellation")).outcome, "cancelled");
        await Promise.all(
          children.map((child) => deadline(child.closed, "overlapping child close")),
        );
        await app.settle();
        assert.equal(app.mainRequests.length, 2);
        assert.equal(app.tui.getFocusedComponent(), app.editor);
        assert.equal(app.confirmations.length, 2);
        assert.equal(app.view(), "");
      } finally {
        workerReply.resolve(assistantMessage("The café is quiet."));
        reviewReply.resolve(submit([]));
      }
    });
  }

  test("cancels preparation, joins shutdown, and isolates a failed replacement review", async () => {
    let armed = false;
    let ready = deferred<AbortSignal>();
    let release = deferred<void>();
    let end: Promise<{ outcome: string }> | undefined;
    respond = () => submit([]);
    app = await openReview(directory, cwd, failures, [], async ({ signal }) => {
      if (armed) {
        const gate = release;
        const onAbort = () => gate.resolve();
        signal.addEventListener("abort", onAbort, { once: true });
        ready.resolve(signal);
        try {
          await gate.promise;
          signal.throwIfAborted();
        } finally {
          signal.removeEventListener("abort", onAbort);
        }
      }
      return [reviewModel];
    });
    await app.modelRuntime.refresh({ providers: [reviewModel.provider] });
    app.handleActivity(true);
    armed = true;
    try {
      for (const stop of ["escape", "shutdown"]) {
        end = app.nextEnd();
        await app.session.prompt("/review commit HEAD focus=general");
        const signal = await deadline(ready.promise, "catalog refresh readiness");
        assert.equal(app.activity(), "review preparing");
        assert.deepEqual(app.lines(), [], "preparation keeps its guard even without a header");
        app.ui.setToolsExpanded(true);
        assert.match(app.view(), /^ Review · preparing/);
        app.ui.setToolsExpanded(false);
        assert.equal(app.press("\x1b"), true);
        assert.equal(signal.aborted, false, "opening confirmation does not cancel preparation");
        const dialogSignal: AbortSignal | undefined = app.confirmations.at(-1)?.signal;
        if (stop === "escape") {
          app.press("\x1b");
          await setImmediate();
          assert.equal(signal.aborted, false, "dismissing confirmation preserves preparation");
          app.confirmInterrupt();
        } else {
          await app.dispose();
          assert.equal(dialogSignal?.aborted, true, "shutdown owns the pending dialog");
        }
        assert.equal((await deadline(end, "preparation cancellation")).outcome, "cancelled");
        assert.equal(app.activity(), undefined);
        assert.equal(signal.aborted, true, "cancellation reaches native model discovery");
        assert.equal(generations.length, 0, "no reviewer starts after cancellation");
        assert.equal(app.reports().length, 0);
        assert.equal(app.mainRequests.length, 0);
        assert.equal(app.listeners.size, 0);
        if (stop === "escape") {
          await app.settle();
          ready = deferred<AbortSignal>();
          release = deferred<void>();
        }
      }
      const previousSessionKey = app.activities.at(-1)!.sessionKey;
      respond = () => ({
        ...assistantMessage(""),
        stopReason: "error",
        errorMessage: "Fixture replacement reviewer unavailable",
      });
      app = await openReview(directory, cwd, failures);
      assert.equal(app.activity(), undefined);
      end = app.nextEnd();
      await app.session.prompt("/review commit HEAD focus=general");
      assert.equal((await deadline(end, "replacement review failure")).outcome, "failed");
      await app.settle();
      assert.equal(app.activity(), undefined);
      assert.notEqual(app.activities[0].sessionKey, previousSessionKey);
      assert.ok(
        app.activities.every(
          ({ sessionKey }) => sessionKey === app!.session.sessionManager.getSessionFile(),
        ),
      );
    } finally {
      release.resolve();
      if (end) await deadline(end, "released preparation");
    }
  });

  test("cancels reviewers, shell work and retry waits, then delivers queued text and image exactly once", async () => {
    await writeFile(path.join(cwd, "new-ticket.txt"), "Review me\n");
    const ready = deferred<ChildGeneration>();
    const release = deferred<AssistantMessage>();
    let workload: Awaited<ReturnType<typeof holdShellWork>> | undefined;
    respond = (request) => {
      ready.resolve(request);
      return release.promise;
    };
    app = await openReview(directory, cwd, failures, [
      assistantMessage("Queued request received."),
    ]);
    try {
      let ended = false;
      const end = app.nextEnd().then((event) => {
        ended = true;
        return event;
      });
      await app.session.prompt("/review uncommitted focus=general");
      const request = await deadline(ready.promise, "review provider readiness");
      assert.match(app.view(), /^ Review · 0\/1 complete/);
      assert.equal(app.lines().length, 1);
      assert.equal(
        app.press("\x0f"),
        false,
        "Review must let the native expansion shortcut cascade",
      );
      app.ui.setToolsExpanded(true);
      assert.match(app.view(), /^ Review · 0\/1 complete/);
      assert.equal(app.lines().length, 2, "Review follows native expansion at render time");
      assert.match(app.view(), /general/);
      for (const width of [40, 160])
        assert.ok(
          app
            .view(width)
            .split("\n")
            .every((line) => visibleWidth(line) <= width),
        );
      await app.session.prompt("/review uncommitted focus=general");
      assert.equal(generations.length, 1, "the busy command must not start another reviewer");
      const cleaning = deferred<void>();
      const finishCleanup = deferred<void>();
      const remove = fs.rm;
      // Hold the real session-directory removal to observe the interval after child exit.
      const cleanup = mock.method(fs, "rm", async (...args: Parameters<typeof fs.rm>) => {
        if (args[0] === path.dirname(sessionPath(request.args))) {
          cleaning.resolve();
          await finishCleanup.promise;
        }
        return remove(...args);
      });
      syncBuiltinESMExports();
      try {
        app.ui.setToolsExpanded(false);
        app.handleActivity(true);
        app.confirmInterrupt();
        await deadline(cleaning.promise, "cancelled review cleanup readiness");
        assert.equal(ended, false, "review completion must join cancellation cleanup");
        assert.equal(app.activity(), "review 0/1 complete", "cleanup still belongs to active work");
        assert.deepEqual(app.lines(), []);
        assert.ok(
          app.activities.every(({ text }) => text !== undefined),
          "child cancellation must not clear the whole-operation contribution",
        );
      } finally {
        finishCleanup.resolve();
        try {
          await deadline(end, "cancelled review cleanup");
        } finally {
          cleanup.mock.restore();
          syncBuiltinESMExports();
        }
      }
      assert.equal((await end).outcome, "cancelled");
      const execution = app.session.sessionManager
        .getBranch()
        .filter((e) => e.type === "custom" && e.customType === "review-execution")
        .at(-1);
      assert.ok(execution?.type === "custom");
      const lane = (execution.data as ReviewExecution).lanes[0];
      assert.equal(lane.status, "cancelled");
      assert.ok(lane.elapsedMs !== null && lane.elapsedMs >= 0);
      assert.equal(app.activity(), undefined);
      await app.settle();
      assert.equal(
        children.find((child) => child.process === request.process)?.hasClosed,
        true,
        "cancellation joins the real child and its pipes before review ends",
      );
      assert.equal(
        app.reports().length,
        0,
        "cancelled findings are not reported as clean or failed review results",
      );
      assert.equal(app.mainRequests.length, 0, "cancellation must not trigger the main model");
      assert.equal(app.listeners.size, 0, "review shortcuts are removed after cancellation");
      assert.equal(app.view(), "", "cancellation removes above-composer progress");

      workload = await holdShellWork();
      const command = workload.command;
      shellCommand = command;
      respond = () => toolCall("bash", { command });
      const shellEnd = app.nextEnd();
      await app.session.prompt("/review uncommitted focus=general");
      await deadline(workload.ready, "native Bash workload readiness");
      app.confirmInterrupt();
      assert.equal((await deadline(shellEnd, "shell cancellation")).outcome, "cancelled");
      await app.settle();
      await deadline(workload.closed, "native Bash workload termination");
      await workload.dispose();
      workload = undefined;
      assert.equal(app.reports().length, 0);
      shellCommand = undefined;

      const backoff = deferred<void>();
      const sleep = timers.setTimeout;
      let retryExpired = false;
      const delay = mock.method(
        timers,
        "setTimeout",
        (ms: number, value: unknown, options?: { signal?: AbortSignal; ref?: boolean }) => {
          const pending = sleep(ms, value, options);
          if (ms < 400 || ms > 600) return pending;
          backoff.resolve();
          return pending.then((result) => {
            retryExpired = true;
            return result;
          });
        },
      );
      syncBuiltinESMExports();
      try {
        respond = () => ({
          ...assistantMessage(""),
          stopReason: "error",
          errorMessage: "Lock file is already being held",
        });
        const retryEnd = app.nextEnd();
        await app.session.prompt("/review uncommitted focus=general");
        await deadline(backoff.promise, "review retry readiness");
        app.confirmInterrupt();
        assert.equal((await deadline(retryEnd, "retry cancellation")).outcome, "cancelled");
        await app.settle();
        assert.equal(retryExpired, false, "Escape must not wait for the pending retry timer");
        assert.equal(generations.length, 3, "cancellation must not launch another retry");
      } finally {
        delay.mock.restore();
        syncBuiltinESMExports();
      }

      respond = async () => {
        // Enter while the restarted reviewer is awaiting its model, not the main agent.
        await app!.session.prompt("Keep the café open 🐙", {
          source: "interactive",
          images: [image],
        });
        assert.equal(app!.mainRequests.length, 0, "input is held until review completion");
        return submit([]);
      };
      const queuedSettled = deferred<void>();
      const unsubscribe = app.session.subscribe((event) => {
        if (event.type === "agent_settled") queuedSettled.resolve();
      });
      try {
        await app.run("/review uncommitted focus=general");
        // Native image normalization can finish after the review and before the parent starts.
        await deadline(queuedSettled.promise, "queued image delivery");
      } finally {
        unsubscribe();
      }
      assert.deepEqual(app.report().details.findings, []);
      assert.equal(generations.length, 4, "cancelled runs do not retain the lock");
      assert.equal(app.mainRequests.length, 1);
      assert.deepEqual(app.mainRequests[0].context.messages.at(-1)?.content, [
        { type: "text", text: "Keep the café open 🐙" },
        image,
      ]);
      assert.equal(app.session.pendingMessageCount, 0);
    } finally {
      release.resolve(assistantMessage("Cancelled fixture generation released."));
      const closing = app?.dispose();
      await workload?.dispose();
      await closing;
    }
  });

  async function openConfiguredReview() {
    respond = () => submit([]);
    return openReview(directory, cwd, failures, [], undefined, undefined, undefined, reviewModel, {
      extensions: [
        scriptedProvider(alternateReviewModel, () => {
          throw new Error("Review must not generate in the main session");
        }),
      ],
      tools: [],
    });
  }

  async function runConfiguredReview(options: string, models: string[], focuses: string[]) {
    assert.ok(app);
    const before = generations.length;
    await app.run(`/review commit HEAD ${options}`);
    const signature = JSON.parse(app.report().details.request.signature);
    assert.deepEqual(signature.models, [...models].sort());
    assert.deepEqual(signature.focuses, [...focuses].sort());
    const effectiveModels = models.length
      ? models
      : [`${alternateReviewModel.provider}/${alternateReviewModel.id}`];
    const labels = models.length ? models : [alternateReviewModel.id];
    assert.deepEqual(
      app.report().details.focusStatus.map(({ model, focus, ok }) => [model, focus, ok]),
      labels.flatMap((model) => focuses.map((focus) => [model, focus, true])),
    );
    assert.equal(generations.length - before, effectiveModels.length * focuses.length);
    for (const request of generations.slice(before))
      assert.ok(effectiveModels.includes(`${request.model.provider}/${request.model.id}`));
    assert.equal(app.mainRequests.length, 0);
    return app.report().details.request.signature;
  }
});

type ChildGeneration = Generation & { args: string[]; process: ChildProcess };

/** Adapt only terminal output/input; command dispatch, history, queues and edit tools are native Pi. */
async function openReview(
  directory: string,
  cwd: string,
  failures: unknown[],
  mainReplies: AssistantMessage[] = [],
  refreshModels?: Parameters<typeof scriptedProvider>[2],
  withSubagent?: "before" | "after",
  sessionFile?: string,
  selectedModel: Model<string> = reviewModel,
  fixture: { extensions: ExtensionFactory[]; tools: string[] } = { extensions: [], tools: [] },
) {
  const previousKeys = getKeybindings();
  const mainRequests: Generation[] = [];
  const notifications: { message: string; type?: string }[] = [];
  const activities: { sessionKey: string; source: string; text?: string }[] = [];
  let activityHandled = false;
  const listeners = new Set<TerminalInputHandler>();
  const ends: { outcome: string }[] = [];
  const endWaiters: ((event: { outcome: string }) => void)[] = [];
  let active = 0;
  let expanded = false;
  const viewListeners = new Set<() => void>();
  const widgets = new Map<string, Component>();
  const tui = new TuiMainScreen({ columns: 160, rows: 40, showCursor() {}, stop() {} } as Terminal);
  tui.stop();
  const lines = (width = 160) => widgets.get("review-progress")?.render(width) ?? [];
  const view = (width = 160) => lines(width).map(stripVTControlCharacters).join("\n");
  const redraw = tui.requestRender.bind(tui);
  tui.requestRender = () => {
    redraw();
    for (const check of viewListeners) check();
  };
  let disposed = false;
  const resources = await createPiResources(cwd, path.join(directory, "agent"), [
    ...(withSubagent === "before" ? [subagent] : []),
    review,
    ...(withSubagent === "after" ? [subagent] : []),
    ...fixture.extensions,
    scriptedProvider(
      selectedModel,
      (request) => {
        mainRequests.push(request);
        const reply = mainReplies.shift();
        if (!reply) {
          const error = new Error("Unexpected main-session model request");
          failures.push(error);
          throw error;
        }
        return reply;
      },
      refreshModels,
    ),
    (pi) => {
      // Substitute only the optional editor negotiation, keeping real Review progress and guards.
      pi.events.on("tau:activity", (data) => {
        const request = data as (typeof activities)[number] & { handled?: boolean };
        if (request.source !== "review") return;
        activities.push({ ...request });
        if (activityHandled) request.handled = true;
      });
      pi.events.on("review:start", () => {
        active++;
      });
      pi.events.on("review:end", (event) => {
        assert.notEqual(
          activities.at(-1)?.text,
          undefined,
          "Review retains its contribution through finalization until the operation ends",
        );
        active--;
        const result = event as { outcome: string };
        const waiter = endWaiters.shift();
        if (waiter) waiter(result);
        else ends.push(result);
      });
    },
  ]);
  const history = sessionFile
    ? SessionManager.open(sessionFile)
    : SessionManager.create(cwd, path.join(directory, "sessions"));
  if (!sessionFile) {
    history.appendMessage({ role: "user", content: "Review the café gate.", timestamp: 0 });
    history.appendMessage(assistantMessage("Ready for review."));
  }
  const { session } = await createAgentSession({
    ...resources,
    sessionManager: history,
    model: selectedModel,
    tools: ["edit", ...(withSubagent ? ["subagent"] : []), ...fixture.tools],
  });
  const nextEnd = () =>
    ends.length
      ? Promise.resolve(ends.shift()!)
      : new Promise<{ outcome: string }>((resolve) => endWaiters.push(resolve));
  const settle = async () => {
    // review:end precedes the command's finally/queue flush; drain that event-loop turn before waiting for Pi.
    await setImmediate();
    await session.waitForIdle();
  };
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    try {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      while (active > 0) await deadline(nextEnd(), "review shutdown");
      await session.abort();
      await settle();
      await resources.settingsManager.flush();
    } finally {
      session.dispose();
      tui.stop();
      setKeybindings(previousKeys);
    }
  };
  try {
    const keys = new KeybindingsManager({
      ...TUI_KEYBINDINGS,
      "app.tools.expand": { defaultKeys: "ctrl+o" },
      "app.interrupt": { defaultKeys: "escape" },
      "app.message.dequeue": { defaultKeys: "alt+up" },
      "app.message.followUp": { defaultKeys: "alt+enter" },
    }) as AppKeybindingsManager;
    setKeybindings(keys);
    initTheme("dark", false);
    const editor = new CustomEditor(
      tui,
      { borderColor: (text) => text, selectList: getSelectListTheme() },
      keys,
    );
    editor.onEscape = () => {
      if (session.isStreaming) {
        const { steering, followUp } = session.clearQueue();
        editor.setText([...steering, ...followUp, editor.getText()].filter(Boolean).join("\n\n"));
        void session.abort();
      } else if (session.isBashRunning) session.abortBash();
    };
    tui.setFocus(editor);
    const confirmations: { title: string; signal?: AbortSignal }[] = [];
    const ui = uiBoundary(
      {
        theme: session.extensionRunner.getUIContext().theme,
        notify: (message, type) => notifications.push({ message, type }),
        setStatus: (_key, value) => {
          assert.equal(value, undefined, "Review progress must not appear in the footer");
        },
        getToolsExpanded: () => expanded,
        setToolsExpanded: (value) => {
          expanded = value;
        },
        setWidget: (key, content, options) => {
          if (content !== undefined)
            assert.equal(options?.placement ?? "aboveEditor", "aboveEditor");
          if (typeof content === "function") widgets.set(key, content(tui, ui.theme));
          else if (content) widgets.set(key, new Text(content.join("\n"), 0, 0));
          else widgets.delete(key);
          for (const check of viewListeners) check();
        },
        onTerminalInput: (handler) => {
          listeners.add(handler);
          return () => {
            listeners.delete(handler);
          };
        },
        getEditorText: () => editor.getText(),
        setEditorText: (text) => editor.setText(text),
        confirm: async (title, message, options) => {
          confirmations.push({ title, signal: options?.signal });
          const dialog = openSelector(
            tui,
            editor,
            `${title}\n${message}`,
            ["Yes", "No"],
            options?.signal,
            () => {
              expanded = !expanded;
            },
          );
          return (await dialog.result) === "Yes";
        },
      } satisfies Partial<ExtensionUIContext>,
      failures,
    );
    await session.bindExtensions({
      uiContext: ui,
      mode: "tui",
      onError: (error) => failures.push(error),
    });
    const reports = () =>
      SessionManager.open(history.getSessionFile()!)
        .getBranch()
        .filter((entry) => entry.type === "custom_message" && entry.customType === "review");
    return {
      session,
      ui,
      tui,
      editor,
      confirmations,
      queuedInput: () =>
        widgets.get("review-message-queue")?.render(160).map(stripVTControlCharacters).join("\n") ??
        "",
      view,
      lines,
      activities,
      activity: () => activities.at(-1)?.text,
      handleActivity: (handled: boolean) => {
        activityHandled = handled;
      },
      async waitForView(predicate: (view: string) => boolean) {
        let check!: () => void;
        try {
          await deadline(
            new Promise<void>((resolve) => {
              check = () => {
                if (predicate(view())) resolve();
              };
              viewListeners.add(check);
              check();
            }),
            "review progress",
          );
        } finally {
          viewListeners.delete(check);
        }
      },
      modelRuntime: resources.modelRuntime,
      settingsManager: resources.settingsManager,
      mainRequests,
      notifications,
      listeners,
      nextEnd,
      settle,
      dispose,
      reports,
      report() {
        const entry = reports().at(-1);
        assert.ok(entry?.type === "custom_message");
        assert.equal(typeof entry.content, "string");
        assert.equal(
          (entry.details as ReviewMessageDetails)?.kind,
          "report",
          entry.content as string,
        );
        return { content: entry.content as string, details: entry.details as ReviewMessageDetails };
      },
      press(data: string) {
        for (const listener of listeners) {
          const result = listener(data);
          if (result?.consume) return true;
          data = result?.data ?? data;
        }
        const focused = tui.getFocusedComponent();
        if (!isKeyRelease(data) || focused?.wantsKeyRelease) focused?.handleInput?.(data);
        return false;
      },
      confirmInterrupt() {
        assert.equal(this.press("\x1b"), true);
        assert.equal(confirmations.at(-1)?.title, "Cancel all ongoing work?");
        this.press("\r");
      },
      async run(command: string) {
        const end = nextEnd();
        await session.prompt(command);
        const result = await deadline(end, "review completion");
        await settle();
        assert.equal(
          result.outcome,
          "success",
          JSON.stringify({ notifications, reports: reports() }),
        );
        assert.deepEqual(failures, []);
        assert.equal(view(), "", "completed reviews remove their progress widget");
      },
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

/** Check scope eligibility and submission contracts delivered through the real review pipeline, not full prose. */
function assertReviewPrompt(prompt: string, policy: "diff" | "snapshot" | "custom") {
  assert.match(prompt, /concrete, high-confidence/);
  assert.match(prompt, /discrete and actionable/);
  assert.match(prompt, /Have provable impact\.[^\n]*evidence from the repository or diff/);
  assert.match(
    prompt,
    /custom instructions, user context, or project review guidelines override these defaults/,
  );
  assert.match(
    prompt,
    /read-only review focus\. Do not modify files or repository state\. Do not run mutating commands/,
  );
  assert.match(prompt, /Never output findings as text or write them to files/);
  assert.match(prompt, /call submit_review exactly once as your final action/);
  assert.match(prompt, /If no issues are found, pass an empty array of findings to submit_review/);
  assert.doesNotMatch(
    prompt,
    /Do not report [^\n]*pre-existing|Only flag [^\n]*introduced by|Focus only on changes introduced/,
  );
  if (policy !== "snapshot") {
    assert.match(prompt, /In diff reviews, assess issues introduced by the scoped changes/);
    assert.match(
      prompt,
      /pre-existing, out of scope, or merely adjacent[^\n]*only as P3[^\n]*framed as follow-up work/,
    );
  }
  if (policy !== "diff") {
    assert.match(prompt, /assess existing issues in the selected paths at their actual severity/);
    assert.match(prompt, /Do not downgrade an issue to P3 merely because it is pre-existing/);
    assert.match(prompt, /Keep findings within the selected paths/);
  }
  if (policy === "snapshot") assert.doesNotMatch(prompt, /introduced (?:in|by)/);
  if (policy === "diff") assert.doesNotMatch(prompt, /In snapshot reviews/);
  if (policy === "custom") assert.match(prompt, /Use the custom instructions to determine/);
}

function submit(findings: FocusFinding[]) {
  return toolCall("submit_review", { findings });
}

function toolCall(name: string, args: JsonObject): AssistantMessage {
  return {
    ...assistantMessage(""),
    stopReason: "toolUse",
    content: [{ type: "toolCall", id: `call-${name}`, name, arguments: args }],
  };
}

function sessionPath(args: string[]) {
  assert.ok(args.includes("--session"));
  return args[args.indexOf("--session") + 1];
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}
