import type { DemoPortable } from "./portable"
import type { DemoUpdates } from "./updates"

// The named update and portable scenarios the demo can play, each defined once: the
// debug panel lists every one (App › Updates, App › Portable) and a spec asks for one by
// its key in the address (`?update=ready`, `?portable=failed`). A new state is one entry.

export type UpdateScenario = {
  readonly label: string
  readonly hint: string
  // Plays the scenario on an installed copy's updates, offering `version`.
  readonly play: (updates: DemoUpdates, version: string) => void
  // The page asks for it once, as the workspace comes up, so the panel plays it by booting
  // again rather than in place.
  readonly reboots?: true
}

// The release before `version`, as the one an update came from: its last number one less,
// or none when that number is 0.
const earlier = (version: string): string | undefined => {
  const last = /(\d+)$/.exec(version)?.[1]
  return last && Number(last) > 0
    ? version.slice(0, -last.length) + String(Number(last) - 1)
    : undefined
}

const fromEarlier = (version: string): { readonly from?: string } => {
  const from = earlier(version)
  return from === undefined ? {} : { from }
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
  allow: {
    label: "Release, needs an administrator",
    hint: "Footer chip, Allow updates; pressing it starts the download",
    play: ({ offer }, version) => offer({ kind: "available", version, allow: true }),
  },
  ready: {
    label: "Ready at launch",
    hint: "No bar: downloaded before this run",
    play: ({ offer }, version) => offer({ kind: "ready", version }),
  },
  whatsNew: {
    label: "What's new, after an update",
    hint: "Card in the corner with three highlights and the version updated from, until dismissed; reboots, as it is asked once at launch",
    play: ({ showWhatsNew }, version) => showWhatsNew(version, fromEarlier(version)),
    reboots: true,
  },
  whatsNewMarkup: {
    label: "What's new, text with markup",
    hint: "Card whose highlights hold <b> and **stars**: shown as typed, never rendered; no version updated from, as from an install that never noted it; reboots",
    play: ({ showWhatsNew }, version) =>
      showWhatsNew(version, {
        highlights: [
          {
            title: "Bold <b>words</b> and **stars**",
            line: "A [link](https://example.com) and <i>tags</i>.",
          },
        ],
      }),
    reboots: true,
  },
  whatsNewLong: {
    label: "What's new, longest highlights",
    hint: "Four highlights at the longest the host allows: the list scrolls in a short window; reboots",
    play: ({ showWhatsNew }, version) =>
      showWhatsNew(version, {
        ...fromEarlier(version),
        highlights: ["First", "Second", "Third", "Fourth"].map((word) => ({
          title: `${word} highlight with a title that runs to the longest allowed`.padEnd(80, "."),
          line: `${word}: a line that runs on to the longest the host allows, `.padEnd(
            240,
            "and on ",
          ),
        })),
      }),
    reboots: true,
  },
  noHighlights: {
    label: "Updated, no highlights",
    hint: "The host takes 1.5 s to answer it has nothing to show: no card appears; reboots",
    play: ({ delayWhatsNew }) => delayWhatsNew(1500),
    reboots: true,
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
