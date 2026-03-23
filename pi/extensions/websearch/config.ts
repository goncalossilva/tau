import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { WebsearchConfig, WebsearchRouteId } from "./types.js";

const WEBSEARCH_CONFIG_PATH = path.join(homedir(), ".pi", "websearch.json");

const DEFAULT_ROUTES: WebsearchRouteId[] = [
  "pi:openai-codex",
  "pi:anthropic",
  "pi:gemini",
  "firefox:gemini",
  "firefox:openai-codex",
  "chromium:gemini",
  "chromium:openai-codex",
];

function sanitizeRoutes(value: unknown): WebsearchRouteId[] {
  if (value === undefined) return [...DEFAULT_ROUTES];
  if (!Array.isArray(value)) {
    throw new Error("websearch config routes must be an array.");
  }

  const valid = new Set<WebsearchRouteId>(DEFAULT_ROUTES);
  const result: WebsearchRouteId[] = [];

  for (const item of value) {
    if (typeof item !== "string" || !valid.has(item as WebsearchRouteId)) {
      throw new Error(`Invalid websearch route: ${String(item)}`);
    }
    if (!result.includes(item as WebsearchRouteId)) {
      result.push(item as WebsearchRouteId);
    }
  }

  return result;
}

function sanitizeProfileName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function loadConfig(): WebsearchConfig {
  let raw: Record<string, unknown> = {};

  try {
    raw = JSON.parse(readFileSync(WEBSEARCH_CONFIG_PATH, "utf8")) as Record<string, unknown>;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? (error as { code?: string }).code
      : undefined;
    if (code === "ENOENT") {
      raw = {};
    } else {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid websearch config at ${WEBSEARCH_CONFIG_PATH}: ${message}`);
    }
  }

  const profiles = raw.profiles && typeof raw.profiles === "object"
    ? raw.profiles as Record<string, unknown>
    : {};

  return {
    routes: sanitizeRoutes(raw.routes),
    profiles: {
      firefox: sanitizeProfileName(profiles.firefox),
      chromium: sanitizeProfileName(profiles.chromium),
    },
  };
}
