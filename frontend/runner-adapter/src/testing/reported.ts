import { vi } from "vitest"

// Test support: what the adapter reports through the page's `reportError`, which the
// desktop app logs. jsdom has none, so it stands in for one until the returned restore.
export const catchReports = (): { readonly reported: unknown[]; readonly restore: () => void } => {
  const reported: unknown[] = []
  vi.stubGlobal("reportError", (error: unknown) => reported.push(error))
  return { reported, restore: () => vi.unstubAllGlobals() }
}
