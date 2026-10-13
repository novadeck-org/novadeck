import "./icon-guides.css"
import type { DemoActionGroup } from "./types"

// The icon guides: a dashed box over every icon, with a dashed line through its middle
// that runs past both sides, for checking how icons sit beside their text. The page's
// root carries data-icon-guides while they show; this tab keeps them across reloads.
const guidesKey = "novadeck.debug-panel.icon-guides"
const attribute = "data-icon-guides"

const readShown = (): boolean => {
  try {
    return window.sessionStorage.getItem(guidesKey) === "on"
  } catch {
    return false
  }
}
const keepShown = (shown: boolean): void => {
  try {
    if (shown) window.sessionStorage.setItem(guidesKey, "on")
    else window.sessionStorage.removeItem(guidesKey)
  } catch {
    // Without storage, the guides hide again at the next reload.
  }
}

const show = (shown: boolean): void => {
  document.documentElement.toggleAttribute(attribute, shown)
}

// Shows the guides again if this tab had them on before a reload.
export const restoreIconGuides = (): void => show(readShown())

export const toggleIconGuides = (): void => {
  const shown = !document.documentElement.hasAttribute(attribute)
  show(shown)
  keepShown(shown)
}

export const iconGuidesGroup: DemoActionGroup = {
  section: "App",
  title: "Guides",
  actions: [
    {
      label: "Toggle icon guides",
      hint: "Dashed box and middle line on every icon until toggled back",
      run: toggleIconGuides,
    },
  ],
}
