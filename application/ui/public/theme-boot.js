// Shows the saved theme before the first paint: sets data-theme and data-scheme on
// <html> from the boot record theme/apply.ts saves, resolving "system" against the
// system's scheme, and the scheme as <html>'s color-scheme, so the browser's own ground
// matches it before the theme's stylesheet arrives. apply.ts hands color-scheme back to
// the theme. A file of its own, because the Content Security Policy allows no inline
// scripts; see docs/theming.md.
;(() => {
  const known = new Set(["light", "dark"])
  const isScheme = (value) => known.has(value)
  // Without a usable record, the default: the first theme, following the system.
  let record = { theme: "graphite", scheme: "system", schemes: ["light", "dark"] }
  try {
    const saved = JSON.parse(localStorage.getItem("novadeck.theme-boot") ?? "null")
    if (
      typeof saved?.theme === "string" &&
      /^[a-z0-9-]+$/.test(saved.theme) &&
      (saved.scheme === "system" || isScheme(saved.scheme)) &&
      Array.isArray(saved.schemes) &&
      saved.schemes.length > 0 &&
      saved.schemes.every(isScheme)
    )
      record = saved
  } catch {
    // Storage is unavailable or the record is corrupt: the default applies.
  }
  let dark = false
  try {
    dark = matchMedia("(prefers-color-scheme: dark)").matches
  } catch {
    // Without media queries the system counts as light.
  }
  const wanted = record.scheme === "system" ? (dark ? "dark" : "light") : record.scheme
  const scheme = record.schemes.includes(wanted) ? wanted : record.schemes[0]
  const root = document.documentElement
  root.setAttribute("data-theme", record.theme)
  root.setAttribute("data-scheme", scheme)
  root.style.colorScheme = scheme
})()
