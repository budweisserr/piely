import type Database from "@tauri-apps/plugin-sql";
import type { ChatMessage } from "@/types";

/**
 * Validate message data
 */
export function validateMessage(message: any): boolean {
  if (!message.id || typeof message.id !== "string") {
    console.error("Invalid message: missing or invalid id");
    return false;
  }
  if (
    !message.role ||
    !["user", "assistant", "system"].includes(message.role)
  ) {
    console.error("Invalid message: missing or invalid role");
    return false;
  }
  if (typeof message.content !== "string") {
    console.error("Invalid message: content must be a string");
    return false;
  }
  if (typeof message.timestamp !== "number" || message.timestamp < 0) {
    console.error("Invalid message: invalid timestamp");
    return false;
  }
  return true;
}

/**
 * Upserts a conversation's messages, writing only the rows that changed.
 *
 * It never deletes: two windows can have the same conversation open, and the
 * one that saves later does not know about the other's messages. (A
 * delete-then-reinsert is no good either: the pool gives each statement its own
 * connection, so a crash between the two would empty the conversation.)
 */
export async function writeMessages(
  db: Database,
  conversationId: string,
  messages: ChatMessage[]
): Promise<void> {
  const existing = await db.select<
    { id: string; content: string; attached_files: string | null }[]
  >("SELECT id, content, attached_files FROM messages WHERE conversation_id = ?", [
    conversationId,
  ]);
  const existingById = new Map(existing.map((row) => [row.id, row]));

  for (const message of messages) {
    if (!validateMessage(message)) {
      console.warn("Skipping invalid message in conversation write");
      continue;
    }

    const attachedFilesJson = message.attachedFiles
      ? JSON.stringify(message.attachedFiles)
      : null;
    const current = existingById.get(message.id);
    if (
      current &&
      current.content === message.content &&
      current.attached_files === attachedFilesJson
    ) {
      continue; // unchanged: no write, no trigger
    }

    await db.execute(
      `INSERT INTO messages (id, conversation_id, role, content, timestamp, attached_files)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         content = excluded.content,
         timestamp = excluded.timestamp,
         attached_files = excluded.attached_files`,
      [
        message.id,
        conversationId,
        message.role,
        message.content,
        message.timestamp,
        attachedFilesJson,
      ]
    );
  }
}
