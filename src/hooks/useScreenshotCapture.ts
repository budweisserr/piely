import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useApp } from "@/contexts";
import { ScreenshotConfig } from "@/types";

const SCREEN_RECORDING_PERMISSION_ERROR =
  "Screen Recording permission required. Please enable it by going to System Settings > Privacy & Security > Screen & System Audio Recording. If you don't see Piely in the list, click the '+' button to add it. If it's already listed, make sure it's enabled. Then restart the app.";

/**
 * Shared screenshot capture flow: full-screen capture (auto/manual mode) and
 * area selection via the overlay window. `onCaptured` receives the base64
 * image and the configuration; the caller decides how to handle it
 * (auto-submit vs attach). Errors surface through `onError`.
 */
export const useScreenshotCapture = (
  onCaptured: (base64: string, config: ScreenshotConfig) => Promise<void>,
  onError: (message: string) => void
) => {
  const { screenshotConfiguration } = useApp();
  const [isScreenshotLoading, setIsScreenshotLoading] = useState(false);
  const screenshotConfigRef = useRef(screenshotConfiguration);
  const isProcessingScreenshotRef = useRef(false);
  const hasCheckedPermissionRef = useRef(false);
  const screenshotInitiatedByThisContext = useRef(false);

  useEffect(() => {
    screenshotConfigRef.current = screenshotConfiguration;
  }, [screenshotConfiguration]);

  const captureScreenshot = useCallback(async () => {
    const config = screenshotConfigRef.current;
    screenshotInitiatedByThisContext.current = true;
    setIsScreenshotLoading(true);

    try {
      // Check screen recording permission on macOS
      const platform = navigator.platform.toLowerCase();
      if (platform.includes("mac") && !hasCheckedPermissionRef.current) {
        const {
          checkScreenRecordingPermission,
          requestScreenRecordingPermission,
        } = await import("tauri-plugin-macos-permissions-api");

        const hasPermission = await checkScreenRecordingPermission();

        if (!hasPermission) {
          // Request permission
          await requestScreenRecordingPermission();

          // Wait a moment and check again
          await new Promise((resolve) => setTimeout(resolve, 2000));

          const hasPermissionNow = await checkScreenRecordingPermission();

          if (!hasPermissionNow) {
            onError(SCREEN_RECORDING_PERMISSION_ERROR);
            screenshotInitiatedByThisContext.current = false;
            return;
          }
        }
        hasCheckedPermissionRef.current = true;
      }

      if (config.enabled) {
        const base64 = await invoke("capture_to_base64");
        await onCaptured(base64 as string, config);
        screenshotInitiatedByThisContext.current = false;
      } else {
        // Selection Mode: open overlay to select an area
        isProcessingScreenshotRef.current = false;
        await invoke("start_screen_capture");
      }
    } catch (error) {
      onError("Failed to capture screenshot. Please try again.");
      isProcessingScreenshotRef.current = false;
      screenshotInitiatedByThisContext.current = false;
    } finally {
      if (config.enabled) {
        setIsScreenshotLoading(false);
      }
    }
  }, [onCaptured, onError]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    const setupListener = async () => {
      unlisten = await listen("captured-selection", async (event: any) => {
        if (
          !screenshotInitiatedByThisContext.current ||
          isProcessingScreenshotRef.current
        ) {
          return;
        }

        isProcessingScreenshotRef.current = true;
        const base64 = event.payload;
        const config = screenshotConfigRef.current;

        try {
          await onCaptured(base64 as string, config);
        } catch (error) {
          console.error("Error processing selection:", error);
        } finally {
          setIsScreenshotLoading(false);
          screenshotInitiatedByThisContext.current = false;
          setTimeout(() => {
            isProcessingScreenshotRef.current = false;
          }, 100);
        }
      });
    };

    setupListener();

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, [onCaptured]);

  useEffect(() => {
    const unlisten = listen("capture-closed", () => {
      setIsScreenshotLoading(false);
      isProcessingScreenshotRef.current = false;
      screenshotInitiatedByThisContext.current = false;
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  return {
    captureScreenshot,
    isScreenshotLoading,
  };
};
