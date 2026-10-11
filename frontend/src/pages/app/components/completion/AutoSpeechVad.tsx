import { fetchSTT } from "@/lib";
import { UseCompletionReturn } from "@/types";
import { useMicVAD } from "@ricky0123/vad-react";
import { LoaderCircleIcon, MicIcon, MicOffIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components";
import { useApp } from "@/contexts";
import { floatArrayToWav } from "@/lib";

interface AutoSpeechVADProps {
  submit: UseCompletionReturn["submit"];
  setState: UseCompletionReturn["setState"];
  setEnableVAD: UseCompletionReturn["setEnableVAD"];
  microphoneDeviceId?: string;
}

const AutoSpeechVADInternal = ({
  submit,
  setState,
  setEnableVAD,
  microphoneDeviceId,
}: AutoSpeechVADProps) => {
  const [isTranscribing, setIsTranscribing] = useState(false);
  const { selectedSttProvider, allSttProviders } = useApp();

  const audioConstraints: MediaTrackConstraints =
    microphoneDeviceId && microphoneDeviceId !== "default"
      ? { deviceId: { exact: microphoneDeviceId } }
      : {};

  const vad = useMicVAD({
    userSpeakingThreshold: 0.6,
    startOnLoad: true,
    additionalAudioConstraints: audioConstraints,
    // Default redemptionFrames=8 (~0.77s) ends the utterance on a breath;
    // 20 frames (~1.9s at 16kHz) lets mid-thought pauses pass.
    redemptionFrames: 20,
    onSpeechEnd: async (audio) => {
      try {
        // convert float32array to blob
        const audioBlob = floatArrayToWav(audio, 16000);

        let transcription: string;

        // Check if we have a configured speech provider
        if (!selectedSttProvider.provider) {
          console.warn("No speech provider selected");
          setState((prev: any) => ({
            ...prev,
            error:
              "No speech provider selected. Please select one in settings.",
          }));
          return;
        }

        const providerConfig = allSttProviders.find(
          (p) => p.id === selectedSttProvider.provider
        );

        if (!providerConfig) {
          console.warn("Selected speech provider configuration not found");
          setState((prev: any) => ({
            ...prev,
            error:
              "Speech provider configuration not found. Please check your settings.",
          }));
          return;
        }

        setIsTranscribing(true);

        // Use the fetchSTT function for all providers
        transcription = await fetchSTT({
          provider: providerConfig,
          selectedProvider: selectedSttProvider,
          audio: audioBlob,
        });

        if (transcription) {
          submit(transcription);
        }
      } catch (error) {
        console.error("Failed to transcribe audio:", error);
        setState((prev: any) => ({
          ...prev,
          error:
            error instanceof Error ? error.message : "Transcription failed",
        }));
      } finally {
        setIsTranscribing(false);
      }
    },
  });

  // Without this the button just did nothing when the microphone could not be
  // opened (permission denied, no device, or a webview that blocks media).
  useEffect(() => {
    if (!vad.errored) return;
    setState((prev: any) => ({
      ...prev,
      error: `Microphone unavailable: ${vad.errored}`,
    }));
  }, [vad.errored, setState]);

  return (
    <>
      <Button
        size="icon"
        variant={vad.errored ? "destructive" : "default"}
        title={
          vad.errored
            ? `Microphone unavailable: ${vad.errored}`
            : vad.listening
            ? "Stop voice input"
            : "Start voice input"
        }
        onClick={() => {
          if (vad.listening) {
            vad.pause();
            setEnableVAD(false);
          } else {
            vad.start();
            setEnableVAD(true);
          }
        }}
        className="cursor-pointer"
      >
        {isTranscribing ? (
          <LoaderCircleIcon className="h-4 w-4 animate-spin text-green-500" />
        ) : vad.userSpeaking ? (
          <LoaderCircleIcon className="h-4 w-4 animate-spin" />
        ) : vad.errored ? (
          <MicOffIcon className="h-4 w-4" />
        ) : vad.loading ? (
          <LoaderCircleIcon className="h-4 w-4 animate-spin" />
        ) : vad.listening ? (
          <MicOffIcon className="h-4 w-4 animate-pulse" />
        ) : (
          <MicIcon className="h-4 w-4" />
        )}
      </Button>
    </>
  );
};

export const AutoSpeechVAD = (props: AutoSpeechVADProps) => {
  return <AutoSpeechVADInternal key={props.microphoneDeviceId} {...props} />;
};
