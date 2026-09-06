import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { createServer, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, mock, test } from "node:test";
import { promisify, stripVTControlCharacters } from "node:util";
import {
  createEditTool,
  createWriteTool,
  ExtensionRunner,
  initTheme,
  ModelRegistry,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import gitDiffStats from "../extensions/git-diff-stats.js";
import { assistantMessage, createPiResources, isolatePiHome, uiBoundary } from "./helpers/pi.js";

describe("git-diff-stats", { concurrency: false }, () => {
  let home: Awaited<ReturnType<typeof isolatePiHome>> | undefined;
  let directory: string | undefined;
  let repo: string;
  let extension: Awaited<ReturnType<typeof openExtension>> | undefined;
  let failures: unknown[];

  before(async () => {
    home = await isolatePiHome();
  });

  after(async () => home?.dispose());

  beforeEach(async () => {
    failures = [];
    mock.method(globalThis, "fetch", (request: unknown) => {
      failures.push(request);
      throw new Error("Unexpected network request in Git status test");
    });
    directory = await mkdtemp(path.join(os.tmpdir(), "tau-git-diff-stats-"));
    repo = path.join(directory, "project");
    await initializeRepository(repo);
  });

  afterEach(async () => {
    try {
      await extension?.dispose();
      assert.deepEqual(failures, [], "unexpected work or errors must not be swallowed by Pi");
    } finally {
      extension = undefined;
      mock.restoreAll();
      syncBuiltinESMExports();
      if (directory) await rm(directory, { recursive: true, force: true });
      directory = undefined;
    }
  });

  describe("opening a nested project", () => {
    for (const { name, prepare, expected } of [
      {
        name: "combines staged, unstaged and untracked changes without restaging anything",
        prepare: stageMixedChanges,
        expected: "+7 -4",
      },
      {
        name: "counts a rewritten rename once and retains a staged new file deleted from disk",
        prepare: stageRewrittenRename,
        expected: "+5 -6",
      },
      {
        name: "shows staged and untracked additions before the first commit",
        async prepare(repo: string) {
          await writeFiles(repo, {
            "duck.txt": "Chief Quacking Officer\n",
            "budget.txt": "Bread: 9000\nServers: 3\n",
          });
          await git(repo, "add", "--", "duck.txt");
        },
        expected: "+3 -0",
      },
    ]) {
      test(name, async () => {
        await prepare(repo);
        const before = await repositoryBytes(repo);
        const cwd = path.join(repo, "src", "nested");
        await mkdir(cwd, { recursive: true });
        extension = await openExtension(directory!, repo, cwd, failures);

        await extension.status.expect(expected, () =>
          extension!.runner.emit({ type: "session_start", reason: "startup" }),
        );
        assert.deepEqual(
          await repositoryBytes(repo),
          before,
          "opening Pi must preserve index and file bytes",
        );
      });
    }
  });

  describe("ending an active refresh", () => {
    for (const [operation, event] of [
      ["shutdown", { type: "session_shutdown", reason: "quit" }],
      ["session replacement", { type: "session_start", reason: "resume" }],
    ] as const) {
      test(`${operation} stops Git and its filter before returning, without leaving temporary indexes`, async () => {
        await writeFiles(repo, { "draft.txt": "first\nsecond\n" });
        await commitAll(repo);
        await writeFiles(repo, { "draft.txt": "first\nchanged\n" });
        const filter = await blockCleanFilter(repo);
        try {
          extension = await openExtension(directory!, repo, repo, failures, filter.observe);
          const before = await repositoryBytes(repo);
          const metadata = await readdir(path.join(repo, ".git"));
          await extension.runner.emit({ type: "session_start", reason: "startup" });
          const blocked = await filter.started;
          assert.equal(blocked.closed, false, "Git is still waiting for its filter");

          // Future refreshes can finish; the already-running filter remains stuck.
          await git(repo, "config", "--unset", "filter.tau-test.clean");
          await extension.runner.emit(event);
          assert.equal(
            blocked.closed,
            true,
            "lifecycle completion must join Git and its inherited pipes",
          );
          if (event.type === "session_start") {
            await extension.status.expect("+1 -1", async () => {});
          }
          assert.equal(await filter.isRunning(), false, "the owned filter has stopped");
          assert.deepEqual(
            await readdir(path.join(repo, ".git")),
            metadata,
            "no temporary index or lock is left behind",
          );
          assert.deepEqual(await repositoryBytes(repo), before);
        } finally {
          await filter.dispose();
        }
      });
    }
  });

  test("shutdown releases pipes held by a detached filter only after Git exits", async () => {
    await writeFiles(repo, { "draft.txt": "first\nsecond\n" });
    await commitAll(repo);
    await writeFiles(repo, { "draft.txt": "first\nchanged\n" });
    const filter = await blockCleanFilter(repo, true);
    let deadline: NodeJS.Timeout | undefined;
    try {
      extension = await openExtension(directory!, repo, repo, failures, filter.observe);
      const before = await repositoryBytes(repo);
      const metadata = await readdir(path.join(repo, ".git"));
      await extension.runner.emit({ type: "session_start", reason: "startup" });
      const blocked = await filter.started;

      await Promise.race([
        extension.runner.emit({ type: "session_shutdown", reason: "quit" }),
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(
            () => reject(new Error("Shutdown waited for a detached pipe holder")),
            10_000,
          );
        }),
      ]);
      assert.ok(
        blocked.child.exitCode !== null || blocked.child.signalCode !== null,
        "Git has actually exited",
      );
      assert.equal(blocked.closed, true, "inherited pipes no longer retain the refresh");
      assert.equal(
        await filter.isRunning(),
        true,
        "shutdown does not kill outside its process group",
      );
      assert.deepEqual(await readdir(path.join(repo, ".git")), metadata);
      assert.deepEqual(await repositoryBytes(repo), before);
    } finally {
      clearTimeout(deadline);
      await filter.dispose();
    }
  });

  describe("refreshing after changes", () => {
    for (const toolName of ["write", "edit"] as const) {
      test(`${toolName} updates the footer before turn end; restoring the project clears it`, async () => {
        const original = "first\nsecond\n";
        await writeFiles(repo, { "draft.txt": original });
        await commitAll(repo);
        await writeFiles(repo, { "draft.txt": "first\nchanged\n" });
        extension = await openExtension(directory!, repo, repo, failures);
        const { runner, status } = extension;
        await status.expect("+1 -1", () =>
          runner.emit({ type: "session_start", reason: "startup" }),
        );

        const writeInput = { path: "draft.txt", content: "first\nchanged\nthird\n" };
        const editInput = {
          path: "draft.txt",
          edits: [{ oldText: "changed\n", newText: "changed\nthird\n" }],
        };
        const input = toolName === "write" ? writeInput : editInput;
        const result =
          toolName === "write"
            ? await createWriteTool(repo).execute("update-draft", writeInput)
            : await createEditTool(repo).execute("update-draft", editInput);
        const changed = await repositoryBytes(repo);
        await status.expect("+2 -1", () =>
          runner.emitToolResult({
            type: "tool_result",
            toolName,
            toolCallId: "update-draft",
            input,
            content: result.content,
            details: result.details,
            isError: false,
          }),
        );
        assert.deepEqual(
          await repositoryBytes(repo),
          changed,
          "refresh must not change what the tool wrote or staged",
        );

        // A user restores the file outside Pi; turn_end must refresh without an
        // edit/write result in that turn and remove the obsolete statistics.
        await writeFiles(repo, { "draft.txt": original });
        const restored = await repositoryBytes(repo);
        await status.expect(undefined, () =>
          runner.emit({
            type: "turn_end",
            turnIndex: 0,
            toolResults: [],
            message: assistantMessage("Done."),
          }),
        );
        assert.deepEqual(await repositoryBytes(repo), restored);
      });
    }
  });
});

/** Prepare overlapping staged/working edits alongside deleted, untracked, ignored, and binary files. */
async function stageMixedChanges(repo: string) {
  await writeFiles(repo, {
    "mixed.txt": "one\ntwo\nthree\nfour\n",
    "staged.txt": "keep\n",
    "deleted.txt": "obsolete\nunused\n",
    ".gitignore": "ignored.txt\n",
  });
  await commitAll(repo);
  await writeFiles(repo, {
    "mixed.txt": "one\nTWO\nthree\nfour\nfive\n",
    "staged.txt": "keep\nstaged addition\n",
  });
  await git(repo, "add", "--", "mixed.txt", "staged.txt");
  await writeFiles(repo, {
    "mixed.txt": "one\nTWO\nTHREE\nfour\nfive\nsix\n", // +4 -2, not staged + unstaged totals
    "notes\tfor review\n.md": "new note\nanother note\n", // +2
    "ignored.txt": "not part of the diff\n",
    "image.bin": Buffer.from([0, 1, 2, 10, 255]), // binary is not a line count
  });
  await rm(path.join(repo, "deleted.txt")); // -2; staged.txt contributes +1
}

/** Stage a rename and a new file, then rewrite the destination and remove the new file from disk. */
async function stageRewrittenRename(repo: string) {
  await writeFiles(repo, {
    "guide.md": "Introduction\nInstallation\nConfiguration\nCommands\nExamples\nReference\n",
  });
  await commitAll(repo);
  const destination = "guide\tv2\n .md";
  await rename(path.join(repo, "guide.md"), path.join(repo, destination));
  await writeFiles(repo, {
    [destination]:
      "Introduction\nInstallation\nConfiguration\nCommands\nExamples\nReference\nAppendix\n",
    "staged-only.txt": "recoverable from the index\nnot present on disk\n",
  });
  await git(repo, "add", "--all");
  // The staged version is a rename with one added line. Rewriting the working
  // version loses rename similarity, but must not add the staged line again.
  await writeFiles(repo, { [destination]: "A completely new guide\nQuick start\nNext steps\n" });
  await rm(path.join(repo, "staged-only.txt"));
}

/**
 * Load the extension into Pi's real runner with a footer adapter, but no model or agent loop.
 * Adapt footer output and reject external work; the extension owns Git cancellation and cleanup.
 */
async function openExtension(
  directory: string,
  repo: string,
  cwd: string,
  failures: unknown[],
  onSpawn?: (child: ReturnType<typeof childProcess.spawn>) => void,
) {
  const { resourceLoader, modelRuntime, sessionManager } = await createPiResources(
    cwd,
    path.join(directory, "agent"),
    [gitDiffStats],
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
  const status = statusOutput(runner.getUIContext().theme, failures);
  runner.setUIContext(status.ui, "tui");

  // Pass through to real Git, rejecting commands outside the fixture's local work.
  const spawn = childProcess.spawn;
  mock.method(childProcess, "spawn", (...args: Parameters<typeof spawn>) => {
    const command = args[1]?.[0];
    const spawnCwd = args[2]?.cwd;
    if (
      args[0] !== "git" ||
      typeof spawnCwd !== "string" ||
      (spawnCwd !== repo && !spawnCwd.startsWith(`${repo}${path.sep}`)) ||
      ["fetch", "push", "pull", "clone", "ls-remote", "submodule"].includes(command ?? "")
    ) {
      failures.push(args);
      throw new Error("Unexpected external work in Git status test");
    }
    const child = spawn(...args);
    onSpawn?.(child);
    return child;
  });
  syncBuiltinESMExports();

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

/**
 * Capture visible footer text without terminal escape sequences and await the next publication.
 * Arm the observer before running an action; assert on that update rather than polling for a match.
 */
function statusOutput(theme: ExtensionUIContext["theme"], failures: unknown[]) {
  let publish: ((text: string | undefined) => void) | undefined;
  const visible = new Map<string, string>();
  const ui = uiBoundary(
    {
      theme,
      setStatus(key, text) {
        if (text === undefined) visible.delete(key);
        else visible.set(key, stripVTControlCharacters(text));
        publish?.([...visible.values()].join(" ") || undefined);
      },
    },
    failures,
  );
  return {
    ui,
    async expect(expected: string | undefined, action: () => Promise<unknown>) {
      assert.equal(await this.observe(action), expected);
    },
    async observe(action: () => Promise<unknown>) {
      assert.equal(publish, undefined, "only one publication may be awaited at a time");
      let timeout: NodeJS.Timeout;
      const next = new Promise<string | undefined>((resolve, reject) => {
        publish = resolve;
        timeout = setTimeout(
          () => reject(new Error("No status publication before the test deadline")),
          10_000,
        );
      });
      try {
        const [, text] = await Promise.all([action(), next]);
        return text;
      } finally {
        clearTimeout(timeout!);
        publish = undefined;
      }
    },
  };
}

/**
 * Stall a real Git filter, optionally outside Git's process group, with a loopback control channel.
 * The channel proves liveness without process-table access and lets cleanup stop the fixture on failure.
 */
async function blockCleanFilter(repo: string, detached = false) {
  const server = createServer();
  let control: Socket | undefined;
  const connected = new Promise<void>((resolve) => {
    server.once("connection", (socket) => {
      control = socket;
      socket.on("error", () => {}); // A forcibly killed peer may reset the connection.
      resolve();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const hold = `
    process.on("SIGTERM", () => {});
    const socket = require("node:net").connect(${address.port}, "127.0.0.1");
    socket.on("connect", () => process.stderr.write("tau-filter-ready\\n"));
    require("node:readline").createInterface({ input: socket }).on("line", (command) => {
      if (command === "stop") process.exit(0);
      socket.write("alive\\n");
    });
  `;
  const script = detached
    ? `
    const child = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(hold)}], {
      detached: true, stdio: ["ignore", "ignore", 2],
    });
    child.unref();
  `
    : hold;
  const command = [process.execPath, "-e", script]
    .map((part) => `'${part.replaceAll("'", "'\\''")}'`)
    .join(" ");
  try {
    await mkdir(path.join(repo, ".git", "info"), { recursive: true });
    await writeFile(path.join(repo, ".git", "info", "attributes"), "draft.txt filter=tau-test\n");
    await git(repo, "config", "filter.tau-test.clean", command);
  } catch (error) {
    server.close();
    throw error;
  }

  type GitProcess = {
    child: ReturnType<typeof childProcess.spawn>;
    closed: boolean;
    done: Promise<void>;
  };
  const live = new Set<GitProcess>();
  let ready: (process: GitProcess) => void;
  let deadline: NodeJS.Timeout;
  const started = new Promise<GitProcess>((resolve, reject) => {
    ready = resolve;
    deadline = setTimeout(() => reject(new Error("Git never entered the clean filter")), 10_000);
  });
  const observe = (child: ReturnType<typeof childProcess.spawn>) => {
    const done = new Promise<void>((resolve) => {
      child.once("close", () => {
        running.closed = true;
        live.delete(running);
        resolve();
      });
    });
    const running: GitProcess = { child, closed: false, done };
    live.add(running);
    let output = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (!output.includes("tau-filter-ready\n")) return;
      clearTimeout(deadline);
      ready(running);
    });
  };

  return {
    started: Promise.all([started, connected]).then(([running]) => running),
    observe,
    async isRunning() {
      if (!control || control.destroyed) return false;
      const socket = control;
      return new Promise<boolean>((resolve, reject) => {
        const finish = (running: boolean) => {
          clearTimeout(timeout);
          socket.removeListener("data", onData);
          socket.removeListener("close", onClose);
          resolve(running);
        };
        const onData = () => finish(true);
        const onClose = () => finish(false);
        const timeout = setTimeout(
          () => reject(new Error("Filter did not answer or close")),
          10_000,
        );
        socket.once("data", onData);
        socket.once("close", onClose);
        socket.write("ping\n");
      });
    },
    async dispose() {
      clearTimeout(deadline);
      if (control && !control.destroyed) {
        const closed = new Promise<void>((resolve) => control!.once("close", () => resolve()));
        control.write("stop\n");
        await closed;
      }
      await Promise.all(
        [...live].map(async ({ child, done }) => {
          child.kill("SIGKILL");
          await done;
        }),
      );
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

/** Initialize real Git with consistent line handling and rename detection, without hooks or signing. */
async function initializeRepository(repo: string) {
  await mkdir(repo);
  await git(repo, "init", "--initial-branch=main", "--template=");
  await git(repo, "config", "core.hooksPath", os.devNull);
  await git(repo, "config", "commit.gpgsign", "false");
  await git(repo, "config", "core.autocrlf", "false");
  await git(repo, "config", "diff.renames", "true");
}

const execFile = promisify(childProcess.execFile);
/** Run local-only Git commands with a fixed fixture identity and commit dates. */
async function git(cwd: string, ...args: string[]) {
  return execFile("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_ALLOW_PROTOCOL: "",
      GIT_AUTHOR_NAME: "Tau Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Tau Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
      GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
    },
    timeout: 10_000,
  });
}

async function commitAll(repo: string) {
  await git(repo, "add", "--all");
  await git(repo, "commit", "--message=Fixture baseline");
}

async function writeFiles(repo: string, files: Record<string, string | Buffer>) {
  for (const [name, content] of Object.entries(files))
    await writeFile(path.join(repo, name), content);
}

/** Snapshot working-file and index bytes so status checks can detect unintended writes or staging. */
async function repositoryBytes(repo: string) {
  const files: Record<string, Buffer> = {};
  async function visit(dir: string) {
    for (const entry of await readdir(path.join(repo, dir), { withFileTypes: true })) {
      if (dir === "" && entry.name === ".git") continue;
      const name = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(name);
      else files[name] = await readFile(path.join(repo, name));
    }
  }
  await visit("");
  return { index: await readFile(path.join(repo, ".git", "index")), files };
}
