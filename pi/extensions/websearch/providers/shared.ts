export function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
}

export async function fetchJson<T>(url: string, options: RequestInit = {}): Promise<T> {
  return JSON.parse(await fetchText(url, options)) as T;
}

export async function fetchText(url: string, options: RequestInit = {}): Promise<string> {
  const response = await fetch(url, options);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}${text ? `\n${text}` : ""}`);
  }
  return text;
}

export async function readEventStream(
  response: Response,
  onEvent: (event: { event?: string; data: string }) => void,
): Promise<void> {
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${response.status} ${response.statusText}${text ? `\n${text}` : ""}`);
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
