export type PromptMode = "interactive" | "non-interactive";

export type ListOp = "add" | "remove";

export type SandboxEventOutcome = "blocked" | "allowed";

export interface SandboxEventBase<TKind extends string, TReason extends string> {
  timestamp: number;
  kind: TKind;
  outcome: SandboxEventOutcome;
  reason: TReason;
  target?: string;
  command?: string;
  cwd?: string;
  summary: string;
  suggestedCommand?: string;
}

export type ViolationResolutionKind = "allow-retry" | "allow-adapt" | "deny";

export type ViolationResolution =
  | {
      kind: "allow-retry";
      message: string;
      retrySuccessMessage: string;
      retryFailureMessage: string;
      retrySkippedMessage: string;
    }
  | { kind: "allow-adapt"; message: string }
  | { kind: "deny"; message: string };
