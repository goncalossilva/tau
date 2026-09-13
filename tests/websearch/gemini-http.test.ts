import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import type { Socket } from "node:net";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import { gzipSync } from "node:zlib";
import undici, { getGlobalDispatcher, type Dispatcher } from "undici";
import { browserGemini } from "../../extensions/websearch/providers/gemini.browser.js";
import type { BrowserSession, WebsearchResult } from "../../extensions/websearch/types.js";

const appUrl = "https://gemini.google.com/app";
const queryUrl =
  "https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate";
const routes = new Map<string, "app" | "query">([
  [appUrl, "app"],
  [queryUrl, "query"],
]);
const nativeFetch = undici.fetch;
const answer = "The café octopus recommends [kelp tea](https://cafe.example/menu).";

describe("Gemini browser HTTP transport", { concurrency: false }, () => {
  let server: Server;
  let origin: string;
  let sockets: Set<Socket>;
  let dispatchers: Set<Dispatcher>;
  let globalDispatcher: Dispatcher;
  let failures: unknown[];
  let controller: AbortController;
  let search: Promise<WebsearchResult> | undefined;
  let session: BrowserSession;
  let appHeaderPaddingBytes: number;
  let holdApp: boolean;
  let queryHeaders: ReturnType<typeof deferred<void>>;
  let received: Record<
    "app" | "query",
    ReturnType<typeof deferred<{ request: IncomingMessage; response: ServerResponse }>>
  >;

  beforeEach(async () => {
    failures = [];
    sockets = new Set();
    dispatchers = new Set();
    globalDispatcher = getGlobalDispatcher();
    controller = new AbortController();
    search = undefined;
    appHeaderPaddingBytes = 63 * 1024;
    holdApp = false;
    queryHeaders = deferred();
    received = {
      app: deferred(),
      query: deferred(),
    };
    session = {
      profile: {
        family: "firefox",
        browserName: "Firefox",
        profileName: "Octopus café",
        profilePath: "/unused-synthetic-profile",
      },
      cookies: ["__Secure-1PSID", "__Secure-1PSIDTS"].map((name) => ({
        name,
        value: `synthetic-${name}`,
        domain: ".google.com",
        path: "/",
        secure: true,
      })),
    };
    server = createServer((request, response) => {
      const route = request.url?.slice(1);
      if (route !== "app" && route !== "query") {
        failures.push(new Error(`Unexpected loopback request: ${request.url}`));
        response.writeHead(500).end();
        return;
      }
      received[route].resolve({ request, response });
      if (route === "app" && !holdApp) {
        sendGzip(response, '<script>{"SNlM0e":"kelp-token"}</script>', appHeaderPaddingBytes);
      }
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    origin = `http://127.0.0.1:${address.port}`;

    // Only the destination is substituted. Undici retains the production dispatcher,
    // request options, HTTP parser, and decompressor. This does not exercise TLS or proxies.
    mock.method(undici, "fetch", (...[input, init]: Parameters<typeof undici.fetch>) => {
      const url = String(input);
      const route = routes.get(url);
      if (!route || !init?.dispatcher) {
        const error = new Error(`Unexpected or unscoped Undici request: ${url}`);
        failures.push(error);
        throw error;
      }
      assert.equal(getGlobalDispatcher(), globalDispatcher);
      assert.notEqual(init.dispatcher, globalDispatcher);
      dispatchers.add(init.dispatcher);
      return nativeFetch(`${origin}/${route}`, init).then((response) => {
        if (route === "query") queryHeaders.resolve();
        return response;
      });
    });
    mock.method(globalThis, "fetch", () => {
      const error = new Error("Unexpected global fetch in Gemini HTTP workflow");
      failures.push(error);
      throw error;
    });
    const rejectProcess = () => {
      const error = new Error("Unexpected subprocess in Gemini HTTP workflow");
      failures.push(error);
      throw error;
    };
    for (const method of [
      "spawn",
      "spawnSync",
      "exec",
      "execSync",
      "execFile",
      "execFileSync",
      "fork",
    ] as const)
      mock.method(childProcess, method, rejectProcess);
    syncBuiltinESMExports();
  });

  afterEach(async () => {
    try {
      assert.deepEqual(failures, [], "unexpected external work must fail the test");
      assert.equal(getGlobalDispatcher(), globalDispatcher);
    } finally {
      controller.abort();
      server.closeAllConnections();
      try {
        await search?.catch(() => {});
        await Promise.all([...dispatchers].map((dispatcher) => dispatcher.destroy()));
        const closed = new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
        for (const socket of sockets) socket.destroy();
        await closed;
      } finally {
        mock.restoreAll();
        syncBuiltinESMExports();
      }
    }
  });

  test("decodes gzip near the 64 KiB header limit and releases its pool", async () => {
    search = browserGemini.search(session, "What should the octopus drink?", controller.signal);
    const { request, response } = await received.query.promise;
    assert.equal(request.method, "POST");
    assert.match(request.headers.cookie ?? "", /__Secure-1PSID=synthetic-__Secure-1PSID/);
    assert.match(request.headers.cookie ?? "", /__Secure-1PSIDTS=synthetic-__Secure-1PSIDTS/);
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const form = new URLSearchParams(Buffer.concat(chunks).toString());
    assert.equal(form.get("at"), "kelp-token");
    assert.match(form.get("f.req") ?? "", /What should the octopus drink\?/);
    sendGzip(response, geminiResponse(answer), 63 * 1024);

    assert.deepEqual(await search, {
      backend: "gemini",
      authSource: "firefox",
      browserName: "Firefox",
      profile: "Octopus café",
      answer,
      sources: [{ title: "kelp tea", url: "https://cafe.example/menu", snippet: undefined }],
    });
    await assertPoolClosed(dispatchers, origin);
  });

  test("consumes a compressed HTTP error body and releases its pool", async () => {
    search = browserGemini.search(session, "Is the kelp gateway open?", controller.signal);
    const errorText = "The kelp gateway is taking a café break.";
    const rejected = assert.rejects(search, (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /^503 /);
      assert.ok(error.message.includes(errorText));
      return true;
    });
    const { response } = await received.query.promise;
    sendGzip(response, errorText, 0, 503);
    await rejected;
    await assertPoolClosed(dispatchers, origin);
  });

  for (const stage of ["app", "query"] as const) {
    test(`rejects headers exceeding 64 KiB during ${stage} and releases its pool`, async () => {
      if (stage === "app") appHeaderPaddingBytes = 65 * 1024;
      search = browserGemini.search(session, "A bounded kelp harvest", controller.signal);
      const rejected = assert.rejects(search, (error) => {
        assert.ok(error instanceof Error && error.cause instanceof Error);
        assert.ok("code" in error.cause);
        assert.equal(error.cause.code, "UND_ERR_HEADERS_OVERFLOW");
        return true;
      });
      if (stage === "query") {
        const { response } = await received.query.promise;
        sendGzip(response, geminiResponse(answer), 65 * 1024);
      }
      await rejected;
      await assertPoolClosed(dispatchers, origin);
    });

    test(`cancels an in-flight ${stage} request and releases its pool`, async () => {
      holdApp = stage === "app";
      search = browserGemini.search(session, "Wait for the sleepy octopus", controller.signal);
      const reason = new Error("The octopus went home");
      const rejected = assert.rejects(search, (error) => error === reason);
      const { response } = await received[stage].promise;
      if (stage === "query") {
        response.writeHead(200, { "content-type": "text/plain" });
        response.write(")]}'\n[");
        await queryHeaders.promise;
      }
      controller.abort(reason);
      await rejected;
      await assertPoolClosed(dispatchers, origin);
    });
  }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** A closed dispatcher must reject new work, rather than leave a reusable pool behind. */
async function assertPoolClosed(dispatchers: Set<Dispatcher>, origin: string): Promise<void> {
  assert.equal(dispatchers.size, 1, "each search owns one dispatcher for all requests");
  for (const dispatcher of dispatchers) {
    await assert.rejects(
      dispatcher.request({ origin, path: "/pool-must-be-closed", method: "GET" }),
      { code: "UND_ERR_DESTROYED" },
    );
  }
}

/** Generate real compressed bytes and a large wire header, not a mocked Fetch response. */
function sendGzip(
  response: ServerResponse,
  text: string,
  headerPaddingBytes: number,
  status = 200,
): void {
  const body = gzipSync(text);
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-encoding": "gzip",
    "content-length": body.length,
    "x-octopus-padding": "k".repeat(headerPaddingBytes),
  });
  response.end(body);
}

/** Minimal completed StreamGenerate frame, retaining the real nested response parser. */
function geminiResponse(text: string): string {
  const candidate = [null, [text], null, null, null, null, null, null, [2]];
  return `)]}'\n${JSON.stringify([["wrb.fr", null, JSON.stringify([null, null, null, null, [candidate]])]])}`;
}
