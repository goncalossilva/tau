export const REVIEW_COMMENT_SCHEMA = "pi.review.comment.v1" as const;

export const REVIEW_OUTPUT_FORMATS = ["inline", "jsonl", "html"] as const;

export type ReviewOutputFormat = (typeof REVIEW_OUTPUT_FORMATS)[number];

export type Priority = "P0" | "P1" | "P2" | "P3";

export const REVIEW_FOCUS_NAMES = [
  "general",
  "security",
  "reuse",
  "quality",
  "testing",
  "efficiency",
] as const;

export type ReviewFocus = (typeof REVIEW_FOCUS_NAMES)[number];
export type ReviewRunSource = "review" | "fix" | "triage";
export type ReviewRunOutcome = "success" | "failed" | "cancelled";

export type ReviewTarget =
  | { type: "auto" }
  | { type: "uncommitted" }
  | { type: "branch"; branch: string }
  | { type: "commit"; sha: string }
  | { type: "pr"; ref: string }
  | { type: "folder"; paths: string[] }
  | { type: "custom"; instructions: string };

export type ReviewRequestMode =
  | "auto"
  | "uncommitted"
  | `branch:${string}`
  | `commit:${string}`
  | `pr:${string}`
  | `folder:${string}`
  | "custom";

export type ParsedRequest = {
  target: ReviewTarget;
  mode: ReviewRequestMode;
  models: string[];
  focuses: ReviewFocus[];
  targetExplicit: boolean;
  focusExplicit: boolean;
  additionalContext?: string;
};

export type RequestSignaturePayload = {
  target: unknown;
  models: string[];
  focuses: ReviewFocus[];
  additionalContext?: string | null;
};

export type ReviewFingerprint = {
  headSha: string;
  branch: string;
  trackedDiffHash: string;
  untrackedHash: string;
};

export type FocusFinding = {
  priority: Priority;
  location: string;
  finding: string;
  suggestion: string;
};

export type FocusOutput = {
  focus: ReviewFocus;
  model: string;
  findings: FocusFinding[];
};

export type ReviewReportFinding = {
  priority: Priority;
  location: string;
  finding: string;
  suggestion: string;
  focus: string;
  model: string;
};

export type ReviewDedupGroup = {
  ids: number[];
};

export type ReviewStaleness = {
  status: "stale";
  warning: string;
  nextStep: string;
};

export type ReviewScopeMode = "working-tree" | "branch-diff" | "commit" | "folder" | "custom";

export type ReviewMessageKind = "report" | "failure" | "triage" | "help";

export type ReviewMessageDetails = {
  kind?: "report";
  request: {
    mode: ReviewRequestMode;
    signature: string;
  };
  scope: {
    mode: ReviewScopeMode;
    description: string;
  };
  fingerprint: ReviewFingerprint;
  staleness?: ReviewStaleness;
  focusStatus: Array<{
    focus: ReviewFocus;
    model: string;
    ok: boolean;
    error?: string;
  }>;
  findings: ReviewReportFinding[];
};

export type ReviewRunResult =
  | { ok: false; error: string }
  | { ok: true; details: ReviewMessageDetails };

export type ReviewCommentSide = "old" | "new" | "snapshot";
export type ReviewCommentAuthor = "pi" | "user" | string;
export type ReviewCommentStatus = "open" | "resolved";

export type ReviewCommentRange = {
  startLine: number;
  endLine?: number;
  startColumn?: number;
  endColumn?: number;
};

export type ReviewCommentAnchor = {
  fileHash?: string;
  selectedText?: string;
  prefix?: string[];
  suffix?: string[];
  diffHunk?: string;
};

export type ReviewComment = {
  schema: typeof REVIEW_COMMENT_SCHEMA;
  id: string;
  reviewId: string;
  author: ReviewCommentAuthor;
  origin: string;
  createdAt: string;
  path: string;
  side: ReviewCommentSide;
  range?: ReviewCommentRange;
  priority?: Priority;
  severity?: "error" | "warning" | "information" | "hint";
  status: ReviewCommentStatus;
  body: string;
  suggestion?: string;
  anchor?: ReviewCommentAnchor;
};
