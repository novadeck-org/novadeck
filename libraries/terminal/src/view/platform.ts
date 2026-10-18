// Apple platforms or the others, which differ in their modifier keys. The views read it for
// Ctrl+V, as a library cannot reach the app's own.
export type Platform = "mac" | "other"

export const currentPlatform = (): Platform =>
  /Mac|iPhone|iPad/.test(navigator.platform) ? "mac" : "other"
