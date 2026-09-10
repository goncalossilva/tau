import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type {
  JsonAgentSessionEvent,
  RpcCommand,
  RpcExtensionUIRequest,
  RpcExtensionUIResponse,
  RpcResponse,
} from "@earendil-works/pi-coding-agent";

export type ChildEvent = JsonAgentSessionEvent | RpcExtensionUIRequest;

/** Own the native RPC process, its LF-delimited protocol, and all pending requests through close. */
export class SubagentProcess {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<
    string,
    {
      command: RpcCommand["type"];
      resolve: (response: RpcResponse) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private sequence = 0;
  private buffer = "";
  private stderr = "";
  private failure?: Error;
  private stopping = false;
  private closed = false;
  private escalation?: ReturnType<typeof setTimeout>;
  private shutdownRequest?: Promise<void>;
  readonly completion: Promise<void>;

  constructor(
    cwd: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    onEvent: (event: ChildEvent) => void,
    onClose: (error?: Error) => void,
  ) {
    this.process = spawn("pi", ["--mode", "rpc", ...args], {
      cwd,
      env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process.stdout.setEncoding("utf8");
    this.process.stderr.setEncoding("utf8");
    this.process.stdout.on("data", (chunk: string) => {
      try {
        this.buffer += chunk;
        let newline: number;
        while ((newline = this.buffer.indexOf("\n")) !== -1) {
          const line = this.buffer.slice(0, newline).replace(/\r$/, "");
          this.buffer = this.buffer.slice(newline + 1);
          if (!line) continue;
          if (Buffer.byteLength(line) > 32 * 1024 * 1024)
            throw new Error("Subagent RPC record exceeds 32 MiB");
          const event = JSON.parse(line) as RpcResponse | ChildEvent;
          if (!event || typeof event !== "object" || typeof event.type !== "string") {
            throw new Error("Invalid subagent RPC record");
          }
          if (event.type === "response") {
            const request = event.id ? this.pending.get(event.id) : undefined;
            if (!request) continue;
            if (event.command !== request.command || typeof event.success !== "boolean")
              throw new Error("Invalid subagent RPC acknowledgement");
            clearTimeout(request.timer);
            this.pending.delete(event.id!);
            if (event.success) request.resolve(event);
            else request.reject(new Error(event.error));
          } else if (!this.stopping) {
            onEvent(event);
          }
        }
        if (Buffer.byteLength(this.buffer) > 32 * 1024 * 1024)
          throw new Error("Subagent RPC record exceeds 32 MiB");
      } catch (error) {
        this.fail(error);
      }
    });
    this.process.stderr.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-8192);
    });
    this.process.on("error", (error) => this.fail(error));
    this.process.stdin.on("error", (error) => this.fail(error));
    this.completion = new Promise<void>((resolve) => {
      this.process.once("close", (code, signal) => {
        this.closed = true;
        clearTimeout(this.escalation);
        const error =
          this.failure ??
          new Error(
            `Subagent exited (${signal ?? code}).${this.stderr.trim() ? ` ${this.stderr.trim()}` : ""}`,
          );
        for (const request of this.pending.values()) {
          clearTimeout(request.timer);
          request.reject(error);
        }
        this.pending.clear();
        try {
          onClose(this.stopping && !this.failure ? undefined : error);
        } finally {
          resolve();
        }
      });
    });
  }

  async request(command: RpcCommand): Promise<RpcResponse> {
    if (this.closed || this.stopping) throw this.failure ?? new Error("Subagent has stopped");
    return this.send(command);
  }

  respond(response: RpcExtensionUIResponse): void {
    if (!this.closed && !this.stopping) this.write(response);
  }

  async stop(): Promise<void> {
    if (!this.closed && !this.stopping) {
      this.stopping = true;
      let terminating = false;
      const terminate = () => {
        if (terminating || this.closed) return;
        terminating = true;
        clearTimeout(this.escalation);
        // Pi's SIGTERM handler also stops separately detached Bash children.
        this.signal("SIGTERM");
        this.escalation = setTimeout(() => this.signal("SIGKILL"), 1000);
      };
      this.escalation = setTimeout(terminate, 250);
      this.shutdownRequest = (
        this.failure
          ? Promise.resolve()
          : this.send({ type: "clear_queue" }).then(() => this.send({ type: "abort" }))
      ).then(terminate, terminate);
    }
    await this.completion;
    await this.shutdownRequest;
  }

  private send(command: RpcCommand): Promise<RpcResponse> {
    if (this.closed) return Promise.reject(this.failure ?? new Error("Subagent has stopped"));
    const id = String(++this.sequence);
    return new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          this.fail(new Error(`Subagent did not acknowledge ${command.type} within 30 seconds`)),
        30_000,
      );
      this.pending.set(id, { command: command.type, resolve, reject, timer });
      this.write({ ...command, id });
    });
  }

  private write(message: RpcCommand | RpcExtensionUIResponse): void {
    try {
      this.process.stdin.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      this.fail(error);
    }
  }

  private fail(error: unknown): void {
    this.failure ??= error instanceof Error ? error : new Error(String(error));
    void this.stop();
  }

  private signal(signal: NodeJS.Signals): void {
    if (this.closed) return;
    try {
      if (this.process.pid) process.kill(-this.process.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") this.process.kill(signal);
    }
  }
}
