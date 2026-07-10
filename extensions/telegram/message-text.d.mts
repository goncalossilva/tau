export type TelegramAssistantResultTone = "assistant" | "error" | "system";

export type TelegramAssistantResult = {
  text: string;
  tone: TelegramAssistantResultTone;
};

export declare function extractTextFromMessage(message: unknown): string;
export declare function formatTelegramAssistantResult(
  message: unknown,
): TelegramAssistantResult | null;
export declare function formatTelegramAssistantResultFromMessages(
  messages: unknown,
): TelegramAssistantResult | null;
