import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { SUBMIT_TOOL_RETRY_PROMPT } from "./prompts.js";

export const REVIEW_INSPECTION_TOOLS = "read,bash,grep,find,ls";

export const REVIEW_TASK_TIMEOUT_MS = 30 * 60 * 1000;
const REVIEW_OUTPUT_EXCERPT_MAX_LENGTH = 240;
export const REVIEW_STARTUP_RETRY_DELAYS_MS = [500, 1000, 2000, 4000, 8000] as const;
const REVIEW_STARTUP_RETRY_JITTER_RATIO = 0.2;

export type TaskErrorKind =
  | "lock_contention"
  | "missing_api_key"
  | "rate_limit"
  | "unsupported_model"
  | "unsupported_reasoning"
  | "other";

export type TaskExecutionControl = {
  isCancelled: () => boolean;
  registerProcess: (proc: ChildProcess) => () => void;
};

export type PiTaskStatus =
  | "ok"
  | "cancelled"
  | "timeout"
  | "spawn_error"
  | "non_zero_exit"
  | "assistant_error";

export type PiTaskResult = {
  status: PiTaskStatus;
  assistantOutput: string;
  stderr: string;
  exitCode?: number;
  error?: string;
  submittedPayloads: unknown[];
};

export type PiTaskOptions = {
  args: string[];
  prompt: string;
  cwd: string;
  timeoutMs: number;
  control?: TaskExecutionControl;
  submitTool?: string;
};

export type PiSubmitToolTaskOptions = PiTaskOptions & {
  submitTool: string;
};

export function withJitter(baseMs: number): number {
  const range = Math.max(0, Math.floor(baseMs * REVIEW_STARTUP_RETRY_JITTER_RATIO));
  if (range === 0) return baseMs;
  const offset = Math.floor(Math.random() * (range * 2 + 1) - range);
  return Math.max(0, baseMs + offset);
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (typeof item !== "object" || item === null) return "";
      if (!("type" in item) || item.type !== "text") return "";
      if (!("text" in item) || typeof item.text !== "string") return "";
      return item.text;
    })
    .filter(Boolean)
    .join("\n");
}

function extractAssistantMessageFromEvent(event: unknown): Record<string, unknown> | null {
  const record = asRecord(event);
  if (!record || typeof record.type !== "string") return null;

  if (record.type === "message_end" || record.type === "turn_end") {
    const message = asRecord(record.message);
    return message?.role === "assistant" ? message : null;
  }

  if (record.type !== "agent_end" || !Array.isArray(record.messages)) return null;
  for (let i = record.messages.length - 1; i >= 0; i -= 1) {
    const message = asRecord(record.messages[i]);
    if (message?.role === "assistant") {
      return message;
    }
  }
  return null;
}

function extractSubmitToolPayloadFromEvent(event: unknown, submitTool: string): unknown | null {
  const record = asRecord(event);
  if (!record || record.type !== "message_end") return null;

  const message = asRecord(record.message);
  return message?.role === "toolResult" && message.toolName === submitTool ? message.details : null;
}

export function parseJsonFromText(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Empty output");

  const codeFenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = codeFenceMatch?.[1]?.trim() || trimmed;

  try {
    return JSON.parse(candidate);
  } catch {
    const firstBrace = candidate.indexOf("{");
    const lastBrace = candidate.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      const sliced = candidate.slice(firstBrace, lastBrace + 1);
      return JSON.parse(sliced);
    }
    throw new Error("Output is not valid JSON");
  }
}

export function getSubmittedPayload(options: {
  submittedPayloads: unknown[];
  assistantOutput: string;
  submitTool: string;
  taskLabel: string;
}): { ok: true; payload: unknown } | { ok: false; error: string } {
  const { submittedPayloads, assistantOutput, submitTool, taskLabel } = options;
  if (submittedPayloads.length === 1) {
    return { ok: true, payload: submittedPayloads[0] };
  }
  if (submittedPayloads.length > 1) {
    return {
      ok: false,
      error: `${taskLabel} called ${submitTool} ${submittedPayloads.length} times.`,
    };
  }

  return {
    ok: false,
    error: buildMissingSubmitPayloadError(taskLabel, submitTool, assistantOutput),
  };
}

function buildMissingSubmitPayloadError(
  taskLabel: string,
  submitTool: string,
  assistantOutput: string,
): string {
  const collapsedOutput = assistantOutput.trim().replace(/\s+/g, " ");
  if (!collapsedOutput) return `${taskLabel} did not call ${submitTool}.`;

  const outputExcerpt =
    collapsedOutput.length <= REVIEW_OUTPUT_EXCERPT_MAX_LENGTH
      ? collapsedOutput
      : `${collapsedOutput.slice(0, REVIEW_OUTPUT_EXCERPT_MAX_LENGTH - 1).trimEnd()}…`;

  return `${taskLabel} did not call ${submitTool}. Output: ${outputExcerpt}`;
}

function extractStructuredErrorRecord(value: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 4) return null;

  const record = asRecord(value);
  if (!record) return null;

  for (const key of ["error", "details", "response", "body"]) {
    const nested = extractStructuredErrorRecord(record[key], depth + 1);
    if (nested) return nested;
  }

  return record;
}

function extractStructuredErrorMessage(value: unknown, depth = 0): string | undefined {
  if (depth > 4) return undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const message = extractStructuredErrorMessage(item, depth + 1);
      if (message) return message;
    }
    return undefined;
  }

  const record = asRecord(value);
  if (!record) return undefined;

  for (const key of ["message", "detail", "error_description", "title", "reason"]) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  for (const key of ["error", "details", "response", "body"]) {
    const message = extractStructuredErrorMessage(record[key], depth + 1);
    if (message) return message;
  }

  return undefined;
}

function parseStructuredErrorPayload(detail: string | undefined): Record<string, unknown> | null {
  const trimmed = detail?.trim();
  if (!trimmed) return null;

  const candidates = [trimmed];
  const jsonStart = trimmed.indexOf("{");
  if (jsonStart > 0) {
    candidates.push(trimmed.slice(jsonStart));
  }

  for (const candidate of candidates) {
    try {
      const parsed = parseJsonFromText(candidate);
      const record = extractStructuredErrorRecord(parsed);
      if (record) return record;
    } catch {
      // Ignore parse failures.
    }
  }

  return null;
}

function getStructuredErrorString(
  value: Record<string, unknown> | null,
  key: string,
): string | undefined {
  const candidate = value?.[key];
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : undefined;
}

function summarizeErrorDetail(detail: string | undefined): string | undefined {
  const trimmed = detail?.trim();
  if (!trimmed) return undefined;

  const payload = parseStructuredErrorPayload(trimmed);
  if (payload) {
    return extractStructuredErrorMessage(payload) ?? trimmed;
  }

  try {
    const parsed = parseJsonFromText(trimmed);
    return extractStructuredErrorMessage(parsed) ?? trimmed;
  } catch {
    return trimmed;
  }
}

export function appendErrorDetails(message: string, detail: string | undefined): string {
  const summarized = summarizeErrorDetail(detail);
  if (!summarized || summarized === message) return message;
  return `${message} Details: ${summarized}`;
}

export function buildProviderErrorMessage(message: string, detail: string | undefined): string {
  const summarized = summarizeErrorDetail(detail);
  if (!summarized || summarized === message) return message;
  if (summarized !== detail?.trim()) return summarized;
  return `${message} Details: ${summarized}`;
}

export function classifyTaskError(errorText: string): {
  errorKind: TaskErrorKind;
  missingApiProvider?: string;
} {
  if (/Lock file is already being held/i.test(errorText)) {
    return { errorKind: "lock_contention" };
  }

  const apiKeyMatch = errorText.match(/No API key found for\s+([\w.-]+)/i);
  if (apiKeyMatch?.[1]) {
    return { errorKind: "missing_api_key", missingApiProvider: apiKeyMatch[1] };
  }

  const authFailedMatch = errorText.match(/Authentication failed for\s+"([\w.-]+)"/i);
  if (authFailedMatch?.[1]) {
    return { errorKind: "missing_api_key", missingApiProvider: authFailedMatch[1] };
  }

  const payload = parseStructuredErrorPayload(errorText);
  const structuredMessage = getStructuredErrorString(payload, "message")?.toLowerCase();
  const structuredCode = getStructuredErrorString(payload, "code")?.toLowerCase();
  const structuredParam = getStructuredErrorString(payload, "param")?.toLowerCase();

  if (structuredCode === "model_not_supported" || structuredParam === "model") {
    return { errorKind: "unsupported_model" };
  }

  if (
    structuredParam?.includes("reasoning") ||
    structuredParam?.includes("thinking") ||
    structuredCode?.includes("reasoning") ||
    structuredCode?.includes("thinking") ||
    structuredMessage?.includes("reasoning") ||
    structuredMessage?.includes("thinking")
  ) {
    return { errorKind: "unsupported_reasoning" };
  }

  if (/rate.?limit|too many requests|\b429\b/i.test(errorText)) {
    return { errorKind: "rate_limit" };
  }

  const summarized = summarizeErrorDetail(errorText)?.toLowerCase();
  if (summarized?.includes("service_tier") && summarized.includes("not supported")) {
    return { errorKind: "unsupported_model" };
  }
  if (summarized?.includes("requested model is not supported")) {
    return { errorKind: "unsupported_model" };
  }
  if (
    summarized &&
    (summarized.includes("reasoning") || summarized.includes("thinking")) &&
    summarized.includes("not supported")
  ) {
    return { errorKind: "unsupported_reasoning" };
  }

  return { errorKind: "other" };
}

export async function runPiSubmitToolTask(options: PiSubmitToolTaskOptions): Promise<PiTaskResult> {
  const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "tau-review-"));
  const args = [
    ...options.args.filter((arg) => arg !== "--no-session"),
    "--session",
    path.join(sessionDir, "session.jsonl"),
  ];

  try {
    const firstResult = await runPiOneShotTask({ ...options, args });
    if (
      firstResult.status !== "ok" ||
      firstResult.submittedPayloads.length > 0 ||
      options.control?.isCancelled()
    ) {
      return firstResult;
    }

    return await runPiOneShotTask({
      ...options,
      args,
      prompt: SUBMIT_TOOL_RETRY_PROMPT.replaceAll("{SUBMIT_TOOL}", options.submitTool),
    });
  } finally {
    await fs.rm(sessionDir, { recursive: true, force: true });
  }
}

export async function runPiOneShotTask({
  args,
  prompt,
  cwd,
  timeoutMs,
  control,
  submitTool,
}: PiTaskOptions): Promise<PiTaskResult> {
  if (control?.isCancelled()) {
    return {
      status: "cancelled",
      assistantOutput: "",
      stderr: "",
      submittedPayloads: [],
    };
  }

  return new Promise<PiTaskResult>((resolve) => {
    const proc = spawn("pi", [...args, prompt], {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    const unregisterProcess = control?.registerProcess(proc);

    let stdoutBuffer = "";
    let latestAssistantOutput = "";
    let latestAssistantError = "";
    const submittedPayloads: unknown[] = [];
    let stderr = "";
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const finish = (result: Omit<PiTaskResult, "submittedPayloads">) => {
      if (settled) return;
      settled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }
      unregisterProcess?.();
      resolve({
        ...result,
        submittedPayloads,
      });
    };

    const processLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const event = JSON.parse(trimmed);
        const submittedPayload = submitTool
          ? extractSubmitToolPayloadFromEvent(event, submitTool)
          : null;
        if (submittedPayload !== null) {
          submittedPayloads.push(submittedPayload);
        }

        const message = extractAssistantMessageFromEvent(event);
        if (message) {
          const text = extractTextContent(message.content);
          if (text) latestAssistantOutput = text;
          latestAssistantError =
            message.stopReason === "error" && typeof message.errorMessage === "string"
              ? message.errorMessage
              : "";
        }
      } catch {
        // Ignore non-JSON lines.
      }
    };

    if (control?.isCancelled()) {
      try {
        proc.kill("SIGKILL");
      } catch {
        // Best effort.
      }
      finish({
        status: "cancelled",
        assistantOutput: latestAssistantOutput,
        stderr,
      });
      return;
    }

    timeoutId = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // Best effort.
      }
      finish({
        status: "timeout",
        assistantOutput: latestAssistantOutput,
        stderr,
      });
    }, timeoutMs);

    proc.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        processLine(line);
      }
    });

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    proc.on("error", (error) => {
      finish({
        status: "spawn_error",
        assistantOutput: latestAssistantOutput,
        stderr,
        error: error.message,
      });
    });

    proc.on("close", (code) => {
      if (stdoutBuffer.trim()) {
        processLine(stdoutBuffer);
      }

      if ((code ?? 1) !== 0) {
        finish({
          status: "non_zero_exit",
          assistantOutput: latestAssistantOutput,
          stderr,
          exitCode: code ?? 1,
        });
        return;
      }

      if (latestAssistantError) {
        finish({
          status: "assistant_error",
          assistantOutput: latestAssistantOutput,
          stderr,
          error: latestAssistantError,
          exitCode: 0,
        });
        return;
      }

      finish({
        status: "ok",
        assistantOutput: latestAssistantOutput,
        stderr,
        exitCode: 0,
      });
    });
  });
}
