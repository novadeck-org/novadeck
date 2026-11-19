import type { ScreenReaderPreference } from "@novadeck/core/types"

/**
 * Whether a terminal in focus keeps its text for a screen reader, by the preference and
 * whether the app says one runs: `running` is undefined where nothing can tell, as in a
 * browser, and then "auto" keeps it, as a reader may be there.
 */
export const readsToScreenReader = (
  preference: ScreenReaderPreference,
  running: boolean | undefined,
): boolean => (preference === "auto" ? (running ?? true) : preference === "on")
