import { useState, useCallback, useRef, useEffect } from "react";
import { useWindowResize } from "../system/useWindow";
import { useGlobalShortcuts } from "@/hooks";
import { MAX_FILES } from "@/config";
import { useApp } from "@/contexts";
import {
  safeJsonParse,
  saveTurn,
  getConversationById,
  resolveChatTarget,
  streamChat,
  getResponseSettings,
} from "@/lib";
import { AttachedFile, ChatMessage, ChatConversation, ScreenshotConfig } from "@/types";
import { useAttachments } from "./useAttachments";
import { useScreenshotCapture } from "../system/useScreenshotCapture";
import { useStreamRequest } from "./useStreamRequest";
import { useToolCalling } from "./useToolCalling";

interface CompletionUiState {
  input: string;
  response: string;
  isLoading: boolean;
  error: string | null;
  currentConversationId: string | null;
  conversationHistory: ChatMessage[];
}

export const useCompletion = () => {
  const {
    selectedAIProvider,
    allAiProviders,
    systemPrompt,
    screenshotConfiguration,
    setScreenshotConfiguration,
    customizable,
  } = useApp();
  const globalShortcuts = useGlobalShortcuts();

  const [state, setState] = useState<CompletionUiState>({
    input: "",
    response: "",
    isLoading: false,
    error: null,
    currentConversationId: null,
    conversationHistory: [],
  });
  const [micOpen, setMicOpen] = useState(false);
  const [enableVAD, setEnableVAD] = useState(false);
  const [messageHistoryOpen, setMessageHistoryOpen] = useState(false);
  const [isFilesPopoverOpen, setIsFilesPopoverOpen] = useState(false);
  const [keepEngaged, setKeepEngaged] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const scrollAreaRef = useRef<HTMLDivElement>(null);

  const { resizeWindow } = useWindowResize();
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

  const setResponse = useCallback((value: string) => {
    setState((prev) => ({ ...prev, response: value }));
  }, []);

  const loadConversation = useCallback((conversation: ChatConversation) => {
    setState((prev) => ({
      ...prev,
      currentConversationId: conversation.id,
      conversationHistory: conversation.messages,
      input: "",
      response: "",
      error: null,
      isLoading: false,
    }));
  }, []);

  const startNewConversation = useCallback(() => {
    setState((prev) => ({
      ...prev,
      currentConversationId: null,
      conversationHistory: [],
      input: "",
      response: "",
      error: null,
      isLoading: false,
    }));
    clearFiles();
  }, [clearFiles]);

  const saveCurrentConversation = useCallback(
    async (userMessage: string, assistantResponse: string) => {
      // Validate inputs
      if (!userMessage || !assistantResponse) {
        console.error("Cannot save conversation: missing message content");
        return;
      }

      try {
        const { conversation, messages } = await saveTurn({
          conversationId: state.currentConversationId,
          history: state.conversationHistory,
          userMessage,
          assistantResponse,
        });

        setState((prev) => ({
          ...prev,
          currentConversationId: conversation.id,
          conversationHistory: messages,
        }));
      } catch (error) {
        console.error("Failed to save conversation:", error);
        // Show error to user
        setState((prev) => ({
          ...prev,
          error: "Failed to save conversation. Please try again.",
        }));
      }
    },
    [state.currentConversationId, state.conversationHistory]
  );

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
        const messageHistory = state.conversationHistory.map((msg) => ({
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

        const target = resolveChatTarget(selectedAIProvider, allAiProviders);

        // Clear previous response and set loading state
        setState((prev) => ({
          ...prev,
          isLoading: true,
          error: null,
          response: "",
        }));
        resetToolActivity();

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
            setState((prev) => ({
              ...prev,
              response: prev.response + event.text,
            }));
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
          await saveCurrentConversation(input, fullResponse);
          // Clear input and attached files after saving
          setState((prev) => ({
            ...prev,
            input: "",
          }));
          clearFiles();
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
      state.conversationHistory,
      attachedFiles,
      selectedAIProvider,
      allAiProviders,
      systemPrompt,
      customizable.toolCalling.isEnabled,
      approveAction,
      recordActivity,
      resetToolActivity,
      beginRequest,
      isCurrent,
      saveCurrentConversation,
      clearFiles,
    ]
  );

  const cancelRequest = useCallback(() => {
    cancel();
    releaseActions();
    setState((prev) => ({ ...prev, isLoading: false }));
  }, [cancel, releaseActions]);

  const reset = useCallback(() => {
    // Don't reset if keep engaged mode is active
    if (keepEngaged) {
      return;
    }
    cancelRequest();
    setState((prev) => ({
      ...prev,
      input: "",
      response: "",
      error: null,
    }));
    clearFiles();
  }, [cancelRequest, keepEngaged, clearFiles]);

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

  // Listen for conversation events from the main ChatHistory component
  useEffect(() => {
    const handleConversationSelected = async (event: Event) => {
      // Only the conversation ID is passed through the event
      const { id } = (event as CustomEvent).detail;
      if (!id || typeof id !== "string") {
        console.error("No conversation ID provided");
        setState((prev) => ({
          ...prev,
          error: "Invalid conversation selected",
        }));
        return;
      }
      try {
        // Fetch the full conversation from SQLite
        const conversation = await getConversationById(id);

        if (conversation) {
          loadConversation(conversation);
        } else {
          console.error(`Conversation ${id} not found in database`);
          setState((prev) => ({
            ...prev,
            error: "Conversation not found. It may have been deleted.",
          }));
        }
      } catch (error) {
        console.error("Failed to load conversation:", error);
        setState((prev) => ({
          ...prev,
          error: "Failed to load conversation. Please try again.",
        }));
      }
    };

    const handleNewConversation = () => {
      startNewConversation();
    };

    const handleConversationDeleted = (event: Event) => {
      const deletedId = (event as CustomEvent).detail;
      // If the currently active conversation was deleted, start a new one
      if (state.currentConversationId === deletedId) {
        startNewConversation();
      }
    };

    const handleStorageChange = async (e: StorageEvent) => {
      if (e.key === "piely-conversation-selected" && e.newValue) {
        const { id } = safeJsonParse<{ id?: string }>(e.newValue, {});
        if (id && typeof id === "string") {
          try {
            const conversation = await getConversationById(id);
            if (conversation) {
              loadConversation(conversation);
            }
          } catch (error) {
            console.error("Failed to load selected conversation:", error);
          }
        }
      }
    };

    window.addEventListener("conversationSelected", handleConversationSelected);
    window.addEventListener("newConversation", handleNewConversation);
    window.addEventListener("conversationDeleted", handleConversationDeleted);
    window.addEventListener("storage", handleStorageChange);

    return () => {
      window.removeEventListener(
        "conversationSelected",
        handleConversationSelected
      );
      window.removeEventListener("newConversation", handleNewConversation);
      window.removeEventListener(
        "conversationDeleted",
        handleConversationDeleted
      );
      window.removeEventListener("storage", handleStorageChange);
    };
  }, [loadConversation, startNewConversation, state.currentConversationId]);

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!state.isLoading && state.input.trim()) {
        submit();
      }
    }
  };

  const isPopoverOpen =
    state.isLoading ||
    state.response !== "" ||
    state.error !== null ||
    keepEngaged;

  useEffect(() => {
    resizeWindow(
      isPopoverOpen || micOpen || messageHistoryOpen || isFilesPopoverOpen
    );
  }, [
    isPopoverOpen,
    micOpen,
    messageHistoryOpen,
    resizeWindow,
    isFilesPopoverOpen,
  ]);

  // Auto scroll to bottom when response updates
  useEffect(() => {
    const responseSettings = getResponseSettings();
    if (
      !keepEngaged &&
      state.response &&
      scrollAreaRef.current &&
      responseSettings.autoScroll
    ) {
      const scrollElement = scrollAreaRef.current.querySelector(
        "[data-radix-scroll-area-viewport]"
      );
      if (scrollElement) {
        scrollElement.scrollTo({
          top: scrollElement.scrollHeight,
          behavior: "smooth",
        });
      }
    }
  }, [state.response, keepEngaged]);

  // Keyboard arrow key support for scrolling
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isPopoverOpen) return;

      const scrollElement = scrollAreaRef.current?.querySelector(
        "[data-radix-scroll-area-viewport]"
      ) as HTMLElement;

      if (!scrollElement) return;

      const scrollAmount = 100; // pixels to scroll

      if (e.key === "ArrowDown") {
        e.preventDefault();
        scrollElement.scrollBy({ top: scrollAmount, behavior: "smooth" });
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        scrollElement.scrollBy({ top: -scrollAmount, behavior: "smooth" });
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isPopoverOpen, scrollAreaRef]);

  // Keyboard shortcut for toggling keep engaged mode (Cmd+K / Ctrl+K)
  useEffect(() => {
    const handleToggleShortcut = (e: KeyboardEvent) => {
      // Only trigger when popover is open
      if (!isPopoverOpen) return;

      // Check for Cmd+K (Mac) or Ctrl+K (Windows/Linux)
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setKeepEngaged((prev) => !prev);
        // Focus the input after toggle (with delay to ensure DOM is ready)
        setTimeout(() => {
          inputRef.current?.focus();
        }, 100);
      }
    };

    window.addEventListener("keydown", handleToggleShortcut);
    return () => window.removeEventListener("keydown", handleToggleShortcut);
  }, [isPopoverOpen]);

  const toggleRecording = useCallback(() => {
    setEnableVAD(!enableVAD);
    setMicOpen(!micOpen);
  }, [enableVAD, micOpen]);

  // register callbacks for global shortcuts
  useEffect(() => {
    globalShortcuts.registerAudioCallback(toggleRecording);
    globalShortcuts.registerInputRef(inputRef.current);
    globalShortcuts.registerScreenshotCallback(captureScreenshot);
  }, [
    globalShortcuts.registerAudioCallback,
    globalShortcuts.registerInputRef,
    globalShortcuts.registerScreenshotCallback,
    toggleRecording,
    captureScreenshot,
    inputRef,
  ]);

  return {
    input: state.input,
    setInput,
    response: state.response,
    setResponse,
    isLoading: state.isLoading,
    error: state.error,
    attachedFiles,
    addFile,
    removeFile,
    clearFiles,
    submit,
    cancel: cancelRequest,
    reset,
    setState,
    enableVAD,
    setEnableVAD,
    micOpen,
    setMicOpen,
    currentConversationId: state.currentConversationId,
    conversationHistory: state.conversationHistory,
    loadConversation,
    startNewConversation,
    messageHistoryOpen,
    setMessageHistoryOpen,
    screenshotConfiguration,
    setScreenshotConfiguration,
    handleScreenshotSubmit,
    handleFileSelect,
    handleKeyPress,
    handlePaste,
    isPopoverOpen,
    scrollAreaRef,
    resizeWindow,
    isFilesPopoverOpen,
    setIsFilesPopoverOpen,
    onRemoveAllFiles: () => {
      clearFiles();
      setIsFilesPopoverOpen(false);
    },
    inputRef,
    captureScreenshot,
    isScreenshotLoading,
    keepEngaged,
    setKeepEngaged,
    toolActivities,
    pendingActions,
    confirmToolAction,
  };
};
