// Apple platforms or the others, which differ in their modifier keys. Backends read it here,
// as backend code may not reach the interaction layer's own.
export type Platform = "mac" | "other"

export const currentPlatform = (): Platform =>
  /Mac|iPhone|iPad/.test(navigator.platform) ? "mac" : "other"
