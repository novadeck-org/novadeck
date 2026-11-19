import { rootSetting } from "./root-setting"

// Whether a terminal in focus keeps its text for a screen reader: `data-screen-reader` on the
// page's root, which the UI sets from the preference and whether the app says one runs. A page
// that doesn't set it, as a test's, keeps the text, as a reader may be there.

export const screenReaderOn = (): boolean => document.documentElement.dataset.screenReader !== "off"

// Tells `changed` when it changes, until the returned stop.
export const watchScreenReader = rootSetting("data-screen-reader")
