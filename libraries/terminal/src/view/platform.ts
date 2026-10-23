// Apple platforms, Windows or the others, which differ in their modifier keys and in what
// Ctrl+C and Ctrl+V do in a terminal. The views read it for those keys, as a library
// cannot reach the app's own.
export type Platform = "mac" | "windows" | "other"

export const currentPlatform = (): Platform =>
  /Mac|iPhone|iPad/.test(navigator.platform)
    ? "mac"
    : navigator.platform.startsWith("Win")
      ? "windows"
      : "other"
