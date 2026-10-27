import type { AgentFeedbackDraft, FeedbackAbout, FeedbackKind } from "@novadeck/core/feedback"

// What the feedback card holds and says, apart from how it looks: the kinds and their
// prompts, the text's limit, the send's states and which keys send.

export const kinds: readonly { readonly value: FeedbackKind; readonly label: string }[] = [
  { value: "bug", label: "Bug" },
  { value: "idea", label: "Idea" },
  { value: "other", label: "Other" },
]

// The text box's placeholder: it asks for what the picked kind is about.
export const promptFor = (kind: FeedbackKind | null): string => {
  switch (kind) {
    case "bug":
      return "What went wrong? What did you expect?"
    case "idea":
      return "What would help?"
    case "other":
      return "What's on your mind?"
    case null:
      return "What's broken, missing or good?"
  }
}

export const feedbackLimit = 2_000
// The count shows from here, so it is no noise for a note far from the limit.
const countFrom = 1_800
export const countShown = (length: number): boolean => length >= countFrom
export const countText = (length: number): string =>
  `${length.toLocaleString("en-US")} / ${feedbackLimit.toLocaleString("en-US")}`

// A note can go when it says something.
export const sendable = (text: string): boolean => text.trim() !== ""

// Whether Enter, with the modifiers held, sends the note rather than typing: Ctrl or ⌘ always
// does; a bare Enter does while the note is one line, and once it has a line break it types
// the next. Shift+Enter always types one.
export const enterSends = (
  keys: { readonly ctrlKey: boolean; readonly metaKey: boolean; readonly shiftKey: boolean },
  text: string,
): boolean => {
  if (keys.ctrlKey || keys.metaKey) return true
  return !keys.shiftKey && !text.includes("\n")
}

// A note's way out: idle, waiting for the network, sent (thanks, for a moment) or not sent.
export type Send = "idle" | "sending" | "sent" | "failed"
export type SendEvent = "send" | "resolved" | "rejected" | "expired"
export const sentForMs = 3_000

export const nextSend = (state: Send, event: SendEvent): Send => {
  switch (event) {
    case "send":
      // One at a time; a sent note's thanks gives way to the next.
      return state === "sending" ? state : "sending"
    case "resolved":
      return state === "sending" ? "sent" : state
    case "rejected":
      return state === "sending" ? "failed" : state
    case "expired":
      return state === "sent" ? "idle" : state
  }
}

// The footer button's words: the word until the card was first opened, then the icon alone;
// a send's outcome says itself in either case.
// A draft waiting from an agent (its handle) says so in the word, until a send's outcome
// does.
export const buttonText = (send: Send, opened: boolean, draftFrom?: string): string | null => {
  if (send === "sent") return "Sent · thanks"
  if (send === "failed") return "Not sent · Retry"
  if (draftFrom !== undefined) return `Draft from @${draftFrom}`
  return opened ? null : "Feedback"
}

// What the card says under its head about an agent's draft: that the person asked for it, or
// what the agent wrote on its own and from which window (none once the terminal is gone).
export const draftCaption = (
  draft: Pick<AgentFeedbackDraft, "asked" | "kind">,
  title: string | undefined,
): string => {
  if (draft.asked) return "The feedback you asked for."
  const what =
    draft.kind === "bug"
      ? "A possible Novadeck bug"
      : draft.kind === "idea"
        ? "An idea for Novadeck"
        : "A note about Novadeck"
  return title === undefined ? `${what}.` : `${what}, from \u201c${title}\u201d.`
}

// The line under the box, in words; its parts are set apart in the component.
export const privacyText = (about: FeedbackAbout | null): string =>
  about === null
    ? "Anonymous. We get this note and the app's version and OS."
    : `Anonymous. We get this note, ${about.version}, ${about.os}.`

export const issuesUrl = "https://github.com/novadeck-org/novadeck/issues/new"

// The mark that the card was opened once, which takes the word off the button for good.
export const openedStorageKey = "novadeck.feedback-opened"
export const readFeedbackOpened = (): boolean => {
  try {
    return localStorage.getItem(openedStorageKey) === "1"
  } catch {
    return false
  }
}
export const writeFeedbackOpened = (): void => {
  try {
    localStorage.setItem(openedStorageKey, "1")
  } catch {
    /* The word stays for this session when storage is unavailable. */
  }
}
