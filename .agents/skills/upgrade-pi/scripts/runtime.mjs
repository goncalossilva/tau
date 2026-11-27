#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [mode, ...args] = process.argv.slice(2);
const options = {};
for (let index = 0; index < args.length; index += 2) {
  const key = args[index];
  const value = args[index + 1];
  if (!["--target-root", "--package-dir"].includes(key) || !value || value.startsWith("--")) {
    throw new Error(`Invalid runtime probe argument: ${key}`);
  }
  if (options[key]) throw new Error(`Duplicate runtime probe argument: ${key}`);
  options[key] = path.resolve(value);
}
if (
  !["help", "resources", "smoke"].includes(mode) ||
  !options["--target-root"] ||
  (mode !== "help" && !options["--package-dir"])
) {
  throw new Error(
    "Usage: runtime.mjs <help|resources|smoke> --target-root <installed dependency root> [--package-dir <package>]",
  );
}

const targetRoot = options["--target-root"];
const packageDir = options["--package-dir"];
const piRoot = path.join(targetRoot, "node_modules", "@earendil-works", "pi-coding-agent");
const manifest = JSON.parse(await readFile(path.join(piRoot, "package.json"), "utf8"));
const directory = await mkdtemp(path.join(tmpdir(), "tau-pi-runtime-"));
try {
  const home = path.join(directory, "home");
  const cwd = path.join(directory, "project");
  const agentDir = path.join(home, ".pi", "agent");
  // Only executable lookup is inherited. Set every runtime path before starting Node or importing Pi.
  const env = {
    PATH: [path.dirname(process.execPath), process.env.PATH].filter(Boolean).join(path.delimiter),
    HOME: home,
    USERPROFILE: home,
    TMPDIR: path.join(directory, "tmp"),
    TMP: path.join(directory, "tmp"),
    TEMP: path.join(directory, "tmp"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
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
  await Promise.all(
    [
      cwd,
      agentDir,
      env.TMPDIR,
      env.XDG_CONFIG_HOME,
      env.XDG_CACHE_HOME,
      env.XDG_DATA_HOME,
      env.XDG_STATE_HOME,
    ].map((dir) => mkdir(dir, { recursive: true })),
  );
  if (mode !== "help") {
    await writeFile(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ packages: [packageDir] }),
    );
  }

  let probeArgs;
  if (mode === "resources") {
    const worker = fileURLToPath(new URL("./validate-resources.mjs", import.meta.url));
    probeArgs = [worker, targetRoot, packageDir];
  } else {
    const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.pi;
    if (typeof bin !== "string" || !bin.trim())
      throw new Error("Target Pi does not declare bin.pi");
    const cli = path.resolve(piRoot, bin);
    const relative = path.relative(piRoot, cli);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Invalid target Pi bin.pi: ${bin}`);
    }
    probeArgs = [cli, "--no-session", "--no-approve", "--no-context-files"];
    if (mode === "help") {
      probeArgs.push(
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--help",
      );
    } else {
      // Startup diagnostics do not fail this command. It is only a CLI smoke check.
      probeArgs.push("--list-models");
    }
  }
  const child = spawn(process.execPath, probeArgs, { cwd, env, stdio: "inherit" });
  const interrupt = () => child.kill("SIGINT");
  const terminate = () => child.kill("SIGTERM");
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  try {
    process.exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? 1));
    });
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
