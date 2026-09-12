import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Optional integration for sharing the parent's approval and confirmation queue. */
interface PermissionRequest {
  run: (signal: AbortSignal) => Promise<unknown>;
  signal?: AbortSignal;
  result?: Promise<unknown>;
}

export function registerPermissions(pi: ExtensionAPI) {
  let queue = new PermissionQueue();
  pi.events.on("subagent:permission", (data) => {
    const request = data as PermissionRequest;
    request.result = queue.run(request.run, request.signal);
  });
  pi.on("ui_prompt_start", () => queue.setPromptActive(true));
  pi.on("ui_prompt_end", () => queue.setPromptActive(false));
  return {
    get active() {
      return queue.active;
    },
    run<T>(run: (signal: AbortSignal) => Promise<T>, signal: AbortSignal) {
      return queue.run(run, signal);
    },
    async reset() {
      await queue.close();
      queue = new PermissionQueue();
    },
    close: () => queue.close(),
  };
}

/** Cancel queued requests independently; stopping one child must not wait for another child's user. */
class PermissionQueue {
  private readonly controller = new AbortController();
  private readonly pending: (() => Promise<void>)[] = [];
  private current?: Promise<void>;
  private promptActive = false;

  get active(): boolean {
    return this.promptActive || this.current !== undefined;
  }

  run<T>(run: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const combined = signal
      ? AbortSignal.any([signal, this.controller.signal])
      : this.controller.signal;
    return new Promise<T>((resolve, reject) => {
      if (combined.aborted) {
        reject(combined.reason);
        return;
      }
      const start = async () => {
        try {
          combined.throwIfAborted();
          resolve(await run(combined));
        } catch (error) {
          reject(error);
        } finally {
          combined.removeEventListener("abort", cancel);
        }
      };
      const cancel = () => {
        const index = this.pending.indexOf(start);
        if (index === -1) return;
        this.pending.splice(index, 1);
        combined.removeEventListener("abort", cancel);
        reject(combined.reason);
      };
      combined.addEventListener("abort", cancel, { once: true });
      this.pending.push(start);
      this.advance();
    });
  }

  setPromptActive(active: boolean): void {
    this.promptActive = active;
    this.advance();
  }

  async close(): Promise<void> {
    this.controller.abort();
    await this.current;
  }

  private advance(): void {
    if (this.current || this.promptActive || this.controller.signal.aborted) return;
    const start = this.pending.shift();
    if (!start) return;
    let begin!: () => void;
    this.current = new Promise<void>((resolve, reject) => {
      begin = () => {
        void start().then(resolve, reject);
      };
    }).finally(() => {
      this.current = undefined;
      this.advance();
    });
    begin();
  }
}
