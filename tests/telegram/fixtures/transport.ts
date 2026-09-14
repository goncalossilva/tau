// Run the real daemon with Telegram HTTP replaced and native RPC subprocess launches inspected.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import type {} from "./rpc.js";

const spawn = childProcess.spawn;
const rpcPath = fileURLToPath(new URL("./rpc.js", import.meta.url));

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
let launched = false;
mock.method(
  childProcess,
  "spawn",
  (command: string, args: string[], options: childProcess.SpawnOptions) => {
    assert.equal(launched, false, "Only one headless launch is expected");
    launched = true;
    const entrypoint = process.env.TAU_TELEGRAM_PI_ENTRYPOINT;
    assert.equal(command, entrypoint ? process.execPath : "pi");
    assert.deepEqual(args, entrypoint ? [rpcPath, "--mode", "rpc"] : ["--mode", "rpc"]);
    assert.equal(
      options.cwd,
      path.join(path.dirname(process.env.PI_CODING_AGENT_DIR!), "otter-workshop"),
    );
    process.send!({
      type: "launch",
      command,
      args,
      cwd: options.cwd,
      agentDir: options.env?.PI_CODING_AGENT_DIR,
      disabled: options.env?.TAU_TELEGRAM_DISABLE,
      token: options.env?.TAU_TELEGRAM_BOT_TOKEN,
    });
    // The explicit entrypoint runs unchanged. Only PATH's `pi` is substituted in the fallback case.
    return spawn(
      command === "pi" ? process.execPath : command,
      command === "pi" ? [rpcPath, ...args] : args,
      options,
    );
  },
);
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
