import { cdp } from "vitest/browser"

/** The colour scheme the page is drawn in, as the browser applies it. */
export const pageScheme = (): string => getComputedStyle(document.documentElement).colorScheme

/** Puts the system in a colour scheme, or back to its own with null. */
export const systemScheme = async (scheme: "light" | "dark" | null): Promise<void> => {
  await cdp().send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: scheme ?? "" }],
  })
}

/** Saves preferences as another window of the app does, and tells this window. */
export const saveFromAnotherWindow = (key: string, value: unknown): void => {
  const text = JSON.stringify(value)
  const oldValue = localStorage.getItem(key)
  localStorage.setItem(key, text)
  window.dispatchEvent(
    new StorageEvent("storage", { key, oldValue, newValue: text, storageArea: localStorage }),
  )
}
