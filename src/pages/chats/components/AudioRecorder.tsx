import { useState } from "react";
import { Button } from "@/components";
import { AudioVisualizer } from "@/pages/app/components/speech/audio-visualizer";
import { fetchSTT } from "@/lib";
import { floatArrayToWav } from "@/lib/utils";
import { useApp } from "@/contexts";
import { useMicVAD } from "@ricky0123/vad-react";
import { Loader2, XIcon } from "lucide-react";

interface AudioRecorderProps {
  onTranscriptionComplete: (text: string) => void;
  onCancel: () => void;
}

/**
 * Mic input with the same behavior as desktop Listen mode: records while you
 * talk, auto-stops when you pause, transcribes, and fills the prompt.
 */
export const AudioRecorder = ({
  onTranscriptionComplete,
  onCancel,
}: AudioRecorderProps) => {
  const { selectedSttProvider, allSttProviders, selectedAudioDevices } =
    useApp();
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const deviceId = selectedAudioDevices?.input?.id;
  const audioConstraints: MediaTrackConstraints =
    deviceId && deviceId !== "default"
      ? { deviceId: { exact: deviceId } }
      : {};

  const vad = useMicVAD({
    startOnLoad: true,
    additionalAudioConstraints: audioConstraints,
    onSpeechEnd: async (audio) => {
      if (isTranscribing) return;
      setIsTranscribing(true);
      setError(null);
      try {
        const audioBlob = floatArrayToWav(audio, 16000);
        const provider = allSttProviders.find(
          (p) => p.id === selectedSttProvider.provider
        );
        const text = await fetchSTT({
          provider,
          selectedProvider: selectedSttProvider,
          audio: audioBlob,
        });
        if (text.trim() && !text.startsWith("Error")) {
          vad.pause();
          onTranscriptionComplete(text.trim());
        } else {
          setError(text || "No speech detected");
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Transcription failed");
      } finally {
        setIsTranscribing(false);
      }
    },
  });

  return (
    <div className="rounded-lg border border-border/50 bg-muted/30 overflow-hidden">
      <div className="p-3 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            {isTranscribing ? (
              <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
            ) : (
              <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
            )}
            <span className="text-xs text-muted-foreground">
              {isTranscribing
                ? "Transcribing..."
                : "Recording — stop talking to send"}
            </span>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              vad.pause();
              onCancel();
            }}
            disabled={isTranscribing}
          >
            <XIcon className="w-3.5 h-3.5" />
            Discard
          </Button>
        </div>

        <AudioVisualizer isRecording={!isTranscribing} />

        {error && (
          <p className="text-xs text-red-500 dark:text-red-400">{error}</p>
        )}
      </div>
    </div>
  );
};
