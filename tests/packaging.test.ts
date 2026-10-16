import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { findPackageJSON } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, before, beforeEach, describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const assetsDirectory = fileURLToPath(new URL("../", import.meta.url));
const workspaceManifest = findPackageJSON(import.meta.url)!;
const runtimeName = "@anthropic-ai/sandbox-runtime";
const runtimeVersion = "0.0.79";
const packageNames = ["tau-coding-agent", "tau-all-agent"];
const managerPath = "dist/sandbox/sandbox-manager.js";
const linuxUtilsPath = "dist/sandbox/linux-sandbox-utils.js";
const patchedPaths = [
  managerPath,
  "dist/sandbox/sandbox-manager.d.ts",
  "dist/sandbox/sandbox-config.d.ts",
  "dist/index.d.ts",
  linuxUtilsPath,
  "dist/sandbox/linux-sandbox-utils.d.ts",
  "README.md",
];
const runtimeAssets = [
  "LICENSE",
  "vendor/java-proxy-agent/srt-proxy-agent.jar",
  "vendor/seccomp/arm64/apply-seccomp",
  "vendor/seccomp/x64/apply-seccomp",
];
const releasedLine = "                allowMachLookup: getAllowMachLookup(),";

describe("packaged sandbox runtime", { concurrency: false }, () => {
  let installed: Map<string, string>;
  let npmCli: string;
  let compiler: string;
  let typeRoots: string;
  let nativeTools: string[];
  let directory: string;
  let fixture: string;
  let environment: NodeJS.ProcessEnv;
  let patches: string[];
  let releasedFiles: Record<string, string>;
  let expectedFiles: Record<string, string>;

  before(async () => {
    installed = await installedRuntimePackages();
    // Bypass version-manager shims that require the user's non-isolated home.
    npmCli = await realpath(path.join(path.dirname(process.execPath), "npm"));
    compiler = path.join(
      path.dirname(findPackageJSON("typescript", import.meta.url)!),
      "bin",
      "tsc",
    );
    typeRoots = path.dirname(path.dirname(findPackageJSON("@types/node", import.meta.url)!));
    // Resolve real tools once; the fixture bin avoids repeated searches through npm's long PATH.
    const { stdout } = await execute("which", ["which", "rg"], { timeout: 20_000 });
    nativeTools = stdout.trim().split(/\r?\n/);
    assert.equal(nativeTools.length, 2);
  });

  beforeEach(async () => {
    directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "tau-packaging-")));
    fixture = path.join(directory, "octopus shipyard");
    await mkdir(fixture);
    for (const asset of ["scripts", "patches", "packages", "LICENSE"]) {
      await cp(path.join(assetsDirectory, asset), path.join(fixture, asset), { recursive: true });
    }
    await cp(workspaceManifest, path.join(fixture, "package.json"));
    await mkdir(path.join(fixture, "extensions"));
    await writeFile(path.join(fixture, "extensions", "octopus.ts"), "export default () => {};\n");
    for (const name of packageNames) {
      const manifestPath = path.join(fixture, "packages", name, "package.json");
      const manifest = await readJson(manifestPath);
      assert.equal(manifest.dependencies[runtimeName], runtimeVersion);
      // Keep real sandbox packaging metadata. Unrelated Tau/Pi dependencies and
      // resources are outside this offline install workflow, not replaced SDKs.
      manifest.dependencies = { [runtimeName]: manifest.dependencies[runtimeName] };
      delete manifest.peerDependencies;
      manifest.pi = { extensions: ["../../extensions/octopus.ts"] };
      await writeJson(manifestPath, manifest);
    }
    for (const [name, source] of installed) {
      await cp(source, path.join(fixture, "node_modules", name), { recursive: true });
    }
    const sourceRuntime = path.join(fixture, "node_modules", runtimeName);
    const home = path.join(directory, "home");
    const bin = path.join(directory, "bin");
    await mkdir(home);
    await mkdir(bin);
    for (const tool of nativeTools) await symlink(tool, path.join(bin, path.basename(tool)));
    environment = {
      ...process.env,
      PATH: [path.dirname(process.execPath), bin, process.env.PATH].join(path.delimiter),
      HOME: home,
      USERPROFILE: home,
      npm_config_userconfig: path.join(home, "empty-npmrc"),
      npm_config_globalconfig: path.join(home, "empty-global-npmrc"),
      npm_config_cache: path.join(directory, "npm-cache"),
      npm_config_offline: "true",
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_ignore_scripts: "true",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: path.join(home, "empty-gitconfig"),
    };
    // Restore only our fixture copy, then compute the full expected patched bytes.
    patches = (await readdir(path.join(fixture, "patches")))
      .filter((file) => file.endsWith(".patch"))
      .sort()
      .map((file) => path.join(fixture, "patches", file));
    assert.ok(patches.length > 0, "fixture requires runtime patches");
    const patchArgs = ["apply", "--whitespace=nowarn", `--directory=node_modules/${runtimeName}`];
    for (const patch of patches.toReversed()) {
      await run("git", [...patchArgs, "--reverse", "--check", patch]).then(
        () => run("git", [...patchArgs, "--reverse", patch]),
        () => undefined,
      );
    }
    releasedFiles = await readPatchedFiles(sourceRuntime);
    assert.equal(releasedFiles[managerPath].split(releasedLine).length, 2);
    for (const patch of patches) {
      await run("git", [...patchArgs, "--check", patch]);
      await run("git", [...patchArgs, patch]);
    }
    expectedFiles = await readPatchedFiles(sourceRuntime);
    for (const file of patchedPaths) {
      assert.notEqual(expectedFiles[file], releasedFiles[file], `${file} must be patched`);
    }
    for (const patch of patches.toReversed()) {
      await run("git", [...patchArgs, "--reverse", patch]);
    }
    await mkdir(path.join(directory, "tarballs"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  for (const name of packageNames) {
    test(`${name} preserves sandbox overrides and dependency isolation after install and dedupe`, async () => {
      await run(process.execPath, ["scripts/package.mjs"]);
      assert.deepEqual(
        await readPatchedFiles(path.join(fixture, "node_modules", runtimeName)),
        releasedFiles,
        "packaging must not patch the development dependency",
      );
      const output = path.join(fixture, "dist", name);
      const manifest = await readJson(path.join(output, "package.json"));
      assert.equal(manifest.dependencies[runtimeName], runtimeVersion);
      assert.deepEqual(manifest.bundleDependencies, [runtimeName]);
      assert.equal(manifest.scripts?.postinstall, undefined);
      const artifact = await pack(output);
      const files = new Set<string>(artifact.files.map((file: { path: string }) => file.path));
      for (const [dependency, source] of installed) {
        const dependencyManifest = await readJson(path.join(source, "package.json"));
        for (const file of ["package.json", dependencyManifest.main.replace(/^\.\//, "")]) {
          assert.ok(
            [...files].some((entry) => entry.endsWith(`node_modules/${dependency}/${file}`)),
            `${dependency}/${file}`,
          );
        }
      }
      for (const file of patchedPaths) {
        assert.ok(files.has(`node_modules/${runtimeName}/${file}`), file);
      }
      for (const file of runtimeAssets) {
        assert.ok(files.has(`node_modules/${runtimeName}/${file}`), file);
      }

      const consumer = path.join(directory, "consumer");
      await mkdir(consumer);
      await writeJson(path.join(consumer, "package.json"), {
        name: "octopus-consumer",
        private: true,
        type: "module",
      });
      await run("npm", ["install", "--ignore-scripts", artifact.tarball], consumer);
      const importer = path.join(consumer, "node_modules", name, "extensions", "octopus.ts");
      const privateRuntime = path.join(consumer, "node_modules", name, "node_modules", runtimeName);
      assert.deepEqual(await readPatchedFiles(privateRuntime), expectedFiles);
      for (const file of runtimeAssets) {
        assert.deepEqual(
          await readFile(path.join(privateRuntime, file)),
          await readFile(path.join(fixture, "node_modules", runtimeName, file)),
          file,
        );
      }
      await probe(importer, privateRuntime, "patched", consumer);

      // Seed only real, locally packed SDK packages. A same-version original at
      // the consumer root must not replace the bundled fix, even after dedupe.
      const originalTarballs: string[] = [];
      for (const dependency of installed.keys()) {
        originalTarballs.push((await pack(path.join(fixture, "node_modules", dependency))).tarball);
      }
      await run("npm", ["install", "--ignore-scripts", ...originalTarballs], consumer);
      const consumerManifest = await readJson(path.join(consumer, "package.json"));
      // Dedupe otherwise queries registry packuments for semver transitive edges.
      // Resolve those edges to the same real local tarballs, with no fake registry.
      consumerManifest.overrides = Object.fromEntries(
        [...installed.keys()].map((dependency) => [dependency, `$${dependency}`]),
      );
      await writeJson(path.join(consumer, "package.json"), consumerManifest);
      await run("npm", ["dedupe", "--ignore-scripts"], consumer);
      const originalRuntime = path.join(consumer, "node_modules", runtimeName);
      assert.deepEqual(await readPatchedFiles(originalRuntime), releasedFiles);
      assert.deepEqual(await readPatchedFiles(privateRuntime), expectedFiles);
      await probe(path.join(consumer, "package.json"), originalRuntime, "released", consumer);
      await probe(importer, privateRuntime, "patched", consumer);
      assert.deepEqual(
        await readPatchedFiles(path.join(fixture, "node_modules", runtimeName)),
        releasedFiles,
      );
    });
  }

  test("development postinstall applies the checked patches idempotently", async () => {
    const manifest = await readJson(path.join(fixture, "package.json"));
    assert.match(manifest.scripts.postinstall, /scripts\/sandbox-runtime\.mjs/);
    await run("npm", ["run", "postinstall"]);
    const sourceRuntime = path.join(fixture, "node_modules", runtimeName);
    const patchedFiles = await readPatchedFiles(sourceRuntime);
    assert.deepEqual(patchedFiles, expectedFiles);
    await run("npm", ["run", "postinstall"]);
    assert.deepEqual(await readPatchedFiles(sourceRuntime), patchedFiles);
    await probe(
      path.join(fixture, "package.json"),
      path.join(fixture, "node_modules", runtimeName),
      "patched",
    );
    await run(process.execPath, ["scripts/package.mjs"]);
    assert.deepEqual(await readPatchedFiles(sourceRuntime), patchedFiles);
  });

  test("development patching discovers patches in filename order and ignores other files", async () => {
    const patchDirectory = path.join(fixture, "patches");
    const sourceRuntime = path.join(fixture, "node_modules", runtimeName);
    // An independent new-file patch sorts before this invalid boundary, and
    // the shipped patches sort after it. No overlapping-hunk idempotence is assumed.
    const invalidPatch = path.join(patchDirectory, "020-kraken.patch");
    await writeFile(invalidPatch, "the kraken ate the diff\n");
    await writeFile(
      path.join(patchDirectory, "010-octopus.patch"),
      "diff --git a/octopus.txt b/octopus.txt\nnew file mode 100644\n--- /dev/null\n+++ b/octopus.txt\n@@ -0,0 +1 @@\n+one small octopus\n",
    );
    await writeFile(path.join(patchDirectory, "000-not-a-patch.txt"), "not a diff\n");
    const marker = path.join(sourceRuntime, "octopus.txt");

    await assert.rejects(run("npm", ["run", "postinstall"]));
    assert.equal(await readFile(marker, "utf8"), "one small octopus\n");
    assert.deepEqual(await readPatchedFiles(sourceRuntime), releasedFiles);

    await rm(invalidPatch);
    await run("npm", ["run", "postinstall"]);
    assert.equal(await readFile(marker, "utf8"), "one small octopus\n");
    assert.deepEqual(await readPatchedFiles(sourceRuntime), expectedFiles);
  });

  test("Linux deny cleanup preserves preexisting files and removes owned absent mount points", async () => {
    const script = path.join(directory, "cleanup.mjs");
    await writeFile(script, cleanupProbe);
    const sourceRuntime = path.join(fixture, "node_modules", runtimeName);
    const releasedCwd = path.join(directory, "released-cleanup");
    const patchedCwd = path.join(directory, "patched-cleanup");
    await mkdir(releasedCwd);
    await mkdir(patchedCwd);
    // The same preservation assertion reproduces the released 0.0.79 deletion.
    await assert.rejects(
      run(process.execPath, [script, sourceRuntime], releasedCwd),
      /preexisting empty read-only deny file must survive cleanup/,
    );
    await run("npm", ["run", "postinstall"]);
    await run(process.execPath, [script, sourceRuntime], patchedCwd);
    assert.deepEqual(await readPatchedFiles(sourceRuntime), expectedFiles);
  });

  for (const fault of [
    "empty patch directory",
    "invalid patch",
    "unsupported version",
    "drifted hunk",
  ]) {
    test(`${fault} fails development patching and packaging rather than shipping unpatched code`, async () => {
      const patch = patches[0];
      const sourceManager = path.join(fixture, "node_modules", runtimeName, managerPath);
      if (fault === "empty patch directory") {
        await rm(path.join(fixture, "patches"), { recursive: true });
        await mkdir(path.join(fixture, "patches"));
      }
      if (fault === "invalid patch") await writeFile(patch, "the kraken ate the diff\n");
      if (fault === "unsupported version") {
        const runtimeManifest = path.join(fixture, "node_modules", runtimeName, "package.json");
        const manifest = await readJson(runtimeManifest);
        manifest.version = "0.0.80";
        await writeJson(runtimeManifest, manifest);
      }
      if (fault === "drifted hunk") {
        await writeFile(
          sourceManager,
          releasedFiles[managerPath].replace(releasedLine, "                allowMachLookup: [],"),
        );
      }
      await assert.rejects(run(process.execPath, ["scripts/sandbox-runtime.mjs"]));
      await assert.rejects(run(process.execPath, ["scripts/package.mjs"]));
    });
  }

  async function run(command: string, args: string[], cwd = fixture) {
    return execute(
      command === "npm" ? process.execPath : command,
      command === "npm" ? [npmCli, ...args] : args,
      {
        cwd,
        env: environment,
        timeout: 20_000,
        maxBuffer: 5_000_000,
      },
    );
  }

  async function pack(cwd: string) {
    const { stdout } = await run(
      "npm",
      [
        "pack",
        "--ignore-scripts",
        "--json",
        "--pack-destination",
        path.join(directory, "tarballs"),
      ],
      cwd,
    );
    const [artifact] = JSON.parse(stdout);
    return { ...artifact, tarball: path.join(directory, "tarballs", artifact.filename) };
  }

  /** Public SDK profile/command generation only, not native enforcement proof. */
  async function probe(importer: string, expectedRuntime: string, mode: string, cwd = fixture) {
    const script = path.join(directory, "profile.mjs");
    await writeFile(script, profileProbe);
    const workDir = path.join(cwd, "profile-fixture");
    await mkdir(workDir, { recursive: true });
    for (const platform of ["darwin", "linux"]) {
      await run(process.execPath, [script, importer, expectedRuntime, mode, platform], workDir);
    }
    await typecheckConsumer(importer, mode, cwd);
  }

  /** Compile an actual consumer beside the importer so package-local resolution stays real. */
  async function typecheckConsumer(importer: string, mode: string, cwd: string) {
    const source = path.join(path.dirname(importer), "command-config.mts");
    await writeFile(source, commandConfigConsumer + (mode === "patched" ? commandConfigTypes : ""));
    const check = run(
      process.execPath,
      [
        compiler,
        "--noEmit",
        "--strict",
        "--skipLibCheck",
        "--module",
        "NodeNext",
        "--target",
        "ES2022",
        "--typeRoots",
        typeRoots,
        "--types",
        "node",
        source,
      ],
      cwd,
    );
    if (mode === "patched") await check;
    else {
      await assert.rejects(check, (error: { stdout: string }) => {
        assert.equal(error.stdout.match(/error TS2739:/g)?.length, 4, error.stdout);
        assert.equal(error.stdout.match(/error TS\d+:/g)?.length, 4, error.stdout);
        return true;
      });
    }
  }
});

/** Copy the real installed production closure. The pinned SDK currently has four leaf dependencies. */
async function installedRuntimePackages() {
  const packages = new Map<string, string>();
  async function visit(name: string, base: string) {
    const manifestPath = findPackageJSON(name, base)!;
    assert.ok(manifestPath, `installed package ${name}`);
    const directory = path.dirname(manifestPath);
    if (packages.has(name)) {
      assert.equal(
        packages.get(name),
        directory,
        "fixture requires an unambiguous installed closure",
      );
      return;
    }
    packages.set(name, directory);
    const manifest = await readJson(manifestPath);
    if (name === runtimeName) assert.equal(manifest.version, runtimeVersion);
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      await visit(dependency, pathToFileURL(manifestPath).href);
    }
  }
  await visit(runtimeName, import.meta.url);
  return packages;
}

async function readPatchedFiles(runtime: string) {
  return Object.fromEntries(
    await Promise.all(
      patchedPaths.map(async (file) => [file, await readFile(path.join(runtime, file), "utf8")]),
    ),
  );
}

async function readJson(file: string) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function writeJson(file: string, value: unknown) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

const commandConfigConsumer = `
import { SandboxManager, type SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
SandboxManager.wrapWithSandbox('true', undefined, { network: { allowAllUnixSockets: false } });
SandboxManager.wrapWithSandbox('true', undefined, { filesystem: { allowGitConfig: false } });
SandboxManager.wrapWithSandboxArgv('true', undefined, { network: { allowAllUnixSockets: false } });
SandboxManager.wrapWithSandboxArgv('true', undefined, { filesystem: { allowGitConfig: false } });
const full: SandboxRuntimeConfig = {
  network: { allowedDomains: [], deniedDomains: [] },
  filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
};
SandboxManager.wrapWithSandbox('true', undefined, full);
SandboxManager.wrapWithSandboxArgv('true', undefined, full);
`;

const commandConfigTypes = `
import type { SandboxCommandConfig } from '@anthropic-ai/sandbox-runtime';
const config: SandboxCommandConfig = {
  filesystem: { allowWrite: [{ path: '/tmp/reef[1]', literal: true }] },
  credentials: { files: [{ path: '/tmp/kelp.key', mode: 'deny' }] },
};
SandboxManager.wrapWithSandbox('true', undefined, config);
SandboxManager.wrapWithSandboxArgv('true', undefined, config);
void ({ filesystem: {
  // @ts-expect-error Literal path entries still require a path.
  allowWrite: [{ literal: true }],
} } satisfies SandboxCommandConfig);
void ({ credentials: {
  // @ts-expect-error Credential files still require a mode.
  files: [{ path: '/tmp/kelp.key' }],
} } satisfies SandboxCommandConfig);
`;

const cleanupProbe = `
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { chmod, link, lstat, readFile, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Real Linux helper generation/cleanup on this host, with no platform override.
// Never execute the returned command or initialize native sandbox services.
globalThis.fetch = () => { throw new Error('unexpected network request'); };
const [, , runtime] = process.argv;
const cwd = process.cwd();
const cases = [
  { name: 'legitimate-empty-0444.env', bytes: '', mode: 0o444 },
  { name: 'empty-writable-0644.env', bytes: '', mode: 0o644 },
  { name: 'nonempty-readonly-0444.env', bytes: 'eight small squid\\n', mode: 0o444 },
  { name: 'hardlinked-empty-0444.env', bytes: '', mode: 0o444, linked: true },
];
for (const entry of cases) {
  const file = path.join(cwd, entry.name);
  await writeFile(file, entry.bytes, { flag: 'wx' });
  await chmod(file, entry.mode);
  if (entry.linked) await link(file, path.join(cwd, 'retained-hardlink.env'));
}
const snapshot = async name => {
  const file = path.join(cwd, name);
  let stat;
  try {
    stat = await lstat(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { exists: false };
  }
  return {
    exists: true, bytes: await readFile(file), mode: stat.mode & 0o777,
    device: stat.dev, inode: stat.ino, links: stat.nlink,
  };
};
const before = await Promise.all(cases.map(entry => snapshot(entry.name)));
assert.equal(before[0].links, 1);
const absent = path.join(cwd, 'absent-denied.env');
await assert.rejects(lstat(absent), { code: 'ENOENT' });

// Guards, not substitutes: only the real fixture rg scan and shell lookup run.
const { spawn, spawnSync } = childProcess;
const blockedMethods = ['exec', 'execSync', 'execFile', 'execFileSync', 'fork'];
const originals = blockedMethods.map(method => [method, childProcess[method]]);
for (const method of blockedMethods) {
  childProcess[method] = () => { throw new Error('unexpected external work: ' + method); };
}
childProcess.spawn = (command, args, options) => {
  assert.equal(command, 'rg', 'unexpected asynchronous external work');
  assert.ok(args.includes('--files'));
  assert.equal(args.at(-1), cwd);
  return spawn(command, args, options);
};
childProcess.spawnSync = (command, args, options) => {
  assert.equal(command, 'which', 'unexpected synchronous external work');
  assert.deepEqual(args, ['/bin/bash']);
  return spawnSync(command, args, options);
};
syncBuiltinESMExports();
try {
  const { wrapCommandWithSandboxLinux, cleanupBwrapMountPoints } = await import(
    pathToFileURL(path.join(runtime, '${linuxUtilsPath}'))
  );
  const profile = await wrapCommandWithSandboxLinux({
    command: 'true', needsNetworkRestriction: false, allowAllUnixSockets: true,
    binShell: '/bin/bash', bwrapPath: '/tau-not-executed/bwrap',
    readConfig: { denyOnly: [], allowWithinDeny: [] },
    writeConfig: { allowOnly: [cwd], denyWithinAllow: [...cases.map(entry => path.join(cwd, entry.name)), absent] },
    ripgrepConfig: { command: 'rg', args: ['--no-config', '--no-ignore'] },
  });
  try {
    assert.deepEqual(await Promise.all(cases.map(entry => snapshot(entry.name))), before, 'wrapping must preserve existing files');
    assert.ok(profile.includes(absent), 'absent deny must remain in the generated policy');
    await assert.rejects(lstat(absent), { code: 'ENOENT' });
    // Substitute only bwrap's mount-point creation, not generation or cleanup.
    await writeFile(absent, '', { flag: 'wx', mode: 0o444 });
    await chmod(absent, 0o444);
  } finally {
    cleanupBwrapMountPoints();
  }
  await assert.rejects(lstat(absent), { code: 'ENOENT' }, 'owned absent mount point must be removed');
  for (let index = 1; index < cases.length; index++) {
    assert.deepEqual(await snapshot(cases[index].name), before[index], cases[index].name);
  }
  const preserved = await snapshot(cases[0].name);
  assert.equal(preserved.exists, true, 'preexisting empty read-only deny file must survive cleanup');
  assert.deepEqual(preserved, before[0], cases[0].name);
} finally {
  childProcess.spawn = spawn;
  childProcess.spawnSync = spawnSync;
  for (const [method, original] of originals) childProcess[method] = original;
  syncBuiltinESMExports();
}
`;

const profileProbe = `
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Select generated policy only. Never initialize or execute a native sandbox.
const [, , importer, expectedRuntime, mode, platform] = process.argv;
Object.defineProperty(process, 'platform', { value: platform });
globalThis.fetch = () => { throw new Error('unexpected network request'); };
const require = createRequire(pathToFileURL(importer));
const entry = require.resolve('@anthropic-ai/sandbox-runtime');
assert.equal(entry, path.join(expectedRuntime, 'dist', 'index.js'));
const { SandboxManager } = await import(pathToFileURL(entry));
const cwd = process.cwd();
for (const name of ['.git/hooks', 'reef/cave']) mkdirSync(path.join(cwd, name), { recursive: true });
for (const name of ['.git/config', 'octopus.secret', 'starfish.lock', 'reef/cave/.bashrc']) writeFileSync(path.join(cwd, name), '');
const base = {
  network: { allowedDomains: [], deniedDomains: [] },
  filesystem: { denyRead: [path.join(cwd, 'octopus.secret')], allowWrite: [cwd], denyWrite: [path.join(cwd, 'starfish.lock')] },
  seccomp: { applyPath: '/srt-profile-only', argv0: 'apply-seccomp' },
};
const macOS = platform === 'darwin';
const fields = macOS
  ? ['network.allowAllUnixSockets', 'network.allowLocalBinding', 'filesystem.allowGitConfig', 'enableWeakerNetworkIsolation', 'allowAppleEvents']
  : ['network.allowAllUnixSockets', 'filesystem.allowGitConfig', 'enableWeakerNestedSandbox'];
const cases = fields.flatMap(field => [[field, false, [true]], [field, true, [false]]]);
cases.push(...(macOS ? [
  ['network.allowMachLookup', ['com.tau.octopus.session'], [['com.tau.octopus.call'], []]],
  ['network.allowUnixSockets', ['/tmp/octopus-session.sock'], [['/tmp/octopus-call.sock'], []]],
] : [['mandatoryDenySearchDepth', 1, [3]], ['mandatoryDenySearchDepth', 3, [1]]]));
const withField = (field, value, policy = structuredClone(base)) => {
  const [section, key] = field.split('.');
  (key ? (policy[section] ??= {}) : policy)[key ?? section] = value;
  return policy;
};
const check = (profile, field, value) => {
  if (Array.isArray(value)) {
    const names = field === 'network.allowMachLookup'
      ? ['com.tau.octopus.session', 'com.tau.octopus.call']
      : ['/tmp/octopus-session.sock', '/tmp/octopus-call.sock'];
    for (const name of names) {
      const rules = field === 'network.allowMachLookup'
        ? ['(allow mach-lookup (global-name "' + name + '"))']
        : [
            '(allow network-bind (local unix-socket (subpath "' + name + '")))',
            '(allow network-outbound (remote unix-socket (subpath "' + name + '")))',
          ];
      for (const rule of rules) assert.equal(profile.includes(rule), value.includes(name), field);
    }
  } else {
    const rules = {
      'network.allowAllUnixSockets': macOS ? '(path-regex #"^/")' : 'ARGV0=apply-seccomp',
      'network.allowLocalBinding': '(allow network-bind (local ip "*:*"))',
      'filesystem.allowGitConfig': path.join(cwd, '.git/config'),
      enableWeakerNetworkIsolation: '(global-name "com.apple.trustd.agent")',
      allowAppleEvents: '(allow appleevent-send)',
      enableWeakerNestedSandbox: '--bind /proc /proc',
      mandatoryDenySearchDepth: path.join(cwd, 'reef/cave/.bashrc'),
    };
    const enabled = field === 'mandatoryDenySearchDepth' ? value === 3 : Boolean(value);
    const inverse = field === 'filesystem.allowGitConfig' || (field === 'network.allowAllUnixSockets' && !macOS);
    assert.equal(profile.includes(rules[field]), inverse ? !enabled : enabled, field);
  }
  for (const name of ['.git/hooks', 'octopus.secret', 'starfish.lock']) assert.ok(profile.includes(path.join(cwd, name)), name);
  if (macOS) {
    assert.ok(profile.includes('(global-name "com.apple.system.logger")'));
    assert.ok(!profile.includes('(allow network*)'));
  } else {
    assert.ok(profile.includes('--unshare-pid'));
  }
};
const wrap = async custom => (await SandboxManager.wrapWithSandboxArgv('true', '/bin/bash', custom)).argv[2];
const getters = () => [SandboxManager.getAllowUnixSockets(), SandboxManager.getAllowLocalBinding(), SandboxManager.getAllowMachLookup(), SandboxManager.getEnableWeakerNestedSandbox(), SandboxManager.getFsWriteConfig()];
try {
  for (const [field, sessionValue, overrides] of cases) {
    const policy = withField(field, sessionValue);
    const originalPolicy = structuredClone(policy);
    SandboxManager.updateConfig(policy);
    const session = structuredClone(SandboxManager.getConfig());
    const sessionGetters = structuredClone(getters());
    for (const value of [undefined, ...overrides]) {
      const custom = value === undefined ? undefined : withField(field, value, {});
      const originalCustom = structuredClone(custom);
      check(await wrap(custom), field, mode === 'released' || value === undefined ? sessionValue : value);
      assert.deepEqual(SandboxManager.getConfig(), session);
      assert.deepEqual(getters(), sessionGetters);
      assert.deepEqual(policy, originalPolicy);
      assert.deepEqual(custom, originalCustom);
      if (value !== undefined) check(await wrap(), field, sessionValue);
    }
  }
} finally {
  await SandboxManager.reset();
}
`;
