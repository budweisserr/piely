/** The sidecar's login/provider calls, as Tauri commands. */
import { invoke } from "@tauri-apps/api/core";

// Piely = pi (earendil-works/pi) login + providers. Credentials live in
// piely-auth.json (app data dir), written by the piely-agent sidecar.

export interface PielyProviderInfo {
  id: string;
  name: string;
  loggedIn: boolean;
  auth: ("oauth" | "api_key")[];
}

export interface PielyModel {
  id: string;
  name: string;
  input: string[];
}

export async function pielyListProviders(): Promise<PielyProviderInfo[]> {
  try {
    return await invoke<PielyProviderInfo[]>("piely_list_providers");
  } catch (error) {
    console.warn("Failed to list piely providers:", error);
    return [];
  }
}

export async function pielyGetModels(provider: string): Promise<PielyModel[]> {
  return invoke<PielyModel[]>("piely_get_models", { provider });
}

export async function pielyLogin(
  provider: string,
  authType: string
): Promise<void> {
  await invoke("piely_login", { provider, authType });
}

export async function pielyLoginAnswer(value: string): Promise<void> {
  await invoke("piely_login_answer", { value });
}

/**
 * Stops a login that is still running. Closing the dialog alone would leave the
 * flow holding the provider's callback port, and the next attempt would fail.
 */
export async function pielyLoginCancel(): Promise<void> {
  try {
    await invoke("piely_login_cancel");
  } catch (error) {
    console.warn("Failed to cancel login:", error);
  }
}

export async function pielyLogout(provider: string): Promise<void> {
  await invoke("piely_logout", { provider });
}
