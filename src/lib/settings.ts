// Per-browser settings kept in localStorage. They're not part of the garden file:
// an API key or a local model address belongs to this device, not the garden.

import type { Provider } from "./store.ts";

// Stored under the app's first name, so settings carry over.
const KEYS = { apiKey: "garden.anthropicKey", provider: "garden.assistantProvider", ollamaUrl: "garden.ollamaUrl", ollamaModel: "garden.ollamaModel" };
export const OLLAMA_DEFAULTS = { url: "http://localhost:11434", model: "gemma4:12b" };

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // Storage blocked; the setting just won't persist.
  }
}

export type AssistantSettings = { provider: Provider; apiKey: string | null; ollamaUrl: string; ollamaModel: string };

export function getAssistantSettings(): AssistantSettings {
  return {
    provider: read(KEYS.provider) === "ollama" ? "ollama" : "claude",
    apiKey: read(KEYS.apiKey),
    ollamaUrl: read(KEYS.ollamaUrl) || OLLAMA_DEFAULTS.url,
    ollamaModel: read(KEYS.ollamaModel) || OLLAMA_DEFAULTS.model,
  };
}

export function saveAssistantSettings(s: Partial<AssistantSettings>): void {
  if (s.provider !== undefined) write(KEYS.provider, s.provider);
  if (s.apiKey !== undefined) write(KEYS.apiKey, s.apiKey);
  if (s.ollamaUrl !== undefined) write(KEYS.ollamaUrl, s.ollamaUrl);
  if (s.ollamaModel !== undefined) write(KEYS.ollamaModel, s.ollamaModel);
}

/** Whether the selected assistant has what it needs to run. */
export function assistantReady(s = getAssistantSettings()): boolean {
  return s.provider === "ollama" ? !!s.ollamaUrl && !!s.ollamaModel : !!s.apiKey;
}
