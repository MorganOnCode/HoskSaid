"use client";
/**
 * Answer-engine choice (browser only), held in this module's memory and
 * nowhere else: no localStorage, sessionStorage, IndexedDB, cookies, URL
 * parameters or analytics. A reload, a closed tab or "Forget key" drops the
 * key. The settings are shared by every Ask box on the page and survive
 * client-side navigation only.
 */
import { useSyncExternalStore } from "react";
import { BYOK_PROVIDERS, isByokProvider, type ByokProviderId } from "@/lib/byok-catalog";

export type EngineMode = "site" | "byok";

export interface EngineSettings {
  mode: EngineMode;
  /** "" until the visitor picks one: no provider or model is preselected. */
  provider: ByokProviderId | "";
  model: string;
  /** True when the visitor typed a model id instead of picking a suggestion. */
  customModel: boolean;
  key: string;
}

export const DEFAULT_ENGINE: EngineSettings = Object.freeze({
  mode: "site",
  provider: "",
  model: "",
  customModel: false,
  key: "",
}) as EngineSettings;

let state: EngineSettings = { ...DEFAULT_ENGINE };
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function getEngine(): EngineSettings {
  return state;
}

export function setEngine(patch: Partial<EngineSettings>): void {
  const next = { ...state, ...patch };
  if (patch.provider !== undefined && patch.provider !== state.provider) {
    // A key or model never carries across providers.
    next.key = patch.key ?? "";
    next.model = patch.model ?? "";
    next.customModel = patch.customModel ?? false;
    if (next.provider !== "" && !isByokProvider(next.provider)) next.provider = "";
  }
  state = next;
  emit();
}

/** Drop the key from memory. Provider and model choices stay. */
export function forgetKey(): void {
  state = { ...state, key: "" };
  emit();
}

/** Test hook. */
export function resetEngineForTests(): void {
  state = { ...DEFAULT_ENGINE };
  emit();
}

/** What is still missing before a visitor-key question can be sent. */
export function engineProblem(s: EngineSettings): string | null {
  if (s.mode !== "byok") return null;
  if (!s.provider) return "Choose a provider.";
  if (!s.model) return "Choose a model.";
  if (!s.key) return `Enter your ${BYOK_PROVIDERS[s.provider].label} API key.`;
  return null;
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useEngine(): EngineSettings {
  return useSyncExternalStore(subscribe, getEngine, () => DEFAULT_ENGINE);
}
