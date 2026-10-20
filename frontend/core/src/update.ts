// An update the desktop app tells of. `downloading`: one the app is downloading, `percent`
// (a whole number from 0 to 100) along, which turns `ready` once downloaded. `ready`:
// downloaded, and installed on a restart. `retrying`: a download failed and the app tries
// again by itself, so nothing shows. `available`: a newer release the app can't install
// itself, which the person gets from its release page; `allow` on it means an
// administrator can let this copy install updates itself, which `updates.allow` asks.
export type UpdateOffer =
  | { readonly kind: "downloading"; readonly version: string; readonly percent: number }
  | { readonly kind: "ready" | "retrying"; readonly version: string }
  | { readonly kind: "available"; readonly version: string; readonly allow?: true }

// Which releases the desktop app follows: stable ones, or every release as it is published.
export type UpdateChannel = "stable" | "early"

// What is new in the version the app updated to: the highlights of its release notes, each
// a short title and one plain line. Text only: the page shows it as text, never as markup.
export type WhatsNew = {
  readonly version: string
  readonly highlights: readonly { readonly title: string; readonly line: string }[]
}
