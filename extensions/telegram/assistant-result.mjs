import { extractTextFromMessage } from "./message-text.mjs";

export function formatTelegramAssistantResult(message) {
  if (!message || message.role !== "assistant") return null;

  const text = extractTextFromMessage(message);
  const stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;

  if (stopReason === "error") {
    const detail = readErrorMessage(message) || "Unknown error.";
    return {
      text: appendNotice(text, `⚠️ ${detail}`),
      tone: "error",
    };
  }

  if (stopReason === "aborted") {
    return {
      text: appendNotice(text, "⚠️ Run aborted."),
      tone: "system",
    };
  }

  if (stopReason === "length") {
    return {
      text: appendNotice(text, "⚠️ Pi stopped because the output length limit was reached."),
      tone: text ? "assistant" : "system",
    };
  }

  if (!text) return null;
  return { text, tone: "assistant" };
}

export function formatTelegramAssistantResultFromMessages(messages) {
  if (!Array.isArray(messages)) return null;

  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") return formatTelegramAssistantResult(messages[i]);
  }

  return null;
}

function readErrorMessage(message) {
  const errorMessage = message?.errorMessage;
  return typeof errorMessage === "string" ? errorMessage.trim() : "";
}

function appendNotice(text, notice) {
  return text ? `${text}\n\n${notice}` : notice;
}
