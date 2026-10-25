// The Ligatures setting is one attribute on the page's root, set from Preferences
// (`data-ligatures`, in the UI's useWorkspaceEffects). One observer serves every screen.

export const ligaturesOn = (): boolean => document.documentElement.dataset.ligatures === "on"

const listeners = new Set<() => void>()
let observer: MutationObserver | undefined

// Tells `changed` when the setting changes, until the returned function is called.
export const watchLigatures = (changed: () => void): (() => void) => {
  listeners.add(changed)
  if (!observer) {
    observer = new MutationObserver(() => listeners.forEach((listener) => listener()))
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-ligatures"],
    })
  }
  return () => {
    listeners.delete(changed)
    if (listeners.size > 0) return
    observer?.disconnect()
    observer = undefined
  }
}
