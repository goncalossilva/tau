import assert from "node:assert/strict";
import childProcess from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import {
  createAgentSession,
  createAgentSessionRuntime,
  initTheme,
  type KeybindingsManager,
  SessionManager,
  type CustomEntry,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { TuiMainScreen, type Terminal } from "@earendil-works/pi-tui";
import worktree from "../extensions/worktree.js";
import {
  assistantMessage,
  createPiResources,
  fixtureModel,
  isolatePiHome,
  uiBoundary,
} from "./helpers/pi.js";

describe("worktree", { concurrency: false }, () => {
  let directory: string | undefined;
  let repo: string;
  let history: SessionManager;
  let home: Awaited<ReturnType<typeof isolatePiHome>> | undefined;
  let ui: Awaited<ReturnType<typeof openWorktree>> | undefined;
  let external: ReturnType<typeof processBoundary> | undefined;
  let failures: unknown[];

  beforeEach(async () => {
    failures = [];
    home = await isolatePiHome();
    directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "tau-worktree-")));
    repo = path.join(directory, "otter's café $coins");
    await mkdir(repo);
    git(repo, "init", "-b", "main");
    git(repo, "config", "user.name", "Otter Keeper");
    git(repo, "config", "user.email", "otter@example.invalid");
    await writeFile(path.join(repo, "menu.txt"), "Kelp croissants\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "Open the underwater café");
    history = conversation(repo, path.join(directory, "session vault"));
    external = processBoundary(directory, failures);
  });

  afterEach(async () => {
    try {
      await ui?.dispose();
      assert.deepEqual(
        failures,
        [],
        "Pi must not swallow unexpected UI, subprocess or extension errors",
      );
    } finally {
      ui = undefined;
      await external?.dispose();
      external = undefined;
      mock.restoreAll();
      syncBuiltinESMExports();
      if (directory) await rm(directory, { recursive: true, force: true });
      directory = undefined;
      await home?.dispose();
      home = undefined;
    }
  });

  test("moves a checked-out feature into its own worktree with durable, usable stash recovery instructions", async () => {
    git(repo, "checkout", "-b", "Feature/Otter");
    const staged = "Kelp croissants\n  Espresso for eight. 🐙\n";
    const working = `${staged}One extra kelp shot.\n`;
    const untracked = Buffer.from([0, 255, 10, 13, 42]);
    await writeFile(path.join(repo, "menu.txt"), staged);
    git(repo, "add", "menu.txt");
    await writeFile(path.join(repo, "menu.txt"), working);
    await writeFile(path.join(repo, "secret recipe.bin"), untracked);
    ui = await openWorktree(directory!, history, failures, {
      confirm: async (title) => {
        assert.match(title, /switch main worktree/i);
        return true;
      },
      select: async (title, options) => {
        assert.match(title, /main worktree.*uncommitted/i);
        return choose(options, /^Stash changes/);
      },
    });
    const sourceFile = history.getSessionFile()!;
    const context = structuredClone(history.buildSessionContext());

    await ui.prompt("/worktree new refs/heads/Feature/Otter");

    const target = `${repo}-feature-otter`;
    assert.equal(git(target, "branch", "--show-current").trim(), "Feature/Otter");
    assert.equal(git(repo, "branch", "--show-current").trim(), "main");
    assert.equal(git(repo, "status", "--porcelain"), "");
    assert.equal(
      ui.session.sessionFile,
      sourceFile,
      "new opens manually rather than switching the running session",
    );
    assert.deepEqual(
      history.buildSessionContext(),
      context,
      "operational instructions are not model input",
    );
    const stash = git(repo, "rev-parse", "stash@{0}").trim();
    assert.equal(
      git(repo, "show", `${stash}^2:menu.txt`),
      staged,
      "the original index remains recoverable",
    );
    const restore = commandEntry(SessionManager.open(sourceFile), "worktree-restore-command");
    const open = commandEntry(SessionManager.open(sourceFile), "worktree-open-command");
    assert.deepEqual(interpretCommand(restore.data!.command, directory!), {
      cwd: target,
      program: "git",
      args: ["stash", "apply", stash],
    });
    assert.deepEqual(interpretCommand(open.data!.command, directory!), {
      cwd: target,
      program: "pi",
      args: [],
    });
    assert.deepEqual(external!.clipboard, [restore.data!.command, open.data!.command]);
    for (const entry of [restore, open]) assert.ok(ui.render(entry).includes(entry.data!.command));

    // A later stash must not redirect the advertised recovery command to unrelated changes.
    await writeFile(path.join(repo, "another order.txt"), "Sea cucumber tea\n");
    git(repo, "stash", "push", "-u", "-m", "Another customer");
    git(target, "stash", "apply", stash);
    assert.equal(await readFile(path.join(target, "menu.txt"), "utf8"), working);
    assert.deepEqual(await readFile(path.join(target, "secret recipe.bin")), untracked);
    await ui.session.reload();
    assert.deepEqual(
      commandEntry(SessionManager.open(sourceFile), "worktree-restore-command"),
      restore,
    );
    assert.ok(ui.render(restore).includes(restore.data!.command));
  });

  test("copies opted-in cache bytes and symlinks without copying an explicitly excluded private subtree", async () => {
    await writeFile(path.join(repo, ".gitignore"), "cache/\n");
    await writeFile(
      path.join(repo, ".worktreeinclude"),
      [
        "# Reuse the pastry cache",
        "cache/",
        "!cache/private/",
        "cache/private/too-late.txt", // An excluded parent must be reincluded first.
        "!*.secret",
        "!/cache/root-only.bin",
        "!discard/",
        "!cache/reopened/",
        "cache/reopened/", // Last matching rule wins for the directory itself.
        "",
      ].join("\n"),
    );
    git(repo, "add", ".");
    git(repo, "commit", "-m", "Share pastries, not secrets");
    git(repo, "tag", "bakery-base");
    await writeFile(path.join(repo, "menu.txt"), "Experimental jellyfish jam\n");
    git(repo, "add", "menu.txt");
    git(repo, "commit", "-m", "Try a newer menu without changing the requested base");
    await mkdir(path.join(repo, "cache/private"), { recursive: true });
    const bytes = Buffer.from([0, 10, 255, 13, 128]);
    await writeFile(path.join(repo, "cache/pastries.bin"), bytes);
    await symlink("pastries.bin", path.join(repo, "cache/latest"));
    await writeFile(path.join(repo, "cache/private/credentials.txt"), "fixture-only secret\n");
    const included = ["nested/root-only.bin", "nested/discard", "reopened/keep.bin"];
    const excluded = [
      "private/too-late.txt",
      "nested/recipe.secret",
      "root-only.bin",
      "discard/deep/crumb.bin",
    ];
    for (const file of [...included, ...excluded]) {
      await mkdir(path.dirname(path.join(repo, "cache", file)), { recursive: true });
      await writeFile(path.join(repo, "cache", file), bytes);
    }
    await symlink("missing-pastry", path.join(repo, "cache/dangling"));
    await symlink("nested", path.join(repo, "cache/nested-link"));
    ui = await openWorktree(directory!, history, failures, {
      confirm: async (title) => {
        assert.match(title, /copy cached files/i);
        return true;
      },
    });

    await ui.prompt("/worktree new pastry-cache --from bakery-base");

    const target = `${repo}-pastry-cache`;
    assert.deepEqual(await readFile(path.join(target, "cache/pastries.bin")), bytes);
    assert.equal(await readlink(path.join(target, "cache/latest")), "pastries.bin");
    assert.equal(await readlink(path.join(target, "cache/dangling")), "missing-pastry");
    assert.equal(await readlink(path.join(target, "cache/nested-link")), "nested");
    for (const file of included) {
      assert.deepEqual(await readFile(path.join(target, "cache", file)), bytes);
    }
    for (const file of excluded) {
      await assert.rejects(access(path.join(target, "cache", file)), { code: "ENOENT" }, file);
      assert.deepEqual(await readFile(path.join(repo, "cache", file)), bytes);
    }
    assert.equal(git(target, "rev-parse", "HEAD"), git(repo, "rev-parse", "bakery-base"));
    assert.equal(await readFile(path.join(target, "menu.txt"), "utf8"), "Kelp croissants\n");
    assert.deepEqual(await readFile(path.join(repo, "cache/pastries.bin")), bytes);
    await assert.rejects(
      access(path.join(target, "cache/private")),
      { code: "ENOENT" },
      "negated descendants must not leak into a new worktree",
    );
  });

  for (const action of ["switch", "archive"] as const) {
    test(`the list picker targets the selected detached worktree for ${action}, not another checkout at the same commit`, async () => {
      const first = path.join(directory!, "a-detached");
      const second = path.join(directory!, "b-detached");
      git(repo, "worktree", "add", "--detach", first, "HEAD");
      git(repo, "worktree", "add", "--detach", second, "HEAD");
      await writeFile(path.join(first, "only-here.txt"), "The otter chose this dock.\n");
      let archivePrompted = false;
      ui = await openWorktree(directory!, history, failures, {
        select: async (title, options) => {
          assert.equal(action, "archive");
          assert.ok(title.includes(first), "archive confirmation must describe the selected path");
          assert.match(title, /uncommitted changes/);
          archivePrompted = true;
          return choose(options, /^Cancel$/);
        },
        custom: async (factory) => {
          let done = false;
          let result: Parameters<Parameters<typeof factory>[3]>[0] | undefined;
          const screen = new TuiMainScreen(terminalBoundary());
          let component: Awaited<ReturnType<typeof factory>> | undefined;
          try {
            component = await factory(
              screen,
              ui!.session.extensionRunner.getUIContext().theme,
              // Pi exports this app manager only as a type. The picker uses real SelectList keybindings,
              // not this injected argument; reject access rather than simulate an application manager.
              new Proxy({} as KeybindingsManager, {
                get(_target, key) {
                  throw new Error(`Unexpected application keybinding access: ${String(key)}`);
                },
              }),
              (value) => {
                done = true;
                result = value;
              },
            );
            const rendered = component.render(1000).map(stripVTControlCharacters).join("\n");
            assert.ok(rendered.includes(first) && rendered.includes(second));
            assert.match(rendered, /detached@\w+ \*/);
            assert.ok(component.handleInput);
            component.handleInput("\x1b[B"); // Main is first; select the first detached checkout.
            component.handleInput(action === "switch" ? "\r" : "a");
            assert.ok(done, "the requested action completes the actual picker");
            return result!;
          } finally {
            try {
              component?.dispose?.();
            } finally {
              screen.stop({ preserveScreen: true });
            }
          }
        },
      });

      await ui.prompt("/worktree list");

      assert.equal(
        ui.cwd,
        action === "switch" ? first : repo,
        "display labels are not unique worktree identities",
      );
      assert.equal(archivePrompted, action === "archive");
      assert.equal(
        await readFile(path.join(first, "only-here.txt"), "utf8"),
        "The otter chose this dock.\n",
      );
      await access(second);
    });
  }

  test("clean skips dirty, locked, current and unpublished worktrees; explicit stash-and-archive keeps dirty work recoverable", async () => {
    const remote = path.join(directory!, "harbor.git");
    await mkdir(remote);
    git(remote, "init", "--bare");
    git(repo, "remote", "add", "origin", remote);
    git(repo, "push", "-u", "origin", "main");
    const trees = Object.fromEntries(
      ["served", "dirty", "locked", "current", "unpublished"].map((branch) => {
        const cwd = `${repo}-${branch}`;
        git(repo, "worktree", "add", "-b", branch, cwd);
        if (branch !== "unpublished") git(cwd, "push", "-u", "origin", branch);
        return [branch, cwd];
      }),
    );
    git(repo, "worktree", "lock", "--reason", "Otter asleep inside", trees.locked);
    const dirty = "  Unserved seaweed latte 🦦\n";
    await writeFile(path.join(trees.dirty, "menu.txt"), dirty);
    await writeFile(path.join(trees.dirty, "receipt.txt"), "Refund the clam.\n");
    const originalIndex = await readFile(
      git(trees.dirty, "rev-parse", "--path-format=absolute", "--git-path", "index").trim(),
    );
    history = conversation(trees.current, path.join(directory!, "session vault"));
    ui = await openWorktree(directory!, history, failures, {
      select: async (title, options) => {
        if (/pushed worktree/.test(title)) return choose(options, /^Archive clean only/);
        assert.match(title, /uncommitted changes/);
        return choose(options, /^Stash changes/);
      },
    });

    await ui.prompt("/worktree clean");

    await assert.rejects(access(trees.served), { code: "ENOENT" });
    assert.ok(!git(repo, "branch", "--list", "served").trim());
    for (const branch of ["dirty", "locked", "current", "unpublished"]) {
      await access(trees[branch]);
      assert.ok(git(repo, "branch", "--list", branch).trim(), `${branch} branch survives cleaning`);
    }
    await access(repo);
    assert.equal(await readFile(path.join(trees.dirty, "menu.txt"), "utf8"), dirty);
    assert.deepEqual(
      await readFile(
        git(trees.dirty, "rev-parse", "--path-format=absolute", "--git-path", "index").trim(),
      ),
      originalIndex,
    );
    assert.equal(ui.cwd, trees.current);

    await ui.prompt("/worktree archive dirty");

    await assert.rejects(access(trees.dirty), { code: "ENOENT" });
    assert.ok(!git(repo, "branch", "--list", "dirty").trim());
    git(repo, "stash", "apply", "stash@{0}");
    assert.equal(await readFile(path.join(repo, "menu.txt"), "utf8"), dirty);
    assert.equal(await readFile(path.join(repo, "receipt.txt"), "utf8"), "Refund the clam.\n");
    await access(trees.locked);
    await access(trees.unpublished);
    await access(trees.current);
  });
});

/** Real command dispatch and session replacement; only user decisions/output and model generation are bounded. Not CLI/PTY E2E. */
async function openWorktree(
  directory: string,
  history: SessionManager,
  failures: unknown[],
  interaction: Partial<ExtensionUIContext> = {},
) {
  const controls = { cancelSwitch: false };
  const notices: { message: string; type?: string }[] = [];
  const statuses = new Map<string, string>();
  const runtime = await createAgentSessionRuntime(
    async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
      const resources = await createPiResources(cwd, agentDir, [
        worktree,
        (pi) => {
          pi.on("session_before_switch", () =>
            controls.cancelSwitch ? { cancel: true } : undefined,
          );
          pi.registerProvider(fixtureModel.provider, {
            api: fixtureModel.api,
            baseUrl: fixtureModel.baseUrl,
            apiKey: "fixture-only",
            models: [fixtureModel],
            streamSimple: () => {
              const error = new Error("Unexpected model request in worktree command");
              failures.push(error);
              throw error;
            },
          });
        },
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
  const dispose = async () => {
    try {
      await runtime.session.abort();
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
            setStatus: (key, value) => {
              if (value === undefined) statuses.delete(key);
              else statuses.set(key, value);
            },
            notify: (message, type) => {
              notices.push({ message, type });
            },
            ...interaction,
          },
          failures,
        ),
        commandContextActions: {
          waitForIdle: () => session.waitForIdle(),
          newSession: (options) => runtime.newSession(options),
          switchSession: (file, options) => runtime.switchSession(file, options),
          fork: (id, options) => runtime.fork(id, options),
          navigateTree: (id, options) => session.navigateTree(id, options),
          reload: () => session.reload(),
        },
        onError: (error) => failures.push(error),
      });
    };
    runtime.setRebindSession(bind);
    await bind();
    return {
      get cancelSwitch() {
        return controls.cancelSwitch;
      },
      set cancelSwitch(value: boolean) {
        controls.cancelSwitch = value;
      },
      get session() {
        return runtime.session;
      },
      get cwd() {
        return runtime.cwd;
      },
      async prompt(text: string) {
        await runtime.session.prompt(text, { source: "interactive" });
        assert.deepEqual(
          notices.filter((notice) => notice.type === "error"),
          [],
          "command errors must be visible failures",
        );
        assert.equal(statuses.size, 0, "completed commands release their status");
      },
      render(entry: CustomEntry) {
        const runner = runtime.session.extensionRunner;
        const renderer = runner.getEntryRenderer(entry.customType);
        assert.ok(renderer);
        const component = renderer(entry, { expanded: false }, runner.getUIContext().theme);
        assert.ok(component);
        return component.render(2000).map(stripVTControlCharacters).join("\n");
      },
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

function conversation(cwd: string, sessionDir?: string) {
  const history = SessionManager.create(cwd, sessionDir);
  history.appendModelChange(fixtureModel.provider, fixtureModel.id);
  history.appendThinkingLevelChange("off");
  history.appendSessionInfo("Keep the café afloat");
  history.appendCustomEntry("otter-plan", { text: "  Keep the original dock.\n" });
  history.appendMessage({ role: "user", content: "Where should we serve espresso?", timestamp: 0 });
  history.appendMessage(assistantMessage("On dry land, preferably."));
  return history;
}

const spawn = childProcess.spawn;
const spawnSync = childProcess.spawnSync;

/** Restrict Git to fixture-local file transport. Fresh repositories cannot inherit hooks or personal configuration. */
function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    env: { ...process.env, GIT_ALLOW_PROTOCOL: "file" },
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout;
}

/** Keep Git real, reject other process/network work, and replace native clipboard programs with a harmless stdin sink. */
function processBoundary(directory: string, failures: unknown[]) {
  const clipboard: string[] = [];
  const children = new Map<ReturnType<typeof spawn>, Promise<void>>();
  const reject = (...args: unknown[]): never => {
    const error = new Error(`Unexpected external work: ${String(args[0])}`);
    failures.push(error);
    throw error;
  };
  mock.method(globalThis, "fetch", reject);
  for (const method of ["exec", "execSync", "execFile", "execFileSync", "fork"] as const)
    mock.method(childProcess, method, reject);
  mock.method(childProcess, "spawn", (...args: Parameters<typeof spawn>) => {
    if (
      args[0] !== "git" ||
      !Array.isArray(args[1]) ||
      typeof args[2]?.cwd !== "string" ||
      !args[2].cwd.startsWith(directory + path.sep)
    )
      return reject(args[0]);
    const child = spawn("git", ["-c", "core.hooksPath=/dev/null", ...args[1]], {
      ...args[2],
      env: { ...process.env, ...args[2]?.env, GIT_ALLOW_PROTOCOL: "file" },
    });
    const done = new Promise<void>((resolve) =>
      child.once("close", () => {
        children.delete(child);
        resolve();
      }),
    );
    children.set(child, done);
    child.once("error", (error) => failures.push(error));
    return child;
  });
  mock.method(childProcess, "spawnSync", (...args: Parameters<typeof spawnSync>) => {
    const programs = process.platform === "darwin" ? ["pbcopy"] : ["wl-copy", "xclip", "xsel"];
    if (!programs.includes(args[0]) || typeof args[2]?.input !== "string") return reject(args[0]);
    clipboard.push(args[2].input);
    return spawnSync(process.execPath, ["-e", "process.stdin.resume()"], args[2]);
  });
  syncBuiltinESMExports();
  return {
    clipboard,
    async dispose() {
      const pending = [...children.values()];
      for (const child of children.keys()) child.kill("SIGKILL");
      await Promise.all(pending);
    },
  };
}

function choose(options: string[], pattern: RegExp) {
  const matches = options.filter((option) => pattern.test(option));
  assert.equal(matches.length, 1, "the requested user decision is available and unambiguous");
  return matches[0];
}

function commandEntry(history: SessionManager, customType: string) {
  const entries = history
    .getEntries()
    .filter((entry) => entry.type === "custom" && entry.customType === customType);
  assert.equal(entries.length, 1);
  const entry = entries[0] as CustomEntry<{ command: string; copiedToClipboard: boolean }>;
  assert.equal(typeof entry.data?.command, "string");
  return entry;
}

/** Parse advertised shell commands with real Bash but replace pi/git with builtin recorders; no external PATH or launches. */
function interpretCommand(command: string, cwd: string) {
  const result = spawnSync(
    "/bin/bash",
    [
      "--noprofile",
      "--norc",
      "-c",
      `pi() { printf '%s\\0' "$PWD" pi "$@"; }; git() { printf '%s\\0' "$PWD" git "$@"; }; ${command}`,
    ],
    { cwd, env: { HOME: process.env.HOME, PATH: "" }, encoding: "utf8", timeout: 5000 },
  );
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const words = result.stdout.split("\0");
  assert.equal(words.pop(), "");
  return { cwd: words[0], program: words[1], args: words.slice(2) };
}

/** Supply dimensions and inert shutdown for real layout; screen.stop owns pending render cancellation. No physical terminal starts. */
function terminalBoundary() {
  return new Proxy({ columns: 1000, rows: 30, showCursor() {}, stop() {} } as Terminal, {
    get(target, key) {
      if (key in target) return Reflect.get(target, key);
      throw new Error(`Unexpected terminal operation: ${String(key)}`);
    },
  });
}
