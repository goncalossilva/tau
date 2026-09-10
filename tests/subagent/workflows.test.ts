import assert from "node:assert/strict";
import childProcess, { type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs, { mkdir, mkdtemp, readFile, rm, access, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { contentText, type AssistantMessage } from "@earendil-works/pi-ai";
import {
  SandboxManager,
  type SandboxAskCallback,
  type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";
import {
  createAgentSession,
  CustomEditor,
  ToolExecutionComponent,
  getAgentDir,
  getPackageDir,
  initTheme,
  type ExtensionUIContext,
  type KeybindingsManager,
  type TerminalInputHandler,
} from "@earendil-works/pi-coding-agent";
import {
  TuiMainScreen,
  KeybindingsManager as TuiKeys,
  TUI_KEYBINDINGS,
  getKeybindings,
  setKeybindings,
  type Component,
  type Terminal,
} from "@earendil-works/pi-tui";
import subagent from "../../extensions/subagent/index.js";
import sandbox from "../../extensions/sandbox/index.js";
import { assistantMessage, createPiResources, uiBoundary } from "../helpers/pi.js";
import { scriptedProvider, type Generation } from "../helpers/provider.js";
import { holdShellWork } from "../helpers/shell.js";
import { deadline } from "../helpers/async.js";
import { parentModel, workerModel } from "./provider.js";

const spawn = childProcess.spawn;
type Request = Generation & { child: string; reply: (message: AssistantMessage) => void };
type Dialog = {
  title: string;
  choices?: string[];
  answer: (value: string | boolean | undefined) => void;
  signal?: AbortSignal;
};

describe("subagent", { concurrency: false }, () => {
  let directory: string;
  let cwd: string;
  let failures: unknown[];
  let processes: { process: ChildProcess; closed: Promise<void>; hasClosed: boolean }[];
  let generations: ReturnType<typeof mailbox<Request>>;
  let app: Awaited<ReturnType<typeof openParent>> | undefined;
  let shell: Awaited<ReturnType<typeof holdShellWork>> | undefined;
  let foregroundShell: Awaited<ReturnType<typeof holdShellWork>> | undefined;
  let unavailable: boolean;
  let sandboxed: boolean;
  let holdStartup: boolean;
  let starting: ReturnType<typeof mailbox<void>>;
  let policies: ReturnType<typeof mailbox<SandboxRuntimeConfig>>;
  let trust: ReturnType<typeof mailbox<boolean>>;

  beforeEach(async () => {
    failures = [];
    processes = [];
    generations = mailbox<Request>();
    unavailable = false;
    sandboxed = false;
    holdStartup = false;
    starting = mailbox<void>();
    policies = mailbox<SandboxRuntimeConfig>();
    trust = mailbox<boolean>();
    directory = await mkdtemp(path.join(os.tmpdir(), "tau-subagent-test-"));
    cwd = path.join(directory, "cookie workshop");
    await mkdir(cwd);
    await writeFile(path.join(cwd, "toppings.txt"), "Pistachios and lime.\n");
    const manifest = JSON.parse(await readFile(path.join(getPackageDir(), "package.json"), "utf8"));
    assert.equal(manifest.version, "0.85.1");
    const cli = path.join(getPackageDir(), manifest.bin.pi);
    const reject = (...args: unknown[]): never => {
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
    ] as const)
      mock.method(childProcess, method, reject);
    mock.method(childProcess, "spawn", (command: string, args: string[], options: SpawnOptions) => {
      if (command === "/bin/bash" && foregroundShell) {
        assert.deepEqual(args, ["-c", foregroundShell.command]);
        return spawn(command, args, options);
      }
      assert.equal(command, "pi");
      assert.equal(options.cwd, cwd);
      assert.equal(options.detached, true);
      assert.equal(options.env?.PI_CODING_AGENT_DIR, getAgentDir());
      assert.equal(options.env?.PI_SUBAGENT, "1");
      assert.deepEqual(args.slice(0, 2), ["--mode", "rpc"]);
      assert.ok(Array.isArray(options.stdio));
      const sessionFile = args[args.indexOf("--session") + 1];
      const child = path.basename(path.dirname(sessionFile));
      const proc = spawn(
        unavailable ? path.join(directory, "missing-pi") : process.execPath,
        [
          cli,
          ...args,
          "--offline",
          "--no-extensions",
          "--no-context-files",
          "--no-skills",
          "--no-prompt-templates",
          "--no-themes",
          "--extension",
          fileURLToPath(new URL("./provider.js", import.meta.url)),
        ],
        {
          ...options,
          env: {
            ...options.env,
            ...(shell ? { TAU_SUBAGENT_TEST_SHELL: shell.command } : {}),
            ...(sandboxed ? { TAU_SUBAGENT_TEST_SANDBOX: "1" } : {}),
            ...(holdStartup ? { TAU_SUBAGENT_TEST_STARTUP: "1" } : {}),
          },
          stdio: [...options.stdio, "ipc"],
        },
      );
      const tracked = { process: proc, closed: Promise.resolve(), hasClosed: false };
      tracked.closed = new Promise<void>((resolve) =>
        proc.once("close", () => {
          tracked.hasClosed = true;
          resolve();
        }),
      );
      processes.push(tracked);
      proc.on("message", (data) => {
        const request = data as Generation & { type: string; id: number };
        if (request.type === "trust") {
          trust.push((data as { trusted: boolean }).trusted);
          return;
        }
        if (request.type === "startup") {
          starting.push();
          return;
        }
        if (request.type === "sandbox") {
          policies.push((data as { config: SandboxRuntimeConfig }).config);
          return;
        }
        if (request.type !== "generation") {
          failures.push(data);
          return;
        }
        generations.push({
          ...request,
          child,
          reply: (message) => {
            assert.ok(proc.connected, "fixture reply belongs to a live child");
            proc.send({ type: "reply", id: request.id, message });
          },
        });
      });
      return proc;
    });
    syncBuiltinESMExports();
  });

  afterEach(async () => {
    try {
      try {
        await app?.dispose();
      } finally {
        await shell?.dispose();
        await foregroundShell?.dispose();
        for (const tracked of processes) if (!tracked.hasClosed) tracked.process.kill("SIGKILL");
        await Promise.all(processes.map((tracked) => tracked.closed));
      }
      assert.deepEqual(failures, [], "unexpected work and native extension errors must surface");
    } finally {
      app = undefined;
      shell = undefined;
      foregroundShell = undefined;
      mock.restoreAll();
      syncBuiltinESMExports();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("runs parallel fresh conversations, steers work, follows up, and delivers bounded answers exactly once", async () => {
    app = await openParent(cwd, failures);
    const first = await app.run({
      action: "start",
      goal: "Map toppings",
      prompt: "Read toppings.txt and explain the choices.",
    });
    assert.equal(first.isError, false, contentText(first.content));
    assert.deepEqual(first.details, {
      id: "a1",
      state: "running",
      model: "test/reply",
      thinking: "high",
    });
    const a1 = await generations.next();
    const second = await app.run({
      action: "start",
      goal: "Write menu",
      prompt: "Write menu.txt. Do not change toppings.txt.",
      model: "worker-fixture/quick",
      thinking: "low",
    });
    assert.equal(second.isError, false);
    assert.equal(second.details.thinking, "low");
    const a2 = await generations.next();
    assert.equal(a2.model.provider, "worker-fixture");
    for (const request of [a1, a2]) {
      assert.equal(request.context.messages.length, 1, "children do not inherit parent history");
      assert.ok(!JSON.stringify(request.context).includes("parent-only secret"));
      assert.ok(
        !request.context.tools?.some((tool) => tool.name === "subagent"),
        "children cannot recursively delegate",
      );
      assert.match(request.context.systemPrompt ?? "", /Other agents share these files/);
    }
    assert.equal(app.status(), "", "progress must not appear in the footer");
    assert.deepEqual(
      app.metrics(),
      { statusWrites: 0, renders: 2 },
      "collapsed workers repaint only when their count changes, not at event or spinner rate",
    );
    assert.match(app.view(), /Subagents: 2 running/);
    app.press("\x0f");
    assert.match(app.view(), /a1.*Map toppings.*test\/reply.*high/);
    assert.match(app.view(), /a2.*Write menu.*worker-fixture\/quick.*low/);
    assert.equal(app.editor.getText(), "Unsent cookie recipe");

    await app.run({ action: "steer", id: "a1", message: "Also explain the lime." });
    a1.reply(call("read", { path: "toppings.txt" }));
    const steered = await generations.next();
    assert.equal(steered.child, "a1");
    assert.match(contentText(steered.context.messages.at(-1)!.content), /Also explain the lime/);
    assert.ok(
      steered.context.messages.some(
        (message) =>
          message.role === "toolResult" && contentText(message.content).includes("Pistachios"),
      ),
    );
    a2.reply(call("write", { path: "menu.txt", content: "Lime cookies 🐙\n" }));
    const written = await generations.next();
    assert.equal(written.child, "a2");
    assert.equal(await readFile(path.join(cwd, "menu.txt"), "utf8"), "Lime cookies 🐙\n");
    written.reply(assistantMessage("Menu ready.\u2028Lime wins.\u2029"));
    assert.match(await app.reports.next(), /Menu ready.\u2028Lime wins.\u2029/);
    await app.session.waitForIdle();
    assert.match(app.view(), /✓ a2/, "automatic reports keep recently completed rows visible");
    await app.session.prompt("Next, choose the filling.", { source: "interactive" });
    assert.doesNotMatch(app.view(), /a2/, "the next user request clears completed rows");
    assert.match(app.view(), /a1.*Map toppings/, "active work stays visible across requests");
    const retained = await app.run({ action: "status" });
    assert.match(contentText(retained.content), /a2.*idle/);
    assert.doesNotMatch(app.view(), /a2/, "status queries do not revive hidden rows");
    assert.ok(
      processes.every((process) => !process.hasClosed),
      "hiding does not stop children",
    );

    const answer = `\x1b]52;c;dGVzdA==\x07${"Lime makes cookies bright 🐙.\n".repeat(1000)}`;
    steered.reply(assistantMessage(answer));
    const delivered = await app.reports.next();
    assert.ok(Buffer.byteLength(delivered) < 14_000);
    const snapshot = await app.run({ action: "status", id: "a1" });
    const component = new ToolExecutionComponent(
      "subagent",
      "answer-preview",
      { action: "status", id: "a1" },
      { showImages: false },
      app.session.getToolDefinition("subagent"),
      app.tui,
      cwd,
    );
    component.updateResult(snapshot);
    component.setArgsComplete();
    assert.ok(!component.render(160).join("\n").includes("Lime makes cookies"));
    component.setExpanded(true);
    const expanded = component.render(160).join("\n");
    assert.ok(expanded.includes("Lime makes cookies"));
    assert.ok(!expanded.includes("\x1b]52"), "rendering must not replay child terminal controls");
    const fullPath = delivered.match(/Full answer: (.+)/)?.[1];
    assert.ok(fullPath);
    assert.equal(await readFile(fullPath, "utf8"), answer);
    assert.match(app.view(), /✓ a1/, "extension-injected control prompts do not clear rows");
    await app.session.prompt("Now adjust the recipe.", { source: "rpc" });
    assert.equal(app.view(), "", "explicit RPC requests also clear completed rows");
    await app.run({ action: "steer", id: "a1", message: "How much lime?" });
    assert.match(app.view(), /a1.*Map toppings/, "steering shows a hidden child again");
    assert.doesNotMatch(app.view(), /a2/);
    const followup = await generations.next();
    assert.equal(followup.child, "a1");
    assert.ok(followup.context.messages.some((message) => contentText(message.content) === answer));
    followup.reply(assistantMessage("One zest per batch."));
    assert.match(await app.reports.next(), /One zest per batch/);
    assert.equal(
      await readFile(fullPath, "utf8"),
      answer,
      "follow-ups must not overwrite earlier answers",
    );
    await app.session.waitForIdle();
    assert.equal(app.reportCount(), 3);
    assert.ok(
      app.parentContexts.some((context) =>
        context.messages.some((message) =>
          contentText(message.content).includes("One zest per batch."),
        ),
      ),
      "hidden reports still reach the parent model",
    );
    assert.equal(app.status(), "", "idle children must not leave a zero-running footer");
    app.press("\x0f");
    assert.equal(
      app.view(),
      "",
      "idle views still follow native expansion without a spinner timer",
    );
    await app.dispose();
    assert.ok(processes.every((process) => process.hasClosed));
    await assert.rejects(access(fullPath), { code: "ENOENT" });
  });

  test("delivers completed answers after a busy parent settles, without waking an aborted parent", async () => {
    app = await openParent(cwd, failures);
    app.press("\x0f");
    for (const abort of [false, true]) {
      const child = await app.run({
        action: "start",
        goal: "Watch the timer",
        prompt: "Report when ready.",
      });
      const worker = await generations.next();
      const parent = app.session.prompt("Wait for the timer.");
      const waiting = await app.parentGenerations.next();
      worker.reply(assistantMessage("The cookies are ready."));
      await app.waitForView((view) => view.includes(`✓ ${child.details.id}`));
      const before = app.parentCalls();
      const count = app.reportCount();
      if (abort) app.press("\x1b");
      else waiting(assistantMessage("The timer rang."));
      await parent;
      assert.match(await app.reports.next(), /The cookies are ready/);
      await app.session.waitForIdle();
      assert.equal(app.reportCount(), count + 1);
      assert.equal(app.parentCalls(), before + (abort ? 0 : 1));
    }
  });

  test("queues child and parent approvals, cancels a queued child independently, and drains dialogs on shutdown", async () => {
    sandboxed = true;
    const errors = mock.method(console, "error", () => {});
    app = await openParent(cwd, failures, true, true);
    await app.session.prompt("/sandbox network deny add syrup.invalid");
    await app.session.prompt("/sandbox filesystem deny-write add glaze-secret.txt");
    app.press("\x0f");
    await app.run({ action: "start", goal: "Choose icing", prompt: "Ask about icing." });
    const a1 = await generations.next();
    const inherited = await policies.next();
    assert.deepEqual(inherited.network.deniedDomains, ["syrup.invalid"]);
    assert.ok(inherited.filesystem.denyWrite.includes("glaze-secret.txt"));
    await app.run({ action: "start", goal: "Choose sprinkles", prompt: "Ask about sprinkles." });
    const a2 = await generations.next();
    const unrelated = app.session.prompt("/recipe-notes");
    const notes = await app.dialogs.next();
    a1.reply(call("ask", { name: "Allow icing?", select: true }));
    await app.waitForView((view) => /a1.*approval/.test(view));
    assert.equal(
      app.currentDialog(),
      notes,
      "child approvals must wait for unrelated native prompts",
    );
    assert.equal(app.dialogs.size, 0);
    notes.answer(false);
    await unrelated;
    const icing = await app.dialogs.next();
    assert.match(icing.title, /a1.*Choose icing/s);
    a2.reply(call("ask", { name: "Allow sprinkles?", select: false }));
    await app.waitForView((view) => /a2.*approval/.test(view));
    await app.session.prompt("Keep waiting for approval.", { source: "rpc" });
    assert.match(app.view(), /a1.*approval/);
    assert.match(app.view(), /a2.*approval/);
    const parent = app.session.prompt("/parent-approval");
    await app.parentQueued.next();
    const stopped = await app.run({ action: "stop", id: "a2" });
    assert.equal(stopped.details.state, "stopped");
    assert.ok(processes[1].hasClosed);
    assert.equal(
      app.currentDialog(),
      icing,
      "stopping a queued child must not dismiss another child's dialog",
    );
    icing.answer("Allow");
    const parentDialog = await app.dialogs.next();
    assert.match(parentDialog.title, /Sandbox blocked network access to parent-approval.invalid/);
    const approved = await generations.next();
    assert.equal(approved.child, "a1");
    assert.equal(contentText(approved.context.messages.at(-1)!.content), '"Allow"');
    approved.reply(assistantMessage("Icing approved."));
    parentDialog.answer(false);
    await parent;
    await app.reports.next();
    assert.equal(app.editor.getText(), "Unsent cookie recipe");

    await app.run({ action: "steer", id: "a1", message: "Ask again." });
    (await generations.next()).reply(call("ask", { name: "Another batch?", select: false }));
    const pending = await app.dialogs.next();
    await app.run({ action: "start", goal: "Choose garnish", prompt: "Ask about garnish." });
    (await generations.next()).reply(call("ask", { name: "Allow garnish?", select: true }));
    await app.waitForView((view) => /a3.*approval/.test(view));
    const parentOnShutdown = app.session.prompt("/parent-approval");
    await app.parentQueued.next();
    await app.dispose();
    await parentOnShutdown;
    assert.deepEqual(
      errors.mock.calls.map((call) => call.arguments),
      [],
      "cancellation is a denial, not a prompt failure",
    );
    assert.equal(pending.signal?.aborted, true);
    assert.equal(app.currentDialog(), undefined);
    assert.equal(app.dialogs.size, 0, "queued requests must never appear after shutdown");
    assert.ok(processes.every((process) => process.hasClosed));
    assert.equal(app.reportCount(), 1, "cancelled tasks must not wake the parent");
  });

  test("Escape and session changes join startup, Bash work, and result delivery", async () => {
    shell = await holdShellWork();
    app = await openParent(cwd, failures);
    await app.run({
      action: "start",
      goal: "Hold the oven",
      prompt: "Run the assigned shell workload.",
    });
    (await generations.next()).reply(call("bash", { command: shell.command }));
    await deadline(shell.ready, "native Bash readiness");
    await app.run({ action: "steer", id: "a1", message: "Report when the shell finishes." });
    foregroundShell = await holdShellWork();
    const foreground = app.session.executeBash(foregroundShell.command, undefined, {
      excludeFromContext: true,
    });
    try {
      await deadline(foregroundShell.ready, "foreground Bash readiness");
      app.press("\x1b");
      await deadline(processes[0].closed, "cancelled RPC child close");
      await deadline(foregroundShell.closed, "foreground Bash cancellation");
      assert.equal((await foreground).cancelled, true, "Escape must reach native standalone Bash");
    } finally {
      app.session.abortBash();
      await foreground;
      await foregroundShell.dispose();
      foregroundShell = undefined;
    }
    await deadline(shell.closed, "native Bash exit");
    assert.equal(generations.size, 0, "cancellation must not run queued directions");
    await shell.dispose();
    shell = undefined;
    const stopped = await app.run({ action: "status", id: "a1" });
    assert.equal(stopped.details.state, "stopped");
    assert.equal(app.reportCount(), 0);
    holdStartup = true;
    const preparation = app.run({
      action: "start",
      goal: "Warm the oven",
      prompt: "Do not start after cancellation.",
    });
    await starting.next();
    app.press("\x1b");
    assert.equal((await preparation).isError, true);
    assert.ok(processes[1].hasClosed, "startup cancellation joins the unready RPC process");
    assert.equal(generations.size, 0);
    holdStartup = false;
    await app.run({ action: "start", goal: "Count cookies", prompt: "Count the next batch." });
    await generations.next();
    await app.dispose();
    assert.ok(processes.every((process) => process.hasClosed));
    assert.equal(app.reportCount(), 0);
    app = await openParent(cwd, failures);
    await app.run({ action: "start", goal: "Fresh batch", prompt: "Report readiness." });
    (await generations.next()).reply(assistantMessage("Ready."));
    assert.match(await app.reports.next(), /Ready\./);
    await app.session.waitForIdle();
    await app.session.reload();
    assert.ok(processes.every((process) => process.hasClosed));
    assert.equal(
      (await app.run({ action: "steer", id: "a1", message: "Are you still there?" })).isError,
      true,
    );
    const next = await app.run({
      action: "start",
      goal: "Another branch",
      prompt: "Wait for instructions.",
    });
    assert.equal(next.details.id, "a2", "reload must not reuse IDs from the same conversation");
    await generations.next();
    const target = app.session.sessionManager
      .getEntries()
      .find((entry) => entry.type === "message");
    assert.ok(target);
    await app.session.navigateTree(target.id, { summarize: false });
    assert.ok(
      processes.every((process) => process.hasClosed),
      "branch navigation must not receive results from abandoned work",
    );
    assert.equal(app.status(), "");

    const saving = mailbox<void>();
    const release = mailbox<void>();
    const originalWrite = fs.writeFile;
    const writer = mock.method(
      fs,
      "writeFile",
      async (...args: Parameters<typeof fs.writeFile>) => {
        if (/\/answer-[^/]+\.md$/.test(String(args[0]))) {
          saving.push();
          await release.next();
        }
        return originalWrite(...args);
      },
    );
    syncBuiltinESMExports();
    try {
      await app.run({ action: "start", goal: "Seal the answer", prompt: "Report readiness." });
      (await generations.next()).reply(assistantMessage("Ready for delivery."));
      await saving.next();
      app.press("\x1b");
      await deadline(processes.at(-1)!.closed, "cancellation during answer persistence");
    } finally {
      release.push();
      writer.mock.restore();
      syncBuiltinESMExports();
    }
    await app.dispose();
    assert.equal(
      app.reportCount(),
      1,
      "cancellation during result delivery must not wake the parent",
    );
  });

  for (const trusted of [true, false]) {
    test(`inherits the parent's project trust (${trusted}) in the real child`, async () => {
      app = await openParent(cwd, failures, true, false, trusted);
      assert.equal(
        (await app.run({ action: "start", goal: "Check trust", prompt: "Wait for the recipe." }))
          .isError,
        false,
      );
      assert.equal(await trust.next(), trusted);
      await generations.next();
    });
  }

  test("headless startup failures stay failures, and permission requests are denied without waiting", async () => {
    app = await openParent(cwd, failures, false);
    unavailable = true;
    const missing = await app.run({ action: "start", goal: "Missing oven", prompt: "Inspect it." });
    assert.equal(missing.isError, true);
    assert.match(contentText(missing.content), /ENOENT/);
    assert.ok(processes[0].hasClosed);
    unavailable = false;
    const unsupported = await app.run({
      action: "start",
      goal: "Too much thinking",
      prompt: "Inspect it.",
      thinking: "max",
    });
    assert.equal(unsupported.isError, true);
    assert.equal(generations.size, 0, "invalid settings must not start generation");
    assert.ok(processes[1].hasClosed);
    await app.run({ action: "start", goal: "Ask headlessly", prompt: "Ask before proceeding." });
    (await generations.next()).reply(call("ask", { name: "May I proceed?", select: false }));
    const denied = await generations.next();
    assert.equal(contentText(denied.context.messages.at(-1)!.content), "false");
    const denial = `Permission was denied.\n${"Diagnostic detail.\n".repeat(4000)}`;
    denied.reply({
      ...assistantMessage(""),
      stopReason: "error",
      errorMessage: denial,
    });
    const report = await app.reports.next();
    assert.match(report, /error.*\n\nPermission was denied\./s);
    assert.ok(Buffer.byteLength(report) < 13_000);
    const answerPath = report.match(/Full answer: (.+)/)?.[1];
    assert.ok(answerPath);
    assert.equal(await readFile(answerPath, "utf8"), denial);
    assert.equal(app.dialogs.size, 0);
    await app.dispose();
    app = await openParent(cwd, failures, false, "blocked");
    const count = processes.length;
    const blocked = await app.run({
      action: "start",
      goal: "Blocked oven",
      prompt: "Do not bypass the sandbox.",
    });
    assert.equal(blocked.isError, true);
    assert.match(contentText(blocked.content), /Sandbox is not ready/);
    assert.equal(processes.length, count, "a blocked parent must refuse before spawning");
    assert.equal(generations.size, 0);
  });
});

/** Real parent sessions and RPC children; adapt terminal dialogs and model generation, not queues or tools. */
async function openParent(
  cwd: string,
  failures: unknown[],
  interactive = true,
  withSandbox: boolean | "blocked" = false,
  trusted = true,
) {
  let askParent: SandboxAskCallback | undefined;
  if (withSandbox) {
    mock.method(SandboxManager, "checkDependencies", () => ({
      warnings: [],
      errors: withSandbox === "blocked" ? ["Fixture: no sandbox runtime"] : [],
    }));
    mock.method(
      SandboxManager,
      "initialize",
      async (...[config, ask]: Parameters<typeof SandboxManager.initialize>) => {
        SandboxManager.updateConfig(config);
        askParent = ask;
      },
    );
    await writeFile(
      path.join(cwd, "sandbox-fixture.json"),
      JSON.stringify({
        enabled: true,
        mode: "interactive",
        network: { allowedDomains: [], deniedDomains: [], allowUnixSockets: [] },
        filesystem: {
          denyRead: [],
          denyWrite: [],
          allowWrite: [cwd],
          allowTempDirs: false,
          allowGitCommonDir: false,
        },
      }),
    );
  }
  const planned = new Map<string, Record<string, unknown>>();
  const reports = mailbox<string>();
  const dialogs = mailbox<Dialog>();
  const views = mailbox<string>();
  const parentQueued = mailbox<void>();
  const parentGenerations = mailbox<(message: AssistantMessage) => void>();
  let parentCalls = 0;
  const parentContexts: Generation["context"][] = [];
  const resources = await createPiResources(cwd, getAgentDir(), [
    ...(withSandbox ? [sandbox] : []),
    subagent,
    scriptedProvider(parentModel, ({ context }, signal) => {
      parentCalls++;
      parentContexts.push(context);
      const last = context.messages.at(-1)!;
      if (last.role === "user" && contentText(last.content) === "Wait for the timer.") {
        return new Promise<AssistantMessage>((resolve) => {
          const finish = (message: AssistantMessage) => {
            signal?.removeEventListener("abort", cancel);
            resolve(message);
          };
          const cancel = () => finish({ ...assistantMessage(""), stopReason: "aborted" });
          signal?.addEventListener("abort", cancel, { once: true });
          if (signal?.aborted) cancel();
          else parentGenerations.push(finish);
        });
      }
      const action = last.role === "user" ? planned.get(contentText(last.content)) : undefined;
      return action
        ? call("subagent", action, contentText(last.content))
        : assistantMessage("Noted.");
    }),
    scriptedProvider(workerModel, () => {
      throw new Error("The parent's model must not change");
    }),
    (pi) => {
      pi.events.on("subagent:permission", () => {
        parentQueued.push();
      });
      pi.registerCommand("recipe-notes", {
        description: "An unrelated native UI prompt",
        async handler(_args, ctx) {
          assert.equal(
            await ctx.ui.confirm("Keep recipe notes open?", "This is not a child's approval."),
            false,
          );
        },
      });
      pi.registerCommand("parent-approval", {
        description:
          "Deliver a network denial through the parent's actual Sandbox permission callback",
        async handler() {
          assert.ok(askParent);
          assert.equal(await askParent({ host: "parent-approval.invalid", port: 443 }), false);
        },
      });
    },
  ]);
  resources.settingsManager.setProjectTrusted(trusted);
  resources.sessionManager.appendMessage({
    role: "user",
    content: "Keep the parent-only secret private.",
    timestamp: 0,
  });
  resources.sessionManager.appendMessage(assistantMessage("Understood."));
  const { session } = await createAgentSession({
    ...resources,
    model: parentModel,
    thinkingLevel: "high",
    tools: ["subagent"],
  });
  let disposed = false;
  let sequence = 0;
  let activeDialog: Dialog | undefined;
  let expanded = false;
  let renders = 0;
  let statusWrites = 0;
  const statuses = new Map<string, string>();
  const widgets = new Map<string, Component>();
  const listeners = new Set<TerminalInputHandler>();
  initTheme("dark", false);
  const theme = session.extensionRunner.getUIContext().theme;
  const terminal = { columns: 160, rows: 40, showCursor() {}, stop() {} } as Terminal;
  const tui = new TuiMainScreen(terminal);
  tui.stop();
  const plain = (value: string) => value;
  const keys = new TuiKeys({
    ...TUI_KEYBINDINGS,
    "app.tools.expand": { defaultKeys: "ctrl+o" },
    "app.interrupt": { defaultKeys: "escape" },
  }) as KeybindingsManager;
  const previousKeys = getKeybindings();
  setKeybindings(keys);
  const editor = new CustomEditor(
    tui,
    {
      borderColor: plain,
      selectList: {
        selectedPrefix: plain,
        selectedText: plain,
        description: plain,
        scrollInfo: plain,
        noMatch: plain,
      },
    },
    keys,
  );
  editor.setText("Unsent cookie recipe");
  editor.actionHandlers.set("app.tools.expand", () => {
    expanded = !expanded;
  });
  editor.onEscape = () => {
    if (session.isStreaming) {
      session.clearQueue();
      void session.abort();
    } else if (session.isBashRunning) session.abortBash();
  };
  const view = () =>
    [...widgets.values()]
      .flatMap((widget) => widget.render(160))
      .map(stripVTControlCharacters)
      .join("\n");
  const redraw = tui.requestRender.bind(tui);
  tui.requestRender = () => {
    renders++;
    views.push(view());
    redraw();
  };
  const show = (title: string, choices: string[] | undefined, signal?: AbortSignal) =>
    new Promise<string | boolean | undefined>((resolve) => {
      if (activeDialog) failures.push(new Error("An approval dialog was overwritten"));
      const finish = (value: string | boolean | undefined) => {
        signal?.removeEventListener("abort", cancel);
        activeDialog = undefined;
        resolve(value);
      };
      const cancel = () => finish(undefined);
      const dialog: Dialog = { title, choices, answer: finish, signal };
      activeDialog = dialog;
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
      else dialogs.push(dialog);
    });
  const ui = uiBoundary(
    {
      theme,
      notify: (message, type) => {
        if (type === "error") failures.push(new Error(message));
      },
      getToolsExpanded: () => expanded,
      setToolsExpanded: (value) => {
        expanded = value;
      },
      getEditorText: () => editor.getText(),
      setEditorText: (value) => editor.setText(value),
      setStatus: (key, value) => {
        if (key === "subagent") statusWrites++;
        if (value === undefined) statuses.delete(key);
        else statuses.set(key, value);
      },
      setWidget: (key, content, options) => {
        if (key === "subagent" && content !== undefined)
          assert.equal(options?.placement ?? "aboveEditor", "aboveEditor");
        if (typeof content === "function") widgets.set(key, content(tui, theme));
        else if (content === undefined) widgets.delete(key);
        else assert.fail("Unexpected string widget");
      },
      onTerminalInput: (handler) => {
        listeners.add(handler);
        return () => {
          listeners.delete(handler);
        };
      },
      select: async (title, choices, options) =>
        (await show(title, choices, options?.signal)) as string | undefined,
      confirm: async (title, _message, options) =>
        (await show(title, undefined, options?.signal)) === true,
      input: async (title, _placeholder, options) =>
        (await show(title, undefined, options?.signal)) as string | undefined,
    } satisfies Partial<ExtensionUIContext>,
    failures,
  );
  session.subscribe((event) => {
    if (
      event.type === "message_end" &&
      event.message.role === "custom" &&
      event.message.customType === "subagent"
    ) {
      assert.equal(event.message.display, false, "internal reports must not appear in chat");
      reports.push(String(event.message.content));
    }
  });
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    try {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      await session.abort();
      await session.waitForIdle();
      await resources.settingsManager.flush();
    } finally {
      session.dispose();
      tui.stop();
      setKeybindings(previousKeys);
    }
  };
  try {
    if (withSandbox)
      session.extensionRunner.setFlagValue(
        "sandbox-config",
        path.join(cwd, "sandbox-fixture.json"),
      );
    await session.bindExtensions({
      uiContext: interactive ? ui : undefined,
      mode: interactive ? "tui" : "print",
      onError: (error) => failures.push(error),
    });
    return {
      session,
      tui,
      editor,
      reports,
      parentContexts,
      dialogs,
      parentQueued,
      parentGenerations,
      parentCalls: () => parentCalls,
      view,
      dispose,
      currentDialog: () => activeDialog,
      status: () => statuses.get("subagent") ?? "",
      metrics: () => ({ statusWrites, renders }),
      reportCount: () => {
        const entries = session.sessionManager
          .getEntries()
          .filter((entry) => entry.type === "custom_message" && entry.customType === "subagent");
        assert.ok(
          entries.every((entry) => entry.type === "custom_message" && !entry.display),
          "saved reports stay hidden on reload",
        );
        return entries.length;
      },
      press(data: string) {
        for (const listener of listeners) if (listener(data)?.consume) return;
        editor.handleInput(data);
      },
      async waitForView(predicate: (value: string) => boolean) {
        await deadline(
          (async () => {
            while (!predicate(view())) await views.next();
          })(),
          "subagent view",
        );
      },
      async run(args: Record<string, unknown>) {
        await session.waitForIdle();
        const id = `control-${++sequence}`;
        planned.set(id, args);
        await session.prompt(id, { source: "extension" });
        await session.waitForIdle();
        const message = session.messages.find(
          (message) => message.role === "toolResult" && message.toolCallId === id,
        );
        assert.ok(message?.role === "toolResult", `missing result for ${id}`);
        return message as typeof message & { details: Record<string, unknown> };
      },
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

function call(
  name: string,
  args: Record<string, unknown>,
  id: string = randomUUID(),
): AssistantMessage {
  return {
    ...assistantMessage(""),
    stopReason: "toolUse",
    content: [{ type: "toolCall", id, name, arguments: args }],
  };
}
function mailbox<T>() {
  const values: T[] = [];
  const waiting: ((value: T) => void)[] = [];
  return {
    get size() {
      return values.length;
    },
    push(value: T) {
      const resolve = waiting.shift();
      if (resolve) resolve(value);
      else values.push(value);
    },
    next(): Promise<T> {
      return deadline(
        values.length
          ? Promise.resolve(values.shift()!)
          : new Promise<T>((resolve) => waiting.push(resolve)),
        "fixture event",
      );
    },
  };
}
