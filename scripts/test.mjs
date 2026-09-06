#!/usr/bin/env node
import { spawn } from "node:child_process";
import { cp, glob, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const extension = args[0] && !args[0].startsWith("-") ? args.shift() : undefined;
const testFiles = (await Array.fromAsync(glob("tests/**/*.test.ts", { cwd: rootDir })))
  .filter(
    (file) =>
      !extension ||
      file === path.join("tests", `${extension}.test.ts`) ||
      file.startsWith(path.join("tests", extension) + path.sep),
  )
  .sort();

if (testFiles.length === 0) {
  throw new Error(extension ? `No tests found for extension: ${extension}` : "No tests found");
}

await mkdir(path.join(rootDir, "build"), { recursive: true });
const buildDir = await mkdtemp(path.join(rootDir, "build", "test-"));
let scratchDir;
try {
  scratchDir = await mkdtemp(path.join(os.tmpdir(), "tau-test-"));
  const env = await createTestEnvironment(scratchDir);
  const configPath = path.join(buildDir, "tsconfig.json");
  await writeFile(
    configPath,
    JSON.stringify({
      extends: path.join(rootDir, "tsconfig.json"),
      compilerOptions: {
        noEmit: false,
        noEmitOnError: true,
        allowJs: true,
        checkJs: false,
        sourceMap: true,
        rootDir,
        outDir: buildDir,
      },
      files: testFiles.map((file) => path.join(rootDir, file)),
      include: [path.join(rootDir, "extensions", "**", "*")],
    }),
  );

  process.exitCode = await runNode(
    [path.join(rootDir, "node_modules", "typescript", "bin", "tsc"), "-p", configPath],
    rootDir,
    env,
  );
  if (process.exitCode === 0) {
    for (const directory of ["extensions", "tests"]) {
      await cp(path.join(rootDir, directory), path.join(buildDir, directory), {
        recursive: true,
        filter: (source) => !/\.[cm]?[jt]s$/.test(source),
      });
    }
    process.exitCode = await runNode(
      [
        "--enable-source-maps",
        "--test",
        "--test-timeout=30000",
        ...args,
        ...testFiles.map((file) => path.join(buildDir, file.replace(/\.ts$/, ".js"))),
      ],
      scratchDir,
      env,
    );
  }
} finally {
  await rm(buildDir, { recursive: true, force: true });
  if (scratchDir) await rm(scratchDir, { recursive: true, force: true });
}

async function createTestEnvironment(directory) {
  const home = path.join(directory, "home");
  const agentDir = path.join(home, ".pi", "agent");
  const tempDir = path.join(directory, "tmp");
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) =>
        /^(PATH|SystemRoot|WINDIR|ComSpec|PATHEXT)$/i.test(key),
      ),
    ),
    HOME: home,
    USERPROFILE: home,
    TMPDIR: tempDir,
    TMP: tempDir,
    TEMP: tempDir,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig"),
    GIT_TERMINAL_PROMPT: "0",
    TZ: "UTC",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    NO_COLOR: "1",
  };
  for (const dir of [
    agentDir,
    tempDir,
    env.XDG_CONFIG_HOME,
    env.XDG_CACHE_HOME,
    env.XDG_DATA_HOME,
  ]) {
    await mkdir(dir, { recursive: true });
  }
  return env;
}

async function runNode(args, cwd, env) {
  const child = spawn(process.execPath, args, { cwd, env, stdio: "inherit" });
  const interrupt = () => child.kill("SIGINT");
  const terminate = () => child.kill("SIGTERM");
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  try {
    return await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve(code ?? (signal === "SIGINT" ? 130 : 1)));
    });
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  }
}
