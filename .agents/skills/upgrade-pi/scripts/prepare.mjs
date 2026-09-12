#!/usr/bin/env node

import { execFile } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PI_PACKAGES = [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
];
const TAU_PACKAGES = ["tau-coding-agent", "tau-all-agent"];
const SOURCE_ROOTS = [".agents", "extensions", "skills", "themes", "packages", "scripts"];
const ROOT_SOURCE_FILES = [
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "README.md",
  "CHANGELOG.md",
  "renovate.json",
];
const TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsonl",
  ".jsx",
  ".md",
  ".mjs",
  ".mts",
  ".scss",
  ".sh",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);

const options = parseArguments(process.argv.slice(2));
if (options.help) {
  printHelp();
  process.exit(0);
}
if (process.platform === "win32") {
  throw new Error("prepare.mjs requires a POSIX environment with npm, tar, and git");
}

const repoDir = path.resolve(options.repo ?? process.cwd());
const packageJsonPath = path.join(repoDir, "package.json");
const packageJson = await readJson(packageJsonPath);
if (packageJson.name !== "tau") {
  throw new Error(
    `Expected Tau repository at ${repoDir}; package name is ${packageJson.name ?? "missing"}`,
  );
}

const currentVersion = getCurrentPiVersion(packageJson);
const targetVersion = await resolveTargetVersion(options.target);
if (compareVersions(targetVersion, currentVersion) <= 0) {
  throw new Error(
    `Target Pi ${targetVersion} is not newer than Tau's current Pi ${currentVersion}`,
  );
}

const outputDir = await createOutputDirectory(
  options.output,
  repoDir,
  currentVersion,
  targetVersion,
);
const git = await collectGitState(repoDir);

progress(`Preparing Pi ${currentVersion} → ${targetVersion} audit at ${outputDir}`);
await mkdir(path.join(outputDir, "archives"), { recursive: true });
await mkdir(path.join(outputDir, "upstream", "target"), { recursive: true });
await mkdir(path.join(outputDir, "changelog", "by-minor"), { recursive: true });
await mkdir(path.join(outputDir, "reports", "release-series"), { recursive: true });
await mkdir(path.join(outputDir, "reports", "resources"), { recursive: true });
await mkdir(path.join(outputDir, "reviews"), { recursive: true });

for (const packageName of PI_PACKAGES) {
  await downloadPackage(packageName, targetVersion, outputDir);
}

const codingAgentDir = path.join(outputDir, "upstream", "target", "pi-coding-agent");
const changelogPath = path.join(codingAgentDir, "CHANGELOG.md");
const changelog = await readFile(changelogPath, "utf8");
const selectedSections = extractChangelogSections(changelog, currentVersion, targetVersion);
await writeChangelogArtifacts(outputDir, currentVersion, targetVersion, selectedSections);

const sourceFiles = await collectSourceFiles(repoDir);
await writeSourceManifest(outputDir, repoDir, sourceFiles);
await writeApiUsageInventory(outputDir, repoDir, sourceFiles);
await writeResourceUnits(outputDir, repoDir);

const scratchResult = await prepareScratchCopy(outputDir, repoDir, targetVersion);

await writeSummary({
  outputDir,
  repoDir,
  currentVersion,
  targetVersion,
  git,
  selectedSections,
  scratchResult,
});

console.log(`workspace=${outputDir}`);

function parseArguments(argv) {
  const parsed = { repo: undefined, target: undefined, output: undefined };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      parsed.help = true;
      continue;
    }
    if (argument === "--repo" || argument === "--target" || argument === "--output") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`Missing value for ${argument}`);
      }
      parsed[argument.slice(2)] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  return parsed;
}

function printHelp() {
  console.log(`Usage: prepare.mjs [options]

Prepare a temporary Tau/Pi upgrade audit workspace.

Options:
  --repo <path>       Tau repository root (default: current directory)
  --target <version>  Target Pi version (default: latest npm version)
  --output <path>     New or empty output directory outside the repository
  -h, --help          Show this help`);
}

function getCurrentPiVersion(manifest) {
  const versions = PI_PACKAGES.map((packageName) => {
    const version = manifest.devDependencies?.[packageName];
    if (typeof version !== "string") {
      throw new Error(`Missing root devDependency ${packageName}`);
    }
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
      throw new Error(`Expected exact version for ${packageName}, found ${version}`);
    }
    return normalizeVersion(version);
  });

  const uniqueVersions = new Set(versions);
  if (uniqueVersions.size !== 1) {
    throw new Error(`Pi development dependencies are not aligned: ${versions.join(", ")}`);
  }
  return versions[0];
}

async function resolveTargetVersion(target) {
  if (target && target !== "latest") return normalizeVersion(target);

  progress("Resolving latest Pi version from npm");
  const result = await runChecked(npmCommand(), [
    "view",
    "@earendil-works/pi-coding-agent",
    "version",
    "--json",
  ]);
  const version = JSON.parse(result.stdout);
  if (typeof version !== "string") {
    throw new Error(`Unexpected npm version response: ${result.stdout}`);
  }
  return normalizeVersion(version);
}

async function createOutputDirectory(output, repo, currentVersion, targetVersion) {
  if (!output) {
    return mkdtemp(path.join(tmpdir(), `tau-pi-upgrade-${currentVersion}-to-${targetVersion}-`));
  }

  const resolved = path.resolve(output);
  if (isInsideOrEqual(resolved, repo)) {
    throw new Error("Audit output must be outside the Tau repository");
  }

  await mkdir(resolved, { recursive: true });
  const entries = await readdir(resolved);
  if (entries.length > 0) {
    throw new Error(`Output directory is not empty: ${resolved}`);
  }
  return resolved;
}

async function collectGitState(repo) {
  const [status, branch, head] = await Promise.all([
    runChecked("git", ["status", "--short", "--branch"], { cwd: repo }),
    runChecked("git", ["branch", "--show-current"], { cwd: repo }),
    runChecked("git", ["rev-parse", "HEAD"], { cwd: repo }),
  ]);

  return {
    status: status.stdout.trimEnd(),
    branch: branch.stdout.trim() || "(detached)",
    head: head.stdout.trim(),
  };
}

async function downloadPackage(packageName, targetVersion, output) {
  const shortName = packageName.slice(packageName.lastIndexOf("/") + 1);
  const archiveDir = path.join(output, "archives");
  const packageDir = path.join(output, "upstream", "target", shortName);

  progress(`Downloading ${packageName}@${targetVersion}`);
  const packed = await runChecked(npmCommand(), [
    "pack",
    "--silent",
    `${packageName}@${targetVersion}`,
    "--pack-destination",
    archiveDir,
  ]);
  const archiveName = packed.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!archiveName) throw new Error(`npm pack returned no archive for ${packageName}`);

  const archivePath = path.resolve(archiveDir, archiveName);
  if (!isInside(archivePath, archiveDir)) {
    throw new Error(`Unexpected npm archive path: ${archiveName}`);
  }

  await mkdir(packageDir, { recursive: true });
  await runChecked("tar", ["-xzf", archivePath, "-C", packageDir, "--strip-components=1"]);

  const manifest = await readJson(path.join(packageDir, "package.json"));
  if (manifest.version !== targetVersion) {
    throw new Error(`Downloaded ${packageName} ${manifest.version}, expected ${targetVersion}`);
  }
}

function extractChangelogSections(changelog, currentVersion, targetVersion) {
  const heading = /^## \[([^\]]+)\][^\n]*$/gm;
  const matches = [...changelog.matchAll(heading)];
  const sections = matches.map((match, index) => ({
    version: match[1],
    content: changelog
      .slice(match.index, index + 1 < matches.length ? matches[index + 1].index : changelog.length)
      .trimEnd(),
  }));

  const selected = sections.filter(({ version }) => {
    try {
      return (
        compareVersions(version, currentVersion) > 0 && compareVersions(version, targetVersion) <= 0
      );
    } catch {
      return false;
    }
  });

  if (!sections.some(({ version }) => versionsEqual(version, currentVersion))) {
    throw new Error(`Current version ${currentVersion} is missing from the packaged changelog`);
  }
  if (!selected.some(({ version }) => versionsEqual(version, targetVersion))) {
    throw new Error(`Target version ${targetVersion} is missing from the packaged changelog`);
  }

  return selected;
}

async function writeChangelogArtifacts(output, currentVersion, targetVersion, sections) {
  const changelogDir = path.join(output, "changelog");
  const combinedPath = path.join(changelogDir, `${currentVersion}-to-${targetVersion}.md`);
  await writeFile(
    combinedPath,
    `# Pi changelog: ${currentVersion} to ${targetVersion}\n\n${sections.map((section) => section.content).join("\n\n")}\n`,
  );
  await writeFile(
    path.join(changelogDir, "versions.json"),
    `${JSON.stringify(
      sections.map(({ version }) => version),
      null,
      2,
    )}\n`,
  );

  const byMinor = new Map();
  for (const section of sections) {
    const parsed = parseVersion(section.version);
    const minor = `${parsed.major}.${parsed.minor}`;
    const existing = byMinor.get(minor) ?? [];
    existing.push(section.content);
    byMinor.set(minor, existing);
  }

  for (const [minor, contents] of byMinor) {
    await writeFile(
      path.join(changelogDir, "by-minor", `${minor}.md`),
      `# Pi ${minor}.x changelog\n\n${contents.join("\n\n")}\n`,
    );
  }
}

async function collectSourceFiles(repo) {
  const files = [];
  for (const relativePath of ROOT_SOURCE_FILES) {
    const absolutePath = path.join(repo, relativePath);
    if (await isFile(absolutePath)) files.push(absolutePath);
  }
  for (const root of SOURCE_ROOTS) {
    const absoluteRoot = path.join(repo, root);
    if (await isDirectory(absoluteRoot)) {
      await walkFiles(absoluteRoot, files);
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

async function walkFiles(directory, files) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) await walkFiles(entryPath, files);
    else if (entry.isFile()) files.push(entryPath);
  }
}

async function writeSourceManifest(output, repo, files) {
  const lines = ["# Tau source inventory", ""];
  for (const file of files) {
    const relativePath = toPosixPath(path.relative(repo, file));
    const contents = await readFile(file);
    lines.push(`- \`${relativePath}\` (${countLines(contents)} lines, ${contents.length} bytes)`);
  }
  await writeFile(path.join(output, "source-inventory.md"), `${lines.join("\n")}\n`);
}

async function writeApiUsageInventory(output, repo, files) {
  const lines = ["# Tau Pi API usage inventory", ""];
  const pattern =
    /@earendil-works\/pi-|\b(?:pi|ctx)\.[A-Za-z_$][\w$]*|\b(?:Type|Value)\.[A-Za-z_$][\w$]*|\bPI_[A-Z0-9_]+/;

  for (const file of files) {
    if (!TEXT_EXTENSIONS.has(path.extname(file).toLowerCase())) continue;
    const relativePath = toPosixPath(path.relative(repo, file));
    const contents = await readFile(file, "utf8");
    contents.split(/\r?\n/).forEach((line, index) => {
      if (pattern.test(line)) lines.push(`${relativePath}:${index + 1}: ${line.trim()}`);
    });
  }

  await writeFile(path.join(output, "pi-api-usage.md"), `${lines.join("\n")}\n`);
}

async function writeResourceUnits(output, repo) {
  const lines = ["# Tau audit resource units", "", "## Extensions", ""];
  lines.push(...(await listImmediateUnits(repo, "extensions")));
  lines.push("", "## Project skills", "");
  lines.push(...(await listImmediateUnits(repo, ".agents/skills", { directoriesOnly: true })));
  lines.push("", "## Packaged skills", "");
  lines.push(...(await listImmediateUnits(repo, "skills", { directoriesOnly: true })));
  lines.push("", "## Themes", "");
  lines.push(...(await listImmediateUnits(repo, "themes")));
  lines.push(
    "",
    "## Cross-cutting",
    "",
    "- `package.json`, `package-lock.json`, `packages/`, and `scripts/package.mjs` — dependencies, packaging, and distribution",
    "- `README.md`, package READMEs, and `CHANGELOG.md` — user-facing documentation",
  );
  await writeFile(path.join(output, "resource-units.md"), `${lines.join("\n")}\n`);
}

async function listImmediateUnits(repo, relativeRoot, options = {}) {
  const root = path.join(repo, relativeRoot);
  if (!(await isDirectory(root))) return ["- (none)"];

  const units = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (options.directoriesOnly && !entry.isDirectory()) continue;
    if (!entry.isDirectory() && !entry.isFile()) continue;
    units.push(`- \`${toPosixPath(path.join(relativeRoot, entry.name))}\``);
  }
  return units.sort();
}

async function prepareScratchCopy(output, repo, targetVersion) {
  const scratchDir = path.join(output, "scratch", "tau");
  progress("Creating scratch Tau copy");
  await copyWorkingTree(repo, scratchDir);

  const scratchManifestPath = path.join(scratchDir, "package.json");
  const scratchManifest = await readJson(scratchManifestPath);
  for (const packageName of PI_PACKAGES) {
    scratchManifest.devDependencies[packageName] = targetVersion;
  }
  await writeJson(scratchManifestPath, scratchManifest);

  progress("Installing target dependencies in scratch copy");
  const install = await runCaptured(npmCommand(), ["install", "--ignore-scripts"], {
    cwd: scratchDir,
  });
  await writeCommandLog(path.join(output, "scratch-install.log"), install);

  let cliHelpCode = null;
  let compileCode = null;
  let packageValidationCode = null;
  if (install.code === 0) {
    let cliHelp;
    try {
      const cliPath = await resolvePiCliPath(scratchDir);
      cliHelp = await runCaptured(process.execPath, [cliPath, "--help"], {
        cwd: scratchDir,
      });
    } catch (error) {
      cliHelp = {
        code: 1,
        stdout: "",
        stderr: error instanceof Error ? error.stack || error.message : String(error),
      };
    }
    cliHelpCode = cliHelp.code;
    await writeCommandLog(path.join(output, "target-cli-help.log"), cliHelp);

    progress("Compiling scratch copy against target Pi");
    const compile = await runCaptured(npmCommand(), ["run", "check:compile"], {
      cwd: scratchDir,
    });
    compileCode = compile.code;
    await writeCommandLog(path.join(output, "scratch-compile.log"), compile);

    progress("Validating generated Tau packages");
    const packageValidation = await validateGeneratedPackages(output, scratchDir);
    packageValidationCode = packageValidation.code;
    await writeCommandLog(path.join(output, "package-validation.log"), packageValidation);
  } else {
    const skipped = "Skipped because the scratch dependency install failed.\n";
    await writeFile(path.join(output, "target-cli-help.log"), skipped);
    await writeFile(path.join(output, "scratch-compile.log"), skipped);
    await writeFile(path.join(output, "package-validation.log"), skipped);
  }

  return {
    directory: scratchDir,
    installCode: install.code,
    cliHelpCode,
    compileCode,
    packageValidationCode,
  };
}

async function resolvePiCliPath(root) {
  const packageDir = path.join(root, "node_modules", "@earendil-works", "pi-coding-agent");
  const manifest = await readJson(path.join(packageDir, "package.json"));
  const binPath = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.pi;
  if (typeof binPath !== "string" || !binPath.trim()) {
    throw new Error("Target Pi package does not declare bin.pi");
  }

  const cliPath = path.resolve(packageDir, binPath);
  if (!isInside(cliPath, packageDir) || !(await isFile(cliPath))) {
    throw new Error(`Target Pi package declares an invalid bin.pi path: ${binPath}`);
  }
  return cliPath;
}

async function validateGeneratedPackages(output, scratchDir) {
  const stdout = [];
  const stderr = [];
  const validationDir = path.join(output, "package-validation");
  const tarballDir = path.join(validationDir, "tarballs");
  await mkdir(tarballDir, { recursive: true });

  const recordCommand = (label, result) => {
    stdout.push(`${label}: exit ${result.code}`);
    if (result.stdout.trim()) stdout.push(result.stdout.trim());
    if (result.stderr.trim()) stderr.push(`${label}:\n${result.stderr.trim()}`);
  };

  try {
    const build = await runCaptured(npmCommand(), ["run", "package"], { cwd: scratchDir });
    recordCommand("generate packages", build);
    if (build.code !== 0) {
      return { code: build.code, stdout: `${stdout.join("\n")}\n`, stderr: stderr.join("\n\n") };
    }

    const cliPath = await resolvePiCliPath(scratchDir);
    const sdkPath = path.join(path.dirname(cliPath), "index.js");
    const { DefaultResourceLoader, SettingsManager } = await import(pathToFileURL(sdkPath).href);

    for (const packageName of TAU_PACKAGES) {
      const generatedDir = path.join(scratchDir, "dist", packageName);
      const packed = await runCaptured(
        npmCommand(),
        ["pack", "--silent", "--pack-destination", tarballDir],
        { cwd: generatedDir },
      );
      recordCommand(`pack ${packageName}`, packed);
      if (packed.code !== 0) {
        return {
          code: packed.code,
          stdout: `${stdout.join("\n")}\n`,
          stderr: stderr.join("\n\n"),
        };
      }

      const archiveName = packed.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
      if (!archiveName) throw new Error(`npm pack returned no archive for ${packageName}`);
      const archivePath = path.resolve(tarballDir, archiveName);
      if (!isInside(archivePath, tarballDir)) {
        throw new Error(`Unexpected package archive path: ${archiveName}`);
      }

      const installDir = path.join(validationDir, "installs", packageName);
      const projectDir = path.join(installDir, "project");
      const agentDir = path.join(installDir, "agent");
      await mkdir(projectDir, { recursive: true });
      await mkdir(agentDir, { recursive: true });
      await writeJson(path.join(installDir, "package.json"), {
        name: `${packageName}-validation`,
        private: true,
      });

      const install = await runCaptured(
        npmCommand(),
        [
          "install",
          "--ignore-scripts",
          "--legacy-peer-deps",
          "--package-lock=false",
          "--no-audit",
          "--no-fund",
          archivePath,
        ],
        { cwd: installDir },
      );
      recordCommand(`install ${packageName}`, install);
      if (install.code !== 0) {
        return {
          code: install.code,
          stdout: `${stdout.join("\n")}\n`,
          stderr: stderr.join("\n\n"),
        };
      }

      const packageDir = path.join(installDir, "node_modules", packageName);
      const manifest = await readJson(path.join(packageDir, "package.json"));
      await writeJson(path.join(agentDir, "settings.json"), { packages: [packageDir] });

      const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
      const previousOffline = process.env.PI_OFFLINE;
      process.env.PI_CODING_AGENT_DIR = agentDir;
      process.env.PI_OFFLINE = "1";
      try {
        const settingsManager = SettingsManager.create(projectDir, agentDir);
        const loader = new DefaultResourceLoader({
          cwd: projectDir,
          agentDir,
          settingsManager,
          noContextFiles: true,
        });
        await loader.reload({ resolveProjectTrust: async () => true });
        assertPackageResources(packageName, packageDir, manifest, loader, stdout);
      } finally {
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        if (previousOffline === undefined) delete process.env.PI_OFFLINE;
        else process.env.PI_OFFLINE = previousOffline;
      }
    }

    return { code: 0, stdout: `${stdout.join("\n")}\n`, stderr: stderr.join("\n\n") };
  } catch (error) {
    stderr.push(error instanceof Error ? error.stack || error.message : String(error));
    return { code: 1, stdout: `${stdout.join("\n")}\n`, stderr: stderr.join("\n\n") };
  }
}

function assertPackageResources(packageName, packageDir, manifest, loader, output) {
  const extensions = loader.getExtensions();
  const skills = loader.getSkills();
  const prompts = loader.getPrompts();
  const themes = loader.getThemes();
  const belongsToPackage = (sourceInfo) =>
    sourceInfo?.source && path.resolve(sourceInfo.source) === path.resolve(packageDir);

  const loadedExtensions = extensions.extensions.filter((extension) =>
    belongsToPackage(extension.sourceInfo),
  );
  const loadedSkills = skills.skills.filter((skill) => belongsToPackage(skill.sourceInfo));
  const loadedPrompts = prompts.prompts.filter((prompt) => belongsToPackage(prompt.sourceInfo));
  const loadedThemes = themes.themes.filter((theme) => belongsToPackage(theme.sourceInfo));
  const diagnostics = [
    ...extensions.errors.map(({ path: resourcePath, error }) => ({
      type: "error",
      message: `${resourcePath}: ${error}`,
    })),
    ...skills.diagnostics,
    ...prompts.diagnostics,
    ...themes.diagnostics,
  ];

  const expected = {
    extensions: manifest.pi?.extensions?.length ?? 0,
    skills: manifest.pi?.skills?.length ?? 0,
    prompts: manifest.pi?.prompts?.length ?? 0,
    themes: manifest.pi?.themes?.length ?? 0,
  };
  const actual = {
    extensions: loadedExtensions.length,
    skills: loadedSkills.length,
    prompts: loadedPrompts.length,
    themes: loadedThemes.length,
  };

  output.push(
    `${packageName}: extensions ${actual.extensions}/${expected.extensions}, skills ${actual.skills}/${expected.skills}, prompts ${actual.prompts}/${expected.prompts}, themes ${actual.themes}/${expected.themes}, diagnostics ${diagnostics.length}`,
  );

  const mismatches = Object.keys(expected).filter((key) => actual[key] !== expected[key]);
  if (mismatches.length > 0 || diagnostics.length > 0) {
    const details = [
      ...mismatches.map((key) => `${key}: loaded ${actual[key]}, expected ${expected[key]}`),
      ...diagnostics.map((diagnostic) => `${diagnostic.type}: ${diagnostic.message}`),
    ];
    throw new Error(`${packageName} resource validation failed:\n${details.join("\n")}`);
  }
}

async function copyWorkingTree(repo, destination) {
  const listed = await runChecked(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: repo },
  );
  const relativePaths = listed.stdout.split("\0").filter(Boolean);

  for (const relativePath of relativePaths) {
    const segments = relativePath.split("/");
    if (
      segments.some(
        (segment) => segment === ".git" || segment === "node_modules" || segment === "dist",
      )
    ) {
      continue;
    }

    const source = path.resolve(repo, relativePath);
    if (!isInside(source, repo)) continue;
    const sourceStat = await lstat(source);
    if (!sourceStat.isFile()) continue;

    const target = path.join(destination, ...segments);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(source, target);
  }
}

async function writeSummary({
  outputDir,
  repoDir,
  currentVersion,
  targetVersion,
  git,
  selectedSections,
  scratchResult,
}) {
  const compileStatus =
    scratchResult.compileCode === 0
      ? "passed"
      : scratchResult.compileCode === null
        ? "not run because install failed"
        : `failed with exit code ${scratchResult.compileCode}`;
  const installStatus =
    scratchResult.installCode === 0
      ? "passed"
      : `failed with exit code ${scratchResult.installCode}`;
  const cliHelpStatus =
    scratchResult.cliHelpCode === 0
      ? "passed"
      : scratchResult.cliHelpCode === null
        ? "not run because install failed"
        : `failed with exit code ${scratchResult.cliHelpCode}`;
  const packageValidationStatus =
    scratchResult.packageValidationCode === 0
      ? "passed"
      : scratchResult.packageValidationCode === null
        ? "not run because install failed"
        : `failed with exit code ${scratchResult.packageValidationCode}`;

  const summary = `# Tau Pi upgrade audit

- Repository: \`${repoDir}\`
- Current Pi: \`${currentVersion}\`
- Target Pi: \`${targetVersion}\`
- Git branch: \`${git.branch}\`
- Git HEAD: \`${git.head}\`
- Releases in range: ${selectedSections.map(({ version }) => `\`${version}\``).join(", ")}
- Scratch install: ${installStatus}
- Target CLI help: ${cliHelpStatus}
- Scratch compile: ${compileStatus}
- Generated package validation: ${packageValidationStatus}

## Git status at preparation time

\`\`\`text
${git.status || "(clean)"}
\`\`\`

## Audit entry points

- \`changelog/${currentVersion}-to-${targetVersion}.md\`: complete intervening changelog
- \`changelog/by-minor/\`: release-series audit slices
- \`upstream/target/\`: unpacked target Pi npm packages, docs, examples, declarations, and runtime
- \`source-inventory.md\`: relevant Tau source inventory
- \`pi-api-usage.md\`: static inventory of likely Pi API integrations
- \`resource-units.md\`: units for one-resource-per-agent audits
- \`reports/\`: primary release-series and resource audit reports
- \`reviews/\`: independent reviews of the plan and final migration
- \`scratch-install.log\`: target dependency installation result
- \`scratch-compile.log\`: initial compatibility compile result
- \`target-cli-help.log\`: target Pi CLI flags
- \`package-validation.log\`: generated tarball installation and resource diagnostics
- \`scratch/tau/\`: isolated Tau copy using target dependencies

## Next step

Read the changelog and compile diagnostics, then audit each release series and Tau resource. Separate required migration work from opportunities enabled by new Pi features and APIs.
`;

  await writeFile(path.join(outputDir, "summary.md"), summary);
}

async function writeCommandLog(file, result) {
  await writeFile(
    file,
    `exitCode=${result.code}\n\n--- stdout ---\n${result.stdout}\n\n--- stderr ---\n${result.stderr}\n`,
  );
}

async function runChecked(command, args, options = {}) {
  const result = await runCaptured(command, args, options);
  if (result.code === 0) return result;

  const details = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  const error = new Error(`${command} ${args.join(" ")} failed${details ? `:\n${details}` : ""}`);
  error.code = result.code;
  error.stdout = result.stdout;
  error.stderr = result.stderr;
  throw error;
}

async function runCaptured(command, args, options = {}) {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      encoding: "utf8",
      maxBuffer: 100 * 1024 * 1024,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: typeof error.code === "number" ? error.code : 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? error.message,
    };
  }
}

function normalizeVersion(version) {
  const normalized = String(version).trim().replace(/^v/, "");
  parseVersion(normalized);
  return normalized;
}

function versionsEqual(left, right) {
  try {
    return compareVersions(left, right) === 0;
  } catch {
    return false;
  }
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

function parseVersion(version) {
  const match = String(version).match(
    /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/,
  );
  if (!match) throw new Error(`Invalid semantic version: ${version}`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split(".") ?? [],
  };
}

function comparePrerelease(left, right) {
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;

  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] === undefined) return -1;
    if (right[index] === undefined) return 1;
    if (left[index] === right[index]) continue;

    const leftNumber = /^\d+$/.test(left[index]) ? Number(left[index]) : undefined;
    const rightNumber = /^\d+$/.test(right[index]) ? Number(right[index]) : undefined;
    if (leftNumber !== undefined && rightNumber !== undefined) {
      return leftNumber < rightNumber ? -1 : 1;
    }
    if (leftNumber !== undefined) return -1;
    if (rightNumber !== undefined) return 1;
    return left[index].localeCompare(right[index]);
  }
  return 0;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function isFile(file) {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

async function isDirectory(directory) {
  try {
    return (await stat(directory)).isDirectory();
  } catch {
    return false;
  }
}

function isInside(candidate, parent) {
  const relativePath = path.relative(path.resolve(parent), path.resolve(candidate));
  return Boolean(relativePath) && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}

function isInsideOrEqual(candidate, parent) {
  return path.resolve(candidate) === path.resolve(parent) || isInside(candidate, parent);
}

function countLines(buffer) {
  if (buffer.length === 0) return 0;
  let lines = 1;
  for (const byte of buffer) if (byte === 10) lines += 1;
  return buffer.at(-1) === 10 ? lines - 1 : lines;
}

function toPosixPath(value) {
  return value.split(path.sep).join("/");
}

function npmCommand() {
  return "npm";
}

function progress(message) {
  console.error(`[upgrade-pi] ${message}`);
}
