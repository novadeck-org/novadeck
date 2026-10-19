// Whether the visitor asked for less motion, as the app's animations read it.
export const lessMotion = (): boolean =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches

// Whether the page asked for the desk held at its first frames, `?still`: the posters of the
// website's hero are taken so, and nothing moves on its own.
export const stillRequested = (): boolean =>
  typeof location !== "undefined" && new URLSearchParams(location.search).has("still")
