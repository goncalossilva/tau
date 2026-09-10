import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Socket } from "node:net";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";

/** Keep native Bash work alive on an owned connection; observe termination independently of its Pi parent. */
export async function holdShellWork() {
  const ready = deferred<void>();
  const closed = deferred<void>();
  const sockets = new Set<Socket>();
  let pid: number | undefined;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    let buffer = "";
    socket.on("data", (data) => {
      buffer += data.toString();
      if (!buffer.includes("\n")) return;
      const candidate = Number(buffer.trim());
      if (Number.isSafeInteger(candidate) && candidate > 1) pid = candidate;
      ready.resolve();
    });
    socket.once("close", () => {
      sockets.delete(socket);
      closed.resolve();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  return {
    command: `exec ${quote(process.execPath)} ${quote(fileURLToPath(new URL("./shell.mjs", import.meta.url)))} ${address.port}`,
    ready: ready.promise.then(() => assert.ok(pid, "the owned workload reports its PID")),
    closed: closed.promise,
    async dispose() {
      if (pid && sockets.size) {
        try {
          process.kill(pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (pid) {
        let expired = false;
        const timeout = setTimeout(() => {
          expired = true;
        }, 10_000);
        try {
          while (!expired) {
            try {
              process.kill(pid, 0);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
              throw error;
            }
            await setImmediate();
          }
          throw new Error("Timed out waiting for owned shell fixture exit");
        } finally {
          clearTimeout(timeout);
        }
      }
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
