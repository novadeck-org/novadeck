import type { BundledPiFetchState } from "@novadeck/core/port"

// The Experimental row of Novadeck's own pi (Novadeck Agent): what it is for and what it costs.
export const bundledPiLabel = "Novadeck Agent (pi built in)"
export const bundledPiDescription =
  "Get Novadeck's own agent ready ahead of time: downloads pi, about 50–60 MB, once. It doesn't show in the agent picker yet. Turning this off keeps the download and stops Novadeck from fetching or starting it."

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
            ? `Downloading pi: ${megabytes(fetch.received)} of ${megabytes(fetch.size)} MB`
            : "Downloading pi…",
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
