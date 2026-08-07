import { useCallback, useState } from "react";
import type { ChangeEvent, ClipboardEvent } from "react";
import { MAX_FILES } from "@/config";
import { blobToBase64 } from "@/lib";
import { AttachedFile } from "@/types";

/**
 * Shared file-attachment state: add/remove/clear + image file-picker and
 * image-paste handlers. Used by useCompletion and useChatCompletion.
 */
export const useAttachments = () => {
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);

  const addFile = useCallback(async (file: File) => {
    try {
      const base64 = await blobToBase64(file);
      const attachedFile: AttachedFile = {
        id: crypto.randomUUID(),
        name: file.name,
        type: file.type,
        base64,
        size: file.size,
      };

      setAttachedFiles((prev) => [...prev, attachedFile]);
    } catch (error) {
      console.error("Failed to process file:", error);
    }
  }, []);

  const removeFile = useCallback((fileId: string) => {
    setAttachedFiles((prev) => prev.filter((f) => f.id !== fileId));
  }, []);

  const clearFiles = useCallback(() => {
    setAttachedFiles([]);
  }, []);

  const handleFileSelect = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files || []);

      files.forEach((file) => {
        if (file.type.startsWith("image/") && attachedFiles.length < MAX_FILES) {
          addFile(file);
        }
      });

      // Reset input so same file can be selected again
      e.target.value = "";
    },
    [attachedFiles.length, addFile]
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

        const processedFiles: File[] = [];

        Array.from(items).forEach((item) => {
          if (
            item.type.startsWith("image/") &&
            attachedFiles.length + processedFiles.length < MAX_FILES
          ) {
            const file = item.getAsFile();
            if (file) {
              processedFiles.push(file);
            }
          }
        });

        // Process all files
        await Promise.all(processedFiles.map((file) => addFile(file)));
      }
    },
    [attachedFiles.length, addFile]
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
