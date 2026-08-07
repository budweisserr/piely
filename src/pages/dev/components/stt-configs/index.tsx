import { UseSettingsReturn } from "@/types";
import { ProviderConfigs } from "../provider-configs";

export const STTProviders = (settings: UseSettingsReturn) => {
  return <ProviderConfigs kind="stt" {...settings} />;
};
