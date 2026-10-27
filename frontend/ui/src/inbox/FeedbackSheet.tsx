/* oxlint-disable react/no-array-index-key -- Segments are cut from text that has no ids; they never reorder. */
import type { FeedbackAbout, FeedbackKind } from "@novadeck/core/feedback"
import { scrub, strikeSummary, textToSend, type Segment } from "@novadeck/core/feedback-scrub"
import { HandleChip } from "@novadeck/toolkit/HandleChip"
import { Bug, Lightbulb, Lock, ShieldCheck, MessageCircleMore, type LucideIcon } from "lucide-react"
import { Fragment, useEffect, useId, useMemo, useState } from "react"

import { waitLabel } from "./inbox-text"
import { useInboxContext } from "./InboxProvider"
import { Page, type SheetContentProps } from "./Page"
import { Failure } from "./sheet-parts"

// Feedback: a draft an agent wrote for the people building Novadeck, from what it just did
// in its terminal. The person edits it, sees what in it could identify them struck through,
// and sends it without those parts, or discards it. Nothing leaves until they send.

const kinds: Readonly<Record<FeedbackKind, { readonly word: string; readonly icon: LucideIcon }>> =
  {
    bug: { word: "Bug", icon: Bug },
    idea: { word: "Idea", icon: Lightbulb },
    other: { word: "Other", icon: MessageCircleMore },
  }

// What a note may hold, as the footer's card limits it.
const limit = 2_000
const issuesUrl = "https://github.com/novadeck-org/novadeck/issues/new"

// The line under the draft, never wrapping: what the note carries and what it doesn't. The
// footer's card says the same in its own words (the features can't share a component).
const Privacy = ({ about }: { readonly about: FeedbackAbout | null }): React.JSX.Element => (
  <p
    className="inbox-feedback-privacy text-caption"
    title={
      about
        ? `Anonymous. We get this note, ${about.version}, ${about.os}.`
        : "Anonymous. We get this note and the app's version and OS."
    }
  >
    <Lock size={12} strokeWidth={1.75} aria-hidden="true" />
    <span className="inbox-feedback-privacy-text">
      {about ? (
        <>
          Anonymous. We get this note, <span className="inbox-feedback-mono">{about.version}</span>,{" "}
          <span className="inbox-feedback-mono">{about.os}</span>.
        </>
      ) : (
        "Anonymous. We get this note and the app's version and OS."
      )}
    </span>
  </p>
)

// The draft as plain text to edit, under which the same text is drawn with the parts that
// would identify the person struck through: the box is transparent over its mirror, so
// typing, selecting and the caret are the browser's own, and the mirror only draws.
const Editor = ({
  value,
  segments,
  onChange,
  onSend,
  describedBy,
}: {
  readonly value: string
  readonly segments: readonly Segment[]
  readonly onChange: (text: string) => void
  readonly onSend: () => void
  readonly describedBy: string
}): React.JSX.Element => (
  <div className="field inbox-feedback-field text-body">
    <div className="inbox-feedback-mirror" aria-hidden="true">
      {segments.map((segment, index) =>
        segment.struck ? (
          <s key={index} className="inbox-feedback-struck" data-strike={segment.struck}>
            {segment.text}
          </s>
        ) : (
          <Fragment key={index}>{segment.text}</Fragment>
        ),
      )}
      {/* A last empty line still takes its height. */}
      {"​"}
    </div>
    <textarea
      className="field-input inbox-feedback-input"
      aria-label="Feedback draft"
      aria-describedby={describedBy}
      spellCheck
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        // Enter types a line; Ctrl or ⌘ with it sends.
        if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey)) return
        if (event.nativeEvent.isComposing) return
        event.preventDefault()
        onSend()
      }}
    />
  </div>
)

export const FeedbackSheet = (props: SheetContentProps): React.JSX.Element | null => {
  const { item, sent, answering, failed, submit } = props
  const { now, feedbackAbout, feedbackEdits, setFeedbackEdit } = useInboxContext()
  const id = item.id
  const original = item.kind === "feedback" ? item.draft.text : ""
  // The person's edits are the Inbox's, so they outlast the sheet and an answer that failed.
  const text = feedbackEdits[id] ?? original
  const setText = (next: string): void => setFeedbackEdit(id, next)
  const [about, setAbout] = useState<FeedbackAbout | null>(null)
  const noteId = useId()
  useEffect(() => {
    if (!feedbackAbout) return
    let current = true
    feedbackAbout().then(
      (next) => current && setAbout(next),
      () => current && setAbout(null),
    )
    return () => {
      current = false
    }
  }, [feedbackAbout])
  const scrubbed = useMemo(() => scrub(text), [text])
  if (item.kind !== "feedback") return null
  const kind = kinds[item.draft.kind]
  const KindIcon = kind.icon
  const outgoing = textToSend(scrubbed).trim()
  const over = outgoing.length - limit
  const summary = strikeSummary(scrubbed.counts)
  const ago = waitLabel(item.at, now)
  const canSend = outgoing !== "" && over <= 0 && !answering
  const send = (): void => {
    if (!canSend) return
    submit(
      { kind: "feedback", answer: { type: "send", text: outgoing } },
      `Sent @${item.source.handle}'s feedback. Thanks.`,
    )
  }
  const discard = (): void => {
    submit(
      { kind: "feedback", answer: { type: "discard" } },
      `Discarded @${item.source.handle}'s feedback draft.`,
    )
  }
  return (
    <Page
      footer={
        sent ? undefined : (
          <div className="inbox-feedback-foot">
            <span className="inbox-feedback-reply text-caption">
              Need a reply?{" "}
              <a className="inbox-link" href={issuesUrl} target="_blank" rel="noopener noreferrer">
                Open an issue
              </a>
            </span>
            <button
              type="button"
              className="button ghost text-control"
              disabled={answering}
              onClick={discard}
            >
              Discard
            </button>
            <button
              type="button"
              className="button primary text-control"
              disabled={!canSend}
              onClick={send}
            >
              Send
            </button>
          </div>
        )
      }
    >
      <div className="inbox-byline">
        <span>
          <HandleChip handle={item.source.handle} /> drafted this{" "}
          {ago === "now" ? "just now" : `${ago} ago`}
        </span>
        <span aria-hidden="true" className="inbox-byline-sep">
          ·
        </span>
        <span className="inbox-feedback-kind">
          <KindIcon size={12} strokeWidth={1.75} aria-hidden="true" />
          {kind.word}, its call
        </span>
        <span aria-hidden="true" className="inbox-byline-sep">
          ·
        </span>
        <span>edit anything</span>
      </div>
      <Editor
        value={text}
        segments={scrubbed.segments}
        onChange={setText}
        onSend={send}
        describedBy={noteId}
      />
      <p
        id={noteId}
        className="inbox-feedback-struck-line text-control"
        data-struck={scrubbed.total > 0 || undefined}
      >
        <ShieldCheck size={14} strokeWidth={1.75} aria-hidden="true" />
        Struck before sending: {summary ?? "nothing"}.
      </p>
      {over > 0 && (
        <p className="inbox-failure" role="alert">
          {`${over.toLocaleString("en-US")} over the ${limit.toLocaleString("en-US")} character limit. Shorten it to send.`}
        </p>
      )}
      <Privacy about={about} />
      <Failure message={failed} />
    </Page>
  )
}
