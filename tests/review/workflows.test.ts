import assert from "node:assert/strict";
import childProcess, { type ChildProcess, type SpawnOptions } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { type AssistantMessage, type Context, type ImageContent } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  getPackageDir,
  initTheme,
  SessionManager,
  type ExtensionUIContext,
  type TerminalInputHandler,
} from "@earendil-works/pi-coding-agent";
import review from "../../extensions/review/index.js";
import type { FocusFinding, ReviewMessageDetails } from "../../extensions/review/schema.js";
import { assistantMessage, createPiResources, uiBoundary } from "../helpers/pi.js";
import { providerPath, reviewModel, scriptedProvider, type Generation } from "./provider.js";

const spawn = childProcess.spawn;
const execFileSync = childProcess.execFileSync;
const finding: FocusFinding = {
  priority: "P1",
  location: "café.ts:1",
  finding: "The octopus accepts expired tickets | after midnight.\nGuests enter for free.",
  suggestion: "Reject expired tickets before opening the gate.",
};

describe("review", { concurrency: false }, () => {
  let directory: string;
  let cwd: string;
  let app: Awaited<ReturnType<typeof openReview>> | undefined;
  let failures: unknown[];
  let children: { process: ChildProcess; closed: Promise<unknown> }[];
  let generations: ChildGeneration[];
  let respond: (request: ChildGeneration) => AssistantMessage | Promise<AssistantMessage>;
  let responderWork: Promise<void>[];

  beforeEach(async () => {
    failures = [];
    children = [];
    generations = [];
    responderWork = [];
    directory = await mkdtemp(path.join(os.tmpdir(), "tau-review-workflows-"));
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
    const manifest = JSON.parse(await readFile(path.join(getPackageDir(), "package.json"), "utf8"));
    assert.equal(manifest.version, "0.85.1");
    const cli = path.join(getPackageDir(), manifest.bin.pi);
    // Resolve `pi` to the pinned executable and add only an offline generation provider.
    // Git and the child's JSON protocol, native tools and durable sessions remain real.
    mock.method(childProcess, "spawn", (command: string, args: string[], options: SpawnOptions) => {
      assert.equal(options.cwd, cwd, "repository work belongs to the owning session cwd");
      if (
        command === "git" &&
        [
          "rev-parse",
          "branch",
          "diff",
          "ls-files",
          "hash-object",
          "status",
          "symbolic-ref",
          "merge-base",
        ].includes(args[0])
      ) {
        return spawn(command, args, options);
      }
      if (command !== "pi") return reject(command);
      const proc = spawn(
        process.execPath,
        [
          cli,
          ...args.slice(0, -1),
          "--extension",
          providerPath,
          "--no-context-files",
          args.at(-1)!,
        ],
        {
          ...options,
          env: { ...options.env, PI_CODING_AGENT_DIR: path.join(directory, "child-agent") },
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        },
      );
      const closed = once(proc, "close");
      children.push({ process: proc, closed });
      proc.on("message", (message: Generation & { type: string; error?: string }) => {
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
      await rm(directory, { recursive: true, force: true });
    }
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
      if (args.includes("--no-tools"))
        return assistantMessage('{"groups":[{"ids":[1,2],"reason":"same expiry check"}]}');
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

    const report = app.report();
    assert.equal(report.details.scope.mode, "working-tree");
    assert.equal(report.details.staleness, undefined);
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
        (m) => m.role === "toolResult" && text(m).includes("acceptsExpired = true"),
      ),
      "retry retains the real read result",
    );
    for (const request of generations.filter((r) => !r.args.includes("--no-tools"))) {
      assert.ok(text(request.context.messages[0]).includes("Keep $& and 🐙 intact"));
      assert.ok(
        text(request.context.messages[0]).includes(
          "Keep café tickets valid; preserve $& literally.",
        ),
      );
      assert.deepEqual(request.context.tools?.map((t) => t.name).sort(), [
        "bash",
        "find",
        "grep",
        "ls",
        "read",
        "submit_review",
      ]);
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
    const fixPrompt = text(app.mainRequests[0].context.messages.at(-1)!);
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
      let reviews = 0;
      respond = async () => {
        assert.ok(++reviews <= 2, "unexpected extra review");
        assert.equal(
          await readFile(path.join(cwd, file), "utf8"),
          `export const acceptsExpired = ${reviews === 1 ? "true" : "false"};\n`,
          "the follow-up reviewer sees the actual native edit",
        );
        return submit(reviews === 1 ? [{ ...finding, location: `${file}:1` }] : []);
      };
      app = await openReview(directory, cwd, failures, [
        toolCall("edit", {
          path: file,
          edits: [{ oldText: "acceptsExpired = true", newText: "acceptsExpired = false" }],
        }),
        assistantMessage("Expiry validation restored."),
      ]);
      await app.session.prompt(`/fix loop ${scope} focus=general`);
      await app.settle();

      assert.equal(app.mainRequests.length, 2, "one native edit and its concluding model turn");
      assert.equal(
        reviews,
        expectedReviews,
        "only scope-relevant changes trigger follow-up review",
      );
      assert.equal(app.reports().length, expectedReviews);
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

  test("cancels the live review process, releases the run lock, and delivers queued text and image exactly once", async () => {
    await writeFile(path.join(cwd, "new-ticket.txt"), "Review me\n");
    const ready = deferred<ChildGeneration>();
    const release = deferred<AssistantMessage>();
    respond = (request) => {
      ready.resolve(request);
      return release.promise;
    };
    app = await openReview(directory, cwd, failures, [
      assistantMessage("Queued request received."),
    ]);
    try {
      const end = app.nextEnd();
      await app.session.prompt("/review uncommitted focus=general");
      const request = await deadline(ready.promise, "review provider readiness");
      const image: ImageContent = {
        type: "image",
        mimeType: "image/png",
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
      };
      await app.session.prompt("/review uncommitted focus=general");
      assert.equal(generations.length, 1, "the busy command must not start another reviewer");
      assert.equal(app.press("\x1b"), true);
      assert.equal((await end).outcome, "cancelled");
      await app.settle();
      assert.equal(
        request.process.signalCode,
        "SIGKILL",
        "cancellation owns the real child through exit",
      );
      assert.equal(
        app.reports().length,
        0,
        "cancelled findings are not reported as clean or failed review results",
      );
      assert.equal(app.mainRequests.length, 0, "cancellation must not trigger the main model");
      assert.equal(app.listeners.size, 0, "review shortcuts are removed after cancellation");

      respond = async () => {
        // Enter while the restarted reviewer is awaiting its model, not the main agent.
        await app!.session.prompt("Keep the café open 🐙", {
          source: "interactive",
          images: [image],
        });
        assert.equal(app!.mainRequests.length, 0, "input is held until review completion");
        return submit([]);
      };
      await app.run("/review uncommitted focus=general");
      assert.deepEqual(app.report().details.findings, []);
      assert.equal(generations.length, 2, "a cancelled run does not retain the lock");
      assert.equal(app.mainRequests.length, 1);
      assert.deepEqual(app.mainRequests[0].context.messages.at(-1)?.content, [
        { type: "text", text: "Keep the café open 🐙" },
        image,
      ]);
      assert.equal(app.session.pendingMessageCount, 0);
    } finally {
      release.resolve(assistantMessage("Cancelled fixture generation released."));
    }
  });
});

type ChildGeneration = Generation & { args: string[]; process: ChildProcess };

/** Adapt only terminal output/input; command dispatch, history, queues and edit tools are native Pi. */
async function openReview(
  directory: string,
  cwd: string,
  failures: unknown[],
  mainReplies: AssistantMessage[] = [],
) {
  const mainRequests: Generation[] = [];
  const notifications: { message: string; type?: string }[] = [];
  const listeners = new Set<TerminalInputHandler>();
  const ends: { outcome: string }[] = [];
  const endWaiters: ((event: { outcome: string }) => void)[] = [];
  let active = 0;
  let draft = "";
  const resources = await createPiResources(cwd, path.join(directory, "agent"), [
    review,
    scriptedProvider((request) => {
      mainRequests.push(request);
      const reply = mainReplies.shift();
      if (!reply) {
        const error = new Error("Unexpected main-session model request");
        failures.push(error);
        throw error;
      }
      return reply;
    }),
    (pi) => {
      pi.events.on("review:start", () => {
        active++;
      });
      pi.events.on("review:end", (event) => {
        active--;
        const result = event as { outcome: string };
        const waiter = endWaiters.shift();
        if (waiter) waiter(result);
        else ends.push(result);
      });
    },
  ]);
  const history = SessionManager.create(cwd, path.join(directory, "sessions"));
  history.appendMessage({ role: "user", content: "Review the café gate.", timestamp: 0 });
  history.appendMessage(assistantMessage("Ready for review."));
  const { session } = await createAgentSession({
    ...resources,
    sessionManager: history,
    model: reviewModel,
    tools: ["edit"],
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
    try {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      while (active > 0) await deadline(nextEnd(), "review shutdown");
      await session.abort();
      await settle();
      await resources.settingsManager.flush();
    } finally {
      session.dispose();
    }
  };
  try {
    initTheme("dark", false);
    const ui = uiBoundary(
      {
        theme: session.extensionRunner.getUIContext().theme,
        notify: (message, type) => notifications.push({ message, type }),
        setStatus() {},
        setWidget() {},
        onTerminalInput: (handler) => {
          listeners.add(handler);
          return () => {
            listeners.delete(handler);
          };
        },
        getEditorText: () => draft,
        setEditorText: (text) => {
          draft = text;
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
        for (const listener of listeners) if (listener(data)?.consume) return true;
        return false;
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
      },
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

function submit(findings: FocusFinding[]) {
  return toolCall("submit_review", { findings });
}

function toolCall(name: string, args: Record<string, unknown>): AssistantMessage {
  return {
    ...assistantMessage(""),
    stopReason: "toolUse",
    content: [{ type: "toolCall", id: `call-${name}`, name, arguments: args }],
  };
}

function text(message: Context["messages"][number]) {
  return typeof message.content === "string"
    ? message.content
    : message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
}

function sessionPath(args: string[]) {
  assert.ok(args.includes("--session"));
  return args[args.indexOf("--session") + 1];
}

/** Bound event waits only as a failure safety net; readiness and completion come from real events. */
async function deadline<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 10_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
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
