import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { InMemoryCredentialStore, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionUIContext,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";

/**
 * Create real, isolated Pi resources with in-memory credentials, settings, and session history.
 * Load only the supplied extensions, with model-catalog network access and unrelated resource discovery disabled.
 */
export async function createPiResources(
  cwd: string,
  agentDir: string,
  extensions: InlineExtension[],
) {
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStorePath: path.join(agentDir, "models-store.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "Reply to the user's message.",
    extensionFactories: extensions,
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  return {
    cwd,
    agentDir,
    settingsManager,
    modelRuntime,
    resourceLoader,
    sessionManager: SessionManager.inMemory(cwd),
  };
}

/**
 * Give a suite its own temporary home/config paths, restored and removed on disposal.
 * Call before importing extensions with module-scoped paths; credential isolation remains the runner's job.
 */
export async function isolatePiHome() {
  const home = await mkdtemp(path.join(os.tmpdir(), "tau-pi-home-"));
  const environment = {
    HOME: home,
    USERPROFILE: home,
    PI_CODING_AGENT_DIR: path.join(home, "agent"),
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_CACHE_HOME: path.join(home, "cache"),
    XDG_DATA_HOME: path.join(home, "data"),
    XDG_STATE_HOME: path.join(home, "state"),
  };
  const previous = Object.fromEntries(
    Object.keys(environment).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, environment);
  return {
    async dispose() {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(home, { recursive: true, force: true });
    },
  };
}

/** Expose only the supplied UI operations, recording and rejecting unexpected access even if Pi catches it. */
export function uiBoundary(implementation: Partial<ExtensionUIContext>, errors: unknown[]) {
  return new Proxy(implementation, {
    get(target, key) {
      if (key in target) return Reflect.get(target, key);
      const error = new Error(`Unexpected UI operation: ${String(key)}`);
      errors.push(error);
      throw error;
    },
  }) as ExtensionUIContext;
}

export const fixtureModel: Model<"test"> = {
  id: "reply",
  name: "Scripted reply",
  provider: "test",
  api: "test",
  baseUrl: "https://test.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 64,
};

/** Build a completed text-only reply with zero usage for scripted generation or lifecycle events. */
export function assistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    api: fixtureModel.api,
    provider: fixtureModel.provider,
    model: fixtureModel.id,
    content: [{ type: "text", text }],
    stopReason: "stop",
    timestamp: 0,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}
