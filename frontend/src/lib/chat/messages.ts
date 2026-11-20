import type { ChatMessage } from "@/types";

export interface ModelMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

/** Stored newest-first (the UI prepends), sent oldest-first to models. */
export const toModelHistory = (messages: ChatMessage[]): ModelMessage[] =>
  [...messages].reverse().map(({ role, content }) => ({ role, content }));

/** True when the newest stored message is already this user turn. */
export const endsWithUserMessage = (
  messages: ChatMessage[],
  content: string
): boolean =>
  messages.length > 0 &&
  messages[0].role === "user" &&
  messages[0].content === content;
