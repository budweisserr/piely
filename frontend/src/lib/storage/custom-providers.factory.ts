import { STORAGE_KEYS } from "@/config";
import { TYPE_PROVIDER } from "@/types";
import { safeLocalStorage } from "./helper.ts";

export type ProviderKind = "ai" | "stt";

/** The four operations custom providers need, over one localStorage key. */
export interface CustomProviderStore {
  get: () => TYPE_PROVIDER[];
  add: (provider: Omit<TYPE_PROVIDER, "id" | "isCustom">) => TYPE_PROVIDER | null;
  update: (id: string, updates: Partial<TYPE_PROVIDER>) => boolean;
  remove: (id: string) => boolean;
}

/**
 * The store behind both custom provider lists: a curl command and a response
 * path, kept in localStorage. AI and STT differ only in key and id prefix.
 */
const createCustomProviderStore = (
  storageKey: string,
  idPrefix: string,
  label: string
): CustomProviderStore => {
  const get = (): TYPE_PROVIDER[] => {
    try {
      if (typeof window === "undefined") return [];
      const saved = safeLocalStorage.getItem(storageKey);
      if (!saved) return [];
      const parsed = JSON.parse(saved);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (p: any) => p.id && p.isCustom && typeof p.curl === "string"
      );
    } catch (error) {
      console.error(`Error retrieving custom ${label} providers:`, error);
      return [];
    }
  };

  const set = (providers: TYPE_PROVIDER[]): void => {
    try {
      if (typeof window === "undefined") return;
      safeLocalStorage.setItem(storageKey, JSON.stringify(providers));
    } catch (error) {
      console.error(`Error setting custom ${label} providers:`, error);
    }
  };

  const add = (
    newProvider: Omit<TYPE_PROVIDER, "id" | "isCustom">
  ): TYPE_PROVIDER | null => {
    try {
      const providers = get();
      const provider: TYPE_PROVIDER = {
        ...newProvider,
        id: `${idPrefix}-${Date.now()}-${Math.random()
          .toString(36)
          .substr(2, 9)}`,
        isCustom: true,
      };
      providers.push(provider);
      set(providers);
      return provider;
    } catch (error) {
      console.error(`Error adding custom ${label} provider:`, error);
      return null;
    }
  };

  const update = (id: string, updates: Partial<TYPE_PROVIDER>): boolean => {
    try {
      const providers = get();
      const index = providers.findIndex((p) => p.id === id && p.isCustom);
      if (index === -1) return false;
      providers[index] = { ...providers[index], ...updates };
      set(providers);
      return true;
    } catch (error) {
      console.error(`Error updating custom ${label} provider:`, error);
      return false;
    }
  };

  const remove = (id: string): boolean => {
    try {
      const providers = get();
      const filtered = providers.filter((p) => p.id !== id);
      if (filtered.length === providers.length) return false; // No removal happened
      set(filtered);
      return true;
    } catch (error) {
      console.error(`Error removing custom ${label} provider:`, error);
      return false;
    }
  };

  return { get, add, update, remove };
};

const aiProviderStore = createCustomProviderStore(
  STORAGE_KEYS.CUSTOM_AI_PROVIDERS,
  "custom",
  "AI"
);

const sttProviderStore = createCustomProviderStore(
  STORAGE_KEYS.CUSTOM_SPEECH_PROVIDERS,
  "custom-stt",
  "STT"
);

/** The store for one kind of custom provider. */
export const customProviderStore = (kind: ProviderKind): CustomProviderStore =>
  kind === "stt" ? sttProviderStore : aiProviderStore;
