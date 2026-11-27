import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { findPackageJSON } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

const resourceRoot = path.dirname(findPackageJSON(import.meta.url)!);

// Real target Pi, npm tarballs, and public runtime probes. No registry or model requests are needed.
describe("upgrade-pi runtime validation", () => {
  let directory: string;
  let targetRoot: string;
  let sourceDir: string;
  let runtime: string;
  let ambient: NodeJS.ProcessEnv;
  let theme: Record<string, unknown>;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "tau-upgrade-pi-"));
    targetRoot = path.join(directory, "target");
    sourceDir = path.join(directory, "source", "packages", "octopus-agent");
    const scripts = path.join(directory, "scripts");
    const home = path.join(directory, "ambient-home");
    const agentDir = path.join(directory, "ambient-agent");
    await Promise.all(
      [targetRoot, sourceDir, scripts, home, agentDir].map((dir) =>
        mkdir(dir, { recursive: true }),
      ),
    );
    await writeJson(path.join(targetRoot, "package.json"), { private: true });
    await symlink(path.join(resourceRoot, "node_modules"), path.join(targetRoot, "node_modules"));
    for (const name of ["runtime.mjs", "validate-resources.mjs"]) {
      await cp(
        path.join(resourceRoot, ".agents", "skills", "upgrade-pi", "scripts", name),
        path.join(scripts, name),
      );
    }
    runtime = path.join(scripts, "runtime.mjs");
    await writeJson(path.join(sourceDir, "package.json"), {
      name: "octopus-agent",
      version: "1.0.0",
      type: "module",
      pi: {
        extensions: ["./inspect.mjs"],
        skills: ["./skill"],
        prompts: ["./prompt.md"],
        themes: ["./theme.json"],
      },
    });
    await cp(
      new URL("./upgrade-pi/inspect.mjs", import.meta.url),
      path.join(sourceDir, "inspect.mjs"),
    );
    await mkdir(path.join(sourceDir, "skill"));
    await writeFile(
      path.join(sourceDir, "skill", "SKILL.md"),
      "---\nname: eight-slippers\ndescription: Fit the octopus for a walk.\n---\nCount eight slippers.\n",
    );
    await writeFile(
      path.join(sourceDir, "prompt.md"),
      "---\ndescription: Take a walk.\n---\nPut on eight slippers.\n",
    );
    const schema = JSON.parse(
      await readFile(
        path.join(
          targetRoot,
          "node_modules",
          "@earendil-works",
          "pi-coding-agent",
          "schemas",
          "theme.schema.json",
        ),
        "utf8",
      ),
    );
    theme = {
      name: "octopus",
      colors: Object.fromEntries(
        schema.properties.colors.required.map((key: string) => [key, "#aabbcc"]),
      ),
    };
    await writeFile(path.join(sourceDir, "theme.json"), "\uFEFF" + JSON.stringify(theme));

    const poison = path.join(directory, "poison.mjs");
    await writeFile(
      poison,
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(path.join(directory, "poison-loaded"))}, "bad"); export default pi => pi.registerFlag("ambient-poison", { description: "Must not load", type: "boolean" });`,
    );
    for (const config of [agentDir, path.join(home, ".pi", "agent"), path.join(directory, ".pi")]) {
      await mkdir(config, { recursive: true });
      await writeJson(path.join(config, "settings.json"), {
        extensions: [poison],
        enabledModels: ["ambient-poison"],
      });
    }
    ambient = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      PI_CODING_AGENT_DIR: agentDir,
      XDG_CONFIG_HOME: home,
      XDG_CACHE_HOME: home,
      XDG_DATA_HOME: home,
      XDG_STATE_HOME: home,
      PI_OFFLINE: "0",
      PI_TELEMETRY: "1",
      ANTHROPIC_API_KEY: "not-a-real-key",
      AWS_PROFILE: "poison",
      GOOGLE_APPLICATION_CREDENTIALS: poison,
      UPGRADE_POISON: "must-not-leak",
    };
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  test("isolates target help and validates source and independently installed tarball resources", async () => {
    const help = await probe("help");
    assert.equal(help.code, 0, help.output);
    assert.match(help.output, /--list-models/);
    assert.doesNotMatch(help.output, /ambient-poison|octopus-isolated/);
    const packed = await command(
      "npm",
      ["pack", "--silent", "--offline", "--pack-destination", directory],
      sourceDir,
    );
    assert.equal(packed.code, 0, packed.output);
    const archive = path.join(directory, packed.output.trim().split(/\r?\n/).at(-1)!);
    const installDir = path.join(directory, "installed");
    await mkdir(installDir);
    await writeJson(path.join(installDir, "package.json"), { private: true });
    const installed = await command(
      "npm",
      [
        "install",
        "--offline",
        "--ignore-scripts",
        "--package-lock=false",
        "--no-audit",
        "--no-fund",
        archive,
      ],
      installDir,
    );
    assert.equal(installed.code, 0, installed.output);

    const homes = new Set<string>();
    for (const packageDir of [sourceDir, path.join(installDir, "node_modules", "octopus-agent")]) {
      assert.equal(
        await readFile(path.join(packageDir, "theme.json"), "utf8"),
        "\uFEFF" + JSON.stringify(theme),
      );
      const resources = await probe("resources", packageDir);
      assert.equal(resources.code, 0, resources.output);
      assert.match(
        resources.output,
        /extensions 1\/1, skills 1\/1, prompts 1\/1, themes 1\/1, diagnostics 0/,
      );
      assert.match(
        resources.output,
        /passes target theme schema; unsupported-property negative control rejected/,
      );
      assert.ok(
        resources.output.includes(
          path.join(
            targetRoot,
            "node_modules",
            "@earendil-works",
            "pi-coding-agent",
            "schemas",
            "theme.schema.json",
          ),
        ),
      );
      const smoke = await probe("smoke", packageDir);
      assert.equal(smoke.code, 0, smoke.output);
      const observations = (await readFile(path.join(packageDir, "observations.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(
        observations.length,
        2,
        "SDK and CLI each import the fixture in a fresh runtime",
      );
      for (const { home } of observations) {
        assert.notEqual(home, ambient.HOME);
        assert.ok(!homes.has(home), "each probe owns a fresh home");
        homes.add(home);
      }
    }
    await assert.rejects(readFile(path.join(directory, "poison-loaded")), { code: "ENOENT" });
  });

  for (const failure of [
    "unsupported theme property",
    "extension error",
    "skill warning",
  ] as const) {
    test(`rejects ${failure} even when CLI smoke exits successfully`, async () => {
      if (failure === "unsupported theme property") {
        await writeJson(path.join(sourceDir, "theme.json"), {
          ...theme,
          unsupportedMetadata: true,
        });
      } else if (failure === "extension error") {
        await writeFile(
          path.join(sourceDir, "inspect.mjs"),
          'throw new Error("The octopus lost a slipper");\n',
        );
      } else {
        const skillPath = path.join(sourceDir, "skill", "SKILL.md");
        await writeFile(
          skillPath,
          (await readFile(skillPath, "utf8")).replace("eight-slippers", "Eight-slippers"),
        );
      }
      const smoke = await probe("smoke", sourceDir);
      assert.equal(smoke.code, 0, smoke.output);
      const resources = await probe("resources", sourceDir);
      assert.equal(resources.code, 1, resources.output);
      if (failure === "unsupported theme property") {
        assert.match(resources.output, /fails target theme schema/);
        assert.match(resources.output, /unsupportedMetadata/);
      } else if (failure === "extension error") {
        assert.match(smoke.output, /The octopus lost a slipper/);
        assert.match(
          resources.output,
          /extensions 0\/1, skills 1\/1, prompts 1\/1, themes 1\/1, diagnostics 1/,
        );
        assert.match(resources.output, /The octopus lost a slipper/);
      } else {
        assert.match(
          resources.output,
          /extensions 1\/1, skills 1\/1, prompts 1\/1, themes 1\/1, diagnostics 1/,
        );
        assert.match(resources.output, /warning: name contains invalid characters/);
      }
    });
  }

  function probe(mode: string, packageDir?: string) {
    return command(
      process.execPath,
      [
        runtime,
        mode,
        "--target-root",
        targetRoot,
        ...(packageDir ? ["--package-dir", packageDir] : []),
      ],
      directory,
      ambient,
    );
  }
});

async function writeJson(file: string, value: unknown) {
  await writeFile(file, JSON.stringify(value));
}

/** Run only local npm work or the shipped probe CLI. The fixture deliberately supplies poisoned ambient config. */
async function command(executable: string, args: string[], cwd: string, env = process.env) {
  const child = spawn(executable, args, {
    cwd,
    env: { ...env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${env.PATH}` },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15000,
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { code, output };
}
