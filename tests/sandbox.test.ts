import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, mock, test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import {
  createAgentSession,
  getAgentDir,
  initTheme,
  type ExtensionFactory,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { createPiResources, fixtureModel, isolatePiHome, uiBoundary } from "./helpers/pi.js";

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
    let runtime: ReturnType<typeof createRuntime>;
    const resources = await createPiResources(cwd, getAgentDir(), [
      (api) => {
        runtime = createRuntime(api);
        api.on("session_start", (_event, ctx) => runtime.captureContext(ctx));
      },
    ]);
    const { session } = await createAgentSession({
      ...resources,
      model: { ...fixtureModel, reasoning: true },
    });
    try {
      await session.bindExtensions({ mode: "print" });
      const captured = runtime!.context!;
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
        assert.equal(await pi.bash(probe), "kraken ready\n");
        assert.equal(
          await readFile(path.join(cwd, "probe.txt"), "utf8"),
          `${pi.session.sessionId}\n`,
        );

        await pi.command("disable");
        assert.equal(pi.status(), "");
        assert.deepEqual(pi.handoff().config, { enabled: false });
        assert.equal(
          await pi.bash(probe),
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

        const outcome = await pi.bash(command).then(
          (text) => ({ text, failed: false }),
          (error: Error) => ({ text: error.message, failed: true }),
        );
        assert.equal(
          outcome.failed,
          !retry,
          "only a successful rerun can turn the tool into a success",
        );
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
          outcome.text,
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

        await assert.rejects(pi.bash(dinnerCommand), (error: Error) => {
          assert.match(error.message, /Command exited with code 73/);
          assert.ok(error.message.includes(errorLine));
          if (initializationFailure) assert.match(error.message, /\[sandbox\].*initializ/i);
          else assert.doesNotMatch(error.message, /\[sandbox\].*initializ/i);
          assert.doesNotMatch(
            error.message,
            /Sandbox blocked filesystem|temporarily allow for this session|already been granted/i,
          );
          return true;
        });
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

        await assert.rejects(pi.bash(dinnerCommand), /Command exited with code 73/);
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
      const execution = pi.bash(command).then(
        () => assert.fail("allow-adapt must retain the failed attempt"),
        (error: Error) => assert.match(error.message, /Command exited with code 1/),
      );
      try {
        await waitForDialog(dialog.promise, execution);
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
    const decision = deferred<string | undefined>();
    boundary.attempts(dinnerCommand, permissionAttempts(target));
    pi = await openSandbox(cwd, sandbox, failures, {
      ui: {
        select: async () => {
          dialog.resolve();
          return decision.promise;
        },
      },
    });
    const execution = pi.bash(dinnerCommand).then(
      () => assert.fail("approval cannot retry after sandbox initialization fails"),
      (error: Error) => assert.match(error.message, /Command exited with code 1/),
    );
    try {
      await waitForDialog(dialog.promise, execution);
      await pi.command("disable");
      boundary.dependencyErrors = ["fixture: no bubblewrap"];
      await pi.command("enable");
      assert.match(await pi.command("doctor"), /Runtime: blocked \(missing dependencies\)/);

      decision.resolve("Allow and retry now");
      await execution;
      assert.equal(pi.status(), "");
      assert.match(await pi.command("doctor"), /Runtime: blocked \(missing dependencies\)/);
      await assert.rejects(pi.bash(dinnerCommand), /Sandbox dependencies are missing/);
      assert.match(pi.handoff().error ?? "", /Sandbox is not ready/);
      assert.equal(await readFile(path.join(cwd, "effects.txt"), "utf8"), "fed the kraken\n");
      assert.equal(await readFile(target, "utf8"), "Eight pinches of paprika.\n");
      assert.equal(await readFile(configPath, "utf8"), configBytes);
    } finally {
      decision.resolve(undefined);
      await execution;
    }
  });
});

/** Real Pi session/tool/command dispatch with dialog and footer adapters, not a CLI or terminal test. */
async function openSandbox(
  cwd: string,
  extension: ExtensionFactory,
  failures: unknown[],
  options: { flags?: Record<string, string | boolean>; ui?: Partial<ExtensionUIContext> } = {},
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
    tools: ["bash"],
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
      async bash(command: string) {
        const tool = session.agent.state.tools.find((tool) => tool.name === "bash");
        assert.ok(tool);
        const result = await tool.execute("fixture-bash", { command, timeout: 5 });
        return result.content
          .map((part) => {
            assert.equal(part.type, "text");
            return part.text;
          })
          .join("");
      },
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

/** Await dialog readiness or an early tool completion, with a failure-only deadline.
 * Callers own resolving the held selection and joining execution in their finally block. */
async function waitForDialog(dialog: Promise<void>, execution: Promise<void>): Promise<void> {
  let deadline: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      dialog,
      execution.then(() => assert.fail("the denied command must reach a permission dialog")),
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(new Error("Permission dialog did not open")), 10_000);
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
    async (...[config]: Parameters<typeof SandboxManager.initialize>) => {
      if (state.initializationError) throw state.initializationError;
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
    return spawn(...args);
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
