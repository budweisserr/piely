import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckCircle2,
  KeyIcon,
  MicIcon,
  SkipForwardIcon,
  SparklesIcon,
} from "lucide-react";
import { Card, Button, Input, PielyProviderLogin } from "@/components";
import { useApp } from "@/contexts";
import { STORAGE_KEYS } from "@/config";
import { extractVariables, safeLocalStorage } from "@/lib";
import { TYPE_PROVIDER } from "@/types";

// Runtime-filled variables — never asked from the user
const RUNTIME_VARS = new Set(["SYSTEM_PROMPT", "TEXT", "IMAGE", "AUDIO"]);

export default function Setup() {
  const navigate = useNavigate();
  const { pielySelection, selectedSttProvider, onSetSelectedSttProvider, allSttProviders } =
    useApp();

  const [step, setStep] = useState(0); // 0 welcome, 1 pi, 2 voice, 3 finish
  const [skippedAi, setSkippedAi] = useState(false);
  const [skippedVoice, setSkippedVoice] = useState(false);
  const [voiceProvider, setVoiceProvider] = useState<TYPE_PROVIDER | null>(
    null
  );
  const [voiceValues, setVoiceValues] = useState<Record<string, string>>({});

  const piConfigured = !!pielySelection;
  const voiceConfigured = !!selectedSttProvider?.provider;

  const selectVoiceProvider = (provider: TYPE_PROVIDER) => {
    setVoiceProvider(provider);
    setVoiceValues({});
    onSetSelectedSttProvider({ provider: provider.id!, variables: {} });
  };

  const voiceVariables = voiceProvider
    ? extractVariables(voiceProvider.curl).filter(
        (v) => !RUNTIME_VARS.has(v.key)
      )
    : [];

  const voiceReady =
    skippedVoice || (voiceConfigured && voiceVariables.every((v) => voiceValues[v.key]?.trim()));

  const handleVoiceValue = (key: string, value: string) => {
    const next = { ...voiceValues, [key]: value };
    setVoiceValues(next);
    onSetSelectedSttProvider({
      provider: voiceProvider!.id!,
      variables: next,
    });
  };

  const canContinue =
    step === 0 ||
    (step === 1 && (piConfigured || skippedAi)) ||
    (step === 2 && voiceReady) ||
    step === 3;

  const finish = () => {
    safeLocalStorage.setItem(STORAGE_KEYS.PIELY_SETUP_COMPLETE, "true");
    navigate("/chats", { replace: true });
  };

  return (
    <div className="flex h-screen w-screen items-center justify-center overflow-hidden bg-background p-6">
      <Card className="w-full max-w-2xl max-h-full overflow-y-auto p-8 shadow-none border border-input/50">
        {/* Stepper */}
        <div className="mb-6 flex items-center gap-2">
          {["Welcome", "AI provider", "Voice", "Done"].map((label, i) => (
            <div key={label} className="flex items-center gap-2">
              <div
                className={`h-2 rounded-full transition-all ${
                  i === step
                    ? "w-8 bg-primary"
                    : i < step
                      ? "w-2 bg-primary/60"
                      : "w-2 bg-muted"
                }`}
              />
              <span
                className={`text-xs ${
                  i === step ? "text-foreground" : "text-muted-foreground"
                }`}
              >
                {label}
              </span>
            </div>
          ))}
        </div>

        {step === 0 && (
          <div className="space-y-4 text-center">
            <div className="mx-auto flex size-16 items-center justify-center rounded-2xl bg-primary/10">
              <SparklesIcon className="size-8 text-primary" />
            </div>
            <h1 className="text-2xl font-semibold">Welcome to Piely</h1>
            <p className="text-sm text-muted-foreground">
              Your invisible AI assistant for meetings, interviews, and
              conversations. Get set up in under a minute: connect an AI
              provider and a voice backend.
            </p>
            <div className="flex flex-wrap justify-center gap-2 pt-2">
              <span className="rounded-full border border-input/50 px-3 py-1 text-xs">
                ⌨️ Live answers
              </span>
              <span className="rounded-full border border-input/50 px-3 py-1 text-xs">
                🎙️ Voice input
              </span>
              <span className="rounded-full border border-input/50 px-3 py-1 text-xs">
                🔒 Local & private
              </span>
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-3">
            <h1 className="text-xl font-semibold">Connect an AI provider</h1>
            <p className="text-sm text-muted-foreground">
              Log in to any provider (OAuth subscription or API key) and pick a
              model — powered by pi. Responses stream through pi, no separate
              API keys to manage.
            </p>
            <PielyProviderLogin />
            {piConfigured && (
              <p className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400">
                <CheckCircle2 className="size-4" />
                Connected: {pielySelection.provider} —{" "}
                {pielySelection.model.name}
              </p>
            )}
          </div>
        )}

        {step === 2 && (
          <div className="space-y-3">
            <h1 className="text-xl font-semibold">Voice input (speech to text)</h1>
            <p className="text-sm text-muted-foreground">
              Pick a transcription backend for voice input and listening mode.
              You can change this later in Dev Space.
            </p>
            <div className="space-y-2">
              {allSttProviders.map((provider) => (
                <Card
                  key={provider.id}
                  className={`cursor-pointer p-4 border ${
                    voiceProvider?.id === provider.id
                      ? "border-primary"
                      : "border-input/50 hover:border-primary/50"
                  }`}
                  onClick={() => selectVoiceProvider(provider)}
                >
                  <div className="flex items-center gap-3">
                    <MicIcon className="size-4 text-muted-foreground" />
                    <div>
                      <p className="text-sm font-medium">
                        {provider.name ?? provider.id}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {provider.id}
                      </p>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
            {voiceProvider && voiceVariables.length > 0 && (
              <div className="space-y-2">
                {voiceVariables.map((v) => (
                  <div key={v.key} className="space-y-1">
                    <label className="text-xs font-medium">
                      {v.key.toLowerCase().replace(/_/g, " ")}
                    </label>
                    <Input
                      type={v.key === "API_KEY" ? "password" : "text"}
                      placeholder={v.key}
                      value={voiceValues[v.key] ?? ""}
                      onChange={(e) => handleVoiceValue(v.key, e.target.value)}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {step === 3 && (
          <div className="space-y-4 text-center">
            <div className="mx-auto flex size-16 items-center justify-center rounded-2xl bg-green-500/10">
              <CheckCircle2 className="size-8 text-green-500" />
            </div>
            <h1 className="text-2xl font-semibold">You're all set!</h1>
            <div className="mx-auto max-w-sm space-y-2 text-left">
              <SummaryRow
                icon={<KeyIcon className="size-4" />}
                label="AI provider"
                value={
                  piConfigured
                    ? `${pielySelection.provider} — ${pielySelection.model.name}`
                    : skippedAi
                      ? "Skipped"
                      : "Missing"
                }
                ok={piConfigured}
              />
              <SummaryRow
                icon={<MicIcon className="size-4" />}
                label="Voice input"
                value={
                  voiceConfigured
                    ? selectedSttProvider.provider
                    : skippedVoice
                      ? "Skipped"
                      : "Missing"
                }
                ok={voiceConfigured}
              />
            </div>
          </div>
        )}

        {/* Navigation */}
        <div className="mt-8 flex items-center justify-between">
          <Button
            variant="ghost"
            onClick={() => setStep((s) => Math.max(0, s - 1))}
            disabled={step === 0}
          >
            <ArrowLeftIcon className="size-4" /> Back
          </Button>
          <div className="flex items-center gap-2">
            {step === 1 && !piConfigured && (
              <Button
                variant="ghost"
                onClick={() => {
                  setSkippedAi(true);
                  setStep(2);
                }}
              >
                <SkipForwardIcon className="size-4" /> Skip for now
              </Button>
            )}
            {step === 2 && !voiceReady && (
              <Button
                variant="ghost"
                onClick={() => setSkippedVoice(true)}
              >
                <SkipForwardIcon className="size-4" /> Skip for now
              </Button>
            )}
            {step === 3 ? (
              <Button onClick={finish}>
                Start using Piely <ArrowRightIcon className="size-4" />
              </Button>
            ) : (
              <Button onClick={() => setStep((s) => s + 1)} disabled={!canContinue}>
                Continue <ArrowRightIcon className="size-4" />
              </Button>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}

function SummaryRow({
  icon,
  label,
  value,
  ok,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  ok: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border border-input/50 p-3">
      <span className="flex items-center gap-2 text-sm">
        {icon}
        {label}
      </span>
      <span
        className={`text-sm ${ok ? "text-green-600 dark:text-green-400" : "text-muted-foreground"}`}
      >
        {value}
      </span>
    </div>
  );
}
