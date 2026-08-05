import { useEffect, useRef } from "react";
import { Card, Updater, DragButton, CustomCursor, Button } from "@/components";
import {
  SystemAudio,
  Completion,
  AudioVisualizer,
  StatusIndicator,
} from "./components";
import { useApp } from "@/hooks";
import { useApp as useAppContext } from "@/contexts";
import { SparklesIcon, KeyIcon } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { ErrorBoundary } from "react-error-boundary";
import { ErrorLayout } from "@/layouts";
import { getPlatform } from "@/lib";

const App = () => {
  const { isHidden, systemAudio } = useApp();
  const { customizable, selectedAIProvider, pielySelection } =
    useAppContext();
  const platform = getPlatform();
  const openedDashboardRef = useRef(false);

  const noProvider = !pielySelection && !selectedAIProvider.provider;

  const openDashboard = async () => {
    try {
      await invoke("open_dashboard");
    } catch (error) {
      console.error("Failed to open dashboard:", error);
    }
  };

  // First launch / nothing connected: open the dashboard (login page) once
  useEffect(() => {
    if (noProvider && !openedDashboardRef.current) {
      openedDashboardRef.current = true;
      openDashboard();
    }
  }, [noProvider]);

  return (
    <ErrorBoundary
      fallbackRender={() => {
        return <ErrorLayout isCompact />;
      }}
      resetKeys={["app-error"]}
      onReset={() => {
        console.log("Reset");
      }}
    >
      <div
        className={`w-screen h-screen flex overflow-hidden justify-center items-start ${
          isHidden ? "hidden pointer-events-none" : ""
        }`}
      >
        <Card className="w-full flex flex-row items-center gap-2 p-2">
          <SystemAudio {...systemAudio} />
          {systemAudio?.capturing ? (
            <div className="flex flex-row items-center gap-2 justify-between w-full">
              <div className="flex flex-1 items-center gap-2">
                <AudioVisualizer isRecording={systemAudio?.capturing} />
              </div>
              <div className="flex !w-fit items-center gap-2">
                <StatusIndicator
                  setupRequired={systemAudio.setupRequired}
                  error={systemAudio.error}
                  isProcessing={systemAudio.isProcessing}
                  isAIProcessing={systemAudio.isAIProcessing}
                  capturing={systemAudio.capturing}
                />
              </div>
            </div>
          ) : null}

          {noProvider ? (
            <div className="w-full flex flex-row gap-2 items-center px-1">
              <p className="text-xs text-muted-foreground truncate flex-1">
                No AI provider connected
              </p>
              <Button
                size="sm"
                className="cursor-pointer"
                title="Connect an AI provider (pi login)"
                onClick={openDashboard}
              >
                <KeyIcon className="h-4 w-4" />
                Connect
              </Button>
            </div>
          ) : (
            <div
              className={`${
                systemAudio?.capturing
                  ? "hidden w-full fade-out transition-all duration-300"
                  : "w-full flex flex-row gap-2 items-center"
              }`}
            >
              <Completion isHidden={isHidden} />
              <Button
                size={"icon"}
                className="cursor-pointer"
                title="Open Dev Space"
                onClick={openDashboard}
              >
                <SparklesIcon className="h-4 w-4" />
              </Button>
            </div>
          )}

          <Updater />
          <DragButton />
        </Card>
        {customizable.cursor.type === "invisible" && platform !== "linux" ? (
          <CustomCursor />
        ) : null}
      </div>
    </ErrorBoundary>
  );
};

export default App;
