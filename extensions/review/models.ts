import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const OPENAI_FAST_MODEL_ID = "gpt-5.3-codex-spark";
const ANTHROPIC_FAST_MODEL_ID = "claude-haiku-4-5";

type ModelFamily = "openai" | "anthropic";

export type ReviewThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

export type ReviewThinkingSource = "explicit" | "inherited";

export type ResolvedReviewProviderCandidate = {
  modelArg?: string;
  baseModelArg?: string;
  supportsThinking?: boolean;
  supportsXhigh?: boolean;
  supportsMax?: boolean;
};

export type ResolvedReviewModel = {
  modelPattern: string;
  modelPatternBase: string;
  thinkingSource: ReviewThinkingSource;
  requestedThinkingLevel?: ReviewThinkingLevel;
  providerCandidates: ResolvedReviewProviderCandidate[];
};

const providerCandidateAvailabilityCache = new WeakMap<
  ResolvedReviewModel,
  Map<string, "supported" | "unsupported">
>();
const providerCandidateProbeCache = new WeakMap<
  ResolvedReviewModel,
  Map<string, Promise<"supported" | "unsupported">>
>();

function getProviderCandidateCacheKey(candidate: ResolvedReviewProviderCandidate): string {
  return candidate.modelArg ?? candidate.baseModelArg ?? "__default__";
}

function getProviderCandidateAvailabilityMap(
  model: ResolvedReviewModel,
): Map<string, "supported" | "unsupported"> {
  let cache = providerCandidateAvailabilityCache.get(model);
  if (!cache) {
    cache = new Map();
    providerCandidateAvailabilityCache.set(model, cache);
  }
  return cache;
}

function getProviderCandidateProbeMap(
  model: ResolvedReviewModel,
): Map<string, Promise<"supported" | "unsupported">> {
  let cache = providerCandidateProbeCache.get(model);
  if (!cache) {
    cache = new Map();
    providerCandidateProbeCache.set(model, cache);
  }
  return cache;
}

export function getProviderCandidateAvailability(
  model: ResolvedReviewModel,
  candidate: ResolvedReviewProviderCandidate,
): "supported" | "unsupported" | undefined {
  return getProviderCandidateAvailabilityMap(model).get(getProviderCandidateCacheKey(candidate));
}

export function setProviderCandidateAvailability(
  model: ResolvedReviewModel,
  candidate: ResolvedReviewProviderCandidate,
  availability: "supported" | "unsupported",
): void {
  getProviderCandidateAvailabilityMap(model).set(
    getProviderCandidateCacheKey(candidate),
    availability,
  );
}

export function getProviderCandidateProbe(
  model: ResolvedReviewModel,
  candidate: ResolvedReviewProviderCandidate,
): Promise<"supported" | "unsupported"> | undefined {
  return getProviderCandidateProbeMap(model).get(getProviderCandidateCacheKey(candidate));
}

export function setProviderCandidateProbe(
  model: ResolvedReviewModel,
  candidate: ResolvedReviewProviderCandidate,
  probe: Promise<"supported" | "unsupported">,
): void {
  getProviderCandidateProbeMap(model).set(getProviderCandidateCacheKey(candidate), probe);
}

export function clearProviderCandidateProbe(
  model: ResolvedReviewModel,
  candidate: ResolvedReviewProviderCandidate,
): void {
  getProviderCandidateProbeMap(model).delete(getProviderCandidateCacheKey(candidate));
}

const REVIEW_THINKING_LEVEL_ORDER: ReviewThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
const REVIEW_THINKING_LEVELS = new Set<ReviewThinkingLevel>(REVIEW_THINKING_LEVEL_ORDER);

function detectModelFamily(provider: string): ModelFamily | null {
  const normalizedProvider = provider.toLowerCase();
  if (normalizedProvider.includes("openai")) return "openai";
  if (normalizedProvider.includes("anthropic")) return "anthropic";
  return null;
}

function isReviewThinkingLevel(value: string): value is ReviewThinkingLevel {
  return REVIEW_THINKING_LEVELS.has(value as ReviewThinkingLevel);
}

function splitModelPatternThinkingSuffix(modelPattern: string): {
  basePattern: string;
  thinkingSuffix?: ReviewThinkingLevel;
} {
  const lastColon = modelPattern.lastIndexOf(":");
  if (lastColon <= 0) return { basePattern: modelPattern };

  const thinkingSuffix = modelPattern
    .slice(lastColon + 1)
    .trim()
    .toLowerCase();
  if (!isReviewThinkingLevel(thinkingSuffix)) {
    return { basePattern: modelPattern };
  }

  const basePattern = modelPattern.slice(0, lastColon).trim();
  return basePattern ? { basePattern, thinkingSuffix } : { basePattern: modelPattern };
}

function clampInheritedThinkingLevel(
  thinkingLevel: ReviewThinkingLevel,
  supportsThinking: boolean | undefined,
  supportsXhighThinking: boolean | undefined,
  supportsMaxThinking: boolean | undefined,
): ReviewThinkingLevel {
  if (supportsThinking === false) return "off";
  if (thinkingLevel === "max" && supportsMaxThinking === false) {
    return supportsXhighThinking === false ? "high" : "xhigh";
  }
  if (thinkingLevel === "xhigh" && supportsXhighThinking === false) return "high";
  return thinkingLevel;
}

export function getFallbackThinkingLevels(
  thinkingLevel: ReviewThinkingLevel,
): ReviewThinkingLevel[] {
  const requestedIndex = REVIEW_THINKING_LEVEL_ORDER.indexOf(thinkingLevel);
  if (requestedIndex === -1) return [];
  return REVIEW_THINKING_LEVEL_ORDER.slice(0, requestedIndex + 1).reverse();
}

function buildGlobRegExp(pattern: string): RegExp {
  let regex = "^";

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      regex += ".*";
      continue;
    }
    if (char === "?") {
      regex += ".";
      continue;
    }
    if (char === "[") {
      const closingIndex = pattern.indexOf("]", index + 1);
      if (closingIndex > index + 1) {
        regex += pattern.slice(index, closingIndex + 1);
        index = closingIndex;
        continue;
      }
    }
    regex += char.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  }

  return new RegExp(`${regex}$`, "i");
}

export function appendModelThinkingSuffix(
  modelArg: string,
  thinkingSuffix: ReviewThinkingLevel | undefined,
): string {
  return thinkingSuffix ? `${modelArg}:${thinkingSuffix}` : modelArg;
}

function createResolvedReviewProviderCandidate(options: {
  modelArg?: string;
  baseModelArg?: string;
  supportsThinking?: boolean;
  supportsXhigh?: boolean;
  supportsMax?: boolean;
}): ResolvedReviewProviderCandidate {
  return {
    modelArg: options.modelArg,
    baseModelArg: options.baseModelArg,
    supportsThinking: options.supportsThinking,
    supportsXhigh: options.supportsXhigh,
    supportsMax: options.supportsMax,
  };
}

export function getResolvedReviewPrimaryProviderCandidate(
  model: ResolvedReviewModel,
): ResolvedReviewProviderCandidate {
  return model.providerCandidates[0] ?? createResolvedReviewProviderCandidate({});
}

export function getResolvedReviewCurrentThinkingLevel(
  model: ResolvedReviewModel,
  providerCandidate: ResolvedReviewProviderCandidate,
): ReviewThinkingLevel | undefined {
  if (model.requestedThinkingLevel === undefined) return undefined;
  return model.thinkingSource === "inherited"
    ? clampInheritedThinkingLevel(
        model.requestedThinkingLevel,
        providerCandidate.supportsThinking,
        providerCandidate.supportsXhigh,
        providerCandidate.supportsMax,
      )
    : model.requestedThinkingLevel;
}

function shouldShowResolvedReviewThinkingSuffix(
  thinkingSource: ReviewThinkingSource,
  requestedThinkingLevel: ReviewThinkingLevel | undefined,
  currentThinkingLevel: ReviewThinkingLevel | undefined,
): boolean {
  if (!currentThinkingLevel) return false;
  if (thinkingSource === "explicit") return true;
  return requestedThinkingLevel !== undefined && requestedThinkingLevel !== currentThinkingLevel;
}

export function buildResolvedReviewModelLabel(
  model: ResolvedReviewModel,
  currentThinkingLevel: ReviewThinkingLevel | undefined,
): string {
  if (model.thinkingSource === "explicit") return model.modelPattern;
  return shouldShowResolvedReviewThinkingSuffix(
    model.thinkingSource,
    model.requestedThinkingLevel,
    currentThinkingLevel,
  )
    ? appendModelThinkingSuffix(model.modelPatternBase, currentThinkingLevel)
    : model.modelPatternBase;
}

export function getResolvedReviewStatusModelArg(model: ResolvedReviewModel): string | undefined {
  const providerCandidate = getResolvedReviewPrimaryProviderCandidate(model);
  if (providerCandidate.modelArg) return providerCandidate.modelArg;
  if (!providerCandidate.baseModelArg) return undefined;
  return appendModelThinkingSuffix(
    providerCandidate.baseModelArg,
    getResolvedReviewCurrentThinkingLevel(model, providerCandidate),
  );
}

export function buildResolvedReviewStatusModelLabel(model: ResolvedReviewModel): string {
  const providerCandidate = getResolvedReviewPrimaryProviderCandidate(model);
  const currentThinkingLevel = getResolvedReviewCurrentThinkingLevel(model, providerCandidate);
  if (!providerCandidate.baseModelArg) {
    return buildResolvedReviewModelLabel(model, currentThinkingLevel);
  }

  return shouldShowResolvedReviewThinkingSuffix(
    model.thinkingSource,
    model.requestedThinkingLevel,
    currentThinkingLevel,
  )
    ? appendModelThinkingSuffix(providerCandidate.baseModelArg, currentThinkingLevel)
    : providerCandidate.baseModelArg;
}

export function buildReviewProgressModelLabel(model: ResolvedReviewModel): string {
  return getResolvedReviewStatusModelArg(model) ?? buildResolvedReviewStatusModelLabel(model);
}

function createResolvedReviewModel(options: {
  modelPattern: string;
  modelPatternBase: string;
  thinkingSource: ReviewThinkingSource;
  requestedThinkingLevel?: ReviewThinkingLevel;
  providerCandidates: ResolvedReviewProviderCandidate[];
}): ResolvedReviewModel {
  return {
    modelPattern: options.modelPattern,
    modelPatternBase: options.modelPatternBase,
    thinkingSource: options.thinkingSource,
    requestedThinkingLevel: options.requestedThinkingLevel,
    providerCandidates:
      options.providerCandidates.length > 0
        ? options.providerCandidates
        : [createResolvedReviewProviderCandidate({})],
  };
}

export function selectReviewDedupModel(ctx: ExtensionContext): { modelArg: string } | null {
  if (!ctx.model) return null;

  const family = detectModelFamily(ctx.model.provider);
  if (family) {
    const modelId = family === "openai" ? OPENAI_FAST_MODEL_ID : ANTHROPIC_FAST_MODEL_ID;
    const providerCandidates =
      family === "openai"
        ? [ctx.model.provider, "openai-codex", "openai"]
        : [ctx.model.provider, "anthropic"];
    const availableModels = ctx.modelRegistry.getAvailable();

    for (const provider of new Set(providerCandidates)) {
      const candidate = availableModels.find(
        (model) => model.provider === provider && model.id === modelId,
      );
      if (!candidate) continue;

      return {
        modelArg: `${candidate.provider}/${candidate.id}`,
      };
    }
  }

  return {
    modelArg: `${ctx.model.provider}/${ctx.model.id}`,
  };
}

function rankModelCandidateGroup<T extends { id: string; provider: string }>(candidates: T[]): T[] {
  if (candidates.length === 0) return [];

  const aliases = candidates.filter(
    (candidate) => candidate.id.endsWith("-latest") || !/-\d{8}$/.test(candidate.id),
  );
  const ranked = (aliases.length > 0 ? aliases : candidates).slice();
  ranked.sort((a, b) => b.id.localeCompare(a.id));
  return ranked;
}

function rankPreferredModelCandidates<T extends { id: string; provider: string }>(
  candidates: T[],
  currentProvider: string | undefined,
  modelRegistry: ExtensionContext["modelRegistry"],
): T[] {
  if (candidates.length === 0) return [];

  const preferredProviderCandidates = currentProvider
    ? candidates.filter(
        (candidate) => candidate.provider.toLowerCase() === currentProvider.toLowerCase(),
      )
    : [];
  const otherProviderCandidates = currentProvider
    ? candidates.filter(
        (candidate) => candidate.provider.toLowerCase() !== currentProvider.toLowerCase(),
      )
    : candidates;

  return [
    ...rankModelCandidateGroup(preferredProviderCandidates),
    ...rankModelCandidatesByProviderAuth(otherProviderCandidates, modelRegistry),
  ];
}

function shouldTreatAsExplicitProviderPattern(
  modelPattern: string,
  availableModels: Array<Model<Api>>,
  modelRegistry: ExtensionContext["modelRegistry"],
): boolean {
  const slash = modelPattern.indexOf("/");
  if (slash <= 0) return false;

  const providerPrefix = modelPattern.slice(0, slash);
  const provider = availableModels.find(
    (model) => model.provider.toLowerCase() === providerPrefix.toLowerCase(),
  )?.provider;
  if (!provider) return false;

  const providerModel = availableModels.find(
    (model) =>
      model.provider.toLowerCase() === provider.toLowerCase() &&
      model.id.toLowerCase() === modelPattern.slice(slash + 1).toLowerCase(),
  );
  const rawModelMatches = availableModels.filter(
    (model) => model.id.toLowerCase() === modelPattern.toLowerCase(),
  );
  if (rawModelMatches.length === 0) return true;
  if (!providerModel) return false;
  if (modelRegistry.hasConfiguredAuth(providerModel)) return true;

  return !rawModelMatches.some((model) => modelRegistry.hasConfiguredAuth(model));
}

function rankModelCandidatesByProviderAuth<T extends { id: string; provider: string }>(
  candidates: T[],
  modelRegistry: ExtensionContext["modelRegistry"],
): T[] {
  const grouped = new Map<number, T[]>();
  for (const candidate of candidates) {
    let rank: number;
    switch (modelRegistry.getProviderAuthStatus(candidate.provider).source) {
      case "stored":
      case "runtime":
      case "fallback":
      case "models_json_key":
      case "models_json_command":
        rank = 0;
        break;
      case "environment":
        rank = 1;
        break;
      default:
        rank = 2;
        break;
    }

    const group = grouped.get(rank) ?? [];
    group.push(candidate);
    grouped.set(rank, group);
  }

  return [...grouped.entries()]
    .sort(([left], [right]) => left - right)
    .flatMap(([, group]) => rankModelCandidateGroup(group));
}

function createResolvedReviewProviderCandidateFromModel(
  model: Model<Api>,
): ResolvedReviewProviderCandidate {
  const supportedThinkingLevels = getSupportedThinkingLevels(model);
  return createResolvedReviewProviderCandidate({
    baseModelArg: `${model.provider}/${model.id}`,
    supportsThinking: model.reasoning,
    supportsXhigh: supportedThinkingLevels.includes("xhigh"),
    supportsMax: supportedThinkingLevels.includes("max"),
  });
}

function getProviderFallbackModelKey(model: { id: string }): string {
  const slash = model.id.lastIndexOf("/");
  return slash === -1 ? model.id : model.id.slice(slash + 1);
}

function resolveUnqualifiedModelPattern(
  modelPattern: string,
  availableModels: Array<Model<Api>>,
  currentProvider: string | undefined,
  modelRegistry: ExtensionContext["modelRegistry"],
  inheritedThinkingLevel: ReviewThinkingLevel,
): ResolvedReviewModel | undefined {
  const { basePattern, thinkingSuffix } = splitModelPatternThinkingSuffix(modelPattern);
  const thinkingSource: ReviewThinkingSource = thinkingSuffix ? "explicit" : "inherited";
  const requestedThinkingLevel = thinkingSuffix ?? inheritedThinkingLevel;
  const normalizedPattern = basePattern.toLowerCase();
  const hasWildcard =
    basePattern.includes("*") || basePattern.includes("?") || basePattern.includes("[");
  const globMatcher = hasWildcard ? buildGlobRegExp(basePattern) : undefined;
  const exactMatches = hasWildcard
    ? []
    : availableModels.filter((model) => model.id.toLowerCase() === normalizedPattern);
  const candidates =
    exactMatches.length > 0
      ? exactMatches
      : availableModels.filter((model) => {
          if (globMatcher) {
            const fullReference = `${model.provider}/${model.id}`;
            return (
              globMatcher.test(model.id) ||
              (model.name ? globMatcher.test(model.name) : false) ||
              globMatcher.test(fullReference)
            );
          }

          const byId = model.id.toLowerCase().includes(normalizedPattern);
          const byName = model.name?.toLowerCase().includes(normalizedPattern) ?? false;
          return byId || byName;
        });
  if (candidates.length === 0) return undefined;

  const rankedCandidates = rankPreferredModelCandidates(candidates, currentProvider, modelRegistry);
  const preferredCandidate = rankedCandidates[0];
  const providerFallbackCandidates = rankedCandidates.filter(
    (candidate) =>
      getProviderFallbackModelKey(candidate) === getProviderFallbackModelKey(preferredCandidate),
  );

  return createResolvedReviewModel({
    modelPattern,
    modelPatternBase: basePattern,
    thinkingSource,
    requestedThinkingLevel,
    providerCandidates: providerFallbackCandidates.map(
      createResolvedReviewProviderCandidateFromModel,
    ),
  });
}

export async function resolveModels(
  ctx: ExtensionContext,
  requestedModels: string[],
  currentThinkingLevel: ReviewThinkingLevel,
): Promise<ResolvedReviewModel[]> {
  ctx.modelRegistry.refresh();
  const currentProvider = typeof ctx.model?.provider === "string" ? ctx.model.provider : undefined;
  const currentModelId = ctx.model?.id;
  const allModels = ctx.modelRegistry.getAll();

  const resolveRequestedModel = (modelPattern: string): ResolvedReviewModel => {
    const { basePattern, thinkingSuffix } = splitModelPatternThinkingSuffix(modelPattern);
    const thinkingSource: ReviewThinkingSource = thinkingSuffix ? "explicit" : "inherited";
    const requestedThinkingLevel = thinkingSuffix ?? currentThinkingLevel;
    const isExplicitProvider = shouldTreatAsExplicitProviderPattern(
      basePattern,
      allModels,
      ctx.modelRegistry,
    );
    if (isExplicitProvider) {
      const exactCandidate = allModels.find(
        (model) => `${model.provider}/${model.id}`.toLowerCase() === basePattern.toLowerCase(),
      );
      return createResolvedReviewModel({
        modelPattern,
        modelPatternBase: basePattern,
        thinkingSource,
        requestedThinkingLevel,
        providerCandidates: [
          exactCandidate
            ? createResolvedReviewProviderCandidateFromModel(exactCandidate)
            : createResolvedReviewProviderCandidate({ modelArg: modelPattern }),
        ],
      });
    }

    const resolved = resolveUnqualifiedModelPattern(
      modelPattern,
      allModels,
      currentProvider,
      ctx.modelRegistry,
      currentThinkingLevel,
    );
    if (resolved) return resolved;

    return createResolvedReviewModel({
      modelPattern,
      modelPatternBase: basePattern,
      thinkingSource,
      requestedThinkingLevel,
      providerCandidates: [createResolvedReviewProviderCandidate({ modelArg: modelPattern })],
    });
  };

  if (requestedModels.length > 0) {
    return requestedModels.map(resolveRequestedModel);
  }

  const modelPatternBase = currentModelId ?? "default";
  const baseModelArg =
    currentModelId && currentProvider ? `${currentProvider}/${currentModelId}` : currentModelId;
  return [
    createResolvedReviewModel({
      modelPattern: modelPatternBase,
      modelPatternBase,
      thinkingSource: "inherited",
      requestedThinkingLevel: currentThinkingLevel,
      providerCandidates: [
        createResolvedReviewProviderCandidate({
          baseModelArg,
          supportsThinking: ctx.model?.reasoning,
          supportsXhigh: ctx.model
            ? getSupportedThinkingLevels(ctx.model).includes("xhigh")
            : undefined,
          supportsMax: ctx.model
            ? getSupportedThinkingLevels(ctx.model).includes("max")
            : undefined,
        }),
      ],
    }),
  ];
}
