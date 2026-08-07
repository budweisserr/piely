import { Header, PielyProviderLogin } from "@/components";
import { UseSettingsReturn } from "@/types";
import { ProviderKind } from "@/hooks";
import { Providers } from "./Providers";
import { CustomProviders } from "./CustomProvider";

export const ProviderConfigs = ({
  kind,
  ...settings
}: UseSettingsReturn & { kind: ProviderKind }) => {
  const isAi = kind === "ai";

  return (
    <div id={isAi ? "ai-providers" : "stt-providers"} className="space-y-3">
      <Header
        title={isAi ? "AI Providers" : "STT Providers"}
        description={
          isAi
            ? "Select your preferred AI service provider to get started."
            : "Select your preferred speech-to-text service provider to get started."
        }
        isMainTitle
      />

      {/* pi login providers */}
      {isAi && <PielyProviderLogin />}

      {/* Custom Provider */}
      <CustomProviders kind={kind} {...settings} />
      {/* Providers Selection */}
      <Providers kind={kind} {...settings} />
    </div>
  );
};
