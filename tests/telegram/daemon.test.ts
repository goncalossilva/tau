import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { afterEach, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import type {} from "./fixtures/transport.js";

const CHAT_ID = 42;

describe("Telegram headless launch", () => {
  let directory: string;
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;

  beforeEach(async () => {
    // Canonical macOS TMPDIR paths can exceed the Unix socket path limit.
    directory = await realpath(await mkdtemp("/tmp/tau-tg-"));
  });

  afterEach(async () => {
    try {
      await daemon?.dispose();
    } finally {
      daemon = undefined;
      await rm(directory, { recursive: true, force: true });
    }
  });

  for (const entrypoint of [true, false]) {
    test(`starts native RPC ${entrypoint ? "with the supplied entrypoint and owning runtime" : "through the standalone pi fallback"}`, async () => {
      const cwd = path.join(directory, "otter-workshop");
      await mkdir(cwd);
      const rpcPath = fileURLToPath(new URL("./fixtures/rpc.js", import.meta.url));
      daemon = await startDaemon(directory, entrypoint ? rpcPath : undefined);

      const active = await daemon.command(
        `/session new ${cwd}`,
        (request) => request.method === "sendMessage",
      );

      assert.match(String(active.body.text), /Session 1 active: otter-workshop \[headless\]/);
      assert.deepEqual(daemon.launches, [
        {
          type: "launch",
          command: entrypoint ? process.execPath : "pi",
          args: entrypoint ? [rpcPath, "--mode", "rpc"] : ["--mode", "rpc"],
          cwd,
          agentDir: daemon.agentDir,
          disabled: "1",
          token: "fixture-token",
        },
      ]);
      await daemon.command("/session", (request) =>
        String(request.body.text).includes("[headless]"),
      );
    });
  }
});

describe("Telegram prompt preflight", () => {
  let directory: string;
  let daemon: Awaited<ReturnType<typeof startDaemon>>;

  beforeEach(async () => {
    directory = await realpath(await mkdtemp("/tmp/tau-tg-"));
    const cwd = path.join(directory, "otter-workshop");
    await mkdir(cwd);
    daemon = await startDaemon(
      directory,
      fileURLToPath(new URL("./fixtures/rpc.js", import.meta.url)),
      true,
    );
    await daemon.command(`/session new ${cwd}`, (request) =>
      String(request.body.text).includes("Session 1 active:"),
    );
    await daemon.control("clock-start");
  });

  afterEach(async () => {
    try {
      await daemon?.dispose();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("accepts a first prompt past the old deadline exactly once and releases every queue slot", async () => {
    await daemon.update("delay: sleepy otter");
    await daemon.waitFixture((event) => event.type === "preflight");
    await daemon.control("tick", { ms: 29_999 });
    assert.equal(daemon.requests.filter(isSendFailure).length, 0);
    assert.equal(daemon.rpcRecords.filter((record) => record.command === "prompt").length, 0);
    await daemon.control("release-preflight");
    await daemon.waitRequest((request) => request.body.text === "Reply: delay: sleepy otter");
    await daemon.control("tick", { ms: 1 });

    // More than one backlog's worth, each after settlement. Leaked/double-counted starts exhaust it.
    for (let index = 0; index < 21; index++) {
      await daemon.command(
        `pebble ${index}`,
        (request) => request.body.text === `Reply: pebble ${index}`,
      );
    }
    await daemon.command("/session", (request) => String(request.body.text).includes("[headless]"));
    assert.equal(daemon.requests.filter(isSendFailure).length, 0);
    assert.equal(daemon.rpcCommands.filter((record) => record.type === "prompt").length, 22);
    const accepted = daemon.rpcRecords.filter((record) => record.command === "prompt");
    assert.equal(accepted.length, 22);
    assert.ok(accepted.every((record) => record.success === true));
    assert.equal(new Set(accepted.map((record) => record.id)).size, 22);
    assert.equal(daemon.rpcRecords.filter((record) => record.type === "agent_start").length, 22);
    assert.equal(daemon.fixtureEvents.filter((event) => event.type === "model").length, 22);
  });

  for (const action of ["deadline", "/esc", "/session quit"] as const) {
    test(`${action} retires and joins preflight before failure, rejects queued sends, and keeps saved history`, async () => {
      await daemon.command("saved otter", (request) => request.body.text === "Reply: saved otter");
      const sessionFile = daemon.fixtureEvents.findLast((event) => event.type === "session")!.file!;
      const saved = await readFile(sessionFile, "utf8");
      await daemon.update("delay: never swim");
      await daemon.waitFixture((event) => event.type === "preflight");
      await daemon.update("queued owl");
      await daemon.nextPoll();
      if (action === "deadline") await daemon.control("tick", { ms: 30_000 });
      else await daemon.update(action);
      await daemon.waitRequest(() => daemon.requests.filter(isSendFailure).length === 2);
      const failures = daemon.requests.filter(isSendFailure);
      assert.match(
        String(failures[0].body.text),
        action === "deadline" ? /Timed out.*Session closed/ : /cancelled.*Session closed/,
      );
      assert.match(String(failures[1].body.text), /Session is no longer available/);
      assert.ok(
        daemon.failureAfterChildClose.every(Boolean),
        "failure is reported only after joining child and pipes",
      );
      const closed = await daemon.waitFixture((event) => event.type === "closed");
      assert.equal(closed.signal, "SIGKILL");
      await daemon.control("release-preflight");
      await daemon.command("/session", (request) =>
        String(request.body.text).startsWith("No sessions."),
      );
      assert.equal(daemon.rpcCommands.filter((record) => record.type === "prompt").length, 2);
      assert.equal(daemon.rpcCommands.filter((record) => record.type === "abort").length, 0);
      assert.deepEqual(
        daemon.fixtureEvents.filter((event) => event.type === "model").map((event) => event.text),
        ["saved otter"],
      );
      const after = await readFile(sessionFile, "utf8");
      assert.ok(after.startsWith(saved), "retirement must preserve existing session bytes");
      assert.equal(daemon.launches.length, 1, "no replacement child or automatic retry");
    });
  }

  test("ignores a real acceptance buffered until the timeout and never retries uncertain work", async () => {
    await daemon.update("delay: photo finish");
    await daemon.waitFixture((event) => event.type === "preflight");
    await daemon.update("queued owl");
    await daemon.nextPoll();
    await daemon.control("pause-rpc");
    await daemon.control("release-preflight");
    await daemon.waitFixture((event) => event.type === "model");
    // The real Pi acknowledgement is in the pipe. Deliver it only after the local deadline wins.
    await daemon.control("tick", { ms: 30_000, resume: true });
    await daemon.waitRequest(() => daemon.requests.filter(isSendFailure).length === 2);
    const accepted = daemon.rpcRecords.filter((record) => record.command === "prompt");
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0].success, true);
    assert.equal(daemon.rpcCommands.filter((record) => record.type === "prompt").length, 1);
    assert.equal(daemon.fixtureEvents.filter((event) => event.type === "model").length, 1);
    assert.equal(
      daemon.requests.filter((request) => String(request.body.text).startsWith("Reply:")).length,
      0,
    );
    assert.ok(daemon.failureAfterChildClose.every(Boolean));
    await daemon.command("/session", (request) =>
      String(request.body.text).startsWith("No sessions."),
    );
    assert.equal(daemon.requests.filter(isSendFailure).length, 2);
    assert.equal(daemon.launches.length, 1);
  });

  test("handled commands finish without a run, release queue slots, and never retire a healthy session", async () => {
    for (let index = 0; index < 21; index++) {
      const start = daemon.rpcRecords.length;
      await daemon.update("/otter-rest");
      await daemon.waitRpc(
        (record) => record.command === "prompt" && record.data?.disposition === "handled",
        start,
      );
    }
    await daemon.control("tick", { ms: 30_000 });
    assert.equal(daemon.rpcRecords.filter((record) => record.type === "agent_start").length, 0);
    assert.equal(daemon.fixtureEvents.filter((event) => event.type === "model").length, 0);
    await daemon.command("awake owl", (request) => request.body.text === "Reply: awake owl");
    assert.equal(
      daemon.rpcRecords.filter((record) => record.command === "prompt" && record.success === true)
        .length,
      22,
    );
    assert.equal(daemon.rpcRecords.filter((record) => record.type === "agent_start").length, 1);
    assert.equal(daemon.requests.filter(isSendFailure).length, 0);
    assert.equal(daemon.fixtureEvents.filter((event) => event.type === "closed").length, 0);
  });

  test("queued acceptance has no start deadline and delivers the prompt once", async () => {
    await daemon.update("hold: diving otter");
    await daemon.waitFixture((event) => event.type === "model");
    await daemon.waitRpc((record) => record.type === "agent_start");
    await daemon.update("queued owl");
    await daemon.waitRpc(
      (record) => record.command === "prompt" && record.data?.disposition === "queued",
    );
    await daemon.control("tick", { ms: 30_000 });
    await daemon.control("release-model");
    await daemon.waitRequest((request) => request.body.text === "Reply: queued owl");
    assert.equal(daemon.requests.filter(isSendFailure).length, 0);
    assert.equal(daemon.fixtureEvents.filter((event) => event.type === "closed").length, 0);
    assert.equal(daemon.rpcCommands.filter((record) => record.type === "prompt").length, 2);
    assert.deepEqual(
      daemon.fixtureEvents.filter((event) => event.type === "model").map((event) => event.text),
      ["hold: diving otter", "queued owl"],
    );
  });

  for (const exitedBeforeDeadline of [false, true]) {
    test(`joins ${exitedBeforeDeadline ? "an already-exited" : "the retiring"} child and closes owned pipes while a descendant retains their writers`, async () => {
      const inherited = await inheritedPipeBoundary(directory);
      try {
        await daemon.update("delay: inherited pipes");
        await daemon.waitFixture((event) => event.type === "preflight");
        const descendantPid = await inherited.ready();
        if (exitedBeforeDeadline) {
          await daemon.control("kill-rpc");
          await daemon.waitFixture((event) => event.type === "exited");
          assert.equal(daemon.fixtureEvents.filter((event) => event.type === "closed").length, 0);
        }
        await daemon.control("tick", { ms: 30_000 });
        const exited = await daemon.waitFixture((event) => event.type === "exited");
        assert.equal(exited.signal, "SIGKILL");
        await daemon.waitRequest(isSendFailure);
        assert.ok(daemon.failureAfterChildClose.every(Boolean));
        assert.equal(daemon.fixtureEvents.filter((event) => event.type === "closed").length, 1);
        assert.equal(daemon.fixtureEvents.filter((event) => event.type === "model").length, 0);
        assert.doesNotThrow(
          () => process.kill(descendantPid, 0),
          "pipe holder is still alive when retirement finishes",
        );
        await daemon.command("/session", (request) =>
          String(request.body.text).startsWith("No sessions."),
        );
      } finally {
        await inherited.dispose();
      }
    });
  }

  for (const boundary of ["model", "tool", "retry", "tool-retry", "empty-retry"] as const) {
    test(`uses native abort during ${boundary} work, reports cancellation once, and leaves the session usable`, async () => {
      await daemon.command(
        "previous otter",
        (request) => request.body.text === "Reply: previous otter",
      );
      const start = daemon.rpcRecords.length;
      await daemon.update(`${boundary === "model" ? "hold" : boundary}: diving otter`);
      await daemon.waitRpc(
        (record) => record.command === "prompt" && record.data?.disposition === "started",
        start,
      );
      if (boundary.includes("retry"))
        await daemon.waitRpc((record) => record.type === "auto_retry_start");
      if (boundary === "tool") await daemon.waitFixture((event) => event.type === "tool");
      await daemon.update("/esc");
      if (!boundary.includes("retry"))
        await daemon.waitFixture((event) => event.type === `${boundary}-aborted`);
      if (boundary === "tool") {
        assert.equal(
          daemon.rpcRecords.filter((record) => record.type === "agent_settled").length,
          1,
          "abort joins tool cleanup before reporting",
        );
        await daemon.control("release-tool");
      }
      await daemon.waitRpc((record) => record.command === "abort" && record.success === true);
      const cancellation = await daemon.waitRequest((request) =>
        String(request.body.text).includes("⚠️ Run aborted"),
      );
      assert.equal(cancellation.body.parse_mode, "HTML", "cancellation uses system tone");
      const detail = boundary.includes("retry") ? "529 overloaded" : "This operation was aborted";
      if (boundary !== "model") {
        const partial = boundary === "empty-retry" ? "" : "The otter checked the map.\n\n";
        assert.equal(cancellation.body.text, `<i>${partial}⚠️ ${detail}\n\n⚠️ Run aborted</i>`);
        const ended = daemon.rpcRecords.findLast((record) => record.type === "agent_end")!;
        assert.equal(
          ended.messages?.findLast((message) => message.role === "assistant")?.stopReason,
          "error",
        );
      }
      const next = daemon.rpcRecords.length;
      await daemon.command("awake owl", (request) => request.body.text === "Reply: awake owl");
      await daemon.waitRpc(
        (record) => record.type === "agent_settled" && record.aborted === false,
        next,
      );
      assert.deepEqual(
        daemon.rpcRecords
          .filter((record) => record.type === "agent_settled")
          .map((record) => record.aborted),
        [false, true, false],
      );
      assert.equal(
        daemon.requests.filter((request) => String(request.body.text).includes("⚠️ Run aborted"))
          .length,
        1,
      );
      assert.equal(
        daemon.fixtureEvents.filter((event) => event.type === "model").length,
        boundary === "tool-retry" ? 4 : 3,
      );
      assert.equal(daemon.requests.filter(isSendFailure).length, 0);
      assert.equal(daemon.fixtureEvents.filter((event) => event.type === "closed").length, 0);
      assert.equal(daemon.rpcCommands.filter((record) => record.type === "abort").length, 1);
      assert.equal(daemon.launches.length, 1);
    });
  }
});

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

type Launch = {
  type: "launch";
  command: string;
  args: string[];
  cwd?: string;
  agentDir?: string;
  disabled?: string;
  token?: string;
};
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

type FixtureEvent = { type: string; text?: string; file?: string; signal?: string };
type RpcRecord = {
  type: string;
  aborted?: boolean;
  messages?: { role: string; stopReason?: string }[];
  command?: string;
  id?: string;
  success?: boolean;
  data?: { disposition?: string };
};

function isSendFailure(request: Request) {
  return String(request.body.text).startsWith("Failed to send to session");
}

/** Run the actual daemon and polling loop. IPC replaces Telegram HTTP and observes native RPC launches. */
async function startDaemon(directory: string, entrypoint?: string, preflight = false) {
  const agentDir = path.join(directory, "agent");
  await mkdir(path.join(agentDir, "telegram"), { recursive: true });
  await writeFile(
    path.join(agentDir, "telegram", "config.json"),
    JSON.stringify({ pairedChatId: CHAT_ID }),
  );
  if (preflight)
    await writeFile(
      path.join(agentDir, "settings.json"),
      JSON.stringify({
        retry: { enabled: true, baseDelayMs: 60_000, maxRetries: 1 },
        compaction: { enabled: false },
      }),
    );
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./fixtures/transport.js", import.meta.url))],
    {
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        TAU_TELEGRAM_BOT_TOKEN: "fixture-token",
        TAU_TELEGRAM_PI_ENTRYPOINT: entrypoint,
        TELEGRAM_PREFLIGHT_FIXTURE: preflight ? "1" : undefined,
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  const launches: Launch[] = [];
  const requests: Request[] = [];
  const fixtureEvents: FixtureEvent[] = [];
  const rpcRecords: RpcRecord[] = [];
  const rpcCommands: RpcRecord[] = [];
  const controlled = new Set<number>();
  const failureAfterChildClose: boolean[] = [];
  const pendingPolls: Request[] = [];
  const cancelled = new Set<number>();
  const changes = new EventEmitter();
  const sockets = new Set<net.Socket>();
  let stderr = "";
  let closed = false;
  let disposed = false;
  let updateId = 0;
  let controlId = 0;
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
    launches,
    sockets,
    requests,
    cancelled,
    agentDir,
    fixtureEvents,
    rpcRecords,
    rpcCommands,
    failureAfterChildClose,
    async control(action: string, options = {}) {
      const id = ++controlId;
      child.send({ type: "control", id, action, ...options });
      await observe(changes, () => controlled.has(id) || (closed ? new Error(stderr) : false));
    },
    async waitFixture(predicate: (event: FixtureEvent) => boolean) {
      await observe(
        changes,
        () => fixtureEvents.some(predicate) || (closed ? new Error(stderr) : false),
      );
      return fixtureEvents.find(predicate)!;
    },
    async waitRpc(predicate: (record: RpcRecord) => boolean, start = 0) {
      await observe(
        changes,
        () => rpcRecords.slice(start).some(predicate) || (closed ? new Error(stderr) : false),
      );
    },
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
      if (preflight) {
        assert.equal(
          fixtureEvents.filter((event) => event.type === "closed").length,
          launches.length,
        );
        assert.deepEqual(
          rpcRecords.filter((record) => record.type === "extension_error"),
          [],
        );
      }
      assert.ok(
        !/Unexpected|AssertionError|handler error|File delivery failed/.test(stderr),
        stderr,
      );
    },
  };
  child.on("message", (message) => {
    const event = message as
      | Request
      | Launch
      | { type: "cancelled" | "controlled"; id: number }
      | { type: "fixture"; event: FixtureEvent }
      | { type: "rpc-record" | "rpc-command"; record: RpcRecord };
    if (event.type === "launch") launches.push(event);
    else if (event.type === "cancelled") cancelled.add(event.id);
    else if (event.type === "controlled") controlled.add(event.id);
    else if (event.type === "fixture") fixtureEvents.push(event.event);
    else if (event.type === "rpc-record") rpcRecords.push(event.record);
    else if (event.type === "rpc-command") rpcCommands.push(event.record);
    else {
      assert.equal(event.type, "request");
      if (isSendFailure(event))
        failureAfterChildClose.push(fixtureEvents.some((entry) => entry.type === "closed"));
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

/** Independently stop the real pipe-holding descendant, including after its Pi parent is killed. */
async function inheritedPipeBoundary(directory: string) {
  let socket: net.Socket | undefined;
  let pid: number | undefined;
  let ended = false;
  let error: Error | undefined;
  const changes = new EventEmitter();
  const server = net.createServer((connection) => {
    assert.equal(socket, undefined, "Only one descendant is expected");
    socket = connection;
    const lines = createInterface({ input: connection });
    lines.on("line", (line) => {
      pid = Number(line);
      assert.ok(Number.isInteger(pid) && pid > 0);
      changes.emit("change");
    });
    connection.on("error", (failure) => {
      error = failure;
      changes.emit("change");
    });
    connection.once("close", () => {
      ended = true;
      lines.close();
      changes.emit("change");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path.join(directory, "pipe-holder.sock"), resolve);
  });
  return {
    async ready() {
      await observe(changes, () => error ?? pid !== undefined);
      return pid!;
    },
    async dispose() {
      try {
        if (socket && !ended) {
          socket.write("stop\n");
          // The descendant exits directly. Its socket closes with the inherited descriptors.
          await observe(changes, () => ended || error || false);
        }
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  };
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
