import { useState, useCallback, useRef } from "react";
import { useApp } from "@/contexts";
import { MAX_FILES } from "@/config";
import {
  fetchAIResponse,
  saveConversation,
  getConversationById,
  generateConversationTitle,
  shouldUsePiely,
  MESSAGE_ID_OFFSET,
  generateMessageId,
  getResponseSettings,
} from "@/lib";
import { AttachedFile, ChatConversation, ChatMessage, ScreenshotConfig } from "@/types";
import { useAttachments } from "./useAttachments";
import { useScreenshotCapture } from "./useScreenshotCapture";
import { useStreamRequest } from "./useStreamRequest";

interface ChatCompletionUiState {
  input: string;
  isLoading: boolean;
  error: string | null;
}

export const useChatCompletion = (
  conversationId: string,
  messages: ChatConversation | null,
  setMessages: (messages: ChatConversation | null) => void
) => {
  const {
    selectedAIProvider,
    allAiProviders,
    systemPrompt,
    screenshotConfiguration,
    setScreenshotConfiguration,
    selectedSttProvider,
    allSttProviders,
    selectedAudioDevices,
  } = useApp();

  const [state, setState] = useState<ChatCompletionUiState>({
    input: "",
    isLoading: false,
    error: null,
  });

  const [micOpen, setMicOpen] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isFilesPopoverOpen, setIsFilesPopoverOpen] = useState(false);

  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const { beginRequest, isCurrent, cancel } = useStreamRequest();
  const {
    attachedFiles,
    setAttachedFiles,
    addFile,
    removeFile,
    clearFiles,
    handleFileSelect,
    handlePaste,
  } = useAttachments();

  const setInput = useCallback((value: string) => {
    setState((prev) => ({ ...prev, input: value }));
  }, []);

  const reportError = useCallback((message: string) => {
    setState((prev) => ({ ...prev, error: message }));
  }, []);

  const scrollToBottom = useCallback(() => {
    const responseSettings = getResponseSettings();
    if (responseSettings.autoScroll) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, []);

  const submit = useCallback(
    async (speechText?: string, screenshotImage?: AttachedFile) => {
      const input = speechText || state.input;

      if (!input.trim()) {
        return;
      }

      if (speechText) {
        setState((prev) => ({
          ...prev,
          input: speechText,
        }));
      }

      // Start a new request, cancelling any in-flight one
      const { requestId, signal } = beginRequest();

      try {
        // Prepare message history for the AI
        const messageHistory = (messages?.messages || []).map((msg) => ({
          role: msg.role,
          content: msg.content,
        }));

        // Handle image attachments (a screenshot counts as an attached image)
        const files = screenshotImage
          ? [...attachedFiles, screenshotImage]
          : attachedFiles;
        const images = files
          .filter((file) => file.type.startsWith("image/"))
          .map((file) => ({ data: file.base64, mimeType: file.type }));

        const usePiely = shouldUsePiely();
        // Check if AI provider is configured
        if (!selectedAIProvider.provider && !usePiely) {
          setState((prev) => ({
            ...prev,
            error: "Please select an AI provider in settings",
          }));
          return;
        }

        const provider = allAiProviders.find(
          (p) => p.id === selectedAIProvider.provider
        );
        if (!provider && !usePiely) {
          setState((prev) => ({
            ...prev,
            error: "Invalid provider selected",
          }));
          return;
        }

        // Add user message to UI immediately
        const timestamp = Date.now();
        const userMsg: ChatMessage = {
          id: generateMessageId("user", timestamp),
          role: "user",
          content: input,
          timestamp,
        };

        const updatedMessages = {
          ...messages!,
          messages: [...(messages?.messages || []), userMsg],
        };
        setMessages(updatedMessages);

        // Clear input and set loading state
        setState((prev) => ({
          ...prev,
          input: "",
          isLoading: true,
          error: null,
        }));
        clearFiles();

        // Scroll to bottom after adding user message
        setTimeout(scrollToBottom, 100);

        let fullResponse = "";

        try {
          // Use the fetchAIResponse function with signal
          for await (const chunk of fetchAIResponse({
            provider: usePiely ? undefined : provider,
            selectedProvider: selectedAIProvider,
            systemPrompt: systemPrompt || undefined,
            history: messageHistory,
            userMessage: input,
            images,
            signal,
          })) {
            // Only update if this is still the current request
            if (!isCurrent(requestId, signal)) {
              return; // Request was superseded or cancelled, stop processing
            }

            fullResponse += chunk;

            // Update the last message (assistant's response) in real-time
            const assistantMsg: ChatMessage = {
              id: generateMessageId("assistant", timestamp + MESSAGE_ID_OFFSET),
              role: "assistant",
              content: fullResponse,
              timestamp: timestamp + MESSAGE_ID_OFFSET,
            };

            setMessages({
              ...updatedMessages,
              messages: [...updatedMessages.messages, assistantMsg],
            });

            // Auto-scroll during streaming
            scrollToBottom();
          }
        } catch (e) {
          // Only show error if this is still the current request and not aborted
          if (isCurrent(requestId, signal)) {
            setState((prev) => ({
              ...prev,
              isLoading: false,
              error: e instanceof Error ? e.message : "An error occurred",
            }));
          }
          return;
        }

        // Only proceed if this is still the current request
        if (!isCurrent(requestId, signal)) {
          return;
        }

        setState((prev) => ({ ...prev, isLoading: false }));

        // Focus input after AI response is complete
        setTimeout(() => {
          inputRef.current?.focus();
        }, 100);

        // Save the conversation after successful completion
        if (fullResponse) {
          const assistantMsg: ChatMessage = {
            id: generateMessageId("assistant", timestamp + MESSAGE_ID_OFFSET),
            role: "assistant",
            content: fullResponse,
            timestamp: timestamp + MESSAGE_ID_OFFSET,
          };

          const newMessages = [
            ...(messages?.messages || []),
            userMsg,
            assistantMsg,
          ];

          // Get existing conversation if updating
          let existingConversation = null;
          if (conversationId) {
            try {
              existingConversation = await getConversationById(conversationId);
            } catch (error) {
              console.error("Failed to get existing conversation:", error);
            }
          }

          const title =
            existingConversation?.title ||
            messages?.title ||
            generateConversationTitle(input);

          const conversation: ChatConversation = {
            id: conversationId,
            title,
            messages: newMessages,
            createdAt:
              existingConversation?.createdAt ||
              messages?.createdAt ||
              timestamp,
            updatedAt: timestamp,
          };

          try {
            await saveConversation(conversation);

            // Reload conversation from database to ensure consistency
            const updatedConversation = await getConversationById(
              conversationId
            );
            if (updatedConversation) {
              setMessages(updatedConversation);
            }
          } catch (error) {
            console.error("Failed to save conversation:", error);
            setState((prev) => ({
              ...prev,
              error: "Failed to save conversation. Please try again.",
            }));
          }
        }
      } catch (error) {
        // Only show error if not aborted
        if (isCurrent(requestId, signal)) {
          setState((prev) => ({
            ...prev,
            error: error instanceof Error ? error.message : "An error occurred",
            isLoading: false,
          }));
        }
      }
    },
    [
      state.input,
      attachedFiles,
      selectedAIProvider,
      allAiProviders,
      systemPrompt,
      messages,
      conversationId,
      setMessages,
      beginRequest,
      isCurrent,
      scrollToBottom,
      clearFiles,
    ]
  );

  const cancelRequest = useCallback(() => {
    cancel();
    setState((prev) => ({ ...prev, isLoading: false }));
  }, [cancel]);

  const handleScreenshotSubmit = useCallback(
    async (base64: string, prompt?: string) => {
      if (attachedFiles.length >= MAX_FILES) {
        setState((prev) => ({
          ...prev,
          error: `You can only upload ${MAX_FILES} files`,
        }));
        return;
      }

      const attachedFile: AttachedFile = {
        id: crypto.randomUUID(),
        name: `screenshot_${Date.now()}.png`,
        type: "image/png",
        base64: base64,
        size: base64.length,
      };

      if (prompt) {
        // Auto mode: Submit directly to AI with screenshot (submit clears
        // the input on success)
        await submit(prompt, attachedFile);
      } else {
        // Manual mode: Add to attached files
        setAttachedFiles((prev) => [...prev, attachedFile]);
      }
    },
    [attachedFiles.length, submit, setAttachedFiles]
  );

  const handleScreenshotCaptured = useCallback(
    async (base64: string, config: ScreenshotConfig) => {
      await handleScreenshotSubmit(
        base64,
        config.mode === "auto" ? config.autoPrompt : undefined
      );
    },
    [handleScreenshotSubmit]
  );

  const { captureScreenshot, isScreenshotLoading } = useScreenshotCapture(
    handleScreenshotCaptured,
    reportError
  );

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!state.isLoading && state.input.trim()) {
        submit();
      }
    }
  };

  return {
    input: state.input,
    setInput,
    isLoading: state.isLoading,
    error: state.error,
    attachedFiles,
    addFile,
    removeFile,
    clearFiles,
    submit,
    cancel: cancelRequest,
    setState,
    isRecording,
    setIsRecording,
    micOpen,
    setMicOpen,
    screenshotConfiguration,
    setScreenshotConfiguration,
    handleScreenshotSubmit,
    handleFileSelect,
    handleKeyPress,
    handlePaste,
    isFilesPopoverOpen,
    setIsFilesPopoverOpen,
    onRemoveAllFiles: () => {
      clearFiles();
      setIsFilesPopoverOpen(false);
    },
    inputRef,
    captureScreenshot,
    isScreenshotLoading,
    messagesEndRef,
    selectedSttProvider,
    allSttProviders,
    selectedAudioDevices,
  };
};
