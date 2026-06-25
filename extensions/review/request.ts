import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  REVIEW_FOCUS_NAMES,
  type ReviewFocus,
  type ParsedRequest,
  type RequestSignaturePayload,
  type ReviewMessageDetails,
  type ReviewMessageKind,
  type ReviewRequestMode,
  type ReviewTarget,
} from "./schema.js";

const REVIEW_MODE_HINTS = [
  "help",
  "auto",
  "uncommitted",
  "branch",
  "commit",
  "pr",
  "folder",
  "custom",
] as const;

const REVIEW_FOCUS_ALL_VALUE = "all";
const REVIEW_FOCUS_OPTION_HINTS = [
  "focus=testing",
  `focus=${REVIEW_FOCUS_NAMES.join(",")}`,
  "focus=all",
] as const;
const VALID_REVIEW_FOCUS_VALUES = [REVIEW_FOCUS_ALL_VALUE, ...REVIEW_FOCUS_NAMES] as const;

function isHelpRequest(args: string | undefined): boolean {
  const tokens = tokenizeArgs(args?.trim() ?? "");
  if (tokens.length === 0) return false;
  const first = unquoteToken(tokens[0]).toLowerCase();
  return first === "help";
}

export function getReviewArgumentCompletions(
  prefix: string,
  extraHints: readonly string[] = [],
): Array<{ value: string; label: string }> | null {
  const completion = getCompletionToken(prefix);
  const hints = completion.isFirstToken
    ? [...extraHints, ...REVIEW_MODE_HINTS, ...REVIEW_FOCUS_OPTION_HINTS]
    : REVIEW_FOCUS_OPTION_HINTS;
  const matches = Array.from(new Set(hints)).filter((value) => value.startsWith(completion.token));
  if (matches.length === 0) return null;
  return matches.map((value) => ({ value, label: value }));
}

export function getFixArgumentCompletions(
  prefix: string,
): Array<{ value: string; label: string }> | null {
  return getReviewArgumentCompletions(prefix, ["loop"]);
}

function getCompletionToken(prefix: string): { token: string; isFirstToken: boolean } {
  const tokens = tokenizeArgs(prefix);
  if (tokens.length === 0) return { token: "", isFirstToken: true };
  if (/\s$/.test(prefix)) return { token: "", isFirstToken: false };
  return {
    token: unquoteToken(tokens[tokens.length - 1] ?? "").toLowerCase(),
    isFirstToken: tokens.length === 1,
  };
}

export function showReviewHelp(pi: ExtensionAPI) {
  pi.sendMessage({
    customType: "review",
    display: true,
    details: { kind: "help" satisfies ReviewMessageKind },
    content: `## /review help

Run findings-only code review across up to 6 parallel focuses (general, security, reuse, quality, testing, efficiency). Defaults to all focuses.

### Syntax
- \`/review [mode] [models=<a,b>] [focus=<focuses>] [context=<text>]\`
- \`/fix [loop] [mode] [models=<a,b>] [focus=<focuses>] [context=<text>]\`
- \`/triage <number|url>\`

### Modes
- \`auto\` (default): working tree first, then branch diff vs base branch.
- \`uncommitted\`: review tracked + untracked local changes.
- \`branch <name>\`: review diff from merge-base(name)..HEAD.
- \`commit <sha>\`: review one commit.
- \`pr <number|url>\`: checkout PR branch and review against PR base.
- \`folder <paths...>\`: snapshot review of files/folders (no git diff).
- \`custom "<instructions>"\`: custom scoped review instructions.

### Options
- \`models=<a,b>\`: run requested review focuses for each listed model.
- \`focus=<focuses>\`: comma-separated focuses to run: \`general\`, \`security\`, \`reuse\`, \`quality\`, \`testing\`, \`efficiency\`. Use \`focus=all\` for all focuses.
- \`context=<text>\`: add extra guidance.
  - For \`/review\`, guides every requested review focus.
  - For \`/fix\`, guides the fix pass; if \`/fix\` must run a fresh review, it guides review too.
  - For spaces, quote the value, e.g. \`context="security and backpressure"\`.

### Examples
- \`/review\`
- \`/review help\`
- \`/review branch main\`
- \`/review pr 123 models=sonnet,gpt-5\`
- \`/review folder src/features/foo focus=testing\`
- \`/review uncommitted focus=testing,quality\`
- \`/review uncommitted context="security and error handling"\`
- \`/triage 123\`
- \`/triage https://github.com/owner/repo/pull/123\`
- \`/fix\`
- \`/fix help\`
- \`/fix context="do not test mocks"\`
- \`/fix folder src/features/foo focus=testing context="testing-only cleanup"\`
- \`/fix branch main models=sonnet\`
- \`/fix loop focus=testing\`
- \`/fix loop models=sonnet,gpt-5\`

### /fix behavior
- Uses the last message only when it is a matching \`customType: "review"\` report payload.
- Otherwise, runs a fresh \`/review\` first.
- If the last review is stale, \`/fix\` warns and continues.
- If a review started by \`/fix\` goes stale mid-run, it shows the findings and applies no fixes.
- Skips execution when there are zero findings.
- \`loop\` repeats review + fix until a review produces zero findings, review fails/stales, the fix pass is aborted, or a fix pass makes no repository changes.

### /triage behavior
- Fetches PR feedback from GitHub for the given PR number or URL.
- Checks out the PR branch locally, then inspects the diff and repository state.
- Produces one triage row per feedback item with decision \`address\`, \`push_back\`, \`research\`, or \`ignore\`.`,
  });
}

function tokenizeArgs(input: string): string[] {
  return input.match(/[^\s"'=]+=(?:"[^"]*"|'[^']*')|"[^"]*"|'[^']*'|\S+/g) ?? [];
}

function unquoteToken(token: string): string {
  const quoted = token.match(/^(['"])([\s\S]*)\1$/);
  if (!quoted) return token;
  return quoted[2] ?? "";
}

function parseKeyValueOption(
  token: string,
  key: "models" | "model" | "context" | "focus" | "focuses",
): string | undefined {
  const pattern = new RegExp(`^${key}=(?:"([\\s\\S]*)"|'([\\s\\S]*)'|(\\S*))$`);
  const match = token.match(pattern);
  if (!match) return undefined;
  const value = (match[1] ?? match[2] ?? match[3] ?? "").trim();
  return value;
}

function isReviewFocus(value: string): value is ReviewFocus {
  return (REVIEW_FOCUS_NAMES as readonly string[]).includes(value);
}

function formatValidReviewFocusValues(): string {
  return VALID_REVIEW_FOCUS_VALUES.join(", ");
}

function parseFocusList(rawFocuses: string[]): { focuses: ReviewFocus[]; explicit: boolean } {
  if (rawFocuses.length === 0) {
    return { focuses: [...REVIEW_FOCUS_NAMES], explicit: false };
  }

  const selected: ReviewFocus[] = [];
  const seen = new Set<ReviewFocus>();
  let includeAll = false;

  for (const rawFocus of rawFocuses) {
    if (!rawFocus) {
      throw new Error(
        `focus= requires at least one value. Valid values: ${formatValidReviewFocusValues()}.`,
      );
    }

    for (const part of rawFocus.split(",")) {
      const focus = part.trim().toLowerCase();
      if (!focus) {
        throw new Error(
          `focus= contains an empty focus name. Valid values: ${formatValidReviewFocusValues()}.`,
        );
      }
      if (focus === REVIEW_FOCUS_ALL_VALUE) {
        includeAll = true;
        continue;
      }
      if (!isReviewFocus(focus)) {
        throw new Error(
          `Invalid focus "${part.trim()}". Valid values: ${formatValidReviewFocusValues()}.`,
        );
      }
      if (!seen.has(focus)) {
        selected.push(focus);
        seen.add(focus);
      }
    }
  }

  return {
    focuses: includeAll ? [...REVIEW_FOCUS_NAMES] : selected,
    explicit: true,
  };
}

export function parseRequestArgs(args: string | undefined): ParsedRequest {
  const raw = args?.trim() ?? "";
  if (!raw) {
    return {
      target: { type: "auto" },
      mode: "auto",
      models: [],
      focuses: [...REVIEW_FOCUS_NAMES],
      targetExplicit: false,
      focusExplicit: false,
    };
  }

  const tokens = tokenizeArgs(raw);
  const rawModels: string[] = [];
  const rawFocuses: string[] = [];
  const rawContext: string[] = [];
  const modeTokens: string[] = [];

  for (const token of tokens) {
    const modelsValue = parseKeyValueOption(token, "models") ?? parseKeyValueOption(token, "model");
    if (modelsValue !== undefined) {
      if (!modelsValue) continue;
      for (const model of modelsValue.split(",")) {
        const trimmed = model.trim();
        if (trimmed) rawModels.push(trimmed);
      }
      continue;
    }

    const focusValue = parseKeyValueOption(token, "focus") ?? parseKeyValueOption(token, "focuses");
    if (focusValue !== undefined) {
      rawFocuses.push(focusValue);
      continue;
    }

    const contextValue = parseKeyValueOption(token, "context");
    if (contextValue !== undefined) {
      if (contextValue) rawContext.push(contextValue);
      continue;
    }

    modeTokens.push(unquoteToken(token));
  }

  const models = Array.from(new Set(rawModels));
  const { focuses, explicit: focusExplicit } = parseFocusList(rawFocuses);
  const additionalContextJoined = rawContext
    .map((c) => c.trim())
    .filter(Boolean)
    .join("\n\n");
  const additionalContext =
    additionalContextJoined.length > 0 ? additionalContextJoined : undefined;
  const toMode = (target: ReviewTarget): ReviewRequestMode => {
    switch (target.type) {
      case "auto":
        return "auto";
      case "uncommitted":
        return "uncommitted";
      case "branch":
        return `branch:${target.branch}`;
      case "commit":
        return `commit:${target.sha}`;
      case "pr":
        return `pr:${target.ref}`;
      case "folder":
        return `folder:${target.paths.join(",")}`;
      case "custom":
        return "custom";
    }
  };
  const withMeta = (target: ReviewTarget, targetExplicit: boolean): ParsedRequest => ({
    target,
    mode: toMode(target),
    models,
    focuses,
    targetExplicit,
    focusExplicit,
    additionalContext,
  });

  if (modeTokens.length === 0) {
    return withMeta({ type: "auto" }, false);
  }

  const mode = modeTokens[0].toLowerCase();
  const rest = modeTokens.slice(1);

  if (mode === "auto" || mode === "uncommitted") {
    if (rest.length > 0)
      throw new Error(
        `${mode} mode does not accept positional args. Use models=..., focus=..., and/or context=...`,
      );
    return withMeta({ type: mode }, true);
  }

  if (mode === "branch" || mode === "commit" || mode === "pr") {
    if (!rest[0]) {
      if (mode === "branch")
        throw new Error("branch mode requires a branch name (e.g. /review branch main)");
      if (mode === "commit")
        throw new Error("commit mode requires a commit SHA (e.g. /review commit abc1234)");
      throw new Error("pr mode requires a PR number or URL (e.g. /review pr 123)");
    }
    if (rest.length > 1) {
      const valueLabel =
        mode === "branch" ? "branch name" : mode === "commit" ? "SHA" : "reference";
      throw new Error(
        `${mode} mode accepts one ${valueLabel}. Use models=..., focus=..., and/or context=... for options.`,
      );
    }

    if (mode === "branch") return withMeta({ type: "branch", branch: rest[0] }, true);
    if (mode === "commit") return withMeta({ type: "commit", sha: rest[0] }, true);
    return withMeta({ type: "pr", ref: rest[0] }, true);
  }
  if (mode === "folder") {
    if (rest.length === 0)
      throw new Error("folder mode requires at least one path (e.g. /review folder src docs)");
    return withMeta({ type: "folder", paths: rest.map((p) => p.trim()).filter(Boolean) }, true);
  }
  if (mode === "custom") {
    const instructions = rest.join(" ").trim();
    if (!instructions)
      throw new Error('custom mode requires instructions (e.g. /review custom "focus on auth")');
    return withMeta({ type: "custom", instructions }, true);
  }

  throw new Error(
    `Unknown mode "${mode}". Supported modes: auto, uncommitted, branch, commit, pr, folder, custom.`,
  );
}

function normalizeRequestModels(models: string[]): string[] {
  return Array.from(new Set(models)).sort((a, b) => a.localeCompare(b));
}

function normalizeRequestFocuses(focuses: readonly ReviewFocus[]): ReviewFocus[] {
  return Array.from(new Set(focuses)).sort((a, b) => a.localeCompare(b));
}

function normalizeStoredRequestFocuses(focuses: unknown): ReviewFocus[] | null {
  if (focuses === undefined) return normalizeRequestFocuses(REVIEW_FOCUS_NAMES);
  if (!Array.isArray(focuses)) return null;

  const parsedFocuses: ReviewFocus[] = [];
  for (const focus of focuses) {
    if (typeof focus !== "string" || !isReviewFocus(focus)) return null;
    parsedFocuses.push(focus);
  }
  if (parsedFocuses.length === 0) return null;
  return normalizeRequestFocuses(parsedFocuses);
}

export function buildRequestSignaturePayload(
  request: ParsedRequest,
  options: { includeAdditionalContext?: boolean } = {},
): RequestSignaturePayload {
  const additionalContext = request.additionalContext?.trim();
  const target =
    request.target.type === "folder"
      ? {
          type: "folder",
          paths: Array.from(new Set(request.target.paths)).sort((a, b) => a.localeCompare(b)),
        }
      : request.target.type === "custom"
        ? { type: "custom", instructions: request.target.instructions.trim() }
        : request.target.type === "pr"
          ? { type: "pr", ref: parsePrReference(request.target.ref) ?? request.target.ref.trim() }
          : request.target.type === "branch"
            ? { type: "branch", branch: request.target.branch }
            : request.target.type === "commit"
              ? { type: "commit", sha: request.target.sha }
              : { type: request.target.type };

  const payload: RequestSignaturePayload = {
    target,
    models: normalizeRequestModels(request.models),
    focuses: normalizeRequestFocuses(request.focuses),
  };
  if (options.includeAdditionalContext ?? true) {
    payload.additionalContext =
      additionalContext && additionalContext.length > 0 ? additionalContext : null;
  }
  return payload;
}

export function buildRequestSignature(request: ParsedRequest): string {
  return JSON.stringify(buildRequestSignaturePayload(request));
}

function buildContextlessRequestSignature(request: ParsedRequest): string {
  return JSON.stringify(buildRequestSignaturePayload(request, { includeAdditionalContext: false }));
}

function parseRequestSignaturePayload(signature: string): RequestSignaturePayload | null {
  try {
    const payload: unknown = JSON.parse(signature);
    if (!payload || typeof payload !== "object") return null;
    const { target, models, focuses } = payload as {
      target?: unknown;
      models?: unknown;
      focuses?: unknown;
    };
    if (target === undefined || !Array.isArray(models)) return null;
    const parsedModels = models.filter((model): model is string => typeof model === "string");
    if (parsedModels.length !== models.length) return null;
    const parsedFocuses = normalizeStoredRequestFocuses(focuses);
    if (!parsedFocuses) return null;
    return {
      target,
      models: normalizeRequestModels(parsedModels),
      focuses: parsedFocuses,
    };
  } catch {
    return null;
  }
}

function buildContextlessStoredRequestSignature(signature: string): string | null {
  const payload = parseRequestSignaturePayload(signature);
  if (!payload) return null;
  return JSON.stringify({
    target: payload.target,
    models: payload.models,
    focuses: payload.focuses,
  });
}

function isOpenEndedFixRequest(request: ParsedRequest): boolean {
  return !request.targetExplicit && request.models.length === 0 && !request.focusExplicit;
}

export function reviewMatchesFixRequest(
  details: ReviewMessageDetails,
  request: ParsedRequest,
): boolean {
  if (isOpenEndedFixRequest(request)) return true;
  return (
    buildContextlessStoredRequestSignature(details.request.signature) ===
    buildContextlessRequestSignature(request)
  );
}

export function parsePrReference(ref: string): number | null {
  const trimmed = ref.trim();
  if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);

  const urlMatch = trimmed.match(/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/i);
  if (!urlMatch?.[1]) return null;
  return Number.parseInt(urlMatch[1], 10);
}

export type ParseFailure = { ok: false; help?: true; error?: string };
export type ParseResult<T> = { ok: true; value: T } | ParseFailure;

export function parseCommandRequest(args: string | undefined): ParseResult<ParsedRequest> {
  if (isHelpRequest(args)) {
    return { ok: false, help: true };
  }

  try {
    return { ok: true, value: parseRequestArgs(args) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function parseFixCommandRequest(
  args: string | undefined,
): ParseResult<{ loop: boolean; request: ParsedRequest }> {
  const raw = args?.trim() ?? "";
  const first = tokenizeArgs(raw)[0];
  const loop = Boolean(first && unquoteToken(first).toLowerCase() === "loop");
  const requestArgs = loop ? raw.slice(first!.length).trim() || undefined : args;
  const parsed = parseCommandRequest(requestArgs);
  if (!parsed.ok) return parsed;
  return { ok: true, value: { loop, request: parsed.value } };
}

export function parseTriagePrRef(args: string | undefined): ParseResult<string> {
  const raw = args?.trim() ?? "";
  if (!raw) {
    return { ok: false, error: "Usage: /triage <pr-number|url>" };
  }

  const tokens = tokenizeArgs(raw).map(unquoteToken);
  if (tokens.length === 1 && tokens[0]?.toLowerCase() === "help") {
    return { ok: false, help: true };
  }
  if (tokens.length !== 1 || !tokens[0]) {
    return { ok: false, error: "Usage: /triage <pr-number|url>" };
  }
  if (!parsePrReference(tokens[0])) {
    return { ok: false, error: `Invalid PR reference: ${tokens[0]}` };
  }
  return { ok: true, value: tokens[0] };
}
