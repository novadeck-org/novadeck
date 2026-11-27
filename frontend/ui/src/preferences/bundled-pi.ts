import type { BundledPiFetchState } from "@novadeck/core/port"

// The Experimental row of Novadeck's own pi (Nova): what it is for and what it costs.
export const bundledPiLabel = "Nova"
export const bundledPiDescription =
  "Type nova in a Novadeck terminal to start Nova, Novadeck's own agent. It runs on a model Novadeck pays for, a few sessions a day. It downloads Pi once, about 50–60 MB. Off: the download stays, and nova doesn't start."

// What the row says under its description of where the download stands: `error` is for an alert,
// which offers to try again.
export type BundledPiNote = { readonly text: string; readonly error: boolean }

const megabytes = (bytes: number): string => (bytes / 1_000_000).toFixed(1)

export const bundledPiNote = (
  enabled: boolean,
  fetch: BundledPiFetchState,
): BundledPiNote | undefined => {
  if (!enabled) return undefined
  switch (fetch.state) {
    case "downloading":
      return {
        text:
          fetch.received !== undefined && fetch.size !== undefined
            ? `Downloading Pi: ${megabytes(fetch.received)} of ${megabytes(fetch.size)} MB`
            : "Downloading Pi…",
        error: false,
      }
    case "ready":
      return { text: "Ready.", error: false }
    case "failed":
      return { text: fetch.error ?? "The download failed.", error: true }
    default:
      // Just switched on: the runner hasn't said yet.
      return { text: "Starting the download…", error: false }
  }
}
