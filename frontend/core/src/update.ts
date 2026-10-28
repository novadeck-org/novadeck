import type { HighlightIcon } from "@novadeck/protocol/release-notes"

export type { HighlightIcon }

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
export type UpdateChannel = "stable" | "experimental"

// What is new in the version the app updated to: the highlights of its release notes, each
// a short title and one plain line. Text only: the page shows it as text, never as markup.
// A highlight may lead with an icon, by its Lucide name (a `HighlightIcon`); the page draws a
// name it doesn't know as its fallback. `from` is the version they are new since, when the
// host knows it: the one updated from, or the newest whose notes were already seen.
export type WhatsNew = {
  readonly version: string
  readonly from?: string
  readonly highlights: readonly {
    readonly title: string
    readonly line: string
    readonly icon?: string
  }[]
}
