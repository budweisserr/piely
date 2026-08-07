import { Button, Header, Input, Selection, TextInput } from "@/components";
import { UseSettingsReturn } from "@/types";
import { ProviderKind } from "@/hooks";
import curl2Json, { ResultJSON } from "@bany/curl-to-json";
import { KeyIcon, TrashIcon } from "lucide-react";
import { useEffect, useState } from "react";

export const Providers = ({
  kind,
  allAiProviders,
  allSttProviders,
  selectedAIProvider,
  selectedSttProvider,
  onSetSelectedAIProvider,
  onSetSelectedSttProvider,
  variables,
  sttVariables,
}: UseSettingsReturn & { kind: ProviderKind }) => {
  const isAi = kind === "ai";
  const allProviders = isAi ? allAiProviders : allSttProviders;
  const selectedProvider = isAi ? selectedAIProvider : selectedSttProvider;
  const onSetSelectedProvider = isAi
    ? onSetSelectedAIProvider
    : onSetSelectedSttProvider;
  const providerVariables = isAi ? variables : sttVariables;
  const label = isAi ? "AI" : "STT";

  const [localSelectedProvider, setLocalSelectedProvider] =
    useState<ResultJSON | null>(null);

  useEffect(() => {
    if (selectedProvider?.provider) {
      const provider = allProviders?.find(
        (p) => p?.id === selectedProvider?.provider
      );
      if (provider) {
        const json = curl2Json(provider?.curl);
        setLocalSelectedProvider(json as ResultJSON);
      }
    }
  }, [selectedProvider?.provider]);

  const findKeyAndValue = (key: string) => {
    return providerVariables?.find((v) => v?.key === key);
  };

  const getApiKeyValue = () => {
    const apiKeyVar = findKeyAndValue("api_key");
    if (!apiKeyVar || !selectedProvider?.variables) return "";
    return selectedProvider?.variables?.[apiKeyVar.key] || "";
  };

  const isApiKeyEmpty = () => {
    return !getApiKeyValue().trim();
  };

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Header
          title={`Select ${label} Provider`}
          description={`Select your preferred ${label} service provider or custom providers to get started.`}
        />
        <Selection
          selected={selectedProvider?.provider}
          options={allProviders?.map((provider) => {
            const json = curl2Json(provider?.curl);
            return {
              label: provider?.isCustom
                ? json?.url || "Custom Provider"
                : provider?.id || "Custom Provider",
              value: provider?.id || "Custom Provider",
              isCustom: provider?.isCustom,
            };
          })}
          placeholder={`Choose your ${label} provider`}
          onChange={(value) => {
            onSetSelectedProvider({
              provider: value,
              variables: {},
            });
          }}
        />
      </div>

      {localSelectedProvider ? (
        <Header
          title={`Method: ${
            localSelectedProvider?.method || "Invalid"
          }, Endpoint: ${localSelectedProvider?.url || "Invalid"}`}
          description={`If you want to use different url or method, you can always create a custom provider.`}
        />
      ) : null}

      {findKeyAndValue("api_key") ? (
        <div className="space-y-2">
          <Header
            title="API Key"
            description={`Enter your ${
              allProviders?.find(
                (p) => p?.id === selectedProvider?.provider
              )?.isCustom
                ? "Custom Provider"
                : selectedProvider?.provider
            } API key to authenticate and access AI models. Your key is stored locally and never shared.`}
          />

          <div className="space-y-2">
            <div className="flex gap-2">
              <Input
                type="password"
                placeholder="**********"
                value={getApiKeyValue()}
                onChange={(value) => {
                  const apiKeyVar = findKeyAndValue("api_key");
                  if (!apiKeyVar || !selectedProvider) return;

                  onSetSelectedProvider({
                    ...selectedProvider,
                    variables: {
                      ...selectedProvider.variables,
                      [apiKeyVar.key]:
                        typeof value === "string" ? value : value.target.value,
                    },
                  });
                }}
                onKeyDown={(e) => {
                  const apiKeyVar = findKeyAndValue("api_key");
                  if (!apiKeyVar || !selectedProvider) return;

                  onSetSelectedProvider({
                    ...selectedProvider,
                    variables: {
                      ...selectedProvider.variables,
                      [apiKeyVar.key]: (e.target as HTMLInputElement).value,
                    },
                  });
                }}
                disabled={false}
                className="flex-1 h-11 border-1 border-input/50 focus:border-primary/50 transition-colors"
              />
              {isApiKeyEmpty() ? (
                <Button
                  onClick={() => {
                    const apiKeyVar = findKeyAndValue("api_key");
                    if (!apiKeyVar || !selectedProvider || isApiKeyEmpty())
                      return;

                    onSetSelectedProvider({
                      ...selectedProvider,
                      variables: {
                        ...selectedProvider.variables,
                        [apiKeyVar.key]: getApiKeyValue(),
                      },
                    });
                  }}
                  disabled={isApiKeyEmpty()}
                  size="icon"
                  className="shrink-0 h-11 w-11"
                  title="Submit API Key"
                >
                  <KeyIcon className="h-4 w-4" />
                </Button>
              ) : (
                <Button
                  onClick={() => {
                    const apiKeyVar = findKeyAndValue("api_key");
                    if (!apiKeyVar || !selectedProvider) return;

                    onSetSelectedProvider({
                      ...selectedProvider,
                      variables: {
                        ...selectedProvider.variables,
                        [apiKeyVar.key]: "",
                      },
                    });
                  }}
                  size="icon"
                  variant="destructive"
                  className="shrink-0 h-11 w-11"
                  title="Remove API Key"
                >
                  <TrashIcon className="h-4 w-4" />
                </Button>
              )}
            </div>
          </div>
        </div>
      ) : null}

      <div className="space-y-4 mt-2">
        {providerVariables
          .filter(
            (variable) => variable.key !== findKeyAndValue("api_key")?.key
          )
          .map((variable) => {
            const getVariableValue = () => {
              if (!variable?.key || !selectedProvider?.variables) return "";
              return selectedProvider.variables[variable.key] || "";
            };

            return (
              <div className="space-y-1" key={variable?.key}>
                <Header
                  title={variable?.value || ""}
                  description={`add your preferred ${variable?.key?.replace(
                    /_/g,
                    " "
                  )} for ${
                    allProviders?.find(
                      (p) => p?.id === selectedProvider?.provider
                    )?.isCustom
                      ? "Custom Provider"
                      : selectedProvider?.provider
                  }`}
                />
                <TextInput
                  placeholder={`Enter ${
                    allProviders?.find(
                      (p) => p?.id === selectedProvider?.provider
                    )?.isCustom
                      ? "Custom Provider"
                      : selectedProvider?.provider
                  } ${variable?.key?.replace(/_/g, " ") || "value"}`}
                  value={getVariableValue()}
                  onChange={(value) => {
                    if (!variable?.key || !selectedProvider) return;

                    onSetSelectedProvider({
                      ...selectedProvider,
                      variables: {
                        ...selectedProvider.variables,
                        [variable.key]: value,
                      },
                    });
                  }}
                />
              </div>
            );
          })}
      </div>
    </div>
  );
};
