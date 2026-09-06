import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createAgentSessionRuntime,
  initTheme,
  SessionManager,
  type CustomEntry,
  type ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import branchTerm from "../extensions/branch-term.js";
import { assistantMessage, createPiResources, fixtureModel, uiBoundary } from "./helpers/pi.js";

describe("branch-term", { concurrency: false }, () => {
  let directory: string | undefined;
  let history: SessionManager;
  let answer: string;
  let ui: Awaited<ReturnType<typeof openBranch>> | undefined;
  let external: ReturnType<typeof terminalBoundary>;
  let failures: unknown[];
  let previousEnvironment: Record<string, string | undefined>;

  beforeEach(async () => {
    failures = [];
    previousEnvironment = { TMUX: process.env.TMUX, PI_HYPERLINKS: process.env.PI_HYPERLINKS };
    process.env.TMUX = "tau-fixture-socket,1,0";
    process.env.PI_HYPERLINKS = "0"; // No capability probe against a user's tmux server.
    external = terminalBoundary(failures);
    directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "tau-branch-term-")));
    const cwd = path.join(directory, "captain's café $raft");
    await mkdir(cwd);
    history = SessionManager.create(cwd, path.join(directory, "session vault's $coins"));
    history.appendModelChange(fixtureModel.provider, fixtureModel.id);
    history.appendThinkingLevelChange("off");
    history.appendSessionInfo("Café continuity plan");
    history.appendCustomEntry("café-draft", {
      text: "  The octopus owns the night shift.\nNo submarine deployments. 🐙  ",
    });
    history.appendMessage({ role: "user", content: "Keep the café afloat.", timestamp: 0 });
    answer = history.appendMessage(assistantMessage("Keep the espresso machine above sea level."));
  });

  afterEach(async () => {
    try {
      await ui?.dispose();
      assert.deepEqual(failures, [], "unexpected work or extension errors must not be swallowed");
    } finally {
      ui = undefined;
      await external.dispose();
      mock.restoreAll();
      syncBuiltinESMExports();
      for (const [key, value] of Object.entries(previousEnvironment)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      if (directory) await rm(directory, { recursive: true, force: true });
      directory = undefined;
    }
  });

  test("opens only the selected history in a requested split, leaving the original session and other branches intact", async () => {
    history.appendLabelChange(answer, "dry-land checkpoint");
    history.appendMessage({ role: "user", content: "Try the submarine instead.", timestamp: 1 });
    const abandoned = history.appendMessage(assistantMessage("The croissants are now soggy."));
    ui = await openBranch(directory!, history, failures);
    await ui.session.navigateTree(answer, { summarize: false });
    ui.session.extensionRunner.setFlagValue("branch-tmux-layout", "split-down");
    const sourceFile = history.getSessionFile()!;
    const sourceId = history.getSessionId();
    const before = await readFile(sourceFile);
    const selected = structuredClone(history.getBranch());
    const context = structuredClone(history.buildSessionContext());

    await ui.prompt("/branch layout=SPLIT-RIGHT");

    assert.deepEqual(external.launches[0]?.slice(0, -1), [
      "split-window",
      "-h",
      "-c",
      history.getCwd(),
    ]);
    const fork = await reopenTmuxFork(external.launches, history.getCwd());
    assert.notEqual(fork.getSessionId(), sourceId);
    assert.equal(fork.getHeader()?.parentSession, sourceFile);
    assert.equal(fork.getCwd(), history.getCwd());
    assert.equal(fork.getSessionName(), "Café continuity plan");
    assert.equal(fork.getLabel(answer), "dry-land checkpoint");
    assert.deepEqual(
      fork.getEntries().filter((entry) => entry.type !== "label"),
      selected,
    );
    assert.deepEqual(fork.buildSessionContext(), context);
    assert.equal(
      fork.getEntry(abandoned),
      undefined,
      "unselected history must not leak into the fork",
    );
    assert.equal(ui.session.sessionId, sourceId, "/branch must not switch the running session");
    assert.equal(ui.session.sessionFile, sourceFile);
    assert.equal(history.getLeafId(), answer);
    assert.deepEqual(
      await readFile(sourceFile),
      before,
      "the entire source tree remains byte-identical",
    );
    assert.equal((await forkFiles(history)).length, 1);
    assert.deepEqual(external.clipboard, []);
    assert.match(ui.notifications.at(-1)?.message ?? "", /opened.*split.*right/i);
  });

  test("waits for the active reply and queued follow-up before handing off a complete persisted conversation", async () => {
    const first = heldReply("The life jackets are ready.");
    const second = heldReply("The espresso machine has its own lifeboat.");
    let requests = 0;
    ui = await openBranch(directory!, history, failures, (_model, _context, options) => {
      const reply = [first, second][requests++];
      assert.ok(reply, "branching must not generate another response");
      return reply.start(options?.signal);
    });
    const sourceId = ui.session.sessionId;
    const prompt = ui.prompt("Check the life jackets.");
    await ready(first.started);
    await ui.session.followUp("And the espresso machine?");
    const branch = ui.prompt("/branch");
    await ready(ui.queuedBranch);
    assert.deepEqual(
      external.launches,
      [],
      "no terminal launch while the first reply is incomplete",
    );
    assert.deepEqual(await forkFiles(history), []);

    first.finish();
    await ready(second.started);
    assert.equal(ui.session.isIdle, false);
    assert.deepEqual(
      external.launches,
      [],
      "an agent_end is not enough while follow-up work remains",
    );
    assert.deepEqual(await forkFiles(history), []);
    second.finish();
    await Promise.all([prompt, branch]);
    await ui.session.waitForIdle();

    const fork = await reopenTmuxFork(external.launches, history.getCwd());
    assert.equal(requests, 2);
    assert.equal(ui.session.pendingMessageCount, 0);
    assert.equal(ui.session.sessionId, sourceId);
    assert.deepEqual(
      fork.getEntries(),
      history.getEntries(),
      "the fork includes both completed replies",
    );
    assert.deepEqual(
      fork
        .buildSessionContext()
        .messages.slice(-4)
        .map((message) => {
          assert.ok(message.role === "user" || message.role === "assistant");
          return { role: message.role, content: message.content };
        }),
      [
        { role: "user", content: [{ type: "text", text: "Check the life jackets." }] },
        { role: "assistant", content: [{ type: "text", text: "The life jackets are ready." }] },
        { role: "user", content: [{ type: "text", text: "And the espresso machine?" }] },
        {
          role: "assistant",
          content: [{ type: "text", text: "The espresso machine has its own lifeboat." }],
        },
      ],
    );
    assert.deepEqual(
      SessionManager.open(history.getSessionFile()!).getEntries(),
      history.getEntries(),
    );
  });

  test("keeps a durable, copyable recovery command after tmux fails, including sessions in a custom vault", async () => {
    external.exitCode = 1;
    ui = await openBranch(directory!, history, failures);
    const sourceFile = history.getSessionFile()!;
    const before = await readFile(sourceFile);
    const context = structuredClone(history.buildSessionContext());
    const originalEntries = structuredClone(history.getEntries());

    await ui.prompt("/branch");

    const fork = await reopenTmuxFork(external.launches, history.getCwd());
    assert.deepEqual(fork.getEntries(), originalEntries);
    assert.equal(ui.session.sessionFile, sourceFile);
    assert.deepEqual((await readFile(sourceFile)).subarray(0, before.length), before);
    assert.deepEqual(
      history.buildSessionContext(),
      context,
      "resume instructions are not model input",
    );
    assert.deepEqual(ui.session.messages, context.messages);
    assert.equal(ui.session.pendingMessageCount, 0);
    assert.equal(ui.notifications.at(-1)?.type, "warning");
    assert.match(ui.notifications.at(-1)?.message ?? "", /tmux.*fixture socket unavailable/i);
    const entry = recoveryEntry(SessionManager.open(sourceFile));
    assert.deepEqual(external.clipboard, [Buffer.from(entry.data!.command)]);
    assert.equal(entry.data!.copiedToClipboard, true);
    assert.ok(
      ui.render(entry).includes(entry.data!.command),
      "the displayed command preserves shell bytes",
    );
    assert.match(ui.render(entry), /separate terminal|tmux pane/i);
    assert.match(ui.render(entry), /copied to clipboard/i);

    await ui.session.reload();
    const recovered = recoveryEntry(SessionManager.open(sourceFile));
    assert.deepEqual(recovered, entry);
    assert.ok(ui.render(recovered).includes(entry.data!.command), "the entry renders after reload");
    assert.deepEqual(history.buildSessionContext(), context);

    const invocation = interpretCommand(recovered.data!.command, directory!);
    assert.equal(invocation.cwd, history.getCwd(), "shell quoting preserves the owning cwd");
    assert.deepEqual(
      invocation.args,
      ["--session", fork.getSessionFile()],
      "a custom-vault fork needs its file path; a bare UUID is not discoverable in default session storage",
    );
  });
});

/** Bind /branch to real Pi dispatch, queues, session replacement and persistence, with scripted generation and UI output. */
async function openBranch(
  directory: string,
  history: SessionManager,
  failures: unknown[],
  generate?: NonNullable<ProviderConfig["streamSimple"]>,
) {
  const runtime = await createAgentSessionRuntime(
    async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
      const resources = await createPiResources(cwd, agentDir, [
        branchTerm,
        (pi) =>
          pi.registerProvider(fixtureModel.provider, {
            api: fixtureModel.api,
            baseUrl: fixtureModel.baseUrl,
            apiKey: "fixture-only",
            models: [fixtureModel],
            streamSimple: (...args) => {
              try {
                assert.ok(generate, "Unexpected model request in branch workflow");
                return generate(...args);
              } catch (error) {
                failures.push(error);
                throw error;
              }
            },
          }),
      ]);
      return {
        ...(await createAgentSession({
          ...resources,
          sessionManager,
          sessionStartEvent,
          model: fixtureModel,
          tools: [],
        })),
        services: { ...resources, diagnostics: [] },
        diagnostics: [],
      };
    },
    { cwd: history.getCwd(), agentDir: path.join(directory, "agent"), sessionManager: history },
  );
  const pending: Promise<void>[] = [];
  const notifications: { message: string; type: string | undefined }[] = [];
  let queued!: () => void;
  const queuedBranch = new Promise<void>((resolve) => {
    queued = resolve;
  });
  const dispose = async () => {
    try {
      runtime.session.clearQueue();
      await runtime.session.abort();
      await Promise.all(pending);
      await runtime.services.settingsManager.flush();
    } finally {
      await runtime.dispose();
    }
  };
  try {
    initTheme("dark", false);
    const bind = async () => {
      const session = runtime.session;
      await session.bindExtensions({
        mode: "tui",
        uiContext: uiBoundary(
          {
            theme: session.extensionRunner.getUIContext().theme,
            notify(message, type) {
              notifications.push({ message, type });
              if (/queued.*\/branch/i.test(message)) queued();
            },
          },
          failures,
        ),
        commandContextActions: {
          waitForIdle: () => session.waitForIdle(),
          newSession: (options) => runtime.newSession(options),
          fork: (id, options) => runtime.fork(id, options),
          switchSession: (file, options) => runtime.switchSession(file, options),
          navigateTree: (id, options) => session.navigateTree(id, options),
          reload: () => session.reload(),
        },
        onError: (error) => failures.push(error),
      });
    };
    runtime.setRebindSession(bind);
    await bind();
    return {
      get session() {
        return runtime.session;
      },
      notifications,
      queuedBranch,
      prompt(text: string) {
        const work = runtime.session.prompt(text, { source: "interactive" });
        pending.push(work);
        return work;
      },
      render(entry: CustomEntry) {
        const runner = runtime.session.extensionRunner;
        const renderer = runner.getEntryRenderer(entry.customType);
        assert.ok(renderer);
        const component = renderer(entry, { expanded: false }, runner.getUIContext().theme);
        assert.ok(component, "persisted recovery instructions have a visible renderer");
        return component.render(1200).map(stripVTControlCharacters).join("\n");
      },
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

const spawn = childProcess.spawn;
const spawnSync = childProcess.spawnSync;

/** Replace unsafe tmux/clipboard programs with short-lived Node children, retaining Pi's real exec/error handling. */
function terminalBoundary(failures: unknown[]) {
  const launches: string[][] = [];
  const clipboard: Buffer[] = [];
  const children = new Map<ReturnType<typeof spawn>, Promise<void>>();
  const reject = () => {
    const error = new Error("Unexpected network request or subprocess in branch workflow");
    failures.push(error);
    throw error;
  };
  mock.method(globalThis, "fetch", reject);
  for (const method of ["exec", "execSync", "execFile", "execFileSync", "fork"] as const)
    mock.method(childProcess, method, reject);
  const boundary = {
    launches,
    clipboard,
    exitCode: 0,
    async dispose() {
      for (const child of children.keys()) child.kill("SIGKILL");
      await Promise.all(children.values());
    },
  };
  mock.method(childProcess, "spawn", (...args: Parameters<typeof spawn>) => {
    if (args[0] !== "tmux" || !Array.isArray(args[1])) return reject();
    launches.push([...args[1]]);
    const child = spawn(
      process.execPath,
      [
        "-e",
        `
      if (${boundary.exitCode}) process.stderr.write("Fixture socket unavailable");
      process.exitCode = ${boundary.exitCode};
    `,
      ],
      args[2],
    );
    children.set(
      child,
      new Promise<void>((resolve) => {
        child.once("error", (error) => failures.push(error));
        child.once("close", () => {
          children.delete(child);
          resolve();
        });
      }),
    );
    return child;
  });
  mock.method(childProcess, "spawnSync", (...args: Parameters<typeof spawnSync>) => {
    const allowed = process.platform === "darwin" ? ["pbcopy"] : ["wl-copy", "xclip", "xsel"];
    if (!allowed.includes(args[0]) || typeof args[2]?.input !== "string") return reject();
    clipboard.push(Buffer.from(args[2].input));
    return spawnSync(process.execPath, ["-e", "process.stdin.resume()"], args[2]);
  });
  syncBuiltinESMExports();
  return boundary;
}

/** Parse actual shell words with Bash, replacing only `pi` with a builtin argument recorder; no external PATH. */
function interpretCommand(command: string, cwd: string) {
  const result = spawnSync(
    "/bin/bash",
    [
      "--noprofile",
      "--norc",
      "-c",
      `
    pi() { printf '%s\\0' "$PWD" "$@"; }
    ${command}
  `,
    ],
    { cwd, env: { HOME: process.env.HOME, PATH: "" }, encoding: "utf8", timeout: 5000 },
  );
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const words = result.stdout.split("\0");
  assert.equal(words.pop(), "", "the invocation is NUL-delimited, including its final argument");
  return { cwd: words[0], args: words.slice(1) };
}

/** Reopen the advertised destination, checking existence first because SessionManager.open accepts missing paths. */
async function reopenTmuxFork(launches: string[][], cwd: string) {
  assert.equal(launches.length, 1, "exactly one destination receives the fork");
  const invocation = interpretCommand(launches[0].at(-1)!, cwd);
  assert.equal(invocation.cwd, cwd);
  assert.equal(invocation.args.length, 2);
  assert.equal(invocation.args[0], "--session");
  const file = invocation.args[1];
  assert.ok(path.isAbsolute(file), "tmux receives an unambiguous session path");
  await assert.doesNotReject(
    () => access(file),
    "the advertised fork must exist before another terminal tries to resume it",
  );
  return SessionManager.open(file);
}

async function forkFiles(history: SessionManager) {
  return (await readdir(history.getSessionDir())).filter(
    (name) => name.endsWith(".jsonl") && name !== path.basename(history.getSessionFile()!),
  );
}

function recoveryEntry(history: SessionManager) {
  const entries = history
    .getEntries()
    .filter((entry) => entry.type === "custom" && entry.customType === "branch-term-message");
  assert.equal(entries.length, 1, "one durable instruction, not a model message or duplicate");
  const entry = entries[0] as CustomEntry<{
    intro: string;
    command: string;
    copiedToClipboard: boolean;
  }>;
  assert.equal(typeof entry.data?.command, "string");
  return entry;
}

/** Bound readiness waits so failure cleanup can abort and join an unfinished agent run. */
async function ready(promise: Promise<void>) {
  let deadline: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(
          () => reject(new Error("Branch workflow did not reach readiness")),
          10_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(deadline);
  }
}

/** Hold a real provider stream open until released or aborted, so queue assertions synchronize on request readiness. */
function heldReply(text: string) {
  let ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const stream = createAssistantMessageEventStream();
  let finish: (() => void) | undefined;
  return {
    started,
    start(signal?: AbortSignal) {
      const abort = () => {
        const error = { ...assistantMessage(""), stopReason: "aborted" as const };
        stream.push({ type: "error", reason: "aborted", error });
        stream.end();
        signal?.removeEventListener("abort", abort);
      };
      finish = () => {
        signal?.removeEventListener("abort", abort);
        stream.push({ type: "done", reason: "stop", message: assistantMessage(text) });
        stream.end();
      };
      stream.push({ type: "start", partial: { ...assistantMessage(""), stopReason: "pending" } });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      ready();
      return stream;
    },
    finish() {
      assert.ok(finish);
      finish();
    },
  };
}
