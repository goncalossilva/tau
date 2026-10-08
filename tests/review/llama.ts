import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { providerPath } from "./provider.js";
import { deadline } from "../helpers/async.js";

const spawn = childProcess.spawn;

export type LlamaRequest = {
  model: string;
  messages: { role: string; content: string }[];
  tools?: { function: { name: string } }[];
};

/** Only llama.cpp HTTP is synthetic. Native discovery, persisted catalog, auth and SSE parsing remain real. */
export async function startLlamaRouter(
  directory: string,
  cwd: string,
  failures: unknown[],
  respond: (request: LlamaRequest) => { tool?: string; payload: unknown },
) {
  const requests: LlamaRequest[] = [];
  const server = createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/models") {
        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify({
            data: [{ id: "cafe-llama", status: { value: "loaded" }, meta: { n_ctx: 32768 } }],
          }),
        );
        return;
      }
      if (request.method === "GET" && request.url === "/props?model=cafe-llama&autoload=false") {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ chat_template: "fixture" }));
        return;
      }
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/chat/completions");
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()) as LlamaRequest;
      assert.equal(body.model, "cafe-llama");
      requests.push(body);
      const reply = respond(body);
      response.setHeader("Content-Type", "text/event-stream");
      const delta = reply.tool
        ? {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "cafe-call",
                type: "function",
                function: { name: reply.tool, arguments: JSON.stringify(reply.payload) },
              },
            ],
          }
        : { role: "assistant", content: JSON.stringify(reply.payload) };
      for (const [content, finish] of [
        [delta, null],
        [{}, reply.tool ? "tool_calls" : "stop"],
      ]) {
        response.write(
          `data: ${JSON.stringify({ id: "cafe-completion", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: content, finish_reason: finish }] })}\n\n`,
        );
      }
      response.end("data: [DONE]\n\n");
    } catch (error) {
      failures.push(error);
      response.writeHead(500).end(String(error));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  return {
    url,
    requests,
    async discover() {
      const agentDir = path.join(directory, "child-agent");
      await mkdir(agentDir, { recursive: true });
      await writeFile(
        path.join(agentDir, "auth.json"),
        JSON.stringify({
          "llama.cpp": { type: "api_key", key: "local", env: { LLAMA_BASE_URL: url } },
        }),
      );
      const manifest = JSON.parse(
        await readFile(path.join(getPackageDir(), "package.json"), "utf8"),
      );
      assert.equal(manifest.version, "1.1.0");
      const child = spawn(
        process.execPath,
        [
          path.join(getPackageDir(), manifest.bin.pi),
          "--mode",
          "json",
          "--offline",
          "--no-session",
          "--no-extensions",
          "--extension",
          "builtin:llama.cpp",
          "--extension",
          providerPath,
          "--no-skills",
          "--no-prompt-templates",
          "--no-themes",
          "--no-context-files",
          "/prime-llama",
        ],
        {
          cwd,
          env: {
            ...process.env,
            PI_CODING_AGENT_DIR: agentDir,
            TAU_REVIEW_LLAMA_URL: url,
            TAU_REVIEW_LLAMA_DISCOVER: "1",
          },
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        },
      );
      const closed = once(child, "close");
      let output = "";
      child.stdout!.on("data", (data) => {
        output += data;
      });
      child.stderr!.on("data", (data) => {
        output += data;
      });
      let model: Model<string> | undefined;
      child.on("message", (message: { type: string; model?: Model<string> }) => {
        if (message.type === "catalog") model = message.model;
        else if (message.type !== "isolation") failures.push(message);
      });
      try {
        const [code] = await deadline(closed, "native llama catalog discovery");
        assert.equal(code, 0, output);
        assert.ok(model, `native llama discovery must populate the child catalog: ${output}`);
        return model;
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await closed;
      }
    },
    async dispose() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
