import { invoke } from "@tauri-apps/api/core";
import { useCallback } from "react";

/**
 * The overlay window is as tall as its content: the input bar alone, or the
 * input bar plus the panel below it. Whoever opens a panel says so - the
 * popover state is the source of truth, so this only has to set the height.
 */
export const useWindowResize = () => {
  const resizeWindow = useCallback(async (expanded: boolean) => {
    try {
      await invoke("set_window_height", { height: expanded ? 600 : 64 });
    } catch (error) {
      console.error("Failed to resize window:", error);
    }
  }, []);

  return { resizeWindow };
};
