import type { DemoPortable } from "./debug/portable"
import type { DemoUpdates } from "./debug/updates"

// The named update and portable scenarios the demo can play, each defined once: the
// debug panel lists every one (App › Updates, App › Portable) and a spec asks for one by
// its key in the address (`?update=ready`, `?portable=failed`). A new state is one entry.

export type UpdateScenario = {
  readonly label: string
  readonly hint: string
  // Plays the scenario on an installed copy's updates, offering `version`.
  readonly play: (updates: DemoUpdates, version: string) => void
}

export const updateScenarios = {
  download: {
    label: "Download",
    hint: "Bar counts up, says ready, then fades",
    play: ({ download }, version) => download(version),
  },
  held: {
    label: "Download, held",
    hint: "Bar stays at 40% to look at",
    play: ({ offer }, version) => offer({ kind: "downloading", version, percent: 40 }),
  },
  failed: {
    label: "Download failed",
    hint: "Bar stands at 40% for a moment, then drops and nothing shows; the host retries later",
    play: ({ failDownload }, version) => failDownload(version),
  },
  available: {
    label: "Release to fetch",
    hint: "Footer chip, Update available; opens the release page",
    play: ({ offer }, version) => offer({ kind: "available", version }),
  },
  ready: {
    label: "Ready at launch",
    hint: "No bar: downloaded before this run",
    play: ({ offer }, version) => offer({ kind: "ready", version }),
  },
} as const satisfies Record<string, UpdateScenario>

export type UpdateScenarioKey = keyof typeof updateScenarios

export type PortableScenario = {
  readonly label: string
  readonly hint: string
  // The portable copy the host plays, given the version of the release waiting where the
  // scenario has one; undefined for an installed copy.
  readonly setup: (version: string) => DemoPortable | undefined
}

// How long the host takes to install, so Installing is there to look at.
const installTakes = 4000

const installs: DemoPortable = {
  ends: { phase: "installed" },
  installAfterMs: installTakes,
  progress: true,
}

export const portableScenarios = {
  "no-release": {
    label: "No release known",
    hint: "Card comes up once, then the Install Novadeck chip; Install takes 4 s",
    setup: () => installs,
  },
  update: {
    label: "Update available",
    hint: "Card for a new release, Update available chip; Install takes 4 s",
    setup: (version) => ({ ...installs, offer: { kind: "available", version } }),
  },
  never: {
    label: "Install never finishes",
    hint: "Install holds the Installing card and chip",
    setup: () => ({ ends: "never" }),
  },
  newer: {
    label: "Newer install exists",
    hint: "Install ends saying that Novadeck 0.0.99 is already installed",
    setup: () => ({ ends: { phase: "newer", version: "0.0.99" }, installAfterMs: installTakes }),
  },
  failed: {
    label: "Install fails",
    hint: "Says why; Try again stays",
    setup: () => ({
      ends: { phase: "failed", reason: "There is no space left on the disk." },
      installAfterMs: installTakes,
    }),
  },
  installed: {
    label: "Already installed",
    hint: "A window opened again after installing: no card, chip reads Installed",
    setup: () => ({ ends: { phase: "installed" }, opens: { phase: "installed" } }),
  },
  "slow-host": {
    label: "Slow host",
    hint: "Chip comes after 4 s",
    setup: () => ({ ...installs, answerAfterMs: 4000 }),
  },
  "installed-copy": {
    label: "Installed copy",
    hint: "No install chip",
    setup: () => undefined,
  },
} as const satisfies Record<string, PortableScenario>

export type PortableScenarioKey = keyof typeof portableScenarios
