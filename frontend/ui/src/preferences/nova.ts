import type { NovaFetchState } from "@novadeck/core/port"

// The Experimental row of Nova, which offers the tour too where the backend has one: what it is
// for and what it costs.
export const novaLabel = "Nova"
export const novaDescription = (tour: boolean): string =>
  [
    "Type nova in a Novadeck terminal to start Nova, Novadeck's own agent. It runs on GPT-6 Luna, Terra or Sol, which Novadeck pays for, a few sessions a day.",
    tour &&
      "It also adds a Help menu to the footer, with a short tour: three Nova agents at work in a sandbox repo.",
    `It downloads Pi once, about 50–60 MB. Off: the download stays, and nova doesn't start${tour ? ", nor the tour" : ""}.`,
  ]
    .filter(Boolean)
    .join(" ")

// What the row says under its description of where the download stands: `error` is for an alert,
// which offers to try again.
export type NovaNote = { readonly text: string; readonly error: boolean }

const megabytes = (bytes: number): string => (bytes / 1_000_000).toFixed(1)

export const novaNote = (enabled: boolean, fetch: NovaFetchState): NovaNote | undefined => {
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
