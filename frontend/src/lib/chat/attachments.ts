import type { AttachedFile } from "@/types";

/** Largest single attachment we will base64 into a request body. */
export const MAX_FILE_BYTES = 8 * 1024 * 1024;

export interface AttachmentSelection {
  /** Files to add, newest last. */
  accepted: File[];
  /** One human-readable reason per rejected file. */
  rejected: string[];
}

/**
 * Splits picked files into accepted and rejected, given how many are attached
 * already. Pure so the limit can be tested.
 */
export const selectAttachableFiles = (
  files: File[],
  alreadyAttached: number,
  maxFiles: number,
  maxBytes: number = MAX_FILE_BYTES
): AttachmentSelection => {
  const accepted: File[] = [];
  const rejected: string[] = [];
  let room = maxFiles - alreadyAttached;

  for (const file of files) {
    if (room <= 0) {
      rejected.push(`${file.name}: too many attachments (limit ${maxFiles})`);
      continue;
    }
    if (file.size > maxBytes) {
      rejected.push(
        `${file.name}: too large (limit ${Math.round(maxBytes / 1024 / 1024)} MB)`
      );
      continue;
    }
    accepted.push(file);
    room -= 1;
  }

  return { accepted, rejected };
};

/** Attachments are stored as base64 without the data URL prefix. */
export const toAttachedFile = (file: File, base64: string): AttachedFile => ({
  id: crypto.randomUUID(),
  name: file.name,
  type: file.type,
  base64,
  size: file.size,
});
