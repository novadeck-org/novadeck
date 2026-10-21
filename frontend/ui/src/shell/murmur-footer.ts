import type { Refusal } from "@novadeck/core/addon"
import { formatSize, stepLabel } from "@novadeck/core/addon-format"
import { MURMUR_NAME, murmurChecking, type MurmurState } from "@novadeck/core/murmur"

// What Murmur's footer item shows, as a plain function of the addon's state: an install's
// progress as it goes, then how it ended. Only an install seen from here (started in this
// run of the app, from the offer or from Addons) shows; what the runner said at the start,
// such as a check that never passed, is Addons' to say. The exception is a failure of an
// installed Murmur (its engine would not run): Murmur is then off without a word, so it shows.

export type FooterPhase = "idle" | "installing" | "done" | "failed" | "unavailable"

// How long "Terminals name themselves now" stays.
export const doneForMs = 4000

// Where the item stands after `state`, given where it stood. The app's own engine update
// (an install of origin "update") shows nothing. From rest a refused install call shows, and
// each refusal is an event: `handled` is the one the person last answered, and another, though
// in the same words, is a new one. So does the runner's failure of an installed Murmur (the engine
// failing again and again, a device that went away); one not installed is Addons' to say. The
// failure that stands is one appearance: `handledFailure` is the one the person last answered,
// and it is forgotten by the caller once the failure clears, so a new one shows. A cancel is no failure: the runner
// leaves the files with the check owed and no failure. A failed item the runner's failure made
// goes when that failure clears (a runner restart, an install or update, a removal); one a refusal made
// stays until it is answered, as the refusal itself goes with the next snapshot.
export const footerPhase = (
  phase: FooterPhase,
  state: MurmurState,
  handled: Refusal | null,
  // The verdict that stood as the install began (a Check again keeps it until the new check
  // ends): only another is news of it.
  verdictBefore: string | null = null,
  // Whether a failed item was made by the runner's failure, not by a refusal.
  fromRunner = false,
  // The runner's failure the person last answered, while it still stands.
  handledFailure: string | null = null,
): FooterPhase => {
  if (state.installing)
    return phase === "installing" || state.installing.origin === "person" ? "installing" : phase
  if (phase === "installing") {
    // It ended: how, is for the state to say.
    if (state.unsupported !== null && state.unsupported.reason !== verdictBefore)
      return "unavailable"
    if (state.failure !== null) return "failed"
    return state.installed && state.check !== null ? "done" : "idle"
  }
  if (phase === "idle") {
    if (state.refused?.call === "install" && state.refused !== handled) return "failed"
    return state.installed && state.failure !== null && state.failure !== handledFailure
      ? "failed"
      : "idle"
  }
  if (phase === "failed" && fromRunner && state.failure === null && state.refused === null)
    return "idle"
  return phase
}

// The share of the whole download that has arrived, 0 to 100, or null while there is nothing
// to count (the check).
export const installPercent = (state: MurmurState): number | null => {
  const { installing, sizes } = state
  if (!installing || installing.step === "check") return null
  const total = sizes.engine + sizes.model
  if (total <= 0) return 0
  const before = installing.step === "model" ? sizes.engine : 0
  return Math.min(100, Math.round(((before + installing.received) / total) * 100))
}

// The item's words, for sighted and assistive technology alike. `summary` is the stable
// one a live region says; the label may carry a percentage that changes.
export const footerText = (
  phase: Exclude<FooterPhase, "idle">,
  state: MurmurState,
  // Why it failed, as the runner or the refused call said, for a failed item.
  failure: string | null = null,
): { readonly label: string; readonly summary: string } => {
  if (phase === "done")
    return { label: "Terminals name themselves now", summary: "Terminals name themselves now" }
  if (phase === "failed")
    return {
      label: `${MURMUR_NAME} \u00b7 failed`,
      summary: `${MURMUR_NAME} couldn't turn on${failure ? `. ${failure}` : ""}`,
    }
  if (phase === "unavailable")
    return {
      label: `${MURMUR_NAME} isn't available`,
      summary: `${MURMUR_NAME} isn't available on this computer`,
    }
  const percent = installPercent(state)
  return {
    label: percent === null ? MURMUR_NAME : `${MURMUR_NAME} ${percent}%`,
    summary: `Setting up ${MURMUR_NAME}`,
  }
}

// What the open sheet says of the step under way.
export const stepText = ({ installing }: MurmurState): string => {
  if (!installing) return "Starting…"
  const title = stepLabel(installing.step, murmurChecking)
  return installing.step === "check"
    ? title
    : `${title} · ${formatSize(installing.received)} of ${formatSize(installing.total)}`
}
