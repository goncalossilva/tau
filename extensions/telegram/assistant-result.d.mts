export type TelegramAssistantResultTone = "assistant" | "error" | "system";

export type TelegramAssistantResult = {
  text: string;
  tone: TelegramAssistantResultTone;
};

export declare function formatTelegramAssistantResult(
  message: unknown,
  aborted?: boolean,
): TelegramAssistantResult | null;
/** Messages observed in the current session-level run, excluding earlier session history. */
export declare function formatTelegramAssistantResultFromMessages(
  runMessages: unknown,
  aborted?: boolean,
): TelegramAssistantResult | null;
