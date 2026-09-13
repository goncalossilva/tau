import type { Api, Model, ProviderHeaders } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface PiModelSelection {
  model: Model<Api>;
  apiKey?: string;
  headers?: ProviderHeaders;
  env?: Record<string, string>;
}

export function getPiModelCandidates(
  ctx: ExtensionContext,
  predicate: (model: Model<Api>) => boolean,
  fallbackModels?: readonly string[],
): Model<Api>[] {
  const available = ctx.modelRegistry.getAvailable().filter(predicate);
  const fallbacks = fallbackModels
    ? fallbackModels.flatMap((id) => available.filter((model) => model.id === id))
    : available.sort(comparePiModels);
  const candidates = ctx.model && predicate(ctx.model) ? [ctx.model, ...fallbacks] : fallbacks;
  const seen = new Set<string>();
  return candidates.filter((model) => {
    const key = `${model.provider}:${model.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Consume candidates lazily so unused routes and alternate models never resolve credentials. */
export async function selectNextPiModel(
  ctx: ExtensionContext,
  remaining: Model<Api>[],
  signal?: AbortSignal,
): Promise<PiModelSelection | null> {
  while (remaining.length > 0) {
    signal?.throwIfAborted();
    const selection = await resolvePiModelSelection(remaining.shift()!, ctx);
    if (selection) return selection;
  }
  return null;
}

async function resolvePiModelSelection(
  model: Model<Api>,
  ctx: Pick<ExtensionContext, "modelRegistry">,
): Promise<PiModelSelection | null> {
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  return auth.ok
    ? {
        model: resolveModelEndpoint(model, auth.baseUrl, auth.env),
        apiKey: auth.apiKey,
        headers: auth.headers,
        env: auth.env,
      }
    : null;
}

function resolveModelEndpoint(
  model: Model<Api>,
  resolvedBaseUrl?: string,
  env?: Record<string, string>,
): Model<Api> {
  let baseUrl = resolvedBaseUrl ?? model.baseUrl;
  if (!baseUrl) return model;

  for (const [name, value] of Object.entries(env ?? {})) {
    baseUrl = baseUrl.replaceAll(`{${name}}`, value);
  }
  return baseUrl === model.baseUrl ? model : { ...model, baseUrl };
}

function comparePiModels(left: Model<Api>, right: Model<Api>): number {
  return (
    compareBoolean(Boolean(right.reasoning), Boolean(left.reasoning)) ||
    compareNumber(right.contextWindow, left.contextWindow) ||
    compareNumber(right.maxTokens, left.maxTokens) ||
    compareNumber(modelCostScore(right), modelCostScore(left)) ||
    right.id.localeCompare(left.id)
  );
}

function modelCostScore(model: Model<Api>): number {
  return (
    (model.cost?.input ?? 0) +
    (model.cost?.output ?? 0) +
    (model.cost?.cacheRead ?? 0) +
    (model.cost?.cacheWrite ?? 0)
  );
}

function compareBoolean(left: boolean, right: boolean): number {
  return Number(left) - Number(right);
}

function compareNumber(left: number, right: number): number {
  return left - right;
}
