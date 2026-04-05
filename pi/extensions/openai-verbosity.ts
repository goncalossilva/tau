import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const STATUS_KEY = "openai-verbosity";
const SUPPORTED_APIS = new Set(["openai-responses", "openai-codex-responses", "azure-openai-responses"]);

type Verbosity = "low" | "medium" | "high";
type VerbositySetting = Verbosity | "auto";
type JsonObject = Record<string, unknown>;
type ModelInfo = NonNullable<ExtensionContext["model"]>;
type VerbosityConfig = {
  models: Record<string, Verbosity>;
};

function emptyConfig(): VerbosityConfig {
  return { models: {} };
}

function getConfigPath(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
  return path.join(agentDir, "openai-verbosity.json");
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

function parseConfig(value: unknown): VerbosityConfig {
  if (!isObject(value) || !isObject(value.models)) return emptyConfig();

  const models: Record<string, Verbosity> = {};
  for (const [key, rawVerbosity] of Object.entries(value.models)) {
    const normalizedKey = key.trim();
    if (!normalizedKey || typeof rawVerbosity !== "string") continue;

    const verbosity = normalizeVerbosity(rawVerbosity);
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

async function saveConfig(config: VerbosityConfig): Promise<void> {
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

function resolveVerbosity(
  config: VerbosityConfig,
  model: Pick<ModelInfo, "provider" | "id">,
): { key?: string; verbosity?: Verbosity } {
  const exactKey = getExactModelKey(model);
  const exactVerbosity = config.models[exactKey];
  if (exactVerbosity) return { key: exactKey, verbosity: exactVerbosity };

  const sharedVerbosity = config.models[model.id];
  if (sharedVerbosity) return { key: model.id, verbosity: sharedVerbosity };

  return {};
}

function setVerbosity(
  config: VerbosityConfig,
  key: string,
  verbosity: VerbositySetting,
): VerbosityConfig {
  const models = { ...config.models };

  if (verbosity === "auto") delete models[key];
  else models[key] = verbosity;

  return { models };
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

  pi.registerCommand("verbosity", {
    description: "Set OpenAI response verbosity for the current model",
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
        ctx.ui.notify(
          "Current model does not support verbosity control. Supported APIs: openai-responses, openai-codex-responses, azure-openai-responses.",
          "warning",
        );
        updateStatus(ctx, config);
        return;
      }

      const resolved = resolveVerbosity(config, model);
      const configKey = resolved.key ?? getExactModelKey(model);
      const nextConfig = setVerbosity(config, configKey, verbosity);

      try {
        await saveConfig(nextConfig);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Failed to save ${getConfigPath()}: ${message}`, "error");
        return;
      }

      config = nextConfig;
      updateStatus(ctx, config);

      if (verbosity === "auto") {
        ctx.ui.notify("Verbosity reset to auto", "info");
        return;
      }

      ctx.ui.notify(`Verbosity set to ${verbosity}`, "info");
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

    const { verbosity } = resolveVerbosity(config, model);
    if (!verbosity) return;

    const payload = event.payload;
    if (!isObject(payload)) return;

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
