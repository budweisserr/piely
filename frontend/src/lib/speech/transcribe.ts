import { deepVariableReplacer } from "../curl/template";
import { getByPath } from "../curl/response-path";
import { blobToBase64 } from "../files/blob";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { invoke } from "@tauri-apps/api/core";

import { TYPE_PROVIDER } from "@/types";
import curl2Json from "@bany/curl-to-json";

export interface STTParams {
  provider: TYPE_PROVIDER | undefined;
  selectedProvider: {
    provider: string;
    variables: Record<string, string>;
  };
  audio: File | Blob | string;
  /** Optional signal to abort the request (e.g. for timeouts) */
  signal?: AbortSignal;
}

/** Local whisper.cpp, on-device. */
/** True for the built-in local whisper and for custom providers that use it. */
const isLocalWhisper = (provider: TYPE_PROVIDER): boolean =>
  provider.id === "whisper-local" || provider.curl.trim().startsWith("whisper-cli");

/** Variables are stored lowercase (`model_path`), so the lookup ignores case. */
const variableValue = (
  variables: Record<string, string> | undefined,
  name: string
): string => {
  const entry = Object.entries(variables ?? {}).find(
    ([key]) => key.toUpperCase() === name
  );
  return entry?.[1] ?? "";
};

async function transcribeLocalWhisper(
  audio: File | Blob | string,
  modelPath: string
): Promise<string> {
  try {
    const audioBase64 =
      typeof audio === "string" ? audio : await blobToBase64(audio);
    const transcription = await invoke<string>("local_transcribe", {
      audioBase64,
      modelPath: modelPath || null,
    });
    return transcription;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return `Local Whisper Error: ${errorMessage}`;
  }
}

/**
 * Transcribes audio and returns either the transcription or an error/warning message as a single string.
 */
export async function fetchSTT(params: STTParams): Promise<string> {
  let warnings: string[] = [];

  try {
    const { provider, selectedProvider, audio, signal } = params;

    if (!provider) throw new Error("Provider not provided");

    // Local whisper.cpp runs entirely on-device, no curl request. A custom
    // provider whose command is `whisper-cli …` takes the same path, which is
    // how a second local model (a bigger ggml file) gets configured.
    if (isLocalWhisper(provider)) {
      return await transcribeLocalWhisper(
        audio,
        variableValue(selectedProvider.variables, "MODEL_PATH")
      );
    }

    if (!selectedProvider) throw new Error("Selected provider not provided");
    if (!audio) throw new Error("Audio file is required");

    // Resolve audio to Blob if passed as base64 string
    const audioBlob: Blob =
      typeof audio === "string"
        ? (() => {
            const rawBase64 = audio.includes(",") ? audio.split(",")[1] : audio;
            const binaryString = atob(rawBase64);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
              bytes[i] = binaryString.charCodeAt(i);
            }
            return new Blob([bytes], { type: "audio/wav" });
          })()
        : audio;

    let curlJson: any;
    try {
      curlJson = curl2Json(provider.curl);
    } catch (error) {
      throw new Error(
        `Failed to parse curl: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }

    // Validate audio file
    if (audioBlob.size === 0) throw new Error("Audio file is empty");

    // Build variable map
    const allVariables = {
      ...Object.fromEntries(
        Object.entries(selectedProvider.variables).map(([key, value]) => [
          key.toUpperCase(),
          value,
        ])
      ),
    };

    // Prepare request
    let url = deepVariableReplacer(curlJson.url || "", allVariables);
    const headers = deepVariableReplacer(curlJson.header || {}, allVariables);
    const formData = deepVariableReplacer(curlJson.form || {}, allVariables);

    // To Check if API accepts Binary Data
    const isBinaryUpload = provider.curl.includes("--data-binary");
    // Fetch URL Params
    const rawParams = curlJson.params || {};
    // Decode Them
    const decodedParams = Object.fromEntries(
      Object.entries(rawParams).map(([key, value]) => [
        key,
        typeof value === "string" ? decodeURIComponent(value) : "",
      ])
    );
    // Get the Parameters from allVariables
    const replacedParams = deepVariableReplacer(decodedParams, allVariables);

    // Add query parameters to URL
    const queryString = new URLSearchParams(replacedParams).toString();
    if (queryString) {
      url += (url.includes("?") ? "&" : "?") + queryString;
    }

    let finalHeaders = { ...headers };
    let body: FormData | string | Blob;

    const isForm =
      provider.curl.includes("-F ") || provider.curl.includes("--form");
    if (isForm) {
      const form = new FormData();
      const freshBlob = new Blob([await audioBlob.arrayBuffer()], {
        type: audioBlob.type,
      });
      form.append("file", freshBlob, "audio.wav");
      const headerKeys = Object.keys(headers).map((k) =>
        k.toUpperCase().replace(/[-_]/g, "")
      );

      for (const [key, val] of Object.entries(formData)) {
        if (typeof val !== "string") {
          if (
            !val ||
            headerKeys.includes(key.toUpperCase()) ||
            key.toUpperCase() === "AUDIO"
          )
            continue;
          form.append(key.toLowerCase(), val as string | Blob);
          continue;
        }

        // Check if key is a number, which indicates array-like parsing from curl2json
        if (!isNaN(parseInt(key, 10))) {
          const [formKey, ...formValueParts] = val.split("=");
          const formValue = formValueParts.join("=");

          if (formKey.toLowerCase() === "file") continue; // Already handled by form.append('file', audio)

          if (
            !formValue ||
            headerKeys.includes(formKey.toUpperCase().replace(/[-_]/g, ""))
          )
            continue;

          form.append(formKey, formValue);
        } else {
          if (key.toLowerCase() === "file") continue; // Already handled by form.append('file', audio)
          if (
            !val ||
            headerKeys.includes(key.toUpperCase()) ||
            key.toUpperCase() === "AUDIO"
          )
            continue;
          form.append(key.toLowerCase(), val as string | Blob);
        }
      }
      delete finalHeaders["Content-Type"];
      body = form;
    } else if (isBinaryUpload) {
      // Deepgram-style: raw binary body
      body = new Blob([await audioBlob.arrayBuffer()], {
        type: audioBlob.type,
      });
    } else {
      // Google-style: JSON payload with base64
      allVariables.AUDIO =
        typeof audio === "string" ? audio : await blobToBase64(audioBlob);
      const dataObj = curlJson.data ? { ...curlJson.data } : {};
      body = JSON.stringify(deepVariableReplacer(dataObj, allVariables));
    }

    const fetchFunction = url?.includes("http") ? fetch : tauriFetch;

    // Send request
    let response: Response;
    try {
      response = await fetchFunction(url, {
        method: curlJson.method || "POST",
        headers: finalHeaders,
        body: curlJson.method === "GET" ? undefined : body,
        signal,
      });
    } catch (e) {
      if (signal?.aborted) {
        throw new Error("Speech transcription timed out (30s)");
      }
      throw new Error(`Network error: ${e instanceof Error ? e.message : e}`);
    }

    if (!response.ok) {
      let errText = "";
      try {
        errText = await response.text();
      } catch {}
      let errMsg: string;
      try {
        const errObj = JSON.parse(errText);
        errMsg = errObj.message || errText;
      } catch {
        errMsg = errText || response.statusText;
      }
      throw new Error(`HTTP ${response.status}: ${errMsg}`);
    }

    const responseText = await response.text();
    let data: any;
    try {
      data = JSON.parse(responseText);
    } catch {
      return [...warnings, responseText.trim()].filter(Boolean).join("; ");
    }

    // Extract transcription
    const rawPath = provider.responseContentPath || "text";
    const path = rawPath.charAt(0).toLowerCase() + rawPath.slice(1);
    const transcription = (getByPath(data, path) || "").trim();

    if (!transcription) {
      return [...warnings, "No transcription found"].join("; ");
    }

    // Return transcription with any warnings
    return [...warnings, transcription].filter(Boolean).join("; ");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(msg);
  }
}
