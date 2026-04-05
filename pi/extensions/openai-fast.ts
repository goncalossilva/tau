import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const STATUS_KEY = "openai-fast";
const SUPPORTED_APIS = new Set(["openai-responses", "openai-codex-responses", "azure-openai-responses"]);

type FastMode = "fast";
type FastSetting = FastMode | "auto";
type JsonObject = Record<string, unknown>;
type ModelInfo = NonNullable<ExtensionContext["model"]>;
type FastConfig = {
  models: Record<string, FastMode>;
};

function emptyConfig(): FastConfig {
  return { models: {} };
}

function getConfigPath(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
  return path.join(agentDir, "openai-fast.json");
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeFastMode(value: string): FastMode | undefined {
  return value.trim().toLowerCase() === "fast" ? "fast" : undefined;
}

function parseFastSetting(value: string): FastSetting | undefined {
  const normalized = value.trim().toLowerCase();

  if (normalized === "on" || normalized === "enabled") return "fast";
  if (normalized === "off" || normalized === "disabled") return "auto";

  return undefined;
}

function parseConfig(value: unknown): FastConfig {
  if (!isObject(value) || !isObject(value.models)) return emptyConfig();

  const models: Record<string, FastMode> = {};
  for (const [key, rawMode] of Object.entries(value.models)) {
    const normalizedKey = key.trim();
    if (!normalizedKey || typeof rawMode !== "string") continue;

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
      console.warn(`[openai-fast] Failed to load config: ${message}`);
    }

    return emptyConfig();
  }
}

async function saveConfig(config: FastConfig): Promise<void> {
  const configPath = getConfigPath();
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
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
): { key?: string; mode?: FastMode } {
  const exactKey = getExactModelKey(model);
  const exactMode = config.models[exactKey];
  if (exactMode) return { key: exactKey, mode: exactMode };

  const sharedMode = config.models[model.id];
  if (sharedMode) return { key: model.id, mode: sharedMode };

  return {};
}

function setFastMode(
  config: FastConfig,
  key: string,
  setting: FastSetting,
): FastConfig {
  const models = { ...config.models };

  if (setting === "auto") delete models[key];
  else models[key] = setting;

  return { models };
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

export default function openaiFastExtension(pi: ExtensionAPI): void {
  let config = emptyConfig();

  async function applySetting(setting: FastSetting, ctx: ExtensionContext): Promise<void> {
    const model = ctx.model;
    if (!model) {
      ctx.ui.notify("No active model.", "warning");
      return;
    }

    if (!isSupportedModel(model)) {
      ctx.ui.notify(
        "Current model does not support fast mode. Supported APIs: openai-responses, openai-codex-responses, azure-openai-responses.",
        "warning",
      );
      updateStatus(ctx, config);
      return;
    }

    const resolved = resolveFastMode(config, model);
    const configKey = resolved.key ?? getExactModelKey(model);
    const nextConfig = setFastMode(config, configKey, setting);

    try {
      await saveConfig(nextConfig);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Failed to save ${getConfigPath()}: ${message}`, "error");
      return;
    }

    config = nextConfig;
    updateStatus(ctx, config);

    const modelLabel = getExactModelKey(model);
    if (setting === "auto") {
      ctx.ui.notify(`Fast mode reset to auto for ${modelLabel}`, "info");
      return;
    }

    ctx.ui.notify(`Fast mode enabled for ${modelLabel}`, "info");
  }

  pi.registerCommand("fast", {
    description: "Toggle priority service tier for the current OpenAI model",
    handler: async (args, ctx) => {
      const arg = args.trim();
      if (arg === "") {
        const nextSetting: FastSetting = isSupportedModel(ctx.model) && resolveFastMode(config, ctx.model).mode ? "auto" : "fast";
        await applySetting(nextSetting, ctx);
        return;
      }

      const setting = parseFastSetting(arg);
      if (!setting) {
        ctx.ui.notify("Usage: /fast [on|off|enabled|disabled]", "error");
        return;
      }

      await applySetting(setting, ctx);
    },
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
