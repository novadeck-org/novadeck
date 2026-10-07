// Shows the saved scheme before the first paint: sets data-scheme on <html> from the
// boot record theme/apply.ts saves, resolving "system" against the system's scheme, and
// the scheme as <html>'s color-scheme, so the browser's own ground matches it before the
// theme's stylesheet arrives. apply.ts hands color-scheme back to the theme. A file of
// its own, because the Content Security Policy allows no inline scripts; see
// docs/theming.md.
;(() => {
  // Without a usable record, the default: following the system. Records older versions
  // saved also name a theme and its schemes; only the scheme is read.
  let choice = "system"
  try {
    const saved = JSON.parse(localStorage.getItem("novadeck.theme-boot") ?? "null")
    if (saved?.scheme === "system" || saved?.scheme === "light" || saved?.scheme === "dark")
      choice = saved.scheme
  } catch {
    // Storage is unavailable or the record is corrupt: the default applies.
  }
  let dark = false
  try {
    dark = matchMedia("(prefers-color-scheme: dark)").matches
  } catch {
    // Without media queries the system counts as light.
  }
  const scheme = choice === "system" ? (dark ? "dark" : "light") : choice
  document.documentElement.setAttribute("data-scheme", scheme)
  document.documentElement.style.colorScheme = scheme
})()
