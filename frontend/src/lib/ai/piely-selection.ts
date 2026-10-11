/** The pi provider and model the user picked, and the switch to use them. */
import { safeLocalStorage } from "../storage/helper.ts";
import { STORAGE_KEYS } from "../../config/constants.ts";

import type { PielyModel } from "./piely-providers.ts";

export interface PielySelection {
  provider: string;
  model: PielyModel;
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
