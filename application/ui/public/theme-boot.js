// Shows the saved theme before the first paint: sets data-theme and data-scheme on
// <html> from the boot record app/appearance.ts saves, resolving "system" against the
// system's scheme, and the scheme as <html>'s color-scheme, so the browser's own ground
// matches it before the theme's stylesheet arrives, and the record's ground, when it
// holds one, as its background-color, so a theme the CSS does not know still shows its
// ground. apply.ts hands both back to the theme. A file of its own, because the Content Security Policy allows no inline
// scripts; see docs/theming.md.
;(() => {
  // The record carries the theme's schemes, so this file needs no list of themes and
  // shows whatever theme was picked. A theme is a plain id; its schemes are light, dark
  // or both. The default is Graphite, which has both. The record says which version
  // wrote it (v 2): older versions saved the same fields for themes since retired, so
  // only a version-2 record names the theme.
  const known = new Set(["light", "dark"])
  let theme = "graphite"
  let schemes = ["light", "dark"]
  let choice = "system"
  let ground = ""
  let groundScheme
  try {
    const saved = JSON.parse(localStorage.getItem("novadeck.theme-boot") ?? "null")
    if (saved?.scheme === "system" || known.has(saved?.scheme)) {
      choice = saved.scheme
      // Only a plain #rrggbb is painted, and only in the scheme it was shown in;
      // anything else is ignored.
      if (typeof saved.ground === "string" && /^#[0-9a-f]{6}$/i.test(saved.ground)) {
        ground = saved.ground
        groundScheme = saved.groundScheme
      }
      // A record without a usable theme and schemes, as older versions saved, is for the
      // default. An id the app no longer has shows until the app applies the default.
      if (
        saved.v === 2 &&
        typeof saved.theme === "string" &&
        /^[a-z0-9-]+$/.test(saved.theme) &&
        Array.isArray(saved.schemes) &&
        saved.schemes.length > 0 &&
        saved.schemes.every((entry) => known.has(entry))
      ) {
        theme = saved.theme
        schemes = saved.schemes
      }
    }
  } catch {
    // Storage is unavailable or the record is corrupt: the default applies.
  }
  let dark = false
  try {
    dark = matchMedia("(prefers-color-scheme: dark)").matches
  } catch {
    // Without media queries the system counts as light.
  }
  const wanted = choice === "system" ? (dark ? "dark" : "light") : choice
  const scheme = schemes.includes(wanted) ? wanted : schemes[0]
  const root = document.documentElement
  root.setAttribute("data-theme", theme)
  root.setAttribute("data-scheme", scheme)
  root.style.colorScheme = scheme
  if (ground && groundScheme === scheme) root.style.backgroundColor = ground
})()
