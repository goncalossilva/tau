import type { Api, Model } from "@earendil-works/pi-ai";

export function isModelUnavailableError(error: unknown, model: Model<Api>): boolean {
  if (!(error instanceof HttpError) || (error.status !== 400 && error.status !== 404)) {
    return false;
  }
  if (!isRecord(error.body)) return false;

  const detail = isRecord(error.body.error) ? error.body.error : undefined;
  if (model.provider === "openai-codex" && model.api === "openai-codex-responses") {
    return (
      (error.status === 400 &&
        Boolean(model.id) &&
        error.body.detail ===
          `The '${model.id}' model is not supported when using Codex with a ChatGPT account.`) ||
      detail?.code === "model_not_found" ||
      detail?.code === "model_not_supported" ||
      detail?.code === "unsupported_model"
    );
  }

  if (error.status !== 404 || !detail) return false;
  if (model.provider === "anthropic" && model.api === "anthropic-messages") {
    return (
      error.body.type === "error" &&
      detail.type === "not_found_error" &&
      Boolean(model.id) &&
      typeof detail.message === "string" &&
      detail.message.trim() === `model: ${model.id}`
    );
  }

  if (model.provider === "google" && model.api === "google-generative-ai") {
    return detail.code === "model_not_found";
  }

  return false;
}

export function applyResolvedHeaders(
  defaults: Record<string, string>,
  overrides?: Record<string, string | null>,
): Record<string, string> {
  const headers = { ...defaults };

  for (const [name, value] of Object.entries(overrides ?? {})) {
    const existingName = Object.keys(headers).find(
      (candidate) => candidate.toLowerCase() === name.toLowerCase(),
    );
    if (existingName) delete headers[existingName];
    if (value !== null) headers[name] = value;
  }

  return headers;
}

export function getResolvedHeader(
  headers: Record<string, string | null> | undefined,
  name: string,
): string | undefined {
  const entry = Object.entries(headers ?? {}).find(
    ([candidate]) => candidate.toLowerCase() === name.toLowerCase(),
  );
  return entry?.[1] ?? undefined;
}

export function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  return signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
}

export async function fetchJson<T>(url: string, options: RequestInit = {}): Promise<T> {
  return JSON.parse(await fetchText(url, options)) as T;
}

export async function fetchText(url: string, options: RequestInit = {}): Promise<string> {
  const response = await fetch(url, options);
  const text = await response.text();
  if (!response.ok) {
    throw new HttpError(response, text);
  }
  return text;
}

export async function readEventStream(
  response: Response,
  onEvent: (event: { event?: string; data: string }) => void,
): Promise<void> {
  if (!response.ok) {
    const text = await response.text();
    throw new HttpError(response, text);
  }

  if (!response.body) {
    throw new Error("Missing response body.");
  }

  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    buffer = buffer.replace(/\r\n/g, "\n");

    while (true) {
      const separatorIndex = buffer.indexOf("\n\n");
      if (separatorIndex === -1) break;

      const block = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);
      emitEventBlock(block, onEvent);
    }
  }

  buffer = buffer.replace(/\r\n/g, "\n");
  if (buffer.trim().length > 0) {
    emitEventBlock(buffer, onEvent);
  }
}

class HttpError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(response: Response, text: string) {
    super(`${response.status} ${response.statusText}${text ? `\n${text}` : ""}`);
    this.status = response.status;
    try {
      this.body = JSON.parse(text);
    } catch {
      this.body = undefined;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function emitEventBlock(
  block: string,
  onEvent: (event: { event?: string; data: string }) => void,
): void {
  let eventName: string | undefined;
  const dataLines: string[] = [];

  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (dataLines.length > 0) {
    onEvent({ event: eventName, data: dataLines.join("\n") });
  }
}
