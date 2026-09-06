import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
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
  parseArgs,
  SessionManager,
  type CustomEntry,
  type ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import branchTerm from "../extensions/branch-term.js";
import { assistantMessage, createPiResources, fixtureModel, uiBoundary } from "./helpers/pi.js";

describe("branch-term", { concurrency: false }, () => {
  let directory: string | undefined;
  let history: SessionManager;
  let checkpoint: string;
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
    const cwd = path.join(
      directory,
      "captain's café $raft $(printf hijacked > injected) {session}",
    );
    await mkdir(cwd);
    history = SessionManager.create(cwd, path.join(directory, "session vault's $coins"));
    history.appendModelChange(fixtureModel.provider, fixtureModel.id);
    history.appendThinkingLevelChange("off");
    history.appendSessionInfo("Café continuity plan");
    checkpoint = history.appendCustomEntry("café-draft", {
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

  for (const layout of ["split-down", "constructor"]) {
    test(`honors or rejects the configured tmux layout ${layout} without a command override`, async () => {
      ui = await openBranch(directory!, history, failures);
      const parsed = parseArgs(["--branch-tmux-layout", layout]);
      assert.deepEqual(parsed.diagnostics, []);
      for (const [name, value] of parsed.unknownFlags)
        ui.session.extensionRunner.setFlagValue(name, value);
      const before = await readFile(history.getSessionFile()!);

      await ui.prompt("/branch");

      const fork = await reopenTmuxFork(external.launches, history.getCwd());
      assert.deepEqual(fork.getEntries(), history.getEntries());
      assert.deepEqual(await readFile(history.getSessionFile()!), before);
      assert.deepEqual(
        external.launches[0].slice(0, -1),
        layout === "split-down"
          ? ["split-window", "-v", "-c", history.getCwd()]
          : ["new-window", "-c", history.getCwd(), "-n", "branch"],
        "the flag controls the destination; invalid values fall back to a window",
      );
      assert.equal(
        ui.notifications.some((notice) => notice.type === "warning"),
        layout === "constructor",
      );
    });
  }

  describe("custom terminal handoff", () => {
    for (const placeholder of ["{session}", "{command}", "appended session"] as const) {
      test(`preserves shell-sensitive paths using ${placeholder} without launching tmux`, async () => {
        ui = await openBranch(directory!, history, failures);
        const before = await readFile(history.getSessionFile()!);
        const argumentsTemplate =
          placeholder === "appended session" ? "{cwd}" : `{cwd} ${placeholder}`;
        ui.session.extensionRunner.setFlagValue("branch-term", terminalCommand(argumentsTemplate));

        await ui.prompt("/branch");

        assert.equal(
          external.terminals.length,
          1,
          "the configured terminal takes precedence over tmux",
        );
        assert.deepEqual(external.launches, []);
        const terminal = external.terminals[0];
        const request = await ready(terminal.request);
        assert.equal(request.cwd, history.getCwd());
        assert.equal(request.args[0], history.getCwd());
        assert.equal(request.args.length, 2);
        let file = request.args[1];
        if (placeholder === "{command}") {
          const invocation = interpretCommand(file, history.getCwd());
          assert.equal(invocation.cwd, history.getCwd());
          assert.equal(invocation.args[0], "--session");
          assert.equal(invocation.args.length, 2);
          file = invocation.args[1];
        }
        await access(file);
        const fork = SessionManager.open(file);
        assert.deepEqual(fork.getEntries(), history.getEntries());
        assert.equal(fork.getHeader()?.parentSession, history.getSessionFile());
        await assert.rejects(access(path.join(history.getCwd(), "injected")), { code: "ENOENT" });

        terminal.child.send(0);
        await ready(terminal.done);
        assert.deepEqual(await readFile(history.getSessionFile()!), before);
        assert.deepEqual(external.clipboard, []);
        assert.ok(!ui.notifications.some((notice) => notice.type === "error"));
      });
    }

    for (const failure of ["spawn error", "nonzero exit"] as const) {
      test(`offers one usable recovery command after a launcher ${failure}`, async () => {
        ui = await openBranch(directory!, history, failures);
        ui.session.extensionRunner.setFlagValue("branch-term", terminalCommand("{session}"));
        if (failure === "spawn error") external.shell = path.join(directory!, "missing-bash");
        const context = structuredClone(history.buildSessionContext());

        await ui.prompt("/branch");

        assert.equal(external.terminals.length, 1);
        const terminal = external.terminals[0];
        if (failure === "spawn error") {
          await assert.rejects(terminal.request, { code: "ENOENT" });
        } else {
          await ready(terminal.request);
          terminal.child.send(7);
        }
        await ready(terminal.done);
        assert.equal(ui.notifications.filter((notice) => notice.type === "error").length, 1);
        const entry = recoveryEntry(SessionManager.open(history.getSessionFile()!));
        const invocation = interpretCommand(entry.data!.command, directory!);
        assert.equal(invocation.cwd, history.getCwd());
        assert.equal(invocation.args[0], "--session");
        assert.equal(invocation.args.length, 2);
        await access(invocation.args[1]);
        assert.equal(
          SessionManager.open(invocation.args[1]).getHeader()?.parentSession,
          history.getSessionFile(),
        );
        assert.deepEqual(history.buildSessionContext(), context);
        assert.deepEqual(external.clipboard, [Buffer.from(entry.data!.command)]);
        assert.equal((await forkFiles(history)).length, 1, "recovery uses the existing fork");
      });
    }

    test("keeps recovery usable if its session entry cannot be written", async () => {
      const diagnostics: string[] = [];
      mock.method(console, "error", (...parts: unknown[]) =>
        diagnostics.push(parts.map(String).join(" ")),
      );
      ui = await openBranch(directory!, history, failures);
      ui.session.extensionRunner.setFlagValue("branch-term", terminalCommand("{session}"));
      await ui.prompt("/branch");
      assert.equal(external.terminals.length, 1);
      const terminal = external.terminals[0];
      const request = await ready(terminal.request);
      const file = history.getSessionFile()!;
      const before = await readFile(file);
      const backup = file + ".backup";
      await rename(file, backup);
      await mkdir(file); // A directory cannot receive an appended session entry, even when tests run as root.

      terminal.child.send(7);
      await ready(terminal.done);

      const command = diagnostics
        .join("\n")
        .split("\n")
        .find((line) => line.startsWith("cd "));
      assert.ok(command, "failed persistence must not discard the manual recovery command");
      assert.deepEqual(interpretCommand(command, directory!).args, ["--session", request.args[0]]);
      assert.deepEqual(await readFile(backup), before);
    });

    for (const lifecycle of ["reload", "shutdown"] as const) {
      test(`${lifecycle} releases failure observers without closing the user's terminal`, async () => {
        const diagnostics: string[] = [];
        for (const method of ["log", "error"] as const) {
          mock.method(console, method, (...parts: unknown[]) =>
            diagnostics.push(parts.map(String).join(" ")),
          );
        }
        ui = await openBranch(directory!, history, failures);
        ui.session.extensionRunner.setFlagValue("branch-term", terminalCommand("{session}"));
        const sourceFile = history.getSessionFile()!;
        await ui.prompt("/branch");
        assert.equal(external.terminals.length, 1);
        const terminal = external.terminals[0];
        await ready(terminal.request);

        if (lifecycle === "reload") await ui.session.reload();
        else await ui.dispose();

        const pong = launcherMessage(terminal.child, terminal.done);
        terminal.child.send("ping");
        const reply = await ready(pong);
        assert.equal(reply, "pong", "the launched terminal remains independently alive");
        const before = await readFile(sourceFile);
        const notices = [...ui.notifications];
        const output = [...diagnostics];
        terminal.child.send(7);
        await ready(terminal.done);
        assert.deepEqual(
          await readFile(sourceFile),
          before,
          "late failure does not append to a replaced session",
        );
        assert.deepEqual(ui.notifications, notices);
        assert.deepEqual(
          diagnostics,
          output,
          "late failures must not leak through console fallback either",
        );
        assert.deepEqual(external.clipboard, []);
      });
    }
  });

  for (const selection of ["pre-assistant checkpoint", "empty conversation"] as const) {
    test(`persists a selected ${selection} before advertising the fork`, async () => {
      ui = await openBranch(directory!, history, failures);
      if (selection === "pre-assistant checkpoint") {
        await ui.session.navigateTree(checkpoint, { summarize: false });
      } else {
        history.resetLeaf();
        ui.session.agent.state.messages = history.buildSessionContext().messages;
      }
      const selected = structuredClone(history.getBranch());
      const leaf = history.getLeafId();
      const before = await readFile(history.getSessionFile()!);
      assert.ok(selected.every((entry) => entry.type !== "message"));
      if (selection === "empty conversation") assert.deepEqual(selected, []);

      await ui.prompt("/branch");

      assert.equal(history.getLeafId(), leaf);
      assert.deepEqual(await readFile(history.getSessionFile()!), before);
      const fork = await reopenTmuxFork(external.launches, history.getCwd());
      assert.deepEqual(
        fork.getEntries(),
        selected,
        "selected state must survive without an assistant reply",
      );
      assert.equal(fork.getHeader()?.parentSession, history.getSessionFile());
      assert.deepEqual(fork.buildSessionContext(), history.buildSessionContext());
    });
  }
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
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
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

type TerminalRequest = { cwd: string; args: string[] };

/** Replace terminal/clipboard programs with controlled Node children; custom launchers still run through real Bash. */
function terminalBoundary(failures: unknown[]) {
  const launches: string[][] = [];
  const terminals: {
    child: ReturnType<typeof spawn>;
    request: Promise<TerminalRequest>;
    done: Promise<void>;
  }[] = [];
  const clipboard: Buffer[] = [];
  const children = new Map<ReturnType<typeof spawn>, { done: Promise<void>; detached: boolean }>();
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
    terminals,
    clipboard,
    shell: "/bin/bash",
    exitCode: 0,
    async dispose() {
      for (const [child, { detached }] of children) {
        if (detached && child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
            continue;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          }
        }
        child.kill("SIGKILL");
      }
      await Promise.all([...children.values()].map(({ done }) => done));
    },
  };
  mock.method(childProcess, "spawn", (...args: Parameters<typeof spawn>) => {
    if (!Array.isArray(args[1])) return reject();
    if (args[0] === "bash") {
      const child = spawn(boundary.shell, args[1], {
        ...args[2],
        env: { ...process.env, ...args[2]?.env, PATH: "", BASH_ENV: "" },
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      const done = track(child, args[2]?.detached ?? false);
      const request = launcherMessage(child, done).then((message) => {
        assert.ok(
          message &&
            typeof message === "object" &&
            "cwd" in message &&
            typeof message.cwd === "string" &&
            "args" in message &&
            Array.isArray(message.args) &&
            message.args.every((arg: unknown) => typeof arg === "string"),
        );
        return { cwd: message.cwd, args: message.args as string[] };
      });
      terminals.push({ child, request, done });
      return child;
    }
    if (args[0] !== "tmux") return reject();
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
    child.once("error", (error) => failures.push(error));
    track(child);
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

  function track(child: ReturnType<typeof spawn>, detached = false) {
    const done = new Promise<void>((resolve) =>
      child.once("close", () => {
        children.delete(child);
        resolve();
      }),
    );
    children.set(child, { done, detached });
    return done;
  }
}

/** Read one fixture IPC message or fail when its launcher closes; always release the event listeners. */
async function launcherMessage(
  child: ReturnType<typeof spawn>,
  done: Promise<void>,
): Promise<unknown> {
  const controller = new AbortController();
  try {
    const [message] = await Promise.race([
      once(child, "message", { signal: controller.signal }),
      done.then(() => {
        throw new Error("Launcher closed before sending its message");
      }),
    ]);
    return message;
  } finally {
    controller.abort();
  }
}

/** Record the real launch arguments over fixture-only IPC, then wait for an explicit exit request. */
function terminalCommand(placeholders: string) {
  const script = `
    process.send({ cwd: process.cwd(), args: process.argv.slice(1) });
    process.on("message", message => {
      if (message === "ping") process.send("pong");
      else process.exit(message);
    });
  `;
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  return `${quote(process.execPath)} -e ${quote(script)} -- ${placeholders}`;
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

/** Bound observable readiness waits so teardown can cancel and join unfinished fixture work. */
async function ready<T>(promise: Promise<T>): Promise<T> {
  let deadline: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
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
