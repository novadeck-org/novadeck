import type { BootProgress, ConnectFailure } from "../backend/port"

// Where the boot is: reaching the backend, loading the workspace, attaching the
// restored session's terminals, or ready.
export type BootStage =
  | { readonly phase: "connecting" }
  | { readonly phase: "loading" }
  | { readonly phase: "attaching"; readonly progress: BootProgress }
  | { readonly phase: "online" }

// What the splash says at each stage.
export const bootLine = (stage: BootStage): string => {
  if (stage.phase === "connecting") return "Powering the deck…"
  if (stage.phase === "online") return "Deck online"
  if (stage.phase === "attaching" && stage.progress.total > 0)
    return `Attaching terminals ${stage.progress.attached} of ${stage.progress.total}`
  return "Jacking in…"
}

// How full the hairline is, from 0 to 1: a little for each step before attaching, and
// the rest in step with the terminals attached.
export const bootFill = (stage: BootStage): number => {
  if (stage.phase === "connecting") return 0.08
  if (stage.phase === "loading") return 0.25
  if (stage.phase === "online") return 1
  const { attached, total, done } = stage.progress
  if (done || total === 0) return done ? 1 : 0.3
  return 0.3 + (0.7 * attached) / total
}

// The splash says "Deck online" this long before it fades into the workspace.
export const onlineHoldMs = 700
// How long the fade takes; reduced motion skips it.
export const splashFadeMs = 400

// A transient failure retries on its own after these pauses, one per failure in a
// row; after the last it stops and waits for the person.
export const retryDelaysMs: readonly number[] = [2_000, 4_000, 8_000]

// The pause before the next automatic retry, or undefined when there is none: after
// `failures` failed attempts in a row.
export const autoRetryDelay = (failure: ConnectFailure, failures: number): number | undefined =>
  failure.kind === "transient" ? retryDelaysMs[failures - 1] : undefined

export const retryCountdown = (msLeft: number): string =>
  `Retrying in ${Math.max(1, Math.ceil(msLeft / 1000))} s…`

// What the person can do: quit a different version, retry anything else.
export const failureAction = (failure: ConnectFailure): "quit" | "retry" =>
  failure.kind === "incompatible" ? "quit" : "retry"

export const failureTitle = "Couldn't power the deck"

// The failure a rejected connect carries, or an unknown one.
export const failureOf = (error: unknown): ConnectFailure => {
  const failure = (error as { failure?: ConnectFailure } | null)?.failure
  if (failure) return failure
  return {
    kind: "unknown",
    message: "Something went wrong starting NovaDeck.",
    code: "UNKNOWN",
    detail: error instanceof Error ? error.message : String(error),
  }
}

// What "Copy details" puts on the clipboard.
export const failureDetails = (failure: ConnectFailure, attempts: number): string =>
  `Code: ${failure.code}\nMessage: ${failure.detail}\nAttempts: ${attempts}`
