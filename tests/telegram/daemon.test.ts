import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { afterEach, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import type {} from "./fixtures/transport.js";

const CHAT_ID = 42;

describe("Telegram attachment routing", () => {
  let directory: string;
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  let otter: Awaited<ReturnType<typeof connectWindow>>;
  let owl: Awaited<ReturnType<typeof connectWindow>>;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "tg-"));
    daemon = await startDaemon(directory);
    otter = await connectWindow(daemon, "otter");
    owl = await connectWindow(daemon, "owl");
    await daemon.select(owl.sessionNo);
  });

  afterEach(async () => {
    await daemon?.dispose();
    daemon = undefined;
    await rm(directory, { recursive: true, force: true });
  });

  for (const mode of ["auto", "document"] as const) {
    test(`queues ${mode} attachments until selection, preserving bytes and delivering only once`, async () => {
      const file = path.join(directory, "otter's café.png");
      const bytes = Buffer.from("The otter keeps its pixels dry.\0\xff", "latin1");
      await writeFile(file, bytes);
      const before = daemon!.uploads.length;

      const result = await otter.sendFile(file, {
        mode,
        caption: "Pixels / 日本語",
        filename: "otter souvenir.png",
      });

      assert.equal(
        daemon!.uploads.length,
        before,
        "inactive attachments must stay out of the selected conversation",
      );
      assert.equal(result.ok, true);
      assert.equal(
        result.queued,
        true,
        "acceptance must not claim the inactive session's file was sent",
      );
      await writeFile(file, "The file changed after the tool completed.");
      await rm(file);
      const listing = await daemon!.command("/session", (request) =>
        String(request.body.text).includes("[window]"),
      );
      assert.match(String(listing.body.text), new RegExp(`${otter.sessionNo}\\).*\\[1 unread\\]`));

      await daemon!.select(otter.sessionNo);
      const upload = await daemon!.waitRequest(
        (request) => request.method === (mode === "auto" ? "sendPhoto" : "sendDocument"),
      );
      assert.equal(upload.body.chat_id, String(CHAT_ID));
      const payload = upload.body[mode === "auto" ? "photo" : "document"] as {
        name: string;
        bytes: string;
      };
      assert.equal(payload.name, "otter souvenir.png");
      assert.equal(upload.body.caption, "Pixels / 日本語");
      assert.deepEqual(Buffer.from(payload.bytes, "base64"), bytes);

      await daemon!.select(owl.sessionNo);
      await daemon!.select(otter.sessionNo);
      assert.equal(
        daemon!.uploads.length,
        before + 1,
        "revisiting a session does not resend an attachment",
      );
    });
  }

  test("reports an active upload as sent and finishes it before announcing a different session", async () => {
    const file = path.join(directory, "owl.txt");
    await writeFile(file, "Night shift report");
    daemon!.holdUploads = true;
    const result = owl.sendFile(file);
    const upload = await daemon!.waitRequest((request) => request.method === "sendDocument");
    const start = daemon!.requests.length;

    await daemon!.update(`/session ${otter.sessionNo}`);
    await daemon!.update("selection checkpoint");
    await otter.waitForInput("selection checkpoint");
    assert.ok(
      !daemon!.requests
        .slice(start)
        .some((request) =>
          String(request.body.text).includes(`Session ${otter.sessionNo} active:`),
        ),
    );
    daemon!.respond(upload);

    assert.equal((await result).queued, false);
    await daemon!.waitRequest(
      (request) => String(request.body.text).includes(`Session ${otter.sessionNo} active:`),
      start,
    );
  });

  test("leaves the rest queued when selection changes during attachment replay", async () => {
    for (const name of ["first.txt", "second.txt"]) {
      const file = path.join(directory, name);
      await writeFile(file, name);
      assert.equal((await otter.sendFile(file)).queued, true);
    }
    daemon!.holdUploads = true;
    await daemon!.select(otter.sessionNo);
    const first = await daemon!.waitRequest((request) => request.method === "sendDocument");
    const start = daemon!.requests.length;
    await daemon!.update(`/session ${owl.sessionNo}`);
    await daemon!.update("replay checkpoint");
    await owl.waitForInput("replay checkpoint");
    daemon!.respond(first);
    await daemon!.waitRequest(
      (request) => String(request.body.text).includes(`Session ${owl.sessionNo} active:`),
      start,
    );
    assert.equal(daemon!.uploads.length, 1);

    daemon!.holdUploads = false;
    await daemon!.select(otter.sessionNo);
    await daemon!.waitRequest(() => daemon!.uploads.length === 2);
    await daemon!.select(owl.sessionNo);
    assert.deepEqual(
      daemon!.uploads.map((request) => (request.body.document as { name: string }).name),
      ["first.txt", "second.txt"],
    );
  });

  test("keeps failed queued uploads for a later selection instead of losing or duplicating them", async () => {
    const file = path.join(directory, "retry.txt");
    await writeFile(file, "An otter never gives up its attachment.");
    assert.equal((await otter.sendFile(file)).queued, true);
    daemon!.holdUploads = true;
    await daemon!.select(otter.sessionNo);
    const first = await daemon!.waitRequest((request) => request.method === "sendDocument");
    daemon!.respond(first, { ok: false, error_code: 400, description: "Fixture upload rejected" });
    await daemon!.waitRequest((request) =>
      String(request.body.text).includes("Switch to it again to retry"),
    );
    await daemon!.select(owl.sessionNo);
    daemon!.holdUploads = false;
    const start = daemon!.requests.length;

    await daemon!.select(otter.sessionNo);
    const retried = await daemon!.waitRequest(
      (request) => request.method === "sendDocument",
      start,
    );
    assert.deepEqual(retried.body, first.body);
    await daemon!.select(owl.sessionNo);
    await daemon!.select(otter.sessionNo);
    assert.equal(daemon!.uploads.length, 2);
  });

  test("does not send queued files into a replacement Pi session in the same window", async () => {
    const file = path.join(directory, "old-session.txt");
    await writeFile(file, "This belongs to the old conversation.");
    assert.equal((await otter.sendFile(file)).queued, true);
    await otter.replaceSession("new-otter");

    await daemon!.select(otter.sessionNo);
    await daemon!.select(owl.sessionNo);

    assert.deepEqual(daemon!.uploads, []);
  });

  test("rejects excess queued files without displacing accepted attachments", async () => {
    const file = path.join(directory, "pebble.txt");
    await writeFile(file, "One pebble for the queue");
    for (let index = 0; index < 20; index++) {
      assert.equal((await otter.sendFile(file)).queued, true);
    }
    const rejected = await otter.sendFile(file);
    assert.equal(rejected.ok, false);
    assert.match(String(rejected.error), /pending files/i);
    assert.deepEqual(daemon!.uploads, []);

    await daemon!.select(otter.sessionNo);
    await daemon!.waitRequest(() => daemon!.uploads.length === 20);
    await daemon!.select(owl.sessionNo);
    assert.equal(daemon!.uploads.length, 20);
  });

  test("cancels an active upload and joins it on daemon shutdown", async () => {
    const file = path.join(directory, "shutdown.txt");
    await writeFile(file, "No delivery after shutdown");
    daemon!.holdUploads = true;
    const result = owl.sendFile(file).catch(() => undefined);
    const upload = await daemon!.waitRequest((request) => request.method === "sendDocument");

    await daemon!.dispose();
    await result;

    assert.ok(daemon!.cancelled.has(upload.id), "shutdown aborts the actual HTTP request");
  });
});

type Request = { type: "request"; id: number; method: string; body: Record<string, unknown> };
type Reply = {
  type: string;
  text?: string;
  id?: string;
  sessionNo?: number;
  ok?: boolean;
  queued?: boolean;
  error?: string;
};

/** Start the actual daemon and polling loop. IPC substitutes only Telegram HTTP, never sessions or daemon routing. */
async function startDaemon(directory: string) {
  const agentDir = path.join(directory, "agent");
  await mkdir(path.join(agentDir, "telegram"), { recursive: true });
  await writeFile(
    path.join(agentDir, "telegram", "config.json"),
    JSON.stringify({ pairedChatId: CHAT_ID }),
  );
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./fixtures/transport.js", import.meta.url))],
    {
      env: {
        ...process.env,
        PI_TELEGRAM_AGENT_DIR: agentDir,
        PI_TELEGRAM_BOT_TOKEN: "fixture-token",
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  const requests: Request[] = [];
  const pendingPolls: Request[] = [];
  const cancelled = new Set<number>();
  const changes = new EventEmitter();
  const sockets = new Set<net.Socket>();
  let stderr = "";
  let closed = false;
  let disposed = false;
  let updateId = 0;
  const done = new Promise<void>((resolve) =>
    child.once("close", () => {
      closed = true;
      changes.emit("change");
      resolve();
    }),
  );
  child.on("error", (error) => {
    stderr += String(error);
    changes.emit("change");
  });
  child.stderr!.on("data", (chunk) => {
    stderr += String(chunk);
    changes.emit("change");
  });
  const daemon = {
    sockets,
    requests,
    cancelled,
    agentDir,
    holdUploads: false,
    get uploads() {
      return requests.filter((request) => ["sendPhoto", "sendDocument"].includes(request.method));
    },
    respond(request: Request, body: unknown = { ok: true, result: {} }) {
      child.send({ type: "response", id: request.id, body });
    },
    async nextPoll() {
      await observe(changes, () => (closed ? new Error(stderr) : pendingPolls.length > 0));
    },
    async update(text: string) {
      await daemon.nextPoll();
      const poll = pendingPolls.shift()!;
      const id = ++updateId;
      daemon.respond(poll, {
        ok: true,
        result: [{ update_id: id, message: { message_id: id, chat: { id: CHAT_ID }, text } }],
      });
    },
    async command(text: string, predicate: (request: Request) => boolean) {
      const start = requests.length;
      await daemon.update(text);
      return daemon.waitRequest(predicate, start);
    },
    async select(number: number) {
      await daemon.command(`/session ${number}`, (request) =>
        String(request.body.text).includes(`Session ${number} active:`),
      );
    },
    async waitRequest(predicate: (request: Request) => boolean, start = 0) {
      await observe(
        changes,
        () => requests.slice(start).some(predicate) || (closed ? new Error(stderr) : false),
      );
      return requests.slice(start).find(predicate)!;
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      child.kill("SIGTERM");
      const deadline = setTimeout(() => child.kill("SIGKILL"), 5000);
      try {
        await done;
      } finally {
        clearTimeout(deadline);
        for (const socket of sockets) socket.destroy();
      }
      assert.equal(child.exitCode, 0, stderr);
      assert.ok(
        !/Unexpected|AssertionError|handler error|File delivery failed/.test(stderr),
        stderr,
      );
    },
  };
  child.on("message", (message) => {
    const event = message as Request | { type: "cancelled"; id: number };
    if (event.type === "cancelled") cancelled.add(event.id);
    else {
      assert.equal(event.type, "request");
      requests.push(event);
      if (event.method === "getUpdates") pendingPolls.push(event);
      else if (!daemon.holdUploads || !["sendPhoto", "sendDocument"].includes(event.method))
        daemon.respond(event);
    }
    changes.emit("change");
  });
  try {
    await observe(
      changes,
      () => stderr.includes("Daemon running.") || (closed ? new Error(stderr) : false),
    );
    return daemon;
  } catch (error) {
    await daemon.dispose();
    throw error;
  }
}

/** A window-side JSONL protocol client. Pi itself is outside these daemon routing tests. */
async function connectWindow(daemon: Awaited<ReturnType<typeof startDaemon>>, windowId: string) {
  const socket = net.connect(path.join(daemon.agentDir, "run", "telegram.sock"));
  daemon.sockets.add(socket);
  const lines = createInterface({ input: socket });
  const replies: Reply[] = [];
  const changes = new EventEmitter();
  let ended = false;
  let nextId = 0;
  lines.on("line", (line) => {
    replies.push(JSON.parse(line));
    changes.emit("change");
  });
  socket.on("error", () => {});
  socket.on("close", () => {
    ended = true;
    lines.close();
    changes.emit("change");
  });
  const send = (message: unknown) => socket.write(JSON.stringify(message) + "\n");
  const register = async (sessionId: string) => {
    const start = replies.length;
    send({ type: "register", windowId, sessionId, cwd: daemon.agentDir, busy: false });
    await observe(
      changes,
      () =>
        replies.slice(start).some((reply) => reply.type === "registered") ||
        (ended ? new Error("Window disconnected") : false),
    );
    return replies.slice(start).find((reply) => reply.type === "registered")!;
  };
  const registered = await register(windowId);
  assert.equal(typeof registered.sessionNo, "number");
  return {
    sessionNo: registered.sessionNo!,
    replaceSession: register,
    async waitForInput(text: string) {
      await observe(
        changes,
        () =>
          replies.some((reply) => reply.type === "inject" && reply.text === text) ||
          (ended ? new Error("Window disconnected") : false),
      );
    },
    async sendFile(file: string, options: Record<string, unknown> = {}) {
      const id = String(++nextId);
      send({ type: "send_file", id, path: file, mode: "auto", ...options });
      await observe(
        changes,
        () =>
          replies.some((reply) => reply.id === id && reply.type === "send_file_result") ||
          (ended ? new Error("Window disconnected") : false),
      );
      return replies.find((reply) => reply.id === id && reply.type === "send_file_result")!;
    },
  };
}

/** Wait for an observable protocol transition, with a failure bound and owned listener/timer cleanup. */
function observe(events: EventEmitter, state: () => boolean | Error): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(deadline);
      events.removeListener("change", check);
      if (error) reject(error);
      else resolve();
    };
    const check = () => {
      const value = state();
      if (value instanceof Error) finish(value);
      else if (value) finish();
    };
    const deadline = setTimeout(
      () => finish(new Error("Daemon protocol did not reach readiness")),
      10_000,
    );
    events.on("change", check);
    check();
  });
}
