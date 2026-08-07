import { UseSettingsReturn } from "@/types";
import { ProviderConfigs } from "../provider-configs";

export const AIProviders = (settings: UseSettingsReturn) => {
  return <ProviderConfigs kind="ai" {...settings} />;
};
