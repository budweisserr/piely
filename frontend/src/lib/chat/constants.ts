/**
 * Timings and id formats the chat surfaces share.
 *
 * The id generators all end in a random suffix on purpose: message ids are a
 * global primary key, so two messages written in the same millisecond would
 * otherwise collide.
 */

/** Assistant ids are one millisecond after the user id they answer. */
export const MESSAGE_ID_OFFSET = 1;

/** Wait this long after the last change before writing a conversation. */
export const CONVERSATION_SAVE_DEBOUNCE_MS = 500;

/** How often the streaming UI looks for new text from the sidecar. */
export const CHUNK_POLL_INTERVAL_MS = 50;

/** How long the "downloaded" checkmark stays on screen. */
export const DOWNLOAD_SUCCESS_DISPLAY_MS = 1000;

/** Characters of randomness appended to every generated id. */
export const CONVERSATION_ID_RANDOM_LENGTH = 9;

export function generateConversationId(
  source: "chat" | "sysaudio" = "chat"
): string {
  const timestamp = Date.now();
  const random = Math.random()
    .toString(36)
    .substring(2, 2 + CONVERSATION_ID_RANDOM_LENGTH);
  const prefix = source === "sysaudio" ? "sysaudio_conv" : "conv";
  return `${prefix}_${timestamp}_${random}`;
}

export function generateMessageId(
  role: "user" | "assistant" | "system",
  timestamp: number = Date.now()
): string {
  const random = Math.random()
    .toString(36)
    .substring(2, 2 + CONVERSATION_ID_RANDOM_LENGTH);
  return `msg_${timestamp}_${role}_${random}`;
}

export function generateRequestId(): string {
  const timestamp = Date.now();
  const random = Math.random()
    .toString(36)
    .substring(2, 2 + CONVERSATION_ID_RANDOM_LENGTH);
  return `req_${timestamp}_${random}`;
}
