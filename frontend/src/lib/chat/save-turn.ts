/**
 * Saves a finished turn. Both chat surfaces call this, so the ids, the title
 * and the creation date are handled the same way everywhere.
 */
import {
  generateConversationTitle,
  getConversationById,
  saveConversation,
} from "../database/conversations.ts";
import {
  MESSAGE_ID_OFFSET,
  generateConversationId,
  generateMessageId,
} from "./constants.ts";
import type { ChatConversation, ChatMessage } from "@/types";

export interface SaveTurnParams {
  /** Existing conversation, or null for a new one (an id is generated). */
  conversationId: string | null;
  /** The conversation so far, oldest message first. */
  history: ChatMessage[];
  userMessage: string;
  assistantResponse: string;
  /** Best-known title when the database has none yet. */
  title?: string;
  createdAt?: number;
  /** Overrides the turn's timestamp (tests). */
  timestamp?: number;
}

export interface SavedTurn {
  conversation: ChatConversation;
  messages: ChatMessage[];
}

export async function saveTurn(params: SaveTurnParams): Promise<SavedTurn> {
  const timestamp = params.timestamp ?? Date.now();
  const conversationId =
    params.conversationId || generateConversationId("chat");

  const userMsg: ChatMessage = {
    id: generateMessageId("user", timestamp),
    role: "user",
    content: params.userMessage,
    timestamp,
  };
  const assistantMsg: ChatMessage = {
    id: generateMessageId("assistant", timestamp + MESSAGE_ID_OFFSET),
    role: "assistant",
    content: params.assistantResponse,
    timestamp: timestamp + MESSAGE_ID_OFFSET,
  };

  const messages = [...params.history, userMsg, assistantMsg];

  // The stored conversation owns the title and the creation date: a reloaded
  // conversation keeps them, a new one takes the caller's guess.
  let existing: ChatConversation | null = null;
  if (params.conversationId) {
    try {
      existing = await getConversationById(params.conversationId);
    } catch (error) {
      console.error("Failed to get existing conversation:", error);
    }
  }

  const conversation: ChatConversation = {
    id: conversationId,
    title:
      existing?.title ||
      params.title ||
      generateConversationTitle(params.userMessage),
    messages,
    messageCount: messages.length,
    createdAt: existing?.createdAt || params.createdAt || timestamp,
    updatedAt: timestamp,
  };

  await saveConversation(conversation);

  return { conversation, messages };
}
