import { useCallback, useState } from "react";
import type { ChangeEvent, ClipboardEvent } from "react";
import {
  blobToBase64,
  selectAttachableFiles,
  toAttachedFile,
} from "@/lib";
import { MAX_FILES } from "@/config";
import { AttachedFile } from "@/types";

/**
 * Attached files for a chat surface: add, remove, pick, paste. Rejected files
 * (too many, too large) are reported through `onError`.
 */
export const useAttachments = (onError?: (message: string) => void) => {
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);

  const addFile = useCallback(
    async (file: File) => {
      try {
        const base64 = await blobToBase64(file);
        setAttachedFiles((prev) => [...prev, toAttachedFile(file, base64)]);
      } catch (error) {
        console.error("Failed to process file:", error);
      }
    },
    []
  );

  const addFiles = useCallback(
    async (files: File[], alreadyAttached: number) => {
      const { accepted, rejected } = selectAttachableFiles(
        files,
        alreadyAttached,
        MAX_FILES
      );
      if (rejected.length > 0) {
        onError?.(rejected[0]);
      }
      await Promise.all(accepted.map((file) => addFile(file)));
    },
    [addFile, onError]
  );

  const removeFile = useCallback((fileId: string) => {
    setAttachedFiles((prev) => prev.filter((f) => f.id !== fileId));
  }, []);

  const clearFiles = useCallback(() => {
    setAttachedFiles([]);
  }, []);

  const handleFileSelect = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files || []).filter((file) =>
        file.type.startsWith("image/")
      );

      // Reset input so the same file can be selected again
      e.target.value = "";

      if (files.length > 0) {
        void addFiles(files, attachedFiles.length);
      }
    },
    [addFiles, attachedFiles.length]
  );

  const handlePaste = useCallback(
    async (e: ClipboardEvent) => {
      // Check if clipboard contains images
      const items = e.clipboardData?.items;
      if (!items) return;

      const hasImages = Array.from(items).some((item) =>
        item.type.startsWith("image/")
      );

      // If we have images, prevent default text pasting and process images
      if (hasImages) {
        e.preventDefault();

        const pastedFiles: File[] = [];
        Array.from(items).forEach((item) => {
          if (item.type.startsWith("image/")) {
            const file = item.getAsFile();
            if (file) {
              pastedFiles.push(file);
            }
          }
        });

        await addFiles(pastedFiles, attachedFiles.length);
      }
    },
    [addFiles, attachedFiles.length]
  );

  return {
    attachedFiles,
    setAttachedFiles,
    addFile,
    removeFile,
    clearFiles,
    handleFileSelect,
    handlePaste,
  };
};
