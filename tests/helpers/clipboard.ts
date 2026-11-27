import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mock } from "node:test";
import { getNativeClipboard } from "@earendil-works/pi-tui";

const spawn = childProcess.spawn;
const writeStdout = process.stdout.write;

/** Keep Pi's routing real. Replace native writes and writer processes, and capture OSC 52 before it reaches a terminal. */
export function clipboardBoundary(failures: unknown[]) {
  const keys = [
    "PI_CLIPBOARD_OSC52",
    "SSH_CONNECTION",
    "SSH_CLIENT",
    "MOSH_CONNECTION",
    "WAYLAND_DISPLAY",
    "DISPLAY",
    "TERMUX_VERSION",
    "WSL_DISTRO_NAME",
    "WSL_INTEROP",
    "WT_SESSION",
  ];
  const environment = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  process.env.WAYLAND_DISPLAY = "tau-clipboard-fixture";
  const writes: Buffer[] = [];
  const stdout: Buffer[] = [];
  const children = new Map<ReturnType<typeof spawn>, Promise<void>>();
  const pauses = new Set<ReturnType<typeof pause>>();
  let held: ReturnType<typeof pause> | undefined;
  const boundary = {
    writes,
    stdout,
    fail: false,
    pause() {
      assert.equal(held, undefined, "only one clipboard write is held at a time");
      held = pause();
      pauses.add(held);
      return held;
    },
    release() {
      for (const pending of pauses) pending.release();
    },
    spawn(...args: Parameters<typeof spawn>) {
      const program = process.platform === "darwin" ? "pbcopy" : "wl-copy";
      if (args[0] !== program) return undefined;
      assert.deepEqual(args[1], program === "wl-copy" ? ["-t", "text/plain"] : []);
      const pending = held;
      held = undefined;
      const child = spawn(
        process.execPath,
        [
          "-e",
          `
            const chunks = [];
            process.stdin.on("data", chunk => chunks.push(chunk));
            process.stdin.on("end", () => process.send(Buffer.concat(chunks).toString("base64")));
            process.on("message", code => process.exit(code));
          `,
        ],
        { ...args[2], stdio: ["pipe", "ignore", "ignore", "ipc"] },
      );
      child.once("error", (error) => failures.push(error));
      child.once("message", (message) => {
        assert.equal(typeof message, "string");
        writes.push(Buffer.from(message as string, "base64"));
        pending?.started();
        void (pending?.done ?? Promise.resolve()).then(() => {
          if (child.connected) child.send(boundary.fail ? 1 : 0);
        });
      });
      const done = new Promise<void>((resolve) =>
        child.once("close", () => {
          children.delete(child);
          resolve();
        }),
      );
      children.set(child, done);
      return child;
    },
    async dispose() {
      boundary.release();
      const pending = [...children.values()];
      for (const child of children.keys()) child.kill("SIGKILL");
      await Promise.all(pending);
      for (const [key, value] of Object.entries(environment)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
  const native = process.platform === "darwin" ? getNativeClipboard() : undefined;
  if (native?.setText) {
    mock.method(
      native as Required<Pick<typeof native, "setText">>,
      "setText",
      async (text: string) => {
        const pending = held;
        held = undefined;
        writes.push(Buffer.from(text));
        pending?.started();
        await pending?.done;
        if (boundary.fail) throw new Error("The octopus unplugged the clipboard");
      },
    );
  }
  mock.method(
    process.stdout,
    "write",
    (
      chunk: string | Uint8Array,
      encoding?: BufferEncoding | ((error?: Error | null) => void),
      callback?: (error?: Error | null) => void,
    ) => {
      // Preserve node:test's stdout transport and ordinary command output.
      if (typeof chunk !== "string" || !chunk.startsWith("\x1b]52;")) {
        return Reflect.apply(writeStdout, process.stdout, [chunk, encoding, callback]) as boolean;
      }
      stdout.push(Buffer.from(chunk, typeof encoding === "string" ? encoding : undefined));
      const done = typeof encoding === "function" ? encoding : callback;
      done?.();
      return true;
    },
  );
  return boundary;
}

function pause() {
  let started!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { ready, done, started, release };
}
