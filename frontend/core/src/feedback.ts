import type { TerminalKey } from "./types"

// Feedback: what the person tells the people building Novadeck, from inside the app. Two
// ways in, one destination. The footer's card sends a note the person wrote. An agent
// window's menu asks that window's agent to write one up from what it just did; its draft
// comes to the Inbox (`kind: "feedback"`), and nothing is sent until the person sends it
// there. Every note is anonymous: it carries its kind, its text, and the app's version and
// OS (`FeedbackAbout`), never a name, an address or an install id.

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

// An agent's draft, as the Inbox holds it until the person sends or discards it. The text
// is the agent's; the person may edit it before sending.
export type FeedbackDraft = {
  readonly kind: FeedbackKind
  readonly text: string
}

export type Feedback = {
  // What goes along with each note, asked when the card opens.
  readonly about: () => Promise<FeedbackAbout>
  // Sends a note. Rejects when it couldn't go (no network), and the card keeps the note.
  readonly send: (note: FeedbackNote) => Promise<void>
  // Asks the agent in a terminal to write feedback from what it just did, with the
  // person's hint (empty for none). Resolves once the request is on its way; the draft
  // arrives later as an Inbox row. Rejects when no agent runs there. Optional: the demo
  // has it, the desktop app not yet (it waits for the same route on every harness), and
  // the window menu offers the item only where it exists.
  readonly ask?: (terminal: TerminalKey, hint: string) => Promise<void>
}
