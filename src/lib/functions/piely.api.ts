import { invoke } from "@tauri-apps/api/core";
import { safeLocalStorage } from "../storage";
import { STORAGE_KEYS } from "@/config";

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

export interface PielySelection {
  provider: string;
  model: PielyModel;
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

export async function pielyLogout(provider: string): Promise<void> {
  await invoke("piely_logout", { provider });
}

export function getPielySelection(): PielySelection | null {
  const provider = safeLocalStorage.getItem(
    STORAGE_KEYS.PIELY_SELECTED_PROVIDER
  );
  const model = safeLocalStorage.getItem(STORAGE_KEYS.PIELY_SELECTED_MODEL);
  if (!provider || !model) return null;
  try {
    return { provider, model: JSON.parse(model) };
  } catch {
    return null;
  }
}

export function setPielySelection(selection: PielySelection | null): void {
  if (selection) {
    safeLocalStorage.setItem(
      STORAGE_KEYS.PIELY_SELECTED_PROVIDER,
      selection.provider
    );
    safeLocalStorage.setItem(
      STORAGE_KEYS.PIELY_SELECTED_MODEL,
      JSON.stringify(selection.model)
    );
  } else {
    safeLocalStorage.removeItem(STORAGE_KEYS.PIELY_SELECTED_PROVIDER);
    safeLocalStorage.removeItem(STORAGE_KEYS.PIELY_SELECTED_MODEL);
  }
}

/** True when the user logged into a pi provider and picked a model. */
export function shouldUsePiely(): boolean {
  return getPielySelection() !== null;
}
