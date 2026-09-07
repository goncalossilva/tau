import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { lock } from "proper-lockfile";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "fast";
const SUPPORTED_APIS = new Set([
  "openai-completions",
  "openai-responses",
  "openai-codex-responses",
  "azure-openai-responses",
]);

type FastMode = "fast";
type FastSetting = FastMode | "auto";
type JsonObject = Record<string, unknown>;
type ModelInfo = NonNullable<ExtensionContext["model"]>;
type FastConfig = {
  models: Record<string, FastSetting>;
};

function emptyConfig(): FastConfig {
  return { models: Object.create(null) };
}

function getConfigPath(): string {
  return path.join(getAgentDir(), "fast.json");
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeFastMode(value: string): FastSetting | undefined {
  const normalized = value.trim().toLowerCase();
  return normalized === "fast" || normalized === "auto" ? normalized : undefined;
}

function parseFastSetting(value: string): FastSetting | undefined {
  const normalized = value.trim().toLowerCase();

  if (normalized === "on" || normalized === "enabled") return "fast";
  if (normalized === "off" || normalized === "disabled") return "auto";

  return undefined;
}

function getFastArgumentCompletions(
  prefix: string,
): Array<{ value: string; label: string }> | null {
  const trimmed = prefix.trim().toLowerCase();
  if (trimmed.includes(" ")) return null;

  const options = ["on", "off", "enabled", "disabled"];
  const matches = options.filter((option) => option.startsWith(trimmed));
  if (!matches.length) return null;

  return matches.map((option) => ({ value: option, label: option }));
}

function parseConfig(value: unknown): FastConfig {
  if (!isObject(value) || !isObject(value.models)) return emptyConfig();

  const models: Record<string, FastSetting> = Object.create(null);
  for (const [key, rawMode] of Object.entries(value.models)) {
    const normalizedKey = key.trim();
    if (!normalizedKey || typeof rawMode !== "string") continue;
    if (key !== normalizedKey && Object.hasOwn(value.models, normalizedKey)) continue;

    const mode = normalizeFastMode(rawMode);
    if (!mode) continue;

    models[normalizedKey] = mode;
  }

  return { models };
}

async function loadConfig(): Promise<FastConfig> {
  try {
    const raw = await readFile(getConfigPath(), "utf8");
    return parseConfig(JSON.parse(raw) as unknown);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[fast] Failed to load config: ${message}`);
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
  setting: FastSetting | undefined,
  onSaved: (config: FastConfig) => void,
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
    const selected =
      setting ?? (resolveFastMode(parseConfig(current), model).mode ? "auto" : "fast");
    const next = { ...current, models: { ...current.models, [getExactModelKey(model)]: selected } };
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
  return !!model && SUPPORTED_APIS.has(model.api);
}

function getExactModelKey(model: Pick<ModelInfo, "provider" | "id">): string {
  return `${model.provider}/${model.id}`;
}

function resolveFastMode(
  config: FastConfig,
  model: Pick<ModelInfo, "provider" | "id">,
): { mode?: FastMode } {
  const setting = config.models[getExactModelKey(model)] ?? config.models[model.id];
  return { mode: setting === "fast" ? "fast" : undefined };
}

function updateStatus(ctx: ExtensionContext, config: FastConfig): void {
  if (!ctx.hasUI) return;
  if (!isSupportedModel(ctx.model)) {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    return;
  }

  const { mode } = resolveFastMode(config, ctx.model);
  ctx.ui.setStatus(STATUS_KEY, mode ? ctx.ui.theme.fg("dim", mode) : undefined);
}

export default function fastExtension(pi: ExtensionAPI): void {
  let config = emptyConfig();
  const pending = new Set<Promise<void>>();

  async function applySetting(
    setting: FastSetting | undefined,
    ctx: ExtensionContext,
  ): Promise<void> {
    const model = ctx.model;
    if (!model) {
      ctx.ui.notify("No active model.", "warning");
      return;
    }

    if (!isSupportedModel(model)) {
      ctx.ui.notify("Current model does not support fast processing.", "warning");
      updateStatus(ctx, config);
      return;
    }

    let saved = false;
    try {
      await saveConfig(model, setting, (nextConfig) => {
        config = nextConfig;
        saved = true;
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (saved) updateStatus(ctx, config);
      ctx.ui.notify(
        `${saved ? "Saved, but cleanup failed for" : "Failed to save"} ${getConfigPath()}: ${message}`,
        saved ? "warning" : "error",
      );
      return;
    }

    updateStatus(ctx, config);

    const modelLabel = getExactModelKey(model);
    if (!resolveFastMode(config, model).mode) {
      ctx.ui.notify(`Fast mode reset to auto for ${modelLabel}`, "info");
      return;
    }

    ctx.ui.notify(`Fast mode enabled for ${modelLabel}`, "info");
  }

  pi.registerCommand("fast", {
    description: "Toggle fast processing for the current model",
    getArgumentCompletions: getFastArgumentCompletions,
    handler: async (args, ctx) => {
      const arg = args.trim();
      const setting = parseFastSetting(arg);
      if (arg && !setting) {
        ctx.ui.notify("Usage: /fast [on|off|enabled|disabled]", "error");
        return;
      }

      const operation = applySetting(setting, ctx);
      pending.add(operation);
      try {
        await operation;
      } finally {
        pending.delete(operation);
      }
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
    if (!resolveFastMode(config, model).mode) return;

    const payload = event.payload;
    if (!isObject(payload)) return;

    return {
      ...payload,
      service_tier: "priority",
    };
  });
}
