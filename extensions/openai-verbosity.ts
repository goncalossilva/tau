import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { lock } from "proper-lockfile";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "openai-verbosity";
const CHAT_COMPLETIONS_API = "openai-completions";
const RESPONSES_APIS = new Set([
  "openai-responses",
  "openai-codex-responses",
  "azure-openai-responses",
]);

type Verbosity = "low" | "medium" | "high";
type VerbositySetting = Verbosity | "auto";
type JsonObject = Record<string, unknown>;
type ModelInfo = NonNullable<ExtensionContext["model"]>;
type VerbosityConfig = {
  models: Record<string, VerbositySetting>;
};

function emptyConfig(): VerbosityConfig {
  return { models: Object.create(null) };
}

function getConfigPath(): string {
  return path.join(getAgentDir(), "openai-verbosity.json");
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeVerbosity(value: string): Verbosity | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === "low" || normalized === "medium" || normalized === "high") return normalized;
  return undefined;
}

function parseVerbositySetting(value: string): VerbositySetting | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === "auto") return normalized;
  return normalizeVerbosity(normalized);
}

function getVerbosityArgumentCompletions(
  prefix: string,
): Array<{ value: string; label: string }> | null {
  const trimmed = prefix.trim().toLowerCase();
  if (trimmed.includes(" ")) return null;

  const options = ["low", "medium", "high", "auto"];
  const matches = options.filter((option) => option.startsWith(trimmed));
  if (!matches.length) return null;

  return matches.map((option) => ({ value: option, label: option }));
}

function parseConfig(value: unknown): VerbosityConfig {
  if (!isObject(value) || !isObject(value.models)) return emptyConfig();

  const models: Record<string, VerbositySetting> = Object.create(null);
  for (const [key, rawVerbosity] of Object.entries(value.models)) {
    const normalizedKey = key.trim();
    if (!normalizedKey || typeof rawVerbosity !== "string") continue;
    if (key !== normalizedKey && Object.hasOwn(value.models, normalizedKey)) continue;

    const verbosity = parseVerbositySetting(rawVerbosity);
    if (!verbosity) continue;

    models[normalizedKey] = verbosity;
  }

  return { models };
}

async function loadConfig(): Promise<VerbosityConfig> {
  try {
    const raw = await readFile(getConfigPath(), "utf8");
    return parseConfig(JSON.parse(raw) as unknown);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[openai-verbosity] Failed to load config: ${message}`);
    }

    return emptyConfig();
  }
}

// Resolve the target before locking and renaming: aliases must share a lock, not lose their symlink.
async function resolveConfigPath(): Promise<string> {
  const configPath = getConfigPath();
  await mkdir(path.dirname(configPath), { recursive: true });
  try {
    return await realpath(configPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const entry = await lstat(configPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (entry) throw new Error("Cannot save through an unresolved configuration symlink");
    return path.join(await realpath(path.dirname(configPath)), path.basename(configPath));
  }
}

async function saveConfig(
  model: Pick<ModelInfo, "provider" | "id">,
  setting: VerbositySetting,
  onSaved: (config: VerbosityConfig) => void,
): Promise<void> {
  const configPath = await resolveConfigPath();
  let compromised: Error | undefined;
  const release = await lock(configPath, {
    realpath: false,
    retries: { retries: 10, factor: 1, minTimeout: 100, maxTimeout: 100 },
    // The library's default callback throws asynchronously and can terminate Pi.
    onCompromised: (error) => {
      compromised = error;
    },
  });
  let temporary: string | undefined;
  try {
    const raw = await readFile(configPath, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return '{"models":{}}';
    });
    const current: unknown = JSON.parse(raw);
    if (!isObject(current) || !isObject(current.models)) {
      throw new Error("Configuration must be an object with a models object");
    }
    const next = { ...current, models: { ...current.models, [getExactModelKey(model)]: setting } };
    const nextConfig = parseConfig(next);
    if (compromised) throw compromised;
    const candidate = `${configPath}.${randomUUID()}.tmp`;
    const file = await open(candidate, "wx", 0o600);
    temporary = candidate;
    try {
      await file.writeFile(`${JSON.stringify(next, null, 2)}\n`, "utf8");
    } finally {
      await file.close();
    }
    // This is a cooperative mtime lease, not fencing against arbitrary OS pauses or lock removal.
    if (compromised) throw compromised;
    await rename(temporary, configPath);
    temporary = undefined;
    // Publication succeeded even if releasing the lock later fails.
    onSaved(nextConfig);
  } finally {
    try {
      if (temporary) await unlink(temporary);
    } finally {
      await release().catch((error: unknown) => {
        throw compromised ?? error;
      });
    }
  }
}

function isSupportedModel(model: ExtensionContext["model"]): model is ModelInfo {
  return (
    !!model &&
    /^gpt-(?:5|6)(?:[.-]|$)/i.test(model.id) &&
    (model.api === CHAT_COMPLETIONS_API || RESPONSES_APIS.has(model.api))
  );
}

function getExactModelKey(model: Pick<ModelInfo, "provider" | "id">): string {
  return `${model.provider}/${model.id}`;
}

function resolveVerbosity(
  config: VerbosityConfig,
  model: Pick<ModelInfo, "provider" | "id">,
): { verbosity?: Verbosity } {
  const setting = config.models[getExactModelKey(model)] ?? config.models[model.id];
  return { verbosity: setting === "auto" ? undefined : setting };
}

function updateStatus(ctx: ExtensionContext, config: VerbosityConfig): void {
  if (!ctx.hasUI) return;
  if (!isSupportedModel(ctx.model)) {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    return;
  }

  const { verbosity } = resolveVerbosity(config, ctx.model);
  ctx.ui.setStatus(STATUS_KEY, verbosity ? ctx.ui.theme.fg("dim", verbosity) : undefined);
}

export default function openaiVerbosityExtension(pi: ExtensionAPI): void {
  let config = emptyConfig();
  const pending = new Set<Promise<void>>();

  pi.registerCommand("verbosity", {
    description: "Set OpenAI response verbosity for the current model",
    getArgumentCompletions: getVerbosityArgumentCompletions,
    handler: async (args, ctx) => {
      const verbosity = parseVerbositySetting(args);
      if (!verbosity) {
        ctx.ui.notify("Usage: /verbosity <low|medium|high|auto>", "error");
        return;
      }

      const model = ctx.model;
      if (!model) {
        ctx.ui.notify("No active model.", "warning");
        return;
      }

      if (!isSupportedModel(model)) {
        ctx.ui.notify("Current model does not support OpenAI verbosity control.", "warning");
        updateStatus(ctx, config);
        return;
      }

      let saved = false;
      const operation = saveConfig(model, verbosity, (nextConfig) => {
        config = nextConfig;
        saved = true;
      });
      pending.add(operation);
      try {
        await operation;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (saved) updateStatus(ctx, config);
        ctx.ui.notify(
          `${saved ? "Saved, but cleanup failed for" : "Failed to save"} ${getConfigPath()}: ${message}`,
          saved ? "warning" : "error",
        );
        return;
      } finally {
        pending.delete(operation);
      }

      updateStatus(ctx, config);

      if (verbosity === "auto") {
        ctx.ui.notify("Verbosity reset to auto", "info");
        return;
      }

      ctx.ui.notify(`Verbosity set to ${verbosity}`, "info");
    },
  });

  pi.on("session_shutdown", async () => {
    await Promise.allSettled(pending);
  });

  pi.on("session_start", async (_event, ctx) => {
    config = await loadConfig();
    updateStatus(ctx, config);
  });

  pi.on("model_select", async (_event, ctx) => {
    updateStatus(ctx, config);
  });

  pi.on("before_provider_request", (event, ctx) => {
    const model = ctx.model;
    if (!isSupportedModel(model)) return;

    const { verbosity } = resolveVerbosity(config, model);
    if (!verbosity) return;

    const payload = event.payload;
    if (!isObject(payload)) return;

    if (model.api === CHAT_COMPLETIONS_API) {
      return { ...payload, verbosity };
    }

    const text = isObject(payload.text) ? payload.text : {};
    return {
      ...payload,
      text: {
        ...text,
        verbosity,
      },
    };
  });
}
