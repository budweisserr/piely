import React, { Suspense, lazy } from "react";
import ReactDOM from "react-dom/client";
import "./global.css";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";

// Loaded on demand: a capture-overlay window renders only the selection UI, and
// every monitor gets its own window, so the app tree must not be in their load
// path. Both branches are their own chunk.
const CaptureOverlay = lazy(() => import("./components/Overlay"));
const Dashboard = lazy(() => import("./dashboard"));

// Unhandled frontend errors vanish into the webview console, which nobody sees
// in a packaged app and which `tauri dev` does not print. Forward them to the
// Rust side so they land in the terminal log.
const reportFrontendError = (message: string, context?: string) => {
  console.error(message, context ?? "");
  void invoke("log_frontend_error", {
    message,
    context: context ?? null,
  }).catch(() => {
    // Tauri is not ready yet, or this is a plain browser: the console is all we have.
  });
};

window.addEventListener("error", (event) => {
  reportFrontendError(
    `Uncaught error: ${event.message}`,
    [event.filename, `${event.lineno}:${event.colno}`, event.error?.stack]
      .filter(Boolean)
      .join(" | ")
  );
});

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  reportFrontendError(
    `Unhandled rejection: ${
      reason instanceof Error ? reason.message : String(reason)
    }`,
    reason instanceof Error ? reason.stack : undefined
  );
});

const currentWindow = getCurrentWindow();
const windowLabel = currentWindow.label;

// Render different components based on window label
if (windowLabel.startsWith("capture-overlay-")) {
  const monitorIndex = parseInt(windowLabel.split("-")[2], 10) || 0;
  // Render overlay without providers
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <Suspense fallback={null}>
        <CaptureOverlay monitorIndex={monitorIndex} />
      </Suspense>
    </React.StrictMode>
  );
} else {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <Suspense fallback={null}>
        <Dashboard />
      </Suspense>
    </React.StrictMode>
  );
}
