import { Sidebar, ErrorBoundary } from "@/components";
import { STORAGE_KEYS } from "@/config";
import { safeLocalStorage } from "@/lib";
import { Navigate, Outlet } from "react-router-dom";
import { ErrorLayout } from "./ErrorLayout";

export const DashboardLayout = () => {
  // First launch: run the setup wizard before showing any dashboard page
  if (safeLocalStorage.getItem(STORAGE_KEYS.PIELY_SETUP_COMPLETE) !== "true") {
    return <Navigate to="/setup" replace />;
  }

  return (
    <ErrorBoundary
      fallbackRender={() => {
        return <ErrorLayout />;
      }}
      resetKeys={["dashboard-error"]}
      onReset={() => {
        console.log("Reset");
      }}
    >
      <div className="relative flex h-screen w-screen overflow-hidden bg-background">
        {/* Draggable region */}
        <div
          className="absolute left-0 right-0 top-0 z-50 h-10 select-none"
          data-tauri-drag-region={true}
        />

        {/* Sidebar */}
        <Sidebar />
        {/* Main Content */}
        <main className="flex flex-1 flex-col overflow-hidden px-8">
          <Outlet />
        </main>
      </div>
    </ErrorBoundary>
  );
};
