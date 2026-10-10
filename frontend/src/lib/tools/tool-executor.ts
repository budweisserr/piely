import { invoke } from "@tauri-apps/api/core";
import type { ToolCall } from "./tool-definitions.ts";

interface FileHit {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  modified_ms: number;
}

interface FilePreview {
  kind: "text" | "binary" | "image" | "directory";
  name: string;
  path: string;
  size: number;
  truncated: boolean;
  text?: string;
  entries?: string[];
  message?: string;
}

interface AppEntry {
  name: string;
  id: string;
  path: string;
}

interface ContentMatch {
  path: string;
  name: string;
  size: number;
  modified_ms: number;
  terms_matched: number;
  match_count: number;
  snippets: string[];
}

interface ContentSearchResult {
  count: number;
  files_scanned: number;
  skipped_binary: number;
  truncated: boolean;
  results: ContentMatch[];
}

interface DirEntryInfo {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  modified_ms: number;
}

/** What one tool call produced: text for the model, plus a line for the UI. */
export interface ToolOutcome {
  text: string;
  isError: boolean;
  summary: string;
}

const formatBytes = (size: number): string => {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
};

const succeeded = (summary: string, payload: unknown): ToolOutcome => ({
  summary,
  text: JSON.stringify(payload),
  isError: false,
});

const failed = (summary: string): ToolOutcome => ({
  summary,
  text: summary,
  isError: true,
});

/** Runs one tool call in Rust and returns the text for the model. */
export const runToolCall = async (call: ToolCall): Promise<ToolOutcome> => {
  const args = call.arguments ?? {};
  try {
    switch (call.name) {
      case "find_files": {
        const query = String(args.query ?? "").trim();
        if (!query) return failed("find_files requires a query");
        const data = await invoke<{ count: number; results: FileHit[] }>(
          "tools_find_files",
          {
            query,
            directory: args.directory ? String(args.directory) : null,
            limit: typeof args.limit === "number" ? args.limit : null,
          }
        );
        return succeeded(
          data.count === 0
            ? `No files found for "${query}"`
            : `Found ${data.count} ${
                data.count === 1 ? "file" : "files"
              } matching "${query}"`,
          data
        );
      }

      case "search_files_content": {
        const query = String(args.query ?? "").trim();
        if (!query) return failed("search_files_content requires a query");
        const data = await invoke<ContentSearchResult>(
          "tools_search_files_content",
          {
            query,
            directory: args.directory ? String(args.directory) : null,
            extensions: Array.isArray(args.extensions)
              ? args.extensions.map((ext) => String(ext))
              : null,
            limit: typeof args.limit === "number" ? args.limit : null,
          }
        );
        if (data.count === 0) {
          const skipped = data.skipped_binary
            ? ` (${data.skipped_binary} non-text files skipped)`
            : "";
          return succeeded(
            `Nothing mentions "${query}" in ${data.files_scanned} files${skipped}`,
            data
          );
        }
        return succeeded(
          `${data.count} ${
            data.count === 1 ? "file mentions" : "files mention"
          } "${query}" (of ${data.files_scanned} files read)`,
          data
        );
      }

      case "list_directory": {
        const data = await invoke<{
          path: string;
          count: number;
          truncated: boolean;
          entries: DirEntryInfo[];
        }>("tools_list_directory", {
          path: args.path ? String(args.path) : null,
          depth: typeof args.depth === "number" ? args.depth : null,
        });
        return succeeded(
          `Listed ${data.count} entries in ${data.path}`,
          data
        );
      }

      case "read_file": {
        const path = String(args.path ?? "").trim();
        if (!path) return failed("read_file requires a path");
        const preview = await invoke<FilePreview>("tools_read_file", {
          path,
          maxBytes: typeof args.max_bytes === "number" ? args.max_bytes : null,
        });
        const label = preview.name || preview.path;
        return succeeded(
          preview.kind === "directory"
            ? `Listed ${preview.entries?.length ?? 0} entries in ${label}`
            : `Previewed ${label} (${formatBytes(preview.size)})`,
          preview
        );
      }

      case "list_apps": {
        const query = args.query ? String(args.query) : null;
        const data = await invoke<{ count: number; results: AppEntry[] }>(
          "tools_list_apps",
          { query }
        );
        return succeeded(
          query
            ? `${data.count} applications matching "${query}"`
            : `${data.count} applications installed`,
          data
        );
      }

      case "open_file": {
        const path = String(args.path ?? "").trim();
        if (!path) return failed("open_file requires a path");
        await invoke("tools_open_path", { path });
        return succeeded(`Opened ${path}`, { opened: path });
      }

      case "open_app": {
        const name = String(args.name ?? "").trim();
        if (!name) return failed("open_app requires a name");
        await invoke("tools_open_app", { name });
        return succeeded(`Launched ${name}`, { launched: name });
      }

      default:
        return failed(`Unknown tool: ${call.name}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failed(`${call.name} failed: ${message}`);
  }
};
