import type { Store } from "./store"

// cmd's AutoRun on Windows, and the person's one-click silencing of its output (the runner's
// `autorun`, approvals-design.md Appendix F): where it prints, Antigravity asks for each command
// and its hooks' answers can't be read outside Novadeck's terminals. These are the protocol's
// shapes as the UI reads them (`@novadeck/protocol`'s autorun.ts).

// What the person's last click came to, shown on the card until the next.
export type AutoRunOutcome =
  | {
      readonly kind: "applied-clean"
      readonly waiting: readonly string[]
      readonly restart: boolean
    }
  | { readonly kind: "applied-still-prints-hklm" }
  | { readonly kind: "rolled-back" }
  | { readonly kind: "conflict" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "undone" }
  | {
      readonly kind: "undo-refused"
      readonly terminals: readonly string[]
      readonly restart: boolean
    }

// Why Novadeck gives the step in words instead of doing the change.
export type AutoRunManualReason = "machine" | "refused" | "form" | "quiet" | "unchecked"

export type AutoRunState =
  // Nothing to offer: another platform, cmd prints nothing, or the person said not now.
  | { readonly state: "none"; readonly outcome: AutoRunOutcome | null; readonly dismissed: boolean }
  // The person's value, the exact new one, and the machine's (HKLM) value where there is one.
  | {
      readonly state: "offer"
      readonly current: string
      readonly next: string
      readonly machine: string | null
      readonly outcome: AutoRunOutcome | null
      // The person said not now to the Inbox's line for this value: Preferences still offers it.
      readonly dismissed: boolean
    }
  | {
      readonly state: "manual"
      readonly reason: AutoRunManualReason
      readonly rule: string | null
      readonly current: string | null
      readonly machine: string | null
      readonly suggested: string | null
      readonly outcome: AutoRunOutcome | null
      // The person said not now to the Inbox's line for this value: Preferences still offers it.
      readonly dismissed: boolean
    }
  // The person's value is Novadeck's wrapper; Undo puts `restores` back exactly.
  | {
      readonly state: "silenced"
      readonly current: string
      readonly restores: string
      readonly machine: string | null
      readonly suggested: string | null
      readonly outcome: AutoRunOutcome | null
      // The person said not now to the Inbox's line for this value: Preferences still offers it.
      readonly dismissed: boolean
    }

export const noAutoRun: AutoRunState = { state: "none", outcome: null, dismissed: false }

// The state and the person's three clicks. Absent from a backend whose runner has none.
export type AutoRun = {
  readonly state: Store<AutoRunState>
  // `value` is the new value the card showed; the runner refuses one that is no longer so.
  readonly silence: (value: string) => void
  readonly undo: () => void
  // Hides an offer or a manual step until the next start.
  readonly dismiss: () => void
  // Why the last call failed to reach the runner, until the next; the state says the rest.
  readonly failed?: Store<string | null>
  // Whether a call is on its way: its buttons wait, so a second click can't repeat it.
  readonly busy?: Store<boolean>
}

// Whether cmd's AutoRun is known to print: the Grant card's Antigravity line names the fix then.
export const autoRunPrints = (state: AutoRunState): boolean =>
  state.state === "offer" || state.state === "manual"
