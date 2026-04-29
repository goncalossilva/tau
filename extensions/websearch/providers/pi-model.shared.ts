import type { Api, Model } from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

export interface PiModelSelection {
  model: Model<Api>;
  apiKey?: string;
  headers?: Record<string, string>;
}

export async function selectCurrentPiModel(
  ctx: ExtensionContext,
  predicate: (model: Model<Api>) => boolean,
): Promise<PiModelSelection | null> {
  if (!ctx.model || !predicate(ctx.model)) return null;

  return resolvePiModelSelection(ctx.model, ctx);
}

export async function selectFallbackPiModel(
  ctx: ExtensionContext,
  predicate: (model: Model<Api>) => boolean,
): Promise<PiModelSelection | null> {
  const currentKey =
    ctx.model && predicate(ctx.model) ? `${ctx.model.provider}:${ctx.model.id}` : null;
  const candidates = rankPiModels(
    ctx.modelRegistry.getAvailable().filter((model) => {
      if (!predicate(model)) return false;
      return `${model.provider}:${model.id}` !== currentKey;
    }),
  );

  for (const model of candidates) {
    const selection = await resolvePiModelSelection(model, ctx);
    if (selection) return selection;
  }

  return null;
}

async function resolvePiModelSelection(
  model: Model<Api>,
  ctx: Pick<ExtensionContext, "modelRegistry">,
): Promise<PiModelSelection | null> {
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  return auth.ok ? { model, apiKey: auth.apiKey, headers: auth.headers } : null;
}

function rankPiModels(models: Model<Api>[]): Model<Api>[] {
  const seen = new Set<string>();

  return [...models]
    .filter((model) => {
      const key = `${model.provider}:${model.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort(comparePiModels);
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
