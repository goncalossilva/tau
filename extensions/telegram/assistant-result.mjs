import { extractTextFromMessage } from "./message-text.mjs";

export function formatTelegramAssistantResult(message, aborted = false) {
  if (!message || message.role !== "assistant") {
    return aborted ? { text: "⚠️ Run aborted", tone: "system" } : null;
  }

  const text = extractTextFromMessage(message);
  const stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;

  if (aborted || stopReason === "aborted") {
    const detail = readErrorMessage(message);
    const notice = "⚠️ Run aborted";
    const withDetail = detail ? appendNotice(text, `⚠️ ${detail}`) : text;
    return {
      text:
        withDetail === notice || withDetail.endsWith(`\n\n${notice}`)
          ? withDetail
          : appendNotice(withDetail, notice),
      tone: "system",
    };
  }

  if (stopReason === "error") {
    const detail = readErrorMessage(message) || "Unknown error";
    return {
      text: appendNotice(text, `⚠️ ${detail}`),
      tone: "error",
    };
  }

  if (stopReason === "length") {
    return {
      text: appendNotice(text, "⚠️ Output length limit reached"),
      tone: text ? "assistant" : "system",
    };
  }

  if (!text) return null;
  return { text, tone: "assistant" };
}

/** Accept only assistant messages observed in the current session-level run, not session history. */
export function formatTelegramAssistantResultFromMessages(runMessages, aborted = false) {
  const assistants = Array.isArray(runMessages)
    ? runMessages.filter((message) => message?.role === "assistant")
    : [];
  let message = assistants.at(-1);
  if (
    message &&
    (aborted || message.stopReason === "aborted") &&
    !extractTextFromMessage(message)
  ) {
    const partial = assistants.findLast((assistant) => extractTextFromMessage(assistant));
    if (partial) message = { ...message, content: partial.content };
  }
  return formatTelegramAssistantResult(message, aborted);
}

function readErrorMessage(message) {
  const errorMessage = message?.errorMessage;
  return typeof errorMessage === "string" ? errorMessage.trim() : "";
}

function appendNotice(text, notice) {
  return text ? `${text}\n\n${notice}` : notice;
}
