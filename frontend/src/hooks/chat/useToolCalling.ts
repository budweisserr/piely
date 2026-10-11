import { useCallback, useRef, useState } from "react";
import { AgentActivity, PendingToolAction, upsertActivity } from "@/lib";

/**
 * Tool-call state for one chat surface: what ran, and what is waiting for the
 * user to accept or dismiss. The returned promise resolves on that click.
 */
export const useToolCalling = () => {
  const [toolActivities, setToolActivities] = useState<AgentActivity[]>([]);
  const [pendingActions, setPendingActions] = useState<PendingToolAction[]>([]);
  // Resolvers for action confirmations the agent turn is waiting on.
  const actionResolvers = useRef(new Map<string, (approved: boolean) => void>());

  /**
   * Clears both lists; called when a new turn starts. Any action still waiting
   * is dismissed first: the loop is parked on that promise, and a new turn must
   * not leave it waiting for a click that can no longer happen.
   */
  const reset = useCallback(() => {
    for (const resolve of actionResolvers.current.values()) {
      resolve(false);
    }
    actionResolvers.current.clear();
    setToolActivities([]);
    setPendingActions([]);
  }, []);

  const recordActivity = useCallback((activity: AgentActivity) => {
    setToolActivities((prev) => upsertActivity(prev, activity));
  }, []);

  /** Resolves when the user accepts or dismisses a proposed tool action. */
  const approveAction = useCallback(
    (action: PendingToolAction) =>
      new Promise<boolean>((resolve) => {
        actionResolvers.current.set(action.id, resolve);
        setPendingActions((prev) => [...prev, action]);
      }),
    []
  );

  const confirmToolAction = useCallback(
    (action: PendingToolAction, approved: boolean) => {
      setPendingActions((prev) =>
        prev.filter((pending) => pending.id !== action.id)
      );
      const resolve = actionResolvers.current.get(action.id);
      actionResolvers.current.delete(action.id);
      resolve?.(approved);
    },
    []
  );

  /** Unblocks an in-flight agent turn when the request is cancelled. */
  const releaseActions = useCallback(() => {
    for (const resolve of actionResolvers.current.values()) {
      resolve(false);
    }
    actionResolvers.current.clear();
    setPendingActions([]);
  }, []);

  return {
    toolActivities,
    pendingActions,
    approveAction,
    confirmToolAction,
    releaseActions,
    recordActivity,
    reset,
  };
};
