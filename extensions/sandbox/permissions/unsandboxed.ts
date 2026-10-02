export const UNSANDBOXED_APPROVAL_CHOICES = ["Deny", "Run once outside sandbox"] as const;

export function isUnsandboxedApproval(choices: readonly string[]): boolean {
  return (
    choices.length === UNSANDBOXED_APPROVAL_CHOICES.length &&
    choices.every((choice, index) => choice === UNSANDBOXED_APPROVAL_CHOICES[index])
  );
}

/** Shell-style details for both the local dialog and forwarded RPC approvals. */
export function formatUnsandboxedApproval(command: string): string {
  return [
    "Run once outside sandbox?",
    "",
    `$ ${escapeControls(command)}`,
    "",
    "This command and its descendants get host filesystem and network access.",
  ].join("\n");
}

/** Preserve layout newlines while making untrusted terminal and Unicode controls inert. */
function escapeControls(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (character) =>
    character === "\n"
      ? character
      : character
          .split("")
          .map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`)
          .join(""),
  );
}
