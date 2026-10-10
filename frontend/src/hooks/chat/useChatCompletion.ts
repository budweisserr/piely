import { useState, useCallback, useRef } from "react";
import { useApp } from "@/contexts";
import { MAX_FILES } from "@/config";
import {
  saveTurn,
  getConversationById,
  resolveChatTarget,
  streamChat,
  MESSAGE_ID_OFFSET,
  generateMessageId,
  getResponseSettings,
} from "@/lib";
import { AttachedFile, ChatConversation, ChatMessage, ScreenshotConfig } from "@/types";
import { useAttachments } from "./useAttachments";
import { useScreenshotCapture } from "../system/useScreenshotCapture";
import { useStreamRequest } from "./useStreamRequest";
import { useToolCalling } from "./useToolCalling";

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
    customizable,
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

  const reportError = useCallback((message: string) => {
    setState((prev) => ({ ...prev, error: message }));
  }, []);

  const {
    attachedFiles,
    setAttachedFiles,
    addFile,
    removeFile,
    clearFiles,
    handleFileSelect,
    handlePaste,
  } = useAttachments(reportError);

  const {
    toolActivities,
    pendingActions,
    approveAction,
    confirmToolAction,
    releaseActions,
    recordActivity,
    reset: resetToolActivity,
  } = useToolCalling();

  const setInput = useCallback((value: string) => {
    setState((prev) => ({ ...prev, input: value }));
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

        const target = resolveChatTarget(
          selectedAIProvider,
          allAiProviders
        );

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
        resetToolActivity();

        // Scroll to bottom after adding user message
        setTimeout(scrollToBottom, 100);

        let fullResponse = "";

        try {
          for await (const event of streamChat({
            target,
            selectedProvider: selectedAIProvider,
            systemPrompt: systemPrompt || undefined,
            history: messageHistory,
            userMessage: input,
            images,
            signal,
            toolCallingEnabled: customizable.toolCalling.isEnabled,
            approveAction,
          })) {
            // Only update if this is still the current request
            if (!isCurrent(requestId, signal)) {
              return; // Request was superseded or cancelled, stop processing
            }

            if (event.type === "activity") {
              recordActivity(event.activity);
              continue;
            }

            fullResponse += event.text;

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
          try {
            await saveTurn({
              conversationId,
              history: messages?.messages || [],
              userMessage: input,
              assistantResponse: fullResponse,
              title: messages?.title,
              createdAt: messages?.createdAt,
              // The user message already went into the UI with this timestamp.
              timestamp,
            });

            // Reload from the database: the saved copy is the source of truth.
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
      customizable.toolCalling.isEnabled,
      approveAction,
      recordActivity,
      resetToolActivity,
      beginRequest,
      isCurrent,
      scrollToBottom,
      clearFiles,
    ]
  );

  const cancelRequest = useCallback(() => {
    cancel();
    releaseActions();
    setState((prev) => ({ ...prev, isLoading: false }));
  }, [cancel, releaseActions]);

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
    toolActivities,
    pendingActions,
    confirmToolAction,
  };
};
