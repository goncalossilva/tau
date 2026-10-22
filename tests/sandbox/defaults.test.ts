import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isolatePiHome } from "../helpers/pi.js";

describe("sandbox platform defaults", { concurrency: false }, () => {
  const originalCwd = process.cwd();
  let home: Awaited<ReturnType<typeof isolatePiHome>>;
  let config: typeof import("../../extensions/sandbox/config.js");
  let directory: string;
  let launcherCwd: string;
  let cwd: string;
  let configPath: string;

  before(async () => {
    home = await isolatePiHome();
    config = await import("../../extensions/sandbox/config.js");
    configPath = path.join(getAgentDir(), "sandbox.json");
  });

  after(async () => home.dispose());

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "tau-sandbox-defaults-"));
    launcherCwd = path.join(directory, "shell dock");
    cwd = path.join(directory, "octopus session");
    await mkdir(launcherCwd);
    await mkdir(cwd);
    process.chdir(launcherCwd);
    await mkdir(getAgentDir(), { recursive: true });
  });

  afterEach(async () => {
    try {
      await SandboxManager.reset();
    } finally {
      process.chdir(originalCwd);
      await rm(configPath, { force: true });
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("native watching is a macOS default, while explicit service restrictions still replace defaults", async () => {
    const defaults = config.loadConfig(cwd).config;
    const runtime = config.toRuntimeConfig(defaults, cwd);
    assert.ok(runtime.filesystem.allowWrite.includes(cwd));
    assert.ok(!runtime.filesystem.allowWrite.includes(launcherCwd));
    assert.ok(runtime.filesystem.denyWrite.includes(path.join(cwd, ".env")));
    assert.ok(runtime.filesystem.denyWrite.includes(path.join(cwd, ".env.*")));
    assert.equal(
      defaults.network.allowMachLookup?.includes("com.apple.FSEvents"),
      process.platform === "darwin",
    );
    const override = { network: { allowMachLookup: [] } };
    await writeFile(configPath, JSON.stringify(override));
    const restricted = config.loadConfig(cwd).config;
    assert.deepEqual(restricted, {
      ...defaults,
      network: { ...defaults.network, allowMachLookup: [] },
    });
  });

  test("Apple Events requires user-selected configuration, never automatic project configuration", async (t) => {
    const warnings = t.mock.method(console, "error", () => {});
    const policy = (override?: string) =>
      config.toRuntimeConfig(
        config.loadConfig(cwd, override, { projectTrusted: true }).config,
        cwd,
      );
    assert.equal(policy().allowAppleEvents, false);

    const projectPath = path.join(cwd, ".pi", "sandbox.json");
    await mkdir(path.dirname(projectPath));
    await writeFile(projectPath, '{"allowAppleEvents":true}\n');
    assert.equal(policy().allowAppleEvents, false, "project trust cannot enable app launching");
    assert.equal(policy(projectPath).allowAppleEvents, true, "explicit selection trusts the file");

    await writeFile(configPath, '{"allowAppleEvents":true}\n');
    await writeFile(projectPath, '{"allowAppleEvents":false}\n');
    assert.equal(policy().allowAppleEvents, true, "project values do not override user policy");
    assert.ok(
      warnings.mock.calls.some((call) =>
        String(call.arguments[0]).includes("Ignoring allowAppleEvents in project sandbox.json"),
      ),
    );

    await writeFile(configPath, '{"allowAppleEvents":null}\n');
    assert.throws(
      () => policy(),
      /allowAppleEvents/,
      "project values cannot mask invalid user policy",
    );
    assert.equal(policy(projectPath).allowAppleEvents, false);
    await writeFile(projectPath, '{"allowAppleEvents":"false"}\n');
    assert.throws(() => policy(projectPath), /allowAppleEvents/, "invalid booleans fail closed");
  });

  test("classifier configuration is validated but never passed into OS policy", async () => {
    for (const [value, expected] of [
      ["openai-codex/guardian", "openai-codex/guardian"],
      ["openrouter/vendor/model", "openrouter/vendor/model"],
      [false, false],
      [true, false],
      ["missing-provider", false],
      ["provider/unsafe\u001bmodel", false],
    ] as const) {
      await writeFile(configPath, JSON.stringify({ classifier: value }));
      const loaded = config.loadConfig(cwd).config;
      assert.equal(loaded.classifier, expected);
      assert.equal("classifier" in config.toRuntimeConfig(loaded, cwd), false);
    }
  });

  test("native per-execution filesystem exceptions do not change the next launch's policy", async () => {
    const secret = path.join(cwd, "sealed recipe.txt");
    const output = path.join(cwd, "approved recipe.txt");
    const emptyDenied = path.join(cwd, "sealed empty recipe.env");
    await writeFile(secret, "eight pinches\n");
    await writeFile(output, "not approved\n");
    await writeFile(emptyDenied, "");
    await chmod(emptyDenied, 0o444);
    const originalEmpty = await fileSnapshot(emptyDenied);
    assert.equal(originalEmpty.mode, 0o444);
    assert.equal(originalEmpty.links, 1);
    await writeFile(
      configPath,
      JSON.stringify({
        network: { allowedDomains: [], allowUnixSockets: [] },
        filesystem: {
          denyRead: [secret],
          allowRead: [],
          allowWrite: [cwd],
          denyWrite: [output, emptyDenied],
          allowTempDirs: false,
        },
      }),
    );
    const policy = config.toRuntimeConfig(config.loadConfig(cwd).config, cwd);
    await SandboxManager.initialize(policy, undefined, false);
    const temporary = structuredClone(policy);
    temporary.filesystem.allowRead = [secret];
    temporary.filesystem.denyWrite = [emptyDenied];
    const script = `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(output)}, fs.readFileSync(${JSON.stringify(secret)}));`;
    const command = [process.execPath, "-e", script].map(shellQuote).join(" ");
    const denied = await runFilesystemCommand(command, cwd);
    assert.notEqual(denied.code, 0, denied.stderr);
    assert.equal(await readFile(output, "utf8"), "not approved\n");
    assert.deepEqual(await fileSnapshot(emptyDenied), originalEmpty);
    const approved = await runFilesystemCommand(command, cwd, temporary);
    assert.equal(approved.code, 0, approved.stderr);
    assert.equal(await readFile(output, "utf8"), "eight pinches\n");
    assert.deepEqual(await fileSnapshot(emptyDenied), originalEmpty);
    assert.deepEqual(SandboxManager.getConfig(), policy);
    await writeFile(output, "sealed again\n");
    const deniedAgain = await runFilesystemCommand(command, cwd);
    assert.notEqual(deniedAgain.code, 0, deniedAgain.stderr);
    assert.equal(await readFile(output, "utf8"), "sealed again\n");
    assert.deepEqual(await fileSnapshot(emptyDenied), originalEmpty);
    assert.deepEqual(SandboxManager.getConfig(), policy);
  });

  // Native Seatbelt behavior, not the scripted OS boundary in sandbox.test.ts.
  if (process.platform === "darwin") {
    for (const restricted of [false, true]) {
      test(`recursive watching ${restricted ? "respects an explicit service restriction" : "receives nested file changes"} with isolated per-call Mach overrides and protected files`, async () => {
        const settings = {
          network: {
            allowedDomains: [],
            allowUnixSockets: [],
            ...(restricted ? { allowMachLookup: [] } : {}),
          },
          filesystem: { allowWrite: ["."], allowTempDirs: false, allowGitCommonDir: false },
        };
        await writeFile(configPath, JSON.stringify(settings));
        const runtime = config.toRuntimeConfig(config.loadConfig(cwd).config, cwd);
        const watchDirectory = path.join(cwd, "octopus nursery");
        const changedFile = path.join(watchDirectory, "nest", "egg.txt");
        const keyFile = path.join(os.homedir(), ".ssh", "nursery-key");
        const protectedFile = path.join(cwd, ".env");
        const protectedGlobFile = path.join(cwd, ".env.tide");
        const launcherFile = path.join(launcherCwd, "dock log.txt");
        await mkdir(path.dirname(changedFile), { recursive: true });
        await mkdir(path.dirname(keyFile), { recursive: true });
        await writeFile(keyFile, "synthetic secret\n");
        await writeFile(protectedFile, "INK=indigo\n");
        await writeFile(protectedGlobFile, "TIDE=hidden\n");
        await writeFile(launcherFile, "The launcher stays ashore.\n");
        try {
          // No OS log monitor or external requests; the child exercises actual enforcement.
          await SandboxManager.initialize(runtime, undefined, false);
          const replacement = structuredClone(runtime);
          replacement.network.allowMachLookup = restricted
            ? ["com.apple.FSEvents"]
            : ["com.apple.SecurityServer"];
          const denied = structuredClone(runtime);
          denied.network.allowMachLookup = [];
          for (const launch of [
            { name: "session policy", policy: undefined, restricted },
            { name: "replacement list", policy: replacement, restricted: !restricted },
            { name: "explicit empty list", policy: denied, restricted: true },
            { name: "subsequent session policy", policy: undefined, restricted },
          ]) {
            const result = await runWatcher(
              launch.name,
              cwd,
              watchDirectory,
              changedFile,
              keyFile,
              launcherFile,
              launch.policy,
            );
            assert.equal(
              result.code,
              launch.restricted ? 1 : 0,
              `${launch.name}: ${result.stderr}`,
            );
            assert.ok(result.stdout.includes("BOUND\n"), result.stdout);
            assert.ok(result.stdout.includes("PROTECTED\n"), result.stdout);
            if (launch.restricted) {
              assert.ok(result.stdout.includes("WATCH_FAILED\n"), result.stdout);
              assert.ok(!result.stdout.includes("OBSERVED\n"), result.stdout);
            } else {
              assert.ok(result.stdout.includes("OBSERVED\n"), result.stdout);
            }
            assert.deepEqual(SandboxManager.getConfig(), runtime);
            assert.equal(await readFile(path.join(cwd, "nursery log.txt"), "utf8"), "eight eggs\n");
            assert.equal(await readFile(launcherFile, "utf8"), "The launcher stays ashore.\n");
            assert.equal(await readFile(protectedFile, "utf8"), "INK=indigo\n");
            assert.equal(await readFile(protectedGlobFile, "utf8"), "TIDE=hidden\n");
          }
        } finally {
          await rm(keyFile, { force: true });
        }
      });
    }
  }
});

async function fileSnapshot(file: string) {
  const stat = await lstat(file);
  return {
    bytes: await readFile(file),
    mode: stat.mode & 0o777,
    device: stat.dev,
    inode: stat.ino,
    links: stat.nlink,
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Exercise real per-launch OS policies, with a deadline only for fixture cleanup. */
async function runFilesystemCommand(
  command: string,
  cwd: string,
  policy?: Parameters<typeof SandboxManager.wrapWithSandboxArgv>[2],
): Promise<{ code: number | null; stderr: string }> {
  const wrapped = await SandboxManager.wrapWithSandboxArgv(
    command,
    "/bin/bash",
    policy,
    undefined,
    cwd,
  );
  const child = spawn(wrapped.argv[0]!, wrapped.argv.slice(1), {
    cwd,
    env: { ...process.env, ...wrapped.env },
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  let error: Error | undefined;
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  child.once("error", (cause) => {
    error = cause;
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause;
      }
    }
  }, 10_000);
  try {
    const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
    if (error) throw error;
    assert.equal(timedOut, false, `native filesystem fixture timed out: ${stderr}`);
    return { code, stderr };
  } finally {
    clearTimeout(timer);
    SandboxManager.cleanupAfterCommand();
  }
}

/** Run a real sandboxed Node watcher; change the nested file only after readiness and join exit. */
async function runWatcher(
  launchName: string,
  cwd: string,
  directory: string,
  changedFile: string,
  keyFile: string,
  launcherFile: string,
  policy?: Parameters<typeof SandboxManager.wrapWithSandboxArgv>[2],
) {
  const fixture = fileURLToPath(new URL("./fixtures/watch.mjs", import.meta.url));
  const command = [process.execPath, fixture, directory, keyFile, launcherFile]
    .map((value) => `'${value.replaceAll("'", "'\\''")}'`)
    .join(" ");
  const wrapped = await SandboxManager.wrapWithSandboxArgv(
    command,
    "/bin/bash",
    policy,
    undefined,
    cwd,
  );
  const child = spawn(wrapped.argv[0]!, wrapped.argv.slice(1), {
    cwd,
    env: { ...process.env, CFFIXED_USER_HOME: os.homedir(), ...wrapped.env },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let onReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    onReady = resolve;
  });
  let stdout = "";
  let stderr = "";
  let error: Error | undefined;
  let closed = false;
  let timedOut = false;
  child.stdout.on("data", (data) => {
    stdout += data;
    if (stdout.includes("READY\n")) onReady();
  });
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  child.once("error", (cause) => {
    error = cause;
  });
  const completion = new Promise<number | null>((resolve) => {
    child.once("close", (code) => {
      closed = true;
      resolve(code);
    });
  });
  const stop = () => {
    if (closed || child.pid === undefined) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause;
    }
  };
  const deadline = setTimeout(() => {
    timedOut = true;
    stop();
  }, 10_000);
  try {
    await Promise.race([ready, completion]);
    if (!closed) await writeFile(changedFile, "eight tiny otters\n");
    const code = await completion;
    if (error) throw error;
    assert.equal(
      timedOut,
      false,
      `${launchName}: native watcher did not finish: ${JSON.stringify({ stdout, stderr })}`,
    );
    return { code, stdout, stderr };
  } finally {
    clearTimeout(deadline);
    stop();
    await completion;
    SandboxManager.cleanupAfterCommand();
  }
}
