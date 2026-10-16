// An update the desktop app tells of. `downloading`: one the app is downloading, `percent`
// (a whole number from 0 to 100) along, which turns `ready` once downloaded. `ready`:
// downloaded, and installed on a restart. `retrying`: a download failed and the app tries
// again by itself, so nothing shows. `available`: a newer release the app can't install
// itself, which the person gets from its release page.
export type UpdateOffer =
  | { readonly kind: "downloading"; readonly version: string; readonly percent: number }
  | { readonly kind: "ready" | "retrying" | "available"; readonly version: string }

// Which releases the desktop app follows: stable ones, or every release as it is published.
export type UpdateChannel = "stable" | "early"
