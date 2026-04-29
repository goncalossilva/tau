import anthropicProvider from "./anthropic.js";
import githubCopilotProvider from "./github-copilot.js";
import googleGeminiCliProvider from "./google-gemini-cli.js";
import minimaxProvider from "./minimax.js";
import openAICodexProvider from "./openai-codex.js";
import openRouterProvider from "./openrouter.js";
import type { UsageProviderDefinition } from "./types.js";
import zaiProvider from "./zai.js";

export const SUPPORTED_PROVIDERS: readonly UsageProviderDefinition[] = [
  openAICodexProvider,
  anthropicProvider,
  githubCopilotProvider,
  googleGeminiCliProvider,
  openRouterProvider,
  zaiProvider,
  minimaxProvider,
];

const SUPPORTED_PROVIDER_BY_ID = new Map<string, UsageProviderDefinition>(
  SUPPORTED_PROVIDERS.map((provider) => [provider.id, provider]),
);

export function getSupportedProvider(providerId: string): UsageProviderDefinition | undefined {
  return SUPPORTED_PROVIDER_BY_ID.get(providerId);
}
