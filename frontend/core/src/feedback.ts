import type { AgentName } from "./harnesses"
import type { TerminalKey } from "./types"

// Feedback: what the person tells the people building Novadeck, from inside the app. Two
// ways in, one destination. The footer's card sends a note the person wrote. An agent
// window's menu asks that window's agent to write one up from what it just did; an agent may
// also draft one on its own. Either draft comes through `drafts`, and nothing is sent until
// the person sends it. Every note is anonymous: it carries its kind, its text, and the app's
// version and OS (`FeedbackAbout`), never a name, an address or an install id.

// What a note is about. The person picks one, or none, in the card; an agent always says.
export type FeedbackKind = "bug" | "idea" | "other"

// A note as it is sent.
export type FeedbackNote = {
  readonly kind: FeedbackKind | null
  readonly text: string
}

// What goes along with every note, shown in the card as it is sent: the app's version
// (`0.0.219`) and the OS with its architecture (`Linux x64`, `macOS arm64`).
export type FeedbackAbout = {
  readonly version: string
  readonly os: string
}

// A draft an agent wrote for the people building Novadeck, waiting for the person to send it
// or discard it. The text is the agent's; the person may edit it before sending. `asked` when
// the person asked that agent for it, not when it wrote one on its own after hitting a
// Novadeck bug. `terminal` is where it was written (the terminal may have closed since) and
// `at` when, in epoch milliseconds.
export type AgentFeedbackDraft = {
  readonly id: string
  readonly terminal: TerminalKey
  readonly handle: string
  readonly agent: AgentName
  readonly kind: FeedbackKind
  readonly text: string
  readonly asked: boolean
  readonly at: number
}

// How a draft ended: its note was sent, or the person discarded it.
export type FeedbackOutcome = "sent" | "discarded"

// The agents' drafts, for a UI to offer them. Nothing is sent from here: a draft goes out
// through `Feedback.send` like any note, and `settle` then tells the backend it is done.
export type FeedbackDrafts = {
  // Hears the drafts now waiting, oldest first (an empty list when none), then again on each
  // change: a new one, one replaced by a newer one from its terminal, or one settled
  // elsewhere. Returns the unsubscribe.
  readonly watch: (listener: (drafts: readonly AgentFeedbackDraft[]) => void) => () => void
  // Drops a draft once its note was sent or the person discarded it. A draft the backend no
  // longer holds (replaced, or settled elsewhere) is done all the same: it resolves.
  // Rejects when the backend couldn't be told; the draft is still waiting then.
  readonly settle: (id: string, outcome: FeedbackOutcome) => Promise<void>
}

export type Feedback = {
  // What goes along with each note, asked when the card opens.
  readonly about: () => Promise<FeedbackAbout>
  // Sends a note. Rejects when it couldn't go (no network), and the card keeps the note.
  readonly send: (note: FeedbackNote) => Promise<void>
  // Asks the agent in a terminal to write feedback from what it just did, with the
  // person's hint (empty for none). Resolves once the request is on its way; the draft
  // arrives later through `drafts`. Rejects when no agent runs there. Optional: the demo
  // and the desktop app (where the host can send feedback) have it, and the window menu
  // offers the item, for an agent of any harness, only where it exists.
  readonly ask?: (terminal: TerminalKey, hint: string) => Promise<void>
  // The agents' drafts, where the backend has them (with `ask`).
  readonly drafts?: FeedbackDrafts
}
