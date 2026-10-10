import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { KeyIcon, LogOutIcon, LoaderIcon, ExternalLinkIcon } from "lucide-react";
import { useApp } from "@/contexts";
import { Header } from "./Header";import {
  Button,
  Input,
  Badge,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui";
import {
  pielyListProviders,
  pielyGetModels,
  pielyLogin,
  pielyLoginAnswer,
  pielyLoginCancel,
  pielyLogout,
  PielyProviderInfo,
  PielyModel,
} from "@/lib";

// Mirrors pi-ai's AuthPrompt / AuthEvent, forwarded by the piely-agent sidecar.
interface AuthPrompt {
  type: "text" | "secret" | "select" | "manual_code";
  message: string;
  placeholder?: string;
  options?: { id: string; label: string; description?: string }[];
}

interface AuthEvent {
  type: "info" | "auth_url" | "device_code" | "progress";
  message?: string;
  url?: string;
  instructions?: string;
  userCode?: string;
  verificationUri?: string;
  links?: { url: string; label?: string }[];
}

export const PielyProviderLogin = () => {
  const { pielySelection, setPielySelection } = useApp();
  const [providers, setProviders] = useState<PielyProviderInfo[]>([]);
  const [modelsByProvider, setModelsByProvider] = useState<
    Record<string, PielyModel[]>
  >({});
  const [loadingModels, setLoadingModels] = useState<Record<string, boolean>>(
    {}
  );
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Active login flow state
  const [loginProvider, setLoginProvider] =
    useState<PielyProviderInfo | null>(null);
  const [prompt, setPrompt] = useState<AuthPrompt | null>(null);
  const [notices, setNotices] = useState<AuthEvent[]>([]);
  const [promptValue, setPromptValue] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);

  const loadModels = async (providerId: string) => {
    setLoadingModels((prev) => ({ ...prev, [providerId]: true }));
    try {
      const models = await pielyGetModels(providerId);
      setModelsByProvider((prev) => ({ ...prev, [providerId]: models }));
    } catch (loadError) {
      setError(
        `Failed to load models: ${
          loadError instanceof Error ? loadError.message : String(loadError)
        }`
      );
    } finally {
      setLoadingModels((prev) => ({ ...prev, [providerId]: false }));
    }
  };

  const refresh = async () => {
    setError(null);
    const list = await pielyListProviders();
    setProviders(list);
    await Promise.all(
      list
        .filter((provider) => provider.loggedIn)
        .map((provider) => loadModels(provider.id))
    );
    setIsLoading(false);
  };

  useEffect(() => {
    refresh();
    const unlistenPrompt = listen<AuthPrompt>("piely_login_prompt", (event) => {
      setPrompt(event.payload);
      setPromptValue("");
    });
    const unlistenNotify = listen<AuthEvent>("piely_login_notify", (event) => {
      setNotices((prev) => [...prev, event.payload]);
    });
    return () => {
      unlistenPrompt.then((fn) => fn());
      unlistenNotify.then((fn) => fn());
    };
  }, []);

  const handleLogin = async (provider: PielyProviderInfo) => {
    setLoginProvider(provider);
    setNotices([]);
    setPrompt(null);
    setPromptValue("");
    setLoginError(null);
    const authType = provider.auth.includes("oauth") ? "oauth" : "api_key";
    try {
      await pielyLogin(provider.id, authType);
      await refresh();
      setLoginProvider(null);
      setPrompt(null);
      setLoginError(null);
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : String(err));
    }
  };

  /** Closing the dialog must also stop the flow, or it keeps running in Rust. */
  const dismissLogin = () => {
    void pielyLoginCancel();
    setLoginProvider(null);
    setPrompt(null);
    setLoginError(null);
    setNotices([]);
  };

  const handleLogout = async (providerId: string) => {
    await pielyLogout(providerId);
    if (pielySelection?.provider === providerId) {
      setPielySelection(null);
    }
    setModelsByProvider((prev) => {
      const next = { ...prev };
      delete next[providerId];
      return next;
    });
    await refresh();
  };

  const handleAnswer = async () => {
    await pielyLoginAnswer(promptValue.trim());
    setPrompt(null);
    setPromptValue("");
  };

  const handleSelectModel = async (providerId: string, modelId: string) => {
    const model = modelsByProvider[providerId]?.find((m) => m.id === modelId);
    if (!model) return;
    setPielySelection({ provider: providerId, model });
  };

  const loggedInProviders = providers.filter((p) => p.loggedIn);

  return (
    <div id="piely-login" className="space-y-3 -mt-2">
      <div className="space-y-2 pt-2">
        {error && (
          <div className="p-3 rounded-lg border border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950">
            <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
          </div>
        )}
        <Header
          title={
            isLoading
              ? "Loading providers..."
              : `pi powers ${providers.length} providers`
          }
          description="Log in to any provider (OAuth subscription or API key) and pick a model. Responses are streamed through the pi coding agent's unified API."
        />
        <div className="space-y-2">
          {isLoading ? (
            <div className="flex justify-center py-6">
              <LoaderIcon className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : providers.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No providers found. Is the piely-agent installed? (node +{" "}
              <code>piely-agent</code> deps are required.)
            </p>
          ) : (
            providers.map((provider) => {
              const models = modelsByProvider[provider.id] ?? [];
              const selected = pielySelection?.provider === provider.id;
              return (
                <div
                  key={provider.id}
                  className="flex flex-col gap-2 rounded-lg border border-input/50 p-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <p className="text-sm font-medium truncate">
                        {provider.name}
                      </p>
                      {provider.loggedIn ? (
                        <Badge className="bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-400 border-0">
                          Logged in
                        </Badge>
                      ) : (
                        <Badge
                          variant="outline"
                          className="text-muted-foreground"
                        >
                          {provider.auth.join(" / ") || "ambient"}
                        </Badge>
                      )}
                    </div>
                    {provider.loggedIn ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleLogout(provider.id)}
                        disabled={isLoading}
                        title="Log out"
                      >
                        <LogOutIcon className="h-4 w-4" />
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleLogin(provider)}
                        disabled={isLoading}
                      >
                        <KeyIcon className="h-4 w-4" />
                        Login
                      </Button>
                    )}
                  </div>
                  {provider.loggedIn && (
                    <div className="flex flex-col gap-1">
                      <label className="text-xs text-muted-foreground flex items-center gap-1">
                        Model
                        {loadingModels[provider.id] && (
                          <LoaderIcon className="h-3 w-3 animate-spin" />
                        )}
                      </label>
                      <select
                        className="h-9 rounded-md border border-input/50 bg-background px-3 text-sm"
                        value={selected ? pielySelection?.model.id : ""}
                        disabled={
                          loadingModels[provider.id] &&
                          models.length === 0
                        }
                        onFocus={() => loadModels(provider.id)}
                        onChange={(e) =>
                          handleSelectModel(provider.id, e.target.value)
                        }
                      >
                        <option value="" disabled>
                          Select a model...
                        </option>
                        {models.map((model) => (
                          <option key={model.id} value={model.id}>
                            {model.name}
                          </option>
                        ))}
                      </select>
                      {selected && (
                        <p className="text-xs text-amber-500 bg-amber-500/10 p-2 rounded-md">
                          {pielySelection?.model.input?.includes("image")
                            ? "This model accepts text and images."
                            : "This model only accepts text. Images will not be sent."}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
        {loggedInProviders.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No pi provider selected yet — chat falls back to your own curl
            providers. Or log in above and pick a model to power every response
            through pi.
          </p>
        )}
      </div>

      {/* Interactive login dialog */}
      <Dialog
        open={loginProvider !== null || prompt !== null || loginError !== null}
        onOpenChange={(open) => {
          if (!open) {
            dismissLogin();
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {loginError
                ? "Login Failed"
                : `Login to ${loginProvider?.name ?? "provider"}`}
            </DialogTitle>
            <DialogDescription>
              {loginError
                ? "An error occurred during authentication. Please review the details below."
                : "Complete the login flow in this window. You can close this dialog to cancel."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {loginError && (
              <div className="p-3 rounded-lg border border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950 space-y-2">
                <p className="text-xs text-red-600 dark:text-red-300 font-mono break-all whitespace-pre-wrap">
                  {loginError}
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full mt-2"
                  onClick={dismissLogin}
                >
                  Close
                </Button>
              </div>
            )}
            {notices.map((notice, index) => (
              <div
                key={index}
                className="text-sm text-muted-foreground space-y-1"
              >
                {notice.type === "auth_url" && (
                  <>
                    <p>{notice.instructions ?? "Open this URL to authorize:"}</p>
                    <div className="flex items-center gap-2">
                      <p className="text-xs truncate flex-1 border border-input/50 rounded-md p-2">
                        {notice.url}
                      </p>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => notice.url && openUrl(notice.url)}
                      >
                        <ExternalLinkIcon className="h-4 w-4" />
                        Open
                      </Button>
                    </div>
                  </>
                )}
                {notice.type === "device_code" && (
                  <>
                    <p>Enter this code at the provider's site:</p>
                    <p className="text-lg font-bold tracking-widest">
                      {notice.userCode}
                    </p>
                    <div className="flex items-center gap-2">
                      <p className="text-xs truncate flex-1 border border-input/50 rounded-md p-2">
                        {notice.verificationUri}
                      </p>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          notice.verificationUri &&
                          openUrl(notice.verificationUri)
                        }
                      >
                        <ExternalLinkIcon className="h-4 w-4" />
                        Open
                      </Button>
                    </div>
                  </>
                )}
                {(notice.type === "info" || notice.type === "progress") && (
                  <p>{notice.message}</p>
                )}
              </div>
            ))}
            {prompt && !loginError && (
              <div className="space-y-2">
                <label className="text-sm font-medium">{prompt.message}</label>
                {prompt.type === "select" && prompt.options ? (
                  <select
                    className="w-full h-9 rounded-md border border-input/50 bg-background px-3 text-sm"
                    value={promptValue}
                    onChange={(e) => setPromptValue(e.target.value)}
                  >
                    <option value="" disabled>
                      Choose...
                    </option>
                    {prompt.options.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <Input
                    type={prompt.type === "secret" ? "password" : "text"}
                    placeholder={prompt.placeholder ?? ""}
                    value={promptValue}
                    onChange={(value) =>
                      setPromptValue(
                        typeof value === "string" ? value : value.target.value
                      )
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleAnswer();
                    }}
                    autoFocus
                  />
                )}
                <Button
                  className="w-full"
                  onClick={handleAnswer}
                >
                  {prompt.type === "text" && !promptValue.trim()
                    ? "Continue"
                    : "Submit"}
                </Button>
              </div>
            )}
            {loginProvider && !prompt && notices.length === 0 && !loginError && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <LoaderIcon className="h-4 w-4 animate-spin" />
                Waiting for provider...
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};
