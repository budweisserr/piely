/**
 * The text protocol for models that cannot call tools.
 *
 * A model without native tool support asks for one by replying with a fenced
 * block named `tool` that holds `{"name": …, "arguments": {…}}`, and ends its
 * turn there. The app runs the tool and sends the result back as the next user
 * message, so the loop looks the same to the model as a normal reply.
 */
import { COMPUTER_USE_TOOLS } from "./tool-definitions.ts";
import type { ToolOutcome } from "./tool-executor.ts";

const FENCE = "```";
const MAX_BLOCK_CHARS = 100_000;

/** Every tool the app can run, for validating what the model asked for. */
export const KNOWN_TOOL_NAMES: ReadonlySet<string> = new Set(
  COMPUTER_USE_TOOLS.map((tool) => tool.name)
);

export interface ToolRequest {
  name: string;
  arguments: Record<string, unknown>;
}

/** Added to the system prompt whenever tools are enabled. */
export const TOOL_PROTOCOL_INSTRUCTIONS = [
  "If you cannot call tools directly, ask for one by replying with a fenced block named tool that contains only JSON, and end your turn right after it:",
  '```tool\n{"name":"find_files","arguments":{"query":"budget"}}\n```',
  "One block per turn, and the user has to approve tools that change anything (write_file, open_file, open_app). The app runs the tool and your next message starts with TOOL RESULT (<tool>): never invent that result, wait for it.",
].join(" ");

/** Parses the body of a ```tool block. Returns null when it is not a tool call. */
export const parseToolRequest = (block: string): ToolRequest | null => {
  const body = block.trim();
  if (!body || body.length > MAX_BLOCK_CHARS) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  const name = record.name ?? record.tool;
  if (typeof name !== "string" || !KNOWN_TOOL_NAMES.has(name)) return null;

  const args = record.arguments ?? record.parameters ?? {};
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return null;
  }
  return { name, arguments: args as Record<string, unknown> };
};

/**
 * Splits a streamed answer into text for the user and tool requests.
 *
 * Text outside a tool block is emitted as it arrives, so a streaming answer
 * still streams; a block is held back until it is complete. Blocks that are not
 * tool calls (a ```python sample, malformed JSON) come back out as text.
 */
export class ToolProtocolFilter {
  private buffer = "";

  push(chunk: string): { text: string; requests: ToolRequest[] } {
    this.buffer += chunk;
    return this.drain(false);
  }

  flush(): { text: string; requests: ToolRequest[] } {
    return this.drain(true);
  }

  private drain(final: boolean): { text: string; requests: ToolRequest[] } {
    let text = "";
    const requests: ToolRequest[] = [];

    for (;;) {
      const start = this.buffer.indexOf(FENCE);
      if (start === -1) {
        // Hold a possible partial fence ("``") for the next chunk.
        const keep = final ? 0 : FENCE.length - 1;
        if (this.buffer.length > keep) {
          text += this.buffer.slice(0, this.buffer.length - keep);
          this.buffer = this.buffer.slice(this.buffer.length - keep);
        }
        if (final && this.buffer) {
          text += this.buffer;
          this.buffer = "";
        }
        break;
      }

      if (start > 0) {
        text += this.buffer.slice(0, start);
        this.buffer = this.buffer.slice(start);
      }

      const after = this.buffer.slice(FENCE.length);
      const info = /^tool[ \t]*\r?\n/.exec(after);
      if (!info) {
        if (!final && after.length < "tool\n".length) break; // may still become one
        text += FENCE;
        this.buffer = after;
        continue;
      }

      const bodyStart = FENCE.length + info[0].length;
      const end = this.buffer.indexOf(`\n${FENCE}`, bodyStart);
      if (end === -1) {
        if (final) {
          text += this.buffer;
          this.buffer = "";
        }
        break;
      }

      const block = this.buffer.slice(bodyStart, end);
      this.buffer = this.buffer.slice(end + 1 + FENCE.length);
      const request = parseToolRequest(block);
      if (request) {
        requests.push(request);
      } else {
        text += `${FENCE}tool\n${block}\n${FENCE}`;
      }
    }

    return { text, requests };
  }
}

/** What the model reads back after a tool ran. */
export const toolResultText = (name: string, outcome: ToolOutcome): string =>
  `TOOL RESULT (${name})${outcome.isError ? " [failed]" : ""}: ${outcome.text}`;
