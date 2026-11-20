import { useCallback, useEffect, useRef } from "react";
import { generateRequestId } from "@/lib";

/**
 * Streaming plumbing shared by both chat surfaces: request ids, the abort
 * controller, and the check that ignores a superseded request.
 */
export const useStreamRequest = () => {
  const abortControllerRef = useRef<AbortController | null>(null);
  const currentRequestIdRef = useRef<string | null>(null);

  /** Start a new request, cancelling any in-flight one. */
  const beginRequest = useCallback(() => {
    const requestId = generateRequestId();
    currentRequestIdRef.current = requestId;
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    return { requestId, signal: controller.signal };
  }, []);

  /** True while `requestId` is the latest request and has not been aborted. */
  const isCurrent = useCallback(
    (requestId: string, signal: AbortSignal) =>
      currentRequestIdRef.current === requestId && !signal.aborted,
    []
  );

  const cancel = useCallback(() => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    currentRequestIdRef.current = null;
  }, []);

  // Abort any in-flight request on unmount
  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
      currentRequestIdRef.current = null;
    };
  }, []);

  return { beginRequest, isCurrent, cancel };
};
