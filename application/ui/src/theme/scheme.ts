// The schemes the app's theme, Graphite, defines in `graphite.css`; see docs/theming.md.

export type Scheme = "light" | "dark"
// What the person chose: a scheme, or whatever the system uses.
export type SchemePreference = "system" | Scheme
