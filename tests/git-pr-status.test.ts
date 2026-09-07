import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { createServer, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import { setImmediate as drainIO } from "node:timers/promises";
import { promisify, stripVTControlCharacters } from "node:util";
import {
  createBashTool,
  ExtensionRunner,
  initTheme,
  ModelRegistry,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import gitPrStatus from "../extensions/git-pr-status.js";
import { assistantMessage, createPiResources, uiBoundary } from "./helpers/pi.js";

describe("git-pr-status", { concurrency: false }, () => {
  let directory: string | undefined;
  let cwd: string;
  let repo: string;
  let failures: unknown[];
  let external: ReturnType<typeof processBoundary> | undefined;
  let extension: Awaited<ReturnType<typeof openExtension>> | undefined;
  let pipeHolder: Awaited<ReturnType<typeof detachedPipeHolder>> | undefined;

  beforeEach(async () => {
    failures = [];
    directory = await mkdtemp(path.join(os.tmpdir(), "tau-git-pr-status-"));
    repo = path.join(directory, "captain's café");
    cwd = path.join(repo, "nested project");
    await mkdir(cwd, { recursive: true });
    await git(repo, "init", "--initial-branch=main", "--template=");
    await git(repo, "config", "core.hooksPath", os.devNull);
    await writeFile(path.join(cwd, "draft.txt"), "  The ducks demand code review. 🦆\n");
    external = processBoundary(cwd, failures);
    extension = await openExtension(directory, cwd, failures);
  });

  afterEach(async () => {
    const disposal = extension?.dispose();
    try {
      await ready(disposal ?? Promise.resolve());
    } finally {
      extension = undefined;
      try {
        await pipeHolder?.dispose();
        pipeHolder = undefined;
        await external?.dispose();
        await disposal;
      } finally {
        external = undefined;
        mock.restoreAll();
        syncBuiltinESMExports();
        if (directory) await rm(directory, { recursive: true, force: true });
        directory = undefined;
      }
    }
    assert.deepEqual(failures, [], "unexpected work and Pi errors must not be swallowed");
  });

  test("tracks closing, reopening and merging a PR; failed lookups preserve it, confirmed absence clears it", async () => {
    const { runner, status } = extension!;
    const draft = await readFile(path.join(cwd, "draft.txt"));
    const first = external!.lookup();
    await runner.emit({ type: "session_start", reason: "startup" });
    await (await ready(first)).reply(pr(101, "OPEN"));
    assert.equal(status.text, "#101");

    for (const [command, state, expected] of [
      ["gh pr close", "CLOSED", "#101 (closed)"],
      ["gh pr reopen", "OPEN", "#101"],
      ["gh pr merge", "MERGED", "#101 (merged)"],
    ] as const) {
      const lookup = external!.lookup();
      await githubMutation(runner, cwd, command);
      await (await ready(lookup)).reply(pr(101, state));
      assert.equal(status.text, expected);
    }

    // Transport failure and unusable CLI data are not evidence that the PR disappeared.
    for (const response of [
      { code: 1, stderr: "HTTP 502: the review ducks are temporarily unavailable" },
      { stdout: "{not json" },
      { stdout: JSON.stringify({ number: 0, state: "OPEN", url: "https://example.invalid/pr/0" }) },
    ]) {
      const lookup = external!.lookup();
      await githubMutation(runner, cwd, "gh pr ready");
      await (await ready(lookup)).reply(response);
      assert.equal(status.text, "#101 (merged)", "failed refresh retains the last known status");
    }

    const missing = external!.lookup();
    await githubMutation(runner, cwd, "gh pr ready");
    await (
      await ready(missing)
    ).reply({
      code: 1,
      stderr: 'no pull requests found for branch "main"',
    });
    assert.equal(status.text, undefined);
    assert.deepEqual(await readFile(path.join(cwd, "draft.txt")), draft);
    assert.equal((await git(repo, "branch", "--show-current")).stdout.trim(), "main");
  });

  for (const trigger of ["bash tool result", "turn end"] as const) {
    test(`${trigger} discovers a changed branch and removes the previous PR even if GitHub is unavailable`, async () => {
      const { runner, status } = extension!;
      const first = external!.lookup();
      await runner.emit({ type: "session_start", reason: "startup" });
      await (await ready(first)).reply(pr(101, "OPEN"));
      await external!.joinGit(); // The initial branch read is complete before checkout.
      assert.equal(status.text, "#101");
      const draft = await readFile(path.join(cwd, "draft.txt"));

      const next = external!.lookup();
      if (trigger === "bash tool result") {
        const command = "git checkout -b bread-review";
        const result = await createBashTool(cwd, { shellPath: "/bin/bash" }).execute("checkout", {
          command,
        });
        await runner.emitToolResult({
          type: "tool_result",
          toolName: "bash",
          toolCallId: "checkout",
          input: { command },
          ...result,
          isError: false,
        });
      } else {
        await git(repo, "checkout", "-b", "bread-review");
        await endTurn(runner);
      }
      const lookup = await ready(next);
      assert.equal(
        status.text,
        undefined,
        "the old branch's PR is cleared before the new lookup finishes",
      );
      await lookup.reply({ code: 1, stderr: "HTTP 503: GitHub unavailable" });
      assert.equal(status.text, undefined, "an outage must not restore the old branch's PR");
      assert.equal((await git(repo, "branch", "--show-current")).stdout.trim(), "bread-review");
      assert.deepEqual(await readFile(path.join(cwd, "draft.txt")), draft);
    });
  }

  test("a late lookup from the previous branch cannot resurrect its PR when the new branch lookup fails", async () => {
    const { runner, status } = extension!;
    const first = external!.lookup();
    await runner.emit({ type: "session_start", reason: "startup" });
    const oldBranch = await ready(first);
    await external!.joinGit();
    await git(repo, "checkout", "-b", "bread-review");

    const cleared = status.next();
    const next = external!.lookup();
    await endTurn(runner);
    assert.equal(await ready(cleared), undefined);
    await oldBranch.reply(pr(101, "OPEN"));
    await (await ready(next)).reply({ code: 1, stderr: "HTTP 503: GitHub unavailable" });

    assert.equal(
      status.text,
      undefined,
      "the footer must not show main's #101 while the user is on bread-review",
    );
  });

  for (const ignoreTermination of [false, true]) {
    test(`shutdown joins an active GitHub lookup${ignoreTermination ? " that ignores SIGTERM" : ""} and leaves the footer empty`, async () => {
      const { runner, status } = extension!;
      const first = external!.lookup({ ignoreTermination });
      await runner.emit({ type: "session_start", reason: "startup" });
      const lookup = await ready(first);
      await external!.joinGit();
      assert.equal(lookup.finished, false, "the CLI is alive, awaiting its response");

      await ready(runner.emit({ type: "session_shutdown", reason: "quit" }));

      assert.equal(
        lookup.finished,
        true,
        "shutdown must join the owned GitHub subprocess and pipes",
      );
      assert.equal(status.text, undefined);
      await ready(lookup.done);
      await drainIO();
      assert.equal(status.text, undefined, "late completion must not republish a status");
    });
  }

  test("shutdown releases inherited pipes without waiting for an escaped daemon", async () => {
    const { runner, status } = extension!;
    pipeHolder = await detachedPipeHolder();
    const first = external!.lookup({ pipeHolderScript: pipeHolder.script });
    await runner.emit({ type: "session_start", reason: "startup" });
    const lookup = await ready(first);
    assert.equal(await pipeHolder.isAlive(), true);

    await ready(runner.emit({ type: "session_shutdown", reason: "quit" }));

    assert.equal(lookup.finished, true, "the lookup process and inherited pipes must be settled");
    assert.equal(status.text, undefined);
    assert.equal(
      await pipeHolder.isAlive(),
      true,
      "the escaped daemon is not owned by the lookup group",
    );
  });

  test("shutdown cancels and joins the initial Git branch read", async () => {
    const { runner, status } = extension!;
    const branch = external!.holdBranch();
    external!.lookup(); // Permit an implementation that primes Git and GitHub concurrently.
    await runner.emit({ type: "session_start", reason: "startup" });
    const read = await ready(branch);
    assert.equal(read.finished, false);

    await ready(runner.emit({ type: "session_shutdown", reason: "quit" }));

    assert.equal(read.finished, true, "the initial branch read belongs to the session too");
    assert.equal(status.text, undefined);
  });

  test("reload joins a pending branch read and its queued checks before publishing the replacement PR", async () => {
    const { runner, status } = extension!;
    const first = external!.lookup();
    await runner.emit({ type: "session_start", reason: "startup" });
    await (await ready(first)).reply(pr(101, "OPEN"));
    await external!.joinGit();

    const branch = external!.holdBranch({ ignoreTermination: true });
    await endTurn(runner);
    const read = await ready(branch);
    await endTurn(runner);
    const next = external!.lookup();
    await ready(runner.emit({ type: "session_start", reason: "reload" }));

    assert.equal(read.finished, true, "reload must settle the old branch read before restarting");
    await (await ready(next)).reply(pr(202, "OPEN"));
    assert.equal(status.text, "#202");
  });
});

/** Real Pi event dispatch and theme with only footer output adapted; this is not CLI/PTY coverage. */
async function openExtension(directory: string, cwd: string, failures: unknown[]) {
  const { resourceLoader, modelRuntime, sessionManager } = await createPiResources(
    cwd,
    path.join(directory, "agent"),
    [gitPrStatus],
  );
  const loaded = resourceLoader.getExtensions();
  const runner = new ExtensionRunner(
    loaded.extensions,
    loaded.runtime,
    cwd,
    sessionManager,
    new ModelRegistry(modelRuntime),
  );
  runner.onError((error) => failures.push(error));
  initTheme("dark", false);
  const status = footerOutput(runner.getUIContext().theme, failures);
  runner.setUIContext(status.ui, "tui");
  return {
    runner,
    status,
    async dispose() {
      try {
        await runner.emit({ type: "session_shutdown", reason: "quit" });
      } finally {
        runner.invalidate();
      }
    },
  };
}

/** Observe user-visible status, not colors or its extension-specific registration key. */
function footerOutput(theme: ExtensionUIContext["theme"], failures: unknown[]) {
  const visible = new Map<string, string>();
  let publication: ReturnType<typeof deferred<string | undefined>> | undefined;
  return {
    get text() {
      return [...visible.values()].join(" ") || undefined;
    },
    next() {
      assert.equal(publication, undefined);
      publication = deferred<string | undefined>();
      return publication.promise;
    },
    ui: uiBoundary(
      {
        theme,
        setStatus(key, text) {
          if (text === undefined) visible.delete(key);
          else visible.set(key, stripVTControlCharacters(text));
          publication?.resolve([...visible.values()].join(" ") || undefined);
          publication = undefined;
        },
      },
      failures,
    ),
  };
}

type Reply = { stdout?: string; stderr?: string; code?: number };
type ChildOptions = {
  ignoreTermination?: boolean;
  pipeHolderScript?: string;
};
type ProcessPlan = ChildOptions & {
  ready: ReturnType<typeof deferred<Lookup>>;
};
type Lookup = {
  readonly finished: boolean;
  done: Promise<void>;
  reply(response: Reply): Promise<void>;
};

/**
 * Use IPC-controlled gh children and optionally delay real Git reads with a fixture launcher.
 * Keep extension process ownership real, reject other subprocesses/network, and join all children on failure.
 */
function processBoundary(cwd: string, failures: unknown[]) {
  const spawn = childProcess.spawn;
  const plans: ProcessPlan[] = [];
  const branchPlans: ProcessPlan[] = [];
  const children = new Map<ReturnType<typeof spawn>, Promise<void>>();
  const gitWork: Promise<void>[] = [];
  const reject = (...args: unknown[]): never => {
    failures.push(args);
    throw new Error("Unexpected external work in PR status test");
  };
  mock.method(globalThis, "fetch", reject);
  for (const method of [
    "exec",
    "execSync",
    "execFile",
    "execFileSync",
    "spawnSync",
    "fork",
  ] as const)
    mock.method(childProcess, method, reject);
  mock.method(childProcess, "spawn", (...args: Parameters<typeof spawn>) => {
    const [command, argv, options] = args;
    if (options?.cwd !== cwd || !Array.isArray(argv)) return reject(...args);
    let plan: ProcessPlan | undefined;
    if (
      command === "git" &&
      JSON.stringify(argv) === JSON.stringify(["branch", "--show-current"])
    ) {
      plan = branchPlans.shift();
      if (!plan) {
        const child = spawn(...args);
        gitWork.push(track(child));
        return child;
      }
    } else if (
      command === "/bin/bash" &&
      JSON.stringify(argv) === JSON.stringify(["-c", "git checkout -b bread-review"])
    ) {
      const child = spawn(...args);
      gitWork.push(track(child));
      return child;
    } else if (
      command === "gh" &&
      JSON.stringify(argv) === JSON.stringify(["pr", "view", "--json", "number,url,state"])
    ) {
      plan = plans.shift();
    }
    if (!plan) return reject(...args);
    const child = spawn(
      process.execPath,
      [
        "-e",
        `
        const { execFile } = require("node:child_process");
        const finish = ({ stdout = "", stderr = "", code = 0 }) => {
          process.stdout.write(stdout);
          process.stderr.write(stderr);
          process.exitCode = code;
          process.disconnect();
        };
        const start = (response) => {
          if (${plan.ignoreTermination === true}) process.on("SIGTERM", () => {});
          process.on("message", reply => finish(response ?? reply));
          process.send("ready");
        };
        if (${command === "git"}) {
          execFile("git", ["branch", "--show-current"], (error, stdout, stderr) => {
            start({ stdout, stderr, code: error?.code ?? 0 });
          });
        } else if (${!!plan.pipeHolderScript}) {
          const holder = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(plan.pipeHolderScript ?? "")}], {
            detached: true, stdio: ["ignore", 1, 2, "ipc"],
          });
          holder.once("message", () => start());
          holder.unref();
        } else start();
      `,
      ],
      { ...options, stdio: ["ignore", "pipe", "pipe", "ipc"] },
    );
    const done = track(child);
    if (command === "git") gitWork.push(done);
    child.once("message", (message) => {
      assert.equal(message, "ready");
      plan.ready.resolve({
        get finished() {
          return (
            (child.exitCode !== null || child.signalCode !== null) &&
            [child.stdout, child.stderr].every(
              (stream) => !stream || stream.readableEnded || stream.destroyed,
            )
          );
        },
        done,
        async reply(response) {
          // A correct branch-change implementation may cancel the obsolete lookup instead of consuming its reply.
          if (!child.killed && child.exitCode === null && child.signalCode === null)
            child.send(response);
          await ready(done);
          // Drain Pi's exec promise continuations after the actual child/pipe close, including no-publication errors.
          await drainIO();
        },
      });
    });
    return child;
  });
  syncBuiltinESMExports();
  return {
    lookup(options: ChildOptions = {}) {
      const plan = { ready: deferred<Lookup>(), ...options };
      plans.push(plan);
      return plan.ready.promise;
    },
    holdBranch(options: { ignoreTermination?: boolean } = {}) {
      const plan = { ready: deferred<Lookup>(), ...options };
      branchPlans.push(plan);
      return plan.ready.promise;
    },
    async joinGit() {
      await Promise.all(gitWork);
      await drainIO();
    },
    async dispose() {
      for (const child of children.keys()) child.kill("SIGKILL");
      await Promise.all(children.values());
      await drainIO();
    },
  };

  function track(child: ReturnType<typeof spawn>) {
    const done = new Promise<void>((resolve) =>
      child.once("close", () => {
        children.delete(child);
        resolve();
      }),
    );
    child.once("error", (error) => failures.push(error));
    children.set(child, done);
    return done;
  }
}

/** A detached child retains lookup pipes; a loopback channel proves liveness and owns failure cleanup. */
async function detachedPipeHolder() {
  let control: Socket | undefined;
  const connected = deferred<Socket>();
  const server = createServer((socket) => {
    control = socket;
    socket.on("error", () => {});
    connected.resolve(socket);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    script: `
      const socket = require("node:net").connect(${address.port}, "127.0.0.1");
      socket.on("connect", () => process.send("ready", () => process.disconnect()));
      require("node:readline").createInterface({ input: socket }).on("line", command => {
        if (command === "stop") process.exit(0);
        socket.write("alive\\n");
      });
    `,
    async isAlive() {
      const socket = await ready(connected.promise);
      if (socket.destroyed) return false;
      const response = deferred<boolean>();
      const onData = () => response.resolve(true);
      const onClose = () => response.resolve(false);
      socket.once("data", onData);
      socket.once("close", onClose);
      try {
        socket.write("ping\n");
        return await ready(response.promise);
      } finally {
        socket.removeListener("data", onData);
        socket.removeListener("close", onClose);
      }
    },
    async dispose() {
      if (control && !control.destroyed) {
        const closed = new Promise<void>((resolve) => control!.once("close", () => resolve()));
        control.write("stop\n");
        await ready(closed);
      }
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

/** Execute Pi's native Bash tool with only the unsafe GitHub mutation replaced by an offline success. */
async function githubMutation(runner: ExtensionRunner, cwd: string, command: string) {
  const result = await createBashTool(cwd, {
    operations: {
      async exec(actualCommand, actualCwd) {
        assert.equal(actualCommand, command);
        assert.equal(actualCwd, cwd);
        assert.match(command, /^gh pr (close|reopen|merge|ready)$/);
        return { exitCode: 0 };
      },
    },
  }).execute("github-mutation", { command });
  await runner.emitToolResult({
    type: "tool_result",
    toolName: "bash",
    toolCallId: "github-mutation",
    input: { command },
    ...result,
    isError: false,
  });
}

function endTurn(runner: ExtensionRunner) {
  return runner.emit({
    type: "turn_end",
    turnIndex: 0,
    message: assistantMessage("Quack."),
    toolResults: [],
  });
}

function pr(number: number, state: "OPEN" | "CLOSED" | "MERGED"): Reply {
  return {
    stdout: JSON.stringify({
      number,
      state,
      url: `https://example.invalid/ducks/review/pull/${number}`,
    }),
  };
}

const execFile = promisify(childProcess.execFile);
/** Fixture-owned Git only; the captured native function bypasses the extension's external-work guard. */
function git(cwd: string, ...args: string[]) {
  return execFile("git", args, {
    cwd,
    env: { ...process.env, GIT_ALLOW_PROTOCOL: "" },
    timeout: 10_000,
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Readiness deadlines are safety nets, never timing assertions; teardown owns all remaining subprocesses. */
async function ready<T>(promise: Promise<T>): Promise<T> {
  let deadline: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(
          () => reject(new Error("PR workflow did not reach readiness")),
          10_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(deadline);
  }
}
