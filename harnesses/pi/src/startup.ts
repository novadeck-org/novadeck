import type { PromptShown } from "@novadeck/harness-core/events"
import type { Harness } from "@novadeck/harness-core/harness"

export const heldScreen: NonNullable<Harness["heldScreen"]> = () => undefined

export const signedOut: NonNullable<Harness["signedOut"]> = () => false

/** The terminal title pi sets, `π - <session> - <folder>` or `π - <folder>`: its screen is up. */
export const title = (text: string, at: number): PromptShown | undefined =>
  text.startsWith("π")
    ? { type: "prompt-shown", agent: "pi", instance: null, startedAt: at }
    : undefined
