import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, mock, test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { SandboxManager, type SandboxAskCallback } from "@anthropic-ai/sandbox-runtime";
import type { AgentToolCallOutcome, AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  createAgentSession,
  getAgentDir,
  initTheme,
  ToolExecutionComponent,
  type ExtensionContext,
  type ExtensionFactory,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { Text, TuiMainScreen, type Terminal } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import toolDisplayMode from "../extensions/tool-display-mode.js";
import {
  assistantMessage,
  createPiResources,
  fixtureModel,
  isolatePiHome,
  uiBoundary,
} from "./helpers/pi.js";
import { scriptedProvider } from "./helpers/provider.js";

const dinnerCommand =
  "printf 'fed the kraken\\n' >> effects.txt; printf 'Dinner served.\\n' > 'secret recipe.txt'; printf 'done\\n'";

describe("sandbox", { concurrency: false }, () => {
  let home: Awaited<ReturnType<typeof isolatePiHome>> | undefined;
  let sandbox: ExtensionFactory;
  let createRuntime: typeof import("../extensions/sandbox/runtime.js").createSandboxRuntime;
  let directory: string;
  let cwd: string;
  let target: string;
  let configPath: string;
  let configBytes: string;
  let failures: unknown[];
  let boundary: ReturnType<typeof sandboxBoundary>;
  let pi: Awaited<ReturnType<typeof openSandbox>> | undefined;

  before(async () => {
    home = await isolatePiHome();
    // Defaults include getAgentDir() at import time.
    ({ default: sandbox } = await import("../extensions/sandbox/index.js"));
    ({ createSandboxRuntime: createRuntime } = await import("../extensions/sandbox/runtime.js"));
  });

  after(async () => home?.dispose());

  beforeEach(async () => {
    failures = [];
    directory = await mkdtemp(path.join(os.tmpdir(), "tau-sandbox-"));
    cwd = path.join(directory, "octopus workshop");
    target = path.join(cwd, "secret recipe.txt");
    configPath = path.join(getAgentDir(), "sandbox.json");
    await mkdir(cwd);
    await mkdir(getAgentDir(), { recursive: true });
    configBytes = JSON.stringify({
      enabled: true,
      network: { allowedDomains: [], deniedDomains: [], allowUnixSockets: [] },
      filesystem: {
        denyRead: [],
        allowRead: [],
        allowWrite: [cwd],
        denyWrite: [target],
        allowTempDirs: false,
        allowGitCommonDir: false,
      },
    });
    await writeFile(configPath, configBytes);
    await writeFile(target, "Eight pinches of paprika.\n");
    boundary = sandboxBoundary(cwd, failures);
  });

  afterEach(async () => {
    try {
      await pi?.dispose();
      assert.deepEqual(failures, [], "Pi must not swallow unexpected external work or errors");
    } finally {
      pi = undefined;
      await SandboxManager.reset();
      SandboxManager.getSandboxViolationStore().clear();
      mock.restoreAll();
      syncBuiltinESMExports();
      await rm(configPath, { force: true });
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("permission contexts keep native getters and reject access after reload", async () => {
    let capturedContext: ExtensionContext | undefined;
    const resources = await createPiResources(cwd, getAgentDir(), [
      (api) => {
        const runtime = createRuntime(api);
        api.on("session_start", (_event, ctx) =>
          runtime.withPermissionContext(ctx, undefined, async (wrapped) => {
            capturedContext = wrapped;
          }),
        );
      },
    ]);
    const { session } = await createAgentSession({
      ...resources,
      model: { ...fixtureModel, reasoning: true },
    });
    try {
      await session.bindExtensions({ mode: "print" });
      const captured = capturedContext;
      assert.ok(captured);
      assert.equal(captured.hasUI, false);
      session.setThinkingLevel("high");
      assert.equal(captured.thinkingLevel, "high", "thinking must not be frozen at capture time");
      await session.bindExtensions({
        mode: "tui",
        uiContext: uiBoundary({ notify() {} }, failures),
      });
      assert.equal(captured.hasUI, true);
      const oldUI = captured.ui;
      await session.reload();
      assert.throws(() => captured.model, /stale/);
      assert.throws(() => captured.ui, /stale/);
      assert.throws(() => oldUI.confirm, /stale/);
    } finally {
      session.dispose();
    }
  });

  test("cancels a nested filesystem approval independently of its parent", async () => {
    const dialog = deferred<void>();
    const decision = deferred<string | undefined>();
    const child = new AbortController();
    let parentSignal: AbortSignal | undefined;
    let issued = false;
    let nestedError: boolean | undefined;
    let dialogSignal: AbortSignal | undefined;
    boundary.attempts(dinnerCommand, permissionAttempts(target));
    pi = await openSandbox(
      cwd,
      (api) => {
        sandbox(api);
        scriptedProvider(fixtureModel, () => {
          if (issued) return assistantMessage("Parent is still alive.");
          issued = true;
          return {
            ...assistantMessage(""),
            stopReason: "toolUse",
            content: [
              { type: "toolCall", id: "parent-shell", name: "nested_shell", arguments: {} },
            ],
          };
        })(api);
        api.registerTool({
          name: "nested_shell",
          label: "Nested shell",
          description: "Run one fixture shell call",
          parameters: Type.Object({}),
          async execute(_id, _params, signal, _update, ctx) {
            parentSignal = signal;
            const outcome = await ctx.executeTool(
              "bash",
              { command: dinnerCommand },
              { signal: child.signal },
            );
            nestedError = outcome.isError;
            return { ...outcome.result, isError: outcome.isError };
          },
        });
      },
      failures,
      {
        tools: ["bash", "nested_shell"],
        ui: {
          select: async (_title, _choices, options) => {
            dialogSignal = options?.signal;
            dialog.resolve();
            return decision.promise;
          },
        },
      },
    );
    const execution = pi.session.prompt("Inspect the kitchen through a nested call.");
    try {
      await waitForStep(
        dialog.promise,
        execution.then((result) => {
          throw new Error(`completed before permission: ${JSON.stringify(result)}`);
        }),
      );
      child.abort();
      assert.equal(
        dialogSignal?.aborted,
        true,
        "nested cancellation must revoke the actual dialog",
      );
      assert.equal(parentSignal?.aborted, false);
      decision.resolve("Allow and retry now");
      await execution;
      assert.equal(nestedError, true);
      assert.equal(pi.session.getLastAssistantText(), "Parent is still alive.");
      assert.deepEqual(SandboxManager.getConfig()?.filesystem.denyWrite, [target]);
      assert.equal(await readFile(path.join(cwd, "effects.txt"), "utf8"), "fed the kraken\n");
    } finally {
      child.abort();
      decision.resolve(undefined);
      await execution;
    }
  });

  test("a queued tool cannot replace the running call's permission signal", async () => {
    const wrapping = deferred<void>();
    const release = deferred<void>();
    const queued = deferred<void>();
    const dialog = deferred<void>();
    const decision = deferred<string | undefined>();
    const first = new AbortController();
    const second = new AbortController();
    let dialogSignal: AbortSignal | undefined;
    const ordinary = "printf 'next squid\\n'";
    boundary.attempts(dinnerCommand, permissionAttempts(target));
    boundary.attempts(ordinary, [{ script: ordinary }]);
    const wrap = SandboxManager.wrapWithSandbox;
    mock.method(SandboxManager, "wrapWithSandbox", async (...args: Parameters<typeof wrap>) => {
      if (args[0] === dinnerCommand) {
        wrapping.resolve();
        await release.promise;
      }
      return wrap(...args);
    });
    pi = await openSandbox(cwd, sandbox, failures, {
      ui: {
        select: async (_title, _choices, options) => {
          dialogSignal = options?.signal;
          dialog.resolve();
          return decision.promise;
        },
      },
    });
    const execution = pi.bash(dinnerCommand, { signal: first.signal });
    const firstRejected = assert.rejects(execution, /Command aborted/);
    let next: Promise<unknown> | undefined;
    try {
      await waitForStep(wrapping.promise, firstRejected);
      const tool = pi.session.agent.state.tools.find((candidate) => candidate.name === "bash");
      assert.ok(tool);
      next = tool.execute("queued-squid", { command: ordinary }, second.signal, () =>
        queued.resolve(),
      );
      const secondRejected = assert.rejects(next, /Command aborted/);
      await waitForStep(queued.promise, secondRejected);
      second.abort();
      await waitForStep(secondRejected, firstRejected);
      release.resolve();
      await waitForStep(dialog.promise, firstRejected);
      assert.equal(dialogSignal?.aborted, false, "the queued call must not own this dialog");
      first.abort();
      assert.equal(dialogSignal?.aborted, true, "the running call must still own this dialog");
      decision.resolve("Allow and retry now");
      await firstRejected;
      assert.deepEqual(SandboxManager.getConfig()?.filesystem.denyWrite, [target]);
      assert.equal(await readFile(path.join(cwd, "effects.txt"), "utf8"), "fed the kraken\n");
      assert.equal(await readFile(target, "utf8"), "Eight pinches of paprika.\n");
      assert.equal(await readFile(configPath, "utf8"), configBytes);
      assert.equal(pi.permissionCount(), 1);
      assert.equal(
        bashOutput(await pi.bash(ordinary)),
        "next squid\n",
        "the queue keeps making progress",
      );
    } finally {
      first.abort();
      second.abort();
      release.resolve();
      decision.resolve(undefined);
      await Promise.allSettled([execution, next]);
    }
  });

  describe("network approval invocation lifetime", () => {
    for (const ending of ["cancellation", "ordinary completion"] as const) {
      test(`${ending} drains a stale approval before a same-host sibling starts`, async (t) => {
        const host = "kraken.invalid";
        const firstCommand = "printf 'first tentacle\\n'";
        const siblingCommand = "printf 'sibling tentacle\\n'";
        const firstDialog = deferred<void>();
        const firstRevoked = deferred<void>();
        const firstClosed = deferred<void>();
        const firstFinished = deferred<void>();
        const releaseFirst = deferred<void>();
        const firstDecision = deferred<boolean>();
        const siblingQueued = deferred<void>();
        const siblingDialog = deferred<void>();
        const siblingDecision = deferred<boolean>();
        const child = new AbortController();
        const events: string[] = [];
        const dialogSignals: (AbortSignal | undefined)[] = [];
        let firstApproval: Promise<boolean> | undefined;
        let siblingApproval: Promise<boolean> | undefined;
        let firstOutcome: AgentToolCallOutcome | undefined;
        let siblingOutcome: AgentToolCallOutcome | undefined;
        let parentSignal: AbortSignal | undefined;
        let issued = false;
        boundary.attempts(firstCommand, [{ script: firstCommand }]);
        boundary.attempts(siblingCommand, [{ script: siblingCommand }]);

        // SRT invokes its proxy callback independently of the command's execution promise.
        // Hold the first command before spawn so its dialog is open before either exit path.
        const wrap = SandboxManager.wrapWithSandbox;
        mock.method(SandboxManager, "wrapWithSandbox", async (...args: Parameters<typeof wrap>) => {
          const script = await wrap(...args);
          if (args[0] === firstCommand) {
            firstApproval = boundary.askNetwork({ host, port: 443 }).then((approved) => {
              events.push("first approval settled");
              return approved;
            });
            await releaseFirst.promise;
          } else {
            assert.equal(args[0], siblingCommand);
            events.push("sibling started");
            siblingApproval = boundary.askNetwork({ host, port: 443 });
            await siblingApproval;
          }
          return script;
        });
        boundary.onCommandClose(firstCommand, () => firstClosed.resolve());

        pi = await openSandbox(
          cwd,
          (api) => {
            sandbox(api);
            scriptedProvider(fixtureModel, () => {
              if (issued) return assistantMessage("Parent kept swimming.");
              issued = true;
              return {
                ...assistantMessage(""),
                stopReason: "toolUse",
                content: [
                  { type: "toolCall", id: "network-parent", name: "network_crew", arguments: {} },
                ],
              };
            })(api);
            api.registerTool({
              name: "network_crew",
              label: "Network crew",
              description: "Run two fixture shell calls",
              parameters: Type.Object({}),
              async execute(_id, _params, signal, _update, ctx) {
                parentSignal = signal;
                const first = ctx
                  .executeTool("bash", { command: firstCommand }, { signal: child.signal })
                  .then((outcome) => {
                    firstOutcome = outcome;
                    events.push("first tool settled");
                    firstFinished.resolve();
                  });
                await firstDialog.promise;
                const sibling = ctx
                  .executeTool(
                    "bash",
                    { command: siblingCommand },
                    {
                      onUpdate: () => siblingQueued.resolve(),
                    },
                  )
                  .then((outcome) => {
                    siblingOutcome = outcome;
                  });
                await Promise.all([first, sibling]);
                return {
                  content: [{ type: "text", text: "Network crew finished." }],
                  details: undefined,
                };
              },
            });
          },
          failures,
          {
            tools: ["bash", "network_crew"],
            ui: {
              async confirm(title, _message, options) {
                assert.ok(title.includes(host));
                dialogSignals.push(options?.signal);
                if (dialogSignals.length === 1) {
                  options?.signal?.addEventListener(
                    "abort",
                    () => {
                      events.push("first dialog revoked");
                      firstRevoked.resolve();
                    },
                    { once: true },
                  );
                  firstDialog.resolve();
                  // Deliberately non-cooperative frontend: its late reply must be joined and ignored.
                  const approved = await firstDecision.promise;
                  events.push("first UI settled");
                  return approved;
                }
                siblingDialog.resolve();
                return siblingDecision.promise;
              },
            },
          },
        );
        const execution = pi.session.prompt("Let both tentacles inspect the same host.");
        try {
          await waitForStep(firstDialog.promise, execution);
          await waitForStep(siblingQueued.promise, execution);
          if (ending === "cancellation") child.abort();
          releaseFirst.resolve();
          await waitForStep(firstRevoked.promise, firstFinished.promise);
          assert.equal(
            dialogSignals[0]?.aborted,
            true,
            "the actual dialog must lose its invocation lifetime",
          );
          await waitForStep(firstClosed.promise, execution);
          assert.equal(await readFile(configPath, "utf8"), configBytes);
          assert.ok(
            !events.includes("first tool settled"),
            "the owning tool must join its pending callback",
          );
          assert.ok(
            !events.includes("sibling started"),
            "the serial lane must remain owned until callback cleanup",
          );
          assert.equal(parentSignal?.aborted, false);
          assert.deepEqual(SandboxManager.getConfig()?.network.allowedDomains, []);

          firstDecision.resolve(true);
          await waitForStep(siblingDialog.promise, execution);
          assert.equal(await firstApproval, false, "a late approval cannot change session policy");
          assert.ok(events.indexOf("first UI settled") < events.indexOf("first approval settled"));
          assert.ok(events.indexOf("first approval settled") < events.indexOf("sibling started"));
          assert.equal(
            dialogSignals.length,
            2,
            "the sibling must receive its own approval, not the cancelled decision",
          );
          assert.equal(dialogSignals[1]?.aborted, false);
          assert.deepEqual(SandboxManager.getConfig()?.network.allowedDomains, []);
          siblingDecision.resolve(true);
          await execution;
          assert.equal(await siblingApproval, true);
          assert.ok(firstOutcome);
          assert.equal(firstOutcome.isError, ending === "cancellation");
          if (ending === "ordinary completion")
            assert.equal(bashOutput(firstOutcome.result), "first tentacle\n");
          assert.ok(siblingOutcome);
          assert.equal(siblingOutcome.isError, false);
          assert.equal(bashOutput(siblingOutcome.result), "sibling tentacle\n");
          assert.deepEqual(SandboxManager.getConfig()?.network.allowedDomains, [host]);
          assert.equal(pi.permissionCount(), 2);
          assert.equal(pi.session.getLastAssistantText(), "Parent kept swimming.");
          assert.equal(await readFile(configPath, "utf8"), configBytes);
        } catch (error) {
          t.diagnostic(
            JSON.stringify({
              events,
              abortedDialogs: dialogSignals.map((signal) => signal?.aborted),
            }),
          );
          throw error;
        } finally {
          child.abort();
          releaseFirst.resolve();
          firstDialog.resolve();
          firstDecision.resolve(false);
          siblingDecision.resolve(false);
          await Promise.allSettled([execution, firstApproval, siblingApproval]);
        }
      });
    }
  });

  test("refreshes agent context when a disabled sandbox becomes active on reload", async () => {
    await writeFile(configPath, JSON.stringify({ ...JSON.parse(configBytes), enabled: false }));
    pi = await openSandbox(cwd, sandbox, failures);
    const states = () =>
      pi!.session.sessionManager
        .getEntries()
        .flatMap((entry) =>
          entry.type === "custom_message" && entry.customType === "sandbox-state"
            ? [{ content: entry.content, display: entry.display }]
            : [],
        );
    assert.deepEqual(states(), [{ content: "Sandbox disabled", display: false }]);
    const probe = "printf 'local squid\\n'";
    boundary.allowLocal(probe);
    assert.equal(bashOutput(await pi.bash(probe)), "local squid\n");

    await writeFile(configPath, configBytes);
    await pi.session.reload();
    assert.deepEqual(states(), [
      { content: "Sandbox disabled", display: false },
      { content: "Sandbox enabled", display: false },
    ]);
    boundary.attempts(probe, [{ script: "printf 'sandboxed squid\\n'" }]);
    assert.equal(bashOutput(await pi.bash(probe)), "sandboxed squid\n");
  });

  describe("recovering a blocked shell", () => {
    for (const failure of ["missing dependencies", "initialization failure"] as const) {
      test(`${failure} cannot silently fall back to local bash; enable retries setup`, async () => {
        if (failure === "missing dependencies")
          boundary.dependencyErrors = ["fixture: no bubblewrap"];
        else boundary.initializationError = new Error("fixture: sandbox setup refused");
        pi = await openSandbox(cwd, sandbox, failures);
        const probe = "printf '%s\\n' \"$PI_SESSION_ID\" > probe.txt; printf 'kraken ready\\n'";
        boundary.allowLocal(probe);

        await assert.rejects(pi.bash(probe), /Sandbox.*(?:dependencies|initialization)/i);
        await assert.rejects(pi.bash(probe, { requestUnsandboxed: true }));
        assert.equal(pi.permissionCount(), 0, "failed setup cannot offer an approval bypass");
        await pi.command("disable");
        await assert.rejects(pi.bash(probe), /Sandbox.*(?:dependencies|initialization)/i);
        await assert.rejects(readFile(path.join(cwd, "probe.txt")), { code: "ENOENT" });
        assert.equal(pi.status(), "");
        const doctor = await pi.command("doctor");
        assert.match(doctor, /Runtime: blocked/);
        assert.match(
          doctor,
          failure === "missing dependencies" ? /missing-dependencies/ : /init-failed/,
        );
        assert.ok(doctor.includes(configPath));

        boundary.dependencyErrors = [];
        boundary.initializationError = undefined;
        boundary.attempts(probe, [{ script: probe }]);
        await pi.command("enable");
        assert.match(pi.status(), /sandbox \(interactive,/);
        assert.equal(bashOutput(await pi.bash(probe)), "kraken ready\n");
        assert.equal(
          await readFile(path.join(cwd, "probe.txt"), "utf8"),
          `${pi.session.sessionId}\n`,
        );

        await pi.command("disable");
        assert.equal(pi.status(), "");
        assert.deepEqual(pi.handoff().config, { enabled: false });
        assert.equal(
          bashOutput(await pi.bash(probe)),
          "kraken ready\n",
          "explicit suspension permits local bash",
        );
        assert.deepEqual(
          pi.session.sessionManager
            .getEntries()
            .filter((entry) => entry.type === "custom_message")
            .map((entry) => ({
              type: entry.customType,
              content: entry.content,
              display: entry.display,
            })),
          [
            { type: "sandbox-state", content: "Sandbox enabled", display: false },
            { type: "sandbox-state", content: "Sandbox disabled", display: false },
          ],
        );
        assert.equal(await readFile(configPath, "utf8"), configBytes);
      });
    }
  });

  for (const displayFirst of [false, true]) {
    test(`minimal Bash output preserves Sandbox approvals and execution (${displayFirst ? "display first" : "sandbox first"})`, async () => {
      const displayConfig = path.join(getAgentDir(), "tool-display-mode.json");
      await writeFile(displayConfig, '{"mode":"minimal"}\n');
      const command = "printf 'local\\n' >> order.txt; printf 'unconfined squid\\n'";
      boundary.allowLocal(command);
      boundary.attempts(command, [
        { script: "printf 'confined squid\\n'" },
        { script: "printf 'confined squid\\n'" },
      ]);
      let approve = false;
      let approvals = 0;
      let customRendering = false;
      try {
        pi = await openSandbox(
          cwd,
          (api) => {
            for (const extension of displayFirst
              ? [toolDisplayMode, sandbox]
              : [sandbox, toolDisplayMode])
              extension(api);
            api.registerToolRenderer((name, next) => {
              const renderers = next();
              return name === "bash" && customRendering
                ? { ...renderers, renderResult: () => new Text("Chef's custom result.", 0, 0) }
                : renderers;
            });
          },
          failures,
          {
            ui: {
              getEditorComponent: () => undefined,
              setEditorComponent() {},
              setToolsExpanded() {},
              setWidget() {},
              async select(_title, choices) {
                approvals++;
                assert.deepEqual(choices, ["Deny", "Run once outside sandbox"]);
                return approve ? "Run once outside sandbox" : "Deny";
              },
            },
          },
        );
        const tui = new TuiMainScreen({
          columns: 100,
          rows: 30,
          stop() {},
          showCursor() {},
        } as Terminal);
        tui.stop();
        mock.method(tui, "requestRender");
        for (const reload of [false, true]) {
          if (reload) await pi.session.reload();
          const policy = structuredClone(SandboxManager.getConfig());
          const result = await pi.bash(command);
          assert.equal(bashOutput(result), "confined squid\n");
          const renderers = pi.session.extensionRunner.resolveToolRenderers("bash", () =>
            pi!.session.getToolDefinition("bash"),
          );
          const row = new ToolExecutionComponent(
            "bash",
            "display-sandbox",
            { command },
            { showImages: false },
            renderers,
            tui,
            cwd,
          );
          row.setArgsComplete();
          row.updateResult({ ...result, isError: false });
          const text = () => row.render(100).map(stripVTControlCharacters).join("\n");
          assert.match(text(), /↳ 1 line/);
          assert.doesNotMatch(text(), /^\s*confined squid\s*$/m);
          row.setExpanded(true);
          assert.match(text(), /^\s*confined squid\s*$/m);

          approve = false;
          await assert.rejects(pi.bash(command, { requestUnsandboxed: true }));
          approve = true;
          assert.equal(
            bashOutput(await pi.bash(command, { requestUnsandboxed: true })),
            "unconfined squid\n",
          );
          assert.deepEqual(SandboxManager.getConfig(), policy);
          assert.equal(await readFile(configPath, "utf8"), configBytes);
        }
        customRendering = true;
        const renderers = pi.session.extensionRunner.resolveToolRenderers("bash", () =>
          pi!.session.getToolDefinition("bash"),
        );
        const row = new ToolExecutionComponent(
          "bash",
          "custom-sandbox",
          { command },
          { showImages: false },
          renderers,
          tui,
          cwd,
        );
        row.updateResult({ content: [{ type: "text", text: "private output" }], isError: false });
        const rendered = row.render(100).map(stripVTControlCharacters).join("\n");
        assert.match(rendered, /Chef's custom result\./);
        assert.doesNotMatch(rendered, /↳/);
        assert.equal(approvals, 4, "each unsandboxed invocation still needs a fresh decision");
        assert.equal(pi.permissionCount(), 4);
        assert.equal(await readFile(path.join(cwd, "order.txt"), "utf8"), "local\nlocal\n");
      } finally {
        await rm(displayConfig, { force: true });
      }
    });
  }

  describe("requesting one command outside the sandbox", () => {
    test("requires fresh approval each time without changing policy or later sandboxed commands", async () => {
      const marker = "octopus\t\r\u001b[31m\u0007\u0085\u202e\u2066\u2028\u2029";
      const command =
        `printf '%s' '${marker}' > controls.txt;\n` +
        "printf '%s\\n' \"$PI_SESSION_ID\" > 'local session.txt'; printf 'local\\n' >> order.txt; printf 'local\\n'";
      boundary.allowLocal(command);
      boundary.attempts(command, [
        { script: "printf 'sandboxed\\n' >> order.txt; printf 'sandboxed\\n'" },
      ]);
      let approvals = 0;
      pi = await openSandbox(cwd, sandbox, failures, {
        ui: {
          async select(title, choices, options) {
            approvals++;
            const displayed = command.replace(
              marker,
              String.raw`octopus\u0009\u000d\u001b[31m\u0007\u0085\u202e\u2066\u2028\u2029`,
            );
            assert.equal(title.split("\n").slice(2, -2).join("\n"), `$ ${displayed}`);
            assert.match(title, /^Run once outside sandbox\?\n\n/);
            assert.ok(!title.includes(cwd), "the approval does not include a folder line");
            assert.match(title, /descendants|child processes/i);
            assert.match(title, /host filesystem and network access/);
            assert.deepEqual(choices, ["Deny", "Run once outside sandbox"]);
            assert.equal(options?.signal?.aborted, false);
            return "Run once outside sandbox";
          },
        },
      });
      const policy = structuredClone(SandboxManager.getConfig());
      const handoff = structuredClone(pi.handoff());
      const status = pi.status();

      assert.equal(bashOutput(await pi.bash(command, { requestUnsandboxed: true })), "local\n");
      assert.equal(bashOutput(await pi.bash(command)), "sandboxed\n");
      assert.equal(bashOutput(await pi.bash(command, { requestUnsandboxed: true })), "local\n");
      assert.equal(approvals, 2);
      assert.equal(pi.permissionCount(), 2, "both approvals use the shared permission bridge");
      assert.equal(
        await readFile(path.join(cwd, "order.txt"), "utf8"),
        "local\nsandboxed\nlocal\n",
      );
      assert.equal(
        await readFile(path.join(cwd, "local session.txt"), "utf8"),
        `${pi.session.sessionId}\n`,
      );
      assert.deepEqual(await readFile(path.join(cwd, "controls.txt")), Buffer.from(marker));
      assert.deepEqual(SandboxManager.getConfig(), policy);
      assert.deepEqual(pi.handoff(), handoff);
      assert.equal(pi.status(), status);
      assert.equal(await readFile(configPath, "utf8"), configBytes);
    });

    for (const decision of ["deny", "dismiss", "UI failure"] as const) {
      test(`${decision} does not execute the command or fall back to sandboxed execution`, async () => {
        const command = "printf 'escaped\\n' > forbidden.txt";
        // No local script or wrapped attempt is allowed. Any execution fails the boundary.
        pi = await openSandbox(cwd, sandbox, failures, {
          ui: {
            async select() {
              if (decision === "UI failure") throw new Error("The octopus closed the window");
              return decision === "deny" ? "Deny" : undefined;
            },
          },
        });
        const policy = structuredClone(SandboxManager.getConfig());
        await assert.rejects(pi.bash(command, { requestUnsandboxed: true }));
        assert.equal(pi.permissionCount(), 1);
        await assert.rejects(readFile(path.join(cwd, "forbidden.txt")), { code: "ENOENT" });
        assert.deepEqual(SandboxManager.getConfig(), policy);
        assert.equal(await readFile(configPath, "utf8"), configBytes);
      });
    }

    for (const unavailable of ["non-interactive mode", "headless UI"] as const) {
      test(`${unavailable} refuses an unsandboxed request without waiting for approval`, async () => {
        pi = await openSandbox(cwd, sandbox, failures);
        if (unavailable === "non-interactive mode") await pi.command("mode non-interactive");
        else await pi.session.bindExtensions({ mode: "print" });
        await assert.rejects(pi.bash("printf 'not approved\\n'", { requestUnsandboxed: true }));
        assert.equal(pi.permissionCount(), 0);
        assert.equal(await readFile(configPath, "utf8"), configBytes);
      });
    }

    test("cancellation rejects a late approval and lets sandboxed execution continue", async () => {
      const dialog = deferred<void>();
      const decision = deferred<string | undefined>();
      const controller = new AbortController();
      const outside = "printf 'escaped\\n' > forbidden.txt";
      const ordinary = "printf 'still sandboxed\\n'";
      let dialogSignal: AbortSignal | undefined;
      boundary.attempts(ordinary, [{ script: ordinary }]);
      pi = await openSandbox(cwd, sandbox, failures, {
        ui: {
          // Deliberately non-cooperative UI: an approval reply can arrive after cancellation.
          select: async (_title, _choices, options) => {
            dialogSignal = options?.signal;
            dialog.resolve();
            return decision.promise;
          },
        },
      });
      const execution = pi.bash(outside, { requestUnsandboxed: true, signal: controller.signal });
      const rejected = assert.rejects(execution);
      let next: Promise<AgentToolResult<unknown>> | undefined;
      try {
        await waitForStep(dialog.promise, rejected);
        next = pi.bash(ordinary);
        assert.equal(dialogSignal?.aborted, false);
        controller.abort();
        assert.equal(dialogSignal?.aborted, true, "cancellation revokes the native selection");
        decision.resolve("Run once outside sandbox");
        await rejected;
        assert.equal(bashOutput(await next), "still sandboxed\n");
        await assert.rejects(readFile(path.join(cwd, "forbidden.txt")), { code: "ENOENT" });
        assert.equal(await readFile(configPath, "utf8"), configBytes);
      } finally {
        controller.abort();
        decision.resolve(undefined);
        await Promise.allSettled([execution, next]);
      }
    });

    test("cancels a queued request without waiting for an earlier filesystem dialog", async () => {
      const dialog = deferred<void>();
      const started = deferred<void>();
      const decision = deferred<string | undefined>();
      const controller = new AbortController();
      boundary.attempts(dinnerCommand, permissionAttempts(target));
      let prompts = 0;
      pi = await openSandbox(cwd, sandbox, failures, {
        ui: {
          select: async () => {
            prompts++;
            dialog.resolve();
            return decision.promise;
          },
        },
      });
      const ordinary = pi.bash(dinnerCommand);
      const ordinaryCompleted = ordinary.then((result) => {
        assert.match(bashOutput(result, 1), /Command exited with code 1/);
      });
      let outside: Promise<unknown> | undefined;
      try {
        await waitForStep(dialog.promise, ordinaryCompleted);
        const tool = pi.session.agent.state.tools.find((candidate) => candidate.name === "bash");
        assert.ok(tool);
        outside = tool.execute(
          "queued-outside",
          { command: "printf 'escaped\\n' > forbidden.txt", requestUnsandboxed: true },
          controller.signal,
          () => started.resolve(),
        );
        const rejected = assert.rejects(outside);
        await waitForStep(started.promise, rejected);
        controller.abort();
        await waitForStep(rejected, ordinaryCompleted);
        assert.equal(prompts, 1, "the cancelled request must never open its own approval dialog");
        decision.resolve("Deny");
        await ordinaryCompleted;
        await assert.rejects(readFile(path.join(cwd, "forbidden.txt")), { code: "ENOENT" });
        assert.equal(await readFile(path.join(cwd, "effects.txt"), "utf8"), "fed the kraken\n");
      } finally {
        controller.abort();
        decision.resolve("Deny");
        await Promise.allSettled([ordinary, outside]);
      }
    });

    test("reload revokes a pending approval rather than transferring it to the new extension", async () => {
      const dialog = deferred<void>();
      const revoked = deferred<void>();
      const decision = deferred<string | undefined>();
      let dialogSignal: AbortSignal | undefined;
      pi = await openSandbox(cwd, sandbox, failures, {
        ui: {
          select: async (_title, _choices, options) => {
            dialogSignal = options?.signal;
            assert.equal(dialogSignal?.aborted, false);
            dialogSignal.addEventListener("abort", () => revoked.resolve(), { once: true });
            dialog.resolve();
            // Simulate a stale frontend's late reply after its selection was revoked.
            return decision.promise;
          },
        },
      });
      const execution = pi.bash("printf 'escaped\\n' > forbidden.txt", {
        requestUnsandboxed: true,
      });
      const rejected = assert.rejects(execution);
      let reload: Promise<void> | undefined;
      try {
        await waitForStep(dialog.promise, rejected);
        reload = pi.session.reload();
        await waitForStep(revoked.promise, reload);
        assert.equal(dialogSignal?.aborted, true, "reload revokes the native selection");
        decision.resolve("Run once outside sandbox");
        await rejected;
        await reload;
        await assert.rejects(readFile(path.join(cwd, "forbidden.txt")), { code: "ENOENT" });
        assert.equal(await readFile(configPath, "utf8"), configBytes);
      } finally {
        decision.resolve(undefined);
        await Promise.allSettled([execution, reload]);
      }
    });
  });

  test("an untrusted checkout cannot disable the sandbox, but an explicit override replaces both config files", async () => {
    const projectConfig = path.join(cwd, ".pi", "sandbox.json");
    await mkdir(path.dirname(projectConfig));
    const projectBytes = '{"enabled":false,"network":{"allowedDomains":["sneaky.invalid"]}}\n';
    await writeFile(projectConfig, projectBytes);
    pi = await openSandbox(cwd, sandbox, failures);
    assert.equal(pi.session.extensionRunner.createContext().isProjectTrusted(), false);
    assert.match(pi.status(), /sandbox/);
    assert.deepEqual(SandboxManager.getConfig()?.network.allowedDomains, []);
    const doctor = await pi.command("doctor");
    assert.ok(doctor.includes(projectConfig));
    assert.match(doctor, /skipped \(project not trusted\)/);
    await pi.dispose();
    pi = undefined;

    const overridePath = path.join(cwd, "travel policy.json");
    const overrideBytes = JSON.stringify({
      network: { allowedDomains: ["octopus.invalid"], allowUnixSockets: [] },
      filesystem: { denyWrite: ["do-not-touch.txt"], allowTempDirs: false },
    });
    await writeFile(overridePath, overrideBytes);
    pi = await openSandbox(cwd, sandbox, failures, {
      flags: { "sandbox-config": "travel policy.json" },
    });
    assert.deepEqual(SandboxManager.getConfig()?.network.allowedDomains, ["octopus.invalid"]);
    assert.deepEqual(SandboxManager.getConfig()?.filesystem.denyWrite, ["do-not-touch.txt"]);
    await pi.command('filesystem deny-write add "a folder/ink budget.txt"');
    await pi.command("network allow add temporary.invalid");
    assert.deepEqual(SandboxManager.getConfig()?.network.allowedDomains, [
      "octopus.invalid",
      "temporary.invalid",
    ]);
    assert.ok(SandboxManager.getConfig()?.filesystem.denyWrite.includes("a folder/ink budget.txt"));

    await pi.session.reload();
    assert.deepEqual(SandboxManager.getConfig()?.network.allowedDomains, ["octopus.invalid"]);
    assert.deepEqual(SandboxManager.getConfig()?.filesystem.denyWrite, ["do-not-touch.txt"]);
    assert.equal(await readFile(configPath, "utf8"), configBytes);
    assert.equal(await readFile(projectConfig, "utf8"), projectBytes);
    assert.equal(await readFile(overridePath, "utf8"), overrideBytes);
  });

  describe("deciding what to do after a partially completed command", () => {
    for (const { name, choice, allowed, retry } of [
      { name: "deny", choice: "Deny", allowed: false, retry: false },
      { name: "dismiss", choice: undefined, allowed: false, retry: false },
      {
        name: "allow without replaying side effects",
        choice: "Allow but adapt for side-effects",
        allowed: true,
        retry: false,
      },
      { name: "explicitly retry once", choice: "Allow and retry now", allowed: true, retry: true },
    ]) {
      test(name, async () => {
        const command = dinnerCommand;
        boundary.attempts(command, permissionAttempts(target));
        let prompts = 0;
        pi = await openSandbox(cwd, sandbox, failures, {
          ui: {
            async select(title, choices) {
              prompts++;
              try {
                assert.ok(title.includes(target));
                assert.deepEqual(choices, [
                  "Allow and retry now",
                  "Allow but adapt for side-effects",
                  "Deny",
                ]);
                return choice;
              } catch (error) {
                failures.push(error); // Tau catches dialog errors; do not lose test assertions.
                throw error;
              }
            },
          },
        });

        // Only a successful rerun can turn the tool into a success.
        const output = bashOutput(await pi.bash(command), retry ? 0 : 1);
        assert.equal(prompts, 1);
        assert.equal(
          await readFile(path.join(cwd, "effects.txt"), "utf8"),
          "fed the kraken\n".repeat(retry ? 2 : 1),
        );
        assert.equal(
          await readFile(target, "utf8"),
          retry ? "Dinner served.\n" : "Eight pinches of paprika.\n",
        );
        assert.equal(SandboxManager.getConfig()?.filesystem.denyWrite.includes(target), !allowed);
        assert.equal(
          await readFile(configPath, "utf8"),
          configBytes,
          "permission decisions are session-only",
        );
        const doctor = await pi.command("doctor");
        assert.ok(doctor.includes(target));
        assert.match(
          doctor,
          allowed ? /\[allowed\] explicit-deny-write/ : /\[blocked\] explicit-deny-write/,
        );
        assert.doesNotMatch(
          output,
          /<sandbox_violations>/,
          "raw OS annotations are summarized, not dumped",
        );
      });
    }
  });

  describe("attributing raw permission errors", () => {
    for (const { name, errorLine, initializationFailure, traversal = false } of [
      {
        name: "nested sandbox startup failure",
        errorLine: "sandbox-exec: sandbox_apply: Operation not permitted",
        initializationFailure: true,
      },
      {
        name: "startup failure with an incidental traversal denial",
        errorLine: "sandbox-exec: sandbox_apply: Operation not permitted",
        initializationFailure: true,
        traversal: true,
      },
      { name: "generic EPERM", errorLine: "Error: EPERM", initializationFailure: false },
      {
        name: "generic Operation not permitted",
        errorLine: "Error: Operation not permitted",
        initializationFailure: false,
      },
    ]) {
      test(`${name} does not turn unrelated trace paths into filesystem permissions`, async () => {
        boundary.attempts(dinnerCommand, [
          {
            script: `printf 'fed the kraken\\n' >> effects.txt
cat <<'TAU_ERROR' >&2
${errorLine}
    at loadRecipe (${target}:19:7)
Debug: loaded source '${target}'
TAU_ERROR
exit 73`,
            ...(traversal ? { violation: `find(42) deny(1) file-write-unlink ${target}` } : {}),
          },
        ]);
        // The default UI boundary records and throws on any unexpected permission dialog.
        pi = await openSandbox(cwd, sandbox, failures);
        const policy = structuredClone(SandboxManager.getConfig());
        const handoff = structuredClone(pi.handoff().config);

        const output = bashOutput(await pi.bash(dinnerCommand), 73);
        assert.match(output, /Command exited with code 73/);
        assert.ok(output.includes(errorLine));
        if (initializationFailure) assert.match(output, /\[sandbox\].*initializ/i);
        else assert.doesNotMatch(output, /\[sandbox\].*initializ/i);
        assert.doesNotMatch(
          output,
          /Sandbox blocked filesystem|temporarily allow for this session|already been granted/i,
        );
        assert.equal(pi.permissionCount(), 0);
        assert.deepEqual(SandboxManager.getConfig(), policy);
        assert.deepEqual(pi.handoff().config, handoff);
        assert.equal(await readFile(configPath, "utf8"), configBytes);
        assert.equal(await readFile(path.join(cwd, "effects.txt"), "utf8"), "fed the kraken\n");
        assert.equal(await readFile(target, "utf8"), "Eight pinches of paprika.\n");
        const doctor = await pi.command("doctor");
        assert.doesNotMatch(doctor, /\[filesystem\]/);
        if (initializationFailure) {
          assert.match(doctor, /\[runtime\] \[blocked\] init-failed/);
        } else {
          assert.doesNotMatch(doctor, /init-failed/);
        }
      });
    }

    for (const source of ["Node error", "CLI error", "kernel record"] as const) {
      test(`${source} identifies the denied path despite misleading raw output`, async () => {
        const decoy = path.join(directory, "red-herring.js");
        const errorLine =
          source === "CLI error"
            ? `cat: ${target}: Operation not permitted`
            : `Error: EPERM: operation not permitted, open '${source === "kernel record" ? decoy : target}'`;
        boundary.attempts(dinnerCommand, [
          {
            script: `printf 'fed the kraken\\n' >> effects.txt
cat <<'TAU_ERROR' >&2
${errorLine}
    at loadRecipe (${decoy}:19:7)
TAU_ERROR
exit 73`,
            ...(source === "kernel record"
              ? { violation: `bash(42) deny(1) file-write-data ${target}` }
              : {}),
          },
        ]);
        const prompts: string[] = [];
        pi = await openSandbox(cwd, sandbox, failures, {
          ui: {
            async select(title) {
              prompts.push(title);
              try {
                assert.ok(title.includes(target));
                assert.ok(!title.includes(decoy));
                return "Allow but adapt for side-effects";
              } catch (error) {
                failures.push(error);
                throw error;
              }
            },
          },
        });
        const policy = structuredClone(SandboxManager.getConfig());
        assert.ok(policy);
        policy.filesystem.denyWrite = [];

        assert.match(bashOutput(await pi.bash(dinnerCommand), 73), /Command exited with code 73/);
        assert.equal(prompts.length, 1);
        assert.equal(pi.permissionCount(), 1);
        assert.deepEqual(SandboxManager.getConfig(), policy);
        assert.equal(await readFile(configPath, "utf8"), configBytes);
        assert.equal(await readFile(path.join(cwd, "effects.txt"), "utf8"), "fed the kraken\n");
        assert.equal(await readFile(target, "utf8"), "Eight pinches of paprika.\n");
        const doctor = await pi.command("doctor");
        assert.match(doctor, /\[filesystem\] \[allowed\] explicit-deny-write/);
        assert.ok(doctor.includes(`Target: ${target}`));
        assert.doesNotMatch(doctor, /init-failed/);
      });
    }
  });

  for (const removeOriginalRule of [false, true]) {
    test(`approving a filesystem prompt preserves policy edits (${removeOriginalRule ? "original deny already removed" : "original deny still present"})`, async () => {
      const dialog = deferred<void>();
      const decision = deferred<string | undefined>();
      const command = dinnerCommand;
      boundary.attempts(command, permissionAttempts(target));
      pi = await openSandbox(cwd, sandbox, failures, {
        ui: {
          select: async () => {
            dialog.resolve();
            return decision.promise;
          },
        },
      });
      // The tool is already stopped at a permission dialog; RPC/extension commands
      // can still edit the live session policy while a user considers the choice.
      const execution = pi.bash(command).then((result) => {
        assert.match(bashOutput(result, 1), /Command exited with code 1/);
      });
      try {
        await waitForStep(dialog.promise, execution);
        await pi.command("network deny add ink-thief.invalid");
        await pi.command('filesystem deny-write add "another secret.txt"');
        assert.deepEqual(SandboxManager.getConfig()?.network.deniedDomains, ["ink-thief.invalid"]);
        assert.deepEqual(SandboxManager.getConfig()?.filesystem.denyWrite, [
          target,
          "another secret.txt",
        ]);
        // The approval is for the original rule, not every rule now blocking this path.
        // A parent deny works on both supported platforms without relying on glob enforcement.
        await pi.command(`filesystem deny-write add ${JSON.stringify(cwd)}`);
        if (removeOriginalRule) {
          await pi.command(`filesystem deny-write remove ${JSON.stringify(target)}`);
        }
        const expectedPolicy = structuredClone(SandboxManager.getConfig());
        assert.ok(expectedPolicy);
        assert.deepEqual(expectedPolicy.filesystem.denyWrite, [
          ...(removeOriginalRule ? [] : [target]),
          "another secret.txt",
          cwd,
        ]);
        expectedPolicy.filesystem.denyWrite = ["another secret.txt", cwd];

        decision.resolve("Allow but adapt for side-effects");
        await execution;
        assert.deepEqual(
          SandboxManager.getConfig()?.network.deniedDomains,
          ["ink-thief.invalid"],
          "approving a filesystem exception must not revoke a newly added network deny",
        );
        assert.deepEqual(
          SandboxManager.getConfig(),
          expectedPolicy,
          "only the originally approved deny may be removed; retain the new broader deny",
        );
        assert.equal(await readFile(path.join(cwd, "effects.txt"), "utf8"), "fed the kraken\n");
        assert.equal(await readFile(target, "utf8"), "Eight pinches of paprika.\n");
        assert.equal(await readFile(configPath, "utf8"), configBytes);
        assert.equal(
          pi.permissionCount(),
          1,
          "parent approvals participate exactly once in the shared queue",
        );
        assert.deepEqual(
          JSON.parse(JSON.stringify(pi.handoff().config)),
          JSON.parse(
            JSON.stringify({
              ...expectedPolicy,
              enabled: true,
              mode: "interactive",
              filesystem: {
                ...expectedPolicy.filesystem,
                allowTempDirs: false,
                allowGitCommonDir: false,
              },
            }),
          ),
          "the JSON handoff carries live policy, not stale configuration files",
        );
      } finally {
        decision.resolve(undefined);
        await execution;
      }
    });
  }

  test("pending filesystem approval cannot revive a runtime blocked by missing prerequisites", async () => {
    const dialog = deferred<void>();
    const revoked = deferred<void>();
    const decision = deferred<string | undefined>();
    let dialogSignal: AbortSignal | undefined;
    boundary.attempts(dinnerCommand, permissionAttempts(target));
    pi = await openSandbox(cwd, sandbox, failures, {
      ui: {
        select: async (_title, _choices, options) => {
          dialogSignal = options?.signal;
          dialogSignal?.addEventListener("abort", () => revoked.resolve(), { once: true });
          dialog.resolve();
          // A stale frontend can still reply after the runtime revokes this dialog.
          return decision.promise;
        },
      },
    });
    const execution = pi.bash(dinnerCommand);
    const rejected = assert.rejects(execution, /Command aborted/);
    let disabling: Promise<string> | undefined;
    try {
      await waitForStep(dialog.promise, rejected);
      disabling = pi.command("disable");
      await waitForStep(
        revoked.promise,
        disabling.then(() => {}),
      );
      assert.equal(dialogSignal?.aborted, true);
      decision.resolve("Allow and retry now");
      await rejected;
      await disabling;
      boundary.dependencyErrors = ["fixture: no bubblewrap"];
      await pi.command("enable");
      assert.match(await pi.command("doctor"), /Runtime: blocked \(missing dependencies\)/);

      assert.equal(pi.status(), "");
      assert.match(await pi.command("doctor"), /Runtime: blocked \(missing dependencies\)/);
      await assert.rejects(pi.bash(dinnerCommand), /Sandbox dependencies are missing/);
      assert.match(pi.handoff().error ?? "", /Sandbox is not ready/);
      assert.equal(await readFile(path.join(cwd, "effects.txt"), "utf8"), "fed the kraken\n");
      assert.equal(await readFile(target, "utf8"), "Eight pinches of paprika.\n");
      assert.equal(await readFile(configPath, "utf8"), configBytes);
    } finally {
      decision.resolve(undefined);
      await Promise.allSettled([execution, disabling]);
    }
  });
});

/** Real Pi session/tool/command dispatch with dialog and footer adapters, not a CLI or terminal test. */
async function openSandbox(
  cwd: string,
  extension: ExtensionFactory,
  failures: unknown[],
  options: {
    flags?: Record<string, string | boolean>;
    ui?: Partial<ExtensionUIContext>;
    tools?: string[];
  } = {},
) {
  let permissionCount = 0;
  let handoff!: () => { config?: unknown; extension?: string; error?: string };
  const resources = await createPiResources(cwd, getAgentDir(), [
    extension,
    (pi) => {
      handoff = () => {
        const request = {};
        pi.events.emit("subagent:sandbox", request);
        return request;
      };
      pi.events.on("subagent:permission", (data) => {
        permissionCount++;
        const request = data as {
          run: (signal?: AbortSignal) => Promise<unknown>;
          signal?: AbortSignal;
          result?: Promise<unknown>;
        };
        request.result = Promise.resolve().then(() => request.run(request.signal));
      });
    },
  ]);
  resources.settingsManager.setProjectTrusted(false);
  const { session } = await createAgentSession({
    ...resources,
    model: fixtureModel,
    tools: options.tools ?? ["bash"],
  });
  const statuses = new Map<string, string>();
  const notifications: string[] = [];
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
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
    const theme = session.extensionRunner.getUIContext().theme;
    for (const [name, value] of Object.entries(options.flags ?? {}))
      session.extensionRunner.setFlagValue(name, value);
    await session.bindExtensions({
      mode: "tui",
      onError: (error) => failures.push(error),
      uiContext: uiBoundary(
        {
          theme,
          setStatus(key, text) {
            if (text === undefined) statuses.delete(key);
            else statuses.set(key, stripVTControlCharacters(text));
          },
          notify(message) {
            notifications.push(message);
          },
          ...options.ui,
        },
        failures,
      ),
    });
    return {
      session,
      handoff,
      permissionCount: () => permissionCount,
      status: () => [...statuses.values()].join("\n"),
      async command(args: string) {
        const before = notifications.length;
        await session.prompt(`/sandbox ${args}`);
        return notifications.slice(before).join("\n");
      },
      async bash(
        command: string,
        options: { requestUnsandboxed?: boolean; signal?: AbortSignal } = {},
      ) {
        const tool = session.agent.state.tools.find((tool) => tool.name === "bash");
        assert.ok(tool);
        return tool.execute(
          "fixture-bash",
          {
            command,
            timeout: 5,
            ...(options.requestUnsandboxed === undefined
              ? {}
              : { requestUnsandboxed: options.requestUnsandboxed }),
          },
          options.signal,
        );
      },
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

/** Assert native Bash's returned status without converting error results into rejections. */
function bashOutput(result: AgentToolResult<unknown>, exitCode = 0): string {
  assert.equal(result.isError ?? false, exitCode !== 0);
  const structured = result.structuredContent;
  assert.ok(structured && typeof structured === "object" && !Array.isArray(structured));
  assert.ok("exit_code" in structured);
  assert.equal(structured.exit_code, exitCode);
  return result.content
    .map((part) => {
      assert.equal(part.type, "text");
      return part.text;
    })
    .join("");
}

/** Await a permission-lifecycle signal or fail on premature completion, with a failure-only deadline.
 * Callers own resolving held selections and joining execution in their finally block. */
async function waitForStep(step: Promise<void>, execution: Promise<void>): Promise<void> {
  let deadline: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      step,
      execution.then(() => assert.fail("operation settled before the expected permission step")),
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(new Error("Permission step did not settle")), 10_000);
      }),
    ]);
  } finally {
    clearTimeout(deadline);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type Attempt = { script: string; violation?: string };

/** Script only OS setup/wrapping/violation input. SRT policy storage and annotation, Tau orchestration,
 * Pi tools, Git discovery, and bash processes stay real. This does NOT prove OS confinement. */
function sandboxBoundary(cwd: string, failures: unknown[]) {
  const scripts = new Set<string>();
  const attempts = new Map<string, Attempt[]>();
  const violations = new Map<string, string>();
  const closeListeners = new Map<string, () => void>();
  let askNetwork: SandboxAskCallback | undefined;
  const state: { dependencyErrors: string[]; initializationError?: Error } = {
    dependencyErrors: [],
  };
  const reject = (...args: unknown[]): never => {
    const error = new Error(`Unexpected external work: ${JSON.stringify(args)}`);
    failures.push(error);
    throw error;
  };
  mock.method(globalThis, "fetch", reject);
  mock.method(SandboxManager, "checkDependencies", () => ({
    warnings: [],
    errors: state.dependencyErrors,
  }));
  mock.method(
    SandboxManager,
    "initialize",
    async (...[config, ask]: Parameters<typeof SandboxManager.initialize>) => {
      if (state.initializationError) throw state.initializationError;
      askNetwork = ask;
      SandboxManager.updateConfig(config);
    },
  );
  mock.method(
    SandboxManager,
    "wrapWithSandbox",
    async (
      ...[command, _shell, _config, _signal, attribution]: Parameters<
        typeof SandboxManager.wrapWithSandbox
      >
    ) => {
      const attempt = attempts.get(command)?.shift();
      if (!attempt || !attribution?.commandId) return reject("unplanned sandbox command", command);
      if (attempt.violation) violations.set(attribution.commandId, attempt.violation);
      return attempt.script;
    },
  );
  // Deliver the OS log after the child closes, before SRT annotates its output.
  // Pre-seeding the store would interrupt bash before its first side effect on macOS.
  const annotate = SandboxManager.annotateStderrWithSandboxFailures;
  mock.method(
    SandboxManager,
    "annotateStderrWithSandboxFailures",
    (commandId: string, output: string) => {
      const line = violations.get(commandId);
      if (line)
        SandboxManager.getSandboxViolationStore().addViolation({
          line,
          encodedCommand: Buffer.from(commandId.slice(0, 100)).toString("base64"),
          timestamp: new Date(),
        });
      violations.delete(commandId);
      return annotate(commandId, output);
    },
  );
  const spawn = childProcess.spawn;
  mock.method(childProcess, "spawn", (...args: Parameters<typeof spawn>) => {
    if (
      path.basename(args[0]) !== "bash" ||
      args[2]?.cwd !== cwd ||
      args[1]?.length !== 2 ||
      args[1][0] !== "-c" ||
      !scripts.has(args[1][1])
    )
      return reject(...args);
    const child = spawn(...args);
    const onClose = closeListeners.get(args[1][1]);
    if (onClose) child.once("close", onClose);
    return child;
  });
  const spawnSync = childProcess.spawnSync;
  mock.method(childProcess, "spawnSync", (...args: Parameters<typeof spawnSync>) => {
    if (
      args[0] !== "git" ||
      args[2]?.cwd !== cwd ||
      JSON.stringify(args[1]) !==
        JSON.stringify(["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"])
    )
      return reject(...args);
    return spawnSync(...args);
  });
  for (const method of ["exec", "execSync", "execFile", "execFileSync", "fork"] as const)
    mock.method(childProcess, method, reject);
  syncBuiltinESMExports();
  return Object.assign(state, {
    askNetwork(params: Parameters<SandboxAskCallback>[0]) {
      assert.ok(askNetwork, "the runtime must register its network permission callback");
      return askNetwork(params);
    },
    onCommandClose(script: string, listener: () => void) {
      closeListeners.set(script, listener);
    },
    allowLocal(script: string) {
      scripts.add(script);
    },
    attempts(command: string, replies: Attempt[]) {
      attempts.set(command, [...replies]);
      for (const { script } of replies) scripts.add(script);
    },
  });
}

/** A harmless partially completed write: the OS reports a deny after an earlier side effect.
 * Only an explicit retry reaches the successful second script; all writes stay inside the fixture. */
function permissionAttempts(target: string): Attempt[] {
  return [
    {
      script: "printf 'fed the kraken\\n' >> effects.txt; printf 'write refused\\n' >&2; exit 1",
      violation: `bash(42) deny(1) file-write-data ${target}`,
    },
    { script: dinnerCommand },
  ];
}
