// Run the real daemon with only Telegram HTTP and unsafe subprocesses replaced.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mock } from "node:test";

for (const name of [
  "spawn",
  "spawnSync",
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
  "fork",
] as const) {
  mock.method(childProcess, name, () => {
    throw new Error(`Unexpected daemon subprocess: ${name}`);
  });
}
syncBuiltinESMExports();

let nextId = 0;
const requests = new Map<number, { resolve: (response: Response) => void }>();
process.on("message", (message) => {
  assert.ok(
    message &&
      typeof message === "object" &&
      "type" in message &&
      message.type === "response" &&
      "id" in message &&
      typeof message.id === "number" &&
      "body" in message,
  );
  const request = requests.get(message.id);
  assert.ok(request, `Unknown HTTP request ${message.id}`);
  request.resolve(Response.json(message.body));
});

globalThis.fetch = async (url, options) => {
  const prefix = "https://api.telegram.org/botfixture-token/";
  assert.ok(
    typeof url === "string" && url.startsWith(prefix),
    `Unexpected network request: ${url}`,
  );
  assert.ok(options);
  const method = url.slice(prefix.length);
  assert.ok(
    [
      "getUpdates",
      "setMyCommands",
      "sendMessage",
      "sendPhoto",
      "sendDocument",
      "answerCallbackQuery",
      "sendChatAction",
    ].includes(method),
    `Unexpected Telegram method: ${method}`,
  );
  let body: Record<string, unknown>;
  if (options.body instanceof FormData) {
    body = {};
    for (const [key, value] of options.body) {
      body[key] =
        typeof value === "string"
          ? value
          : {
              name: value.name,
              type: value.type,
              bytes: Buffer.from(await value.arrayBuffer()).toString("base64"),
            };
    }
  } else {
    assert.equal(typeof options.body, "string");
    body = JSON.parse(options.body as string);
  }
  const id = ++nextId;
  const signal = options.signal;
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  return new Promise<Response>((resolve, reject) => {
    const cleanup = () => {
      requests.delete(id);
      signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      process.send!({ type: "cancelled", id });
      reject(new DOMException("Aborted", "AbortError"));
    };
    requests.set(id, {
      resolve: (response) => {
        cleanup();
        resolve(response);
      },
    });
    signal?.addEventListener("abort", abort, { once: true });
    process.send!({ type: "request", id, method, body });
  });
};
const daemon = new URL("../../../extensions/telegram/daemon.mjs", import.meta.url).href;
await import(daemon);
