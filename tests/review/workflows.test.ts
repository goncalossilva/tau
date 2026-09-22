import assert from "node:assert/strict";
import childProcess, { type ChildProcess, type SpawnOptions } from "node:child_process";
import { once } from "node:events";
import fs, { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import timers, { setImmediate } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import { contentText, type AssistantMessage, type ImageContent } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  CustomEditor,
  getSelectListTheme,
  getPackageDir,
  initTheme,
  SessionManager,
  type ExtensionUIContext,
  type KeybindingsManager as AppKeybindingsManager,
  type TerminalInputHandler,
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
import type { FocusFinding, ReviewMessageDetails } from "../../extensions/review/schema.js";
import { assistantMessage, createPiResources, uiBoundary } from "../helpers/pi.js";
import { providerPath, reviewModel } from "./provider.js";
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

describe("review", { concurrency: false }, () => {
  let directory: string;
  let cwd: string;
  let app: Awaited<ReturnType<typeof openReview>> | undefined;
  let failures: unknown[];
  let children: { process: ChildProcess; closed: Promise<unknown>; hasClosed: boolean }[];
  let generations: ChildGeneration[];
  let respond: (request: ChildGeneration) => AssistantMessage | Promise<AssistantMessage>;
  let responderWork: Promise<void>[];
  let shellCommand: string | undefined;

  beforeEach(async () => {
    failures = [];
    children = [];
    generations = [];
    responderWork = [];
    shellCommand = undefined;
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
          },
          stdio: [...options.stdio, "ipc"],
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
      const prompt = contentText(request.context.messages[0].content);
      assertReviewPrompt(prompt, "diff");
      assert.match(prompt, /review untracked files as additions/);
      assert.ok(prompt.includes("Keep $& and 🐙 intact"));
      assert.ok(
        contentText(request.context.messages[0].content).includes(
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
        const prompt = contentText(context.messages[0].content);
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

  test("keeps a quiet heading and aligned focus statuses readable at wide and narrow widths", async () => {
    await writeFile(path.join(cwd, "new-ticket.txt"), "Review every angle of the café.\n");
    const focuses = ["general", "security", "reuse", "quality", "testing", "efficiency"];
    const replies = focuses.map(() => deferred<AssistantMessage>());
    const ready = deferred<void>();
    let received = 0;
    respond = ({ context }) => {
      assertReviewPrompt(contentText(context.messages[0].content), "diff");
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
      const image: ImageContent = {
        type: "image",
        mimeType: "image/png",
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
      };
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
      const image: ImageContent = {
        type: "image",
        mimeType: "image/png",
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
      };
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
      shellCommand = workload.command;
      respond = () => toolCall("bash", { command: shellCommand });
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
      await app.run("/review uncommitted focus=general");
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
    scriptedProvider(
      reviewModel,
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
  const history = SessionManager.create(cwd, path.join(directory, "sessions"));
  history.appendMessage({ role: "user", content: "Review the café gate.", timestamp: 0 });
  history.appendMessage(assistantMessage("Ready for review."));
  const { session } = await createAgentSession({
    ...resources,
    sessionManager: history,
    model: reviewModel,
    tools: ["edit", ...(withSubagent ? ["subagent"] : [])],
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

function toolCall(name: string, args: Record<string, unknown>): AssistantMessage {
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
