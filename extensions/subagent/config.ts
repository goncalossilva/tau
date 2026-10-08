import { readFileSync } from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

interface Recommendation {
  id: string;
  when: string;
  model?: string;
  thinking?: string;
  enabled?: boolean;
}

const DEFAULT_RECOMMENDATIONS: readonly Recommendation[] = [
  {
    id: "low",
    when: "mechanical searches and extraction",
    thinking: "low",
  },
  {
    id: "medium",
    when: "bounded edits or tests with a well-defined approach",
    thinking: "medium",
  },
  {
    id: "high",
    when: "non-trivial implementation tasks, cross-cutting changes, and security or concurrency review with a reasonably understood problem and direction",
    thinking: "high",
  },
  {
    id: "xhigh",
    when: "difficult, open-ended reasoning that requires resolving substantial uncertainty or evaluating competing explanations and approaches. Ambiguous debugging and difficult investigations are examples",
    thinking: "xhigh",
  },
];
const FIELDS = new Set(["id", "when", "model", "thinking", "enabled"]);
const THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max", "inherit"]);

export function loadRecommendations(): string[] {
  const configPath = path.join(getAgentDir(), "subagent.json");
  try {
    let overrides: unknown = [];
    try {
      overrides = JSON.parse(readFileSync(configPath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const recommendations = mergeRecommendations(overrides);
    const enabled = recommendations.filter((recommendation) => recommendation.enabled !== false);
    if (!enabled.length) return [];
    return [
      "Use these task-specific subagent recommendations when applicable, in preference to general selection guidance. They are advice, not fixed tiers or automatic routing. Choose model and thinking independently; a recommendation may suggest either or both. Inherit by omitting the corresponding tool argument, not by passing the literal string inherit.",
      ...enabled.map(describeRecommendation),
    ];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid subagent config at ${configPath}: ${message}`);
  }
}

function mergeRecommendations(value: unknown): Recommendation[] {
  if (!Array.isArray(value)) throw new Error("Expected an array of recommendation overrides");
  const recommendations = new Map(DEFAULT_RECOMMENDATIONS.map((item) => [item.id, item]));
  const seen = new Set<string>();
  for (const [index, item] of value.entries()) {
    const entry = `Entry ${index + 1}`;
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error(`${entry} must be an object`);
    const raw = item as Record<string, unknown>;
    for (const key of Object.keys(raw)) {
      if (!FIELDS.has(key)) throw new Error(`${entry}: unknown field ${JSON.stringify(key)}`);
    }
    const id = readString(raw.id, `${entry}.id`);
    if (seen.has(id)) throw new Error(`${entry}: duplicate id ${JSON.stringify(id)}`);
    seen.add(id);
    const label = `${entry} (${JSON.stringify(id)})`;
    const override: Partial<Recommendation> = { id };
    if (raw.when !== undefined) override.when = readString(raw.when, `${label}.when`);
    if (raw.model !== undefined) {
      const model = readString(raw.model, `${label}.model`);
      if (model !== "inherit" && !/^[^\s/]+\/[^\s]+$/.test(model))
        throw new Error(`${label}.model must be inherit or an exact provider/model ID`);
      override.model = model;
    }
    if (raw.thinking !== undefined) {
      const thinking = readString(raw.thinking, `${label}.thinking`);
      if (!THINKING.has(thinking))
        throw new Error(`${label}.thinking must be one of ${[...THINKING].join(", ")}`);
      override.thinking = thinking;
    }
    if (raw.enabled !== undefined) {
      if (typeof raw.enabled !== "boolean") throw new Error(`${label}.enabled must be a boolean`);
      override.enabled = raw.enabled;
    }
    const merged = { ...recommendations.get(id), ...override, id };
    if (!merged.when) throw new Error(`${label}: a new recommendation requires when`);
    if (merged.model === undefined && merged.thinking === undefined)
      throw new Error(`${label}: a new recommendation requires model or thinking`);
    recommendations.set(id, { ...merged, when: merged.when });
  }
  return [...recommendations.values()];
}

function readString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${label} must be a nonblank string`);
  return value.trim();
}

function describeRecommendation(recommendation: Recommendation): string {
  const settings = (["model", "thinking"] as const).flatMap((field) => {
    const value = recommendation[field];
    if (value === undefined) return [];
    return value === "inherit"
      ? [`omit ${field} to inherit the parent's ${field === "model" ? "model" : "thinking level"}`]
      : [`prefer ${field}=${JSON.stringify(value)}`];
  });
  return `Subagent recommendation ${JSON.stringify(recommendation.id)} (${recommendation.when}): ${settings.join("; ")}.`;
}
