// A setting the UI keeps as one attribute on the page's root, such as `data-ligatures`, set
// from Preferences in the UI's useWorkspaceEffects. One observer per attribute serves every
// screen.

// What tells `changed` when the attribute changes, until the stop it returns.
export const rootSetting = (attribute: string): ((changed: () => void) => () => void) => {
  const listeners = new Set<() => void>()
  let observer: MutationObserver | undefined
  return (changed) => {
    listeners.add(changed)
    if (!observer) {
      observer = new MutationObserver(() => listeners.forEach((listener) => listener()))
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: [attribute],
      })
    }
    return () => {
      listeners.delete(changed)
      if (listeners.size > 0) return
      observer?.disconnect()
      observer = undefined
    }
  }
}
