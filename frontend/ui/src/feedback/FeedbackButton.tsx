import type {
  AgentFeedbackDraft,
  Feedback,
  FeedbackAbout,
  FeedbackKind,
  FeedbackNote,
  FeedbackOutcome,
} from "@novadeck/core/feedback"
import { scrub, strikeSummary, textToSend } from "@novadeck/core/feedback/scrub"
import type { AgentName } from "@novadeck/core/harnesses"
import type { TerminalKey } from "@novadeck/core/types"
import { HandleChip } from "@novadeck/toolkit/HandleChip"
import { Popover } from "@novadeck/toolkit/Popover"
import { SegmentGroup } from "@novadeck/toolkit/SegmentGroup"
import {
  Bug,
  Check,
  Lightbulb,
  MessageCircle,
  MessageSquareText,
  WifiOff,
  X,
  type LucideIcon,
} from "lucide-react"
import { createElement, useEffect, useRef, useState } from "react"

import { currentPlatform } from "../interaction/shortcuts"

import "./ask-agent.css"
import "./feedback.css"
import {
  buttonText,
  countShown,
  countText,
  draftCaption,
  enterSends,
  feedbackLimit,
  issuesUrl,
  kinds,
  nextSend,
  promptFor,
  readFeedbackOpened,
  sendable,
  sentForMs,
  writeFeedbackOpened,
  type Send,
} from "./feedback-state"
import { PrivacyLine } from "./PrivacyLine"

// The footer's feedback button and the card it opens, for a note the person writes. It
// shows its word, "Feedback", until the card was first opened, and is the icon alone from
// then on. A note goes with Send: the card closes and the button says it was sent for a
// moment; one that cannot go stays in the card, and the button says "Not sent · Retry". The
// draft (kind and text) lives here, so closing the card keeps it.
//
// An agent's draft (`Feedback.drafts`) opens the same card by itself, without taking focus,
// its kind and text filled in (what `feedback/scrub` strikes already replaced) under a head
// that says who wrote it, and a Discard beside Send. Closing the card keeps the draft in it,
// and the button says "Draft from @handle". The person's own note is never overwritten: a draft
// waits until the card is empty. One draft shows at a time, oldest first.
type Loaded = {
  readonly draft: AgentFeedbackDraft
  // The text as it was put in the card, to tell whether the person changed it.
  readonly original: string
  // The window's title when the draft arrived; none once its terminal is gone.
  readonly title: string | undefined
  // What was replaced in the text, in words; none where nothing was.
  readonly replaced: string | null
}

// The drafts' sends and settles on their way, by id: kept outside the card, so a second Send
// (a card made again after the runner's backend was) joins the one on its way instead of
// sending the note twice. `sentNotes` those whose note went out but whose settle has not.
const flights = new Map<string, Promise<void>>()
const sentNotes = new Set<string>()

const sendDraft = (feedback: Feedback, id: string, note: FeedbackNote): Promise<void> => {
  const going = flights.get(id)
  if (going) return going
  const work = (async () => {
    if (!sentNotes.has(id)) {
      await feedback.send(note)
      sentNotes.add(id)
    }
    try {
      await feedback.drafts?.settle(id, "sent")
      sentNotes.delete(id)
    } catch {
      // The note went; the settle is tried again when the listing still holds the draft.
    }
  })().finally(() => flights.delete(id))
  flights.set(id, work)
  return work
}
const kindIcons: Record<FeedbackKind, React.JSX.Element> = {
  bug: <Bug size={14} strokeWidth={1.6} aria-hidden="true" />,
  idea: <Lightbulb size={14} strokeWidth={1.6} aria-hidden="true" />,
  other: <MessageCircle size={14} strokeWidth={1.6} aria-hidden="true" />,
}

const sameTerminal = (a: TerminalKey, b: TerminalKey): boolean =>
  a.projectId === b.projectId &&
  a.workspaceSessionId === b.workspaceSessionId &&
  a.terminalId === b.terminalId

export const FeedbackButton = ({
  feedback,
  titleOf,
  iconOf,
}: {
  readonly feedback: Feedback
  // The title of a terminal's window, for what an agent's draft says of where it came from.
  readonly titleOf?: (terminal: TerminalKey) => string | undefined
  // The mark of an agent's harness, as its window's header shows it.
  readonly iconOf?: (agent: AgentName) => LucideIcon
}): React.JSX.Element => {
  const [open, setOpen] = useState(false)
  const [opened, setOpened] = useState(readFeedbackOpened)
  const [kind, setKind] = useState<FeedbackKind | null>(null)
  const [text, setText] = useState("")
  const [send, setSend] = useState<Send>("idle")
  const [about, setAbout] = useState<FeedbackAbout | null>(null)
  const [drafts, setDrafts] = useState<readonly AgentFeedbackDraft[]>([])
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  // The drafts the person sent or discarded, whose settle the backend may not have taken yet:
  // never offered again, and settled again with the next listing that holds them. The ref is
  // what the listing's callback reads; the state is what the card renders from.
  const doneRef = useRef(new Map<string, FeedbackOutcome>())
  const [done, setDone] = useState<ReadonlyMap<string, FeedbackOutcome>>(new Map())
  const markDone = (id: string, outcome: FeedbackOutcome): void => {
    doneRef.current.set(id, outcome)
    setDone(new Map(doneRef.current))
  }
  // Whether the card opened by itself, which takes no focus; the terminal a draft left from,
  // whose newer draft is the one to move on to.
  const [byDraft, setByDraft] = useState(false)
  const [lostFrom, setLostFrom] = useState<TerminalKey | null>(null)
  const field = useRef<HTMLTextAreaElement>(null)
  const alive = useRef(true)
  // What had focus before the card opened, which gets it back when the card closes.
  const before = useRef<Element | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  // Whether the card is open now, for a send that ends later; whether one is on its way,
  // so two nudges to send cannot make two; and the latest `submit`, for the online listener.
  const isOpen = useRef(false)
  const inFlight = useRef(false)
  const latestSubmit = useRef<() => void>(() => {})
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  // What goes along is asked when the card opens, so it is current.
  useEffect(() => {
    if (!open) return
    let current = true
    feedback.about().then(
      (next) => current && setAbout(next),
      () => current && setAbout(null),
    )
    return () => {
      current = false
    }
  }, [open, feedback])
  useEffect(
    () =>
      feedback.drafts?.watch((listed) => {
        for (const [id, outcome] of doneRef.current)
          if (listed.some((each) => each.id === id))
            feedback.drafts?.settle(id, outcome).catch(() => {})
        setDrafts(listed)
      }),
    [feedback],
  )
  const waiting = drafts.filter((each) => !done.has(each.id))
  const upNext =
    (lostFrom && waiting.find((each) => sameTerminal(each.terminal, lostFrom))) ?? waiting.at(0)
  // A draft that left the listing (replaced by a newer one, or settled elsewhere) leaves the
  // card, unless the person changed it: that is their own note now. Settled by this card, it
  // is already gone from it.
  if (loaded && !drafts.some((each) => each.id === loaded.draft.id) && !done.has(loaded.draft.id)) {
    setLostFrom(loaded.draft.terminal)
    setLoaded(null)
    if (text === loaded.original && kind === loaded.draft.kind) {
      setKind(null)
      setText("")
      // What failed to send was the draft that is gone: nothing is left to retry.
      setSend("idle")
      if (waiting.length === 0) setOpen(false)
    }
  } else if (loaded === null && text.trim() === "" && send !== "sending" && upNext) {
    // A draft comes into the card once it holds nothing of the person's, and opens it.
    const original = textToSend(scrub(upNext.text))
    setLoaded({
      draft: upNext,
      original,
      title: titleOf?.(upNext.terminal),
      replaced: strikeSummary(scrub(upNext.text).counts),
    })
    setLostFrom(null)
    // A new draft starts clean: a failed send of an earlier note is not its to retry.
    setSend("idle")
    setKind(upNext.kind)
    setText(original)
    setByDraft(true)
    setOpen(true)
  }
  // An agent's draft is longer than a note typed: the box grows to its text, up to its limit.
  const drafting = loaded?.draft.id
  useEffect(() => {
    if (!open || drafting === undefined) return
    const frame = requestAnimationFrame(() => {
      const box = field.current
      if (!box) return
      box.style.height = "auto"
      box.style.height = `${box.scrollHeight}px`
    })
    return () => cancelAnimationFrame(frame)
  }, [open, drafting])
  useEffect(() => {
    if (send !== "sent") return
    const timer = setTimeout(() => setSend((now) => nextSend(now, "expired")), sentForMs)
    return () => clearTimeout(timer)
  }, [send])

  // Focus goes back to what had it before the card opened (the terminal, say), or to the
  // button when the card was opened from it by keyboard; a click elsewhere keeps its own.
  // Focus still in the closing card is the card's, not something else that took it.
  const giveFocusBack = (): void => {
    const card = field.current?.closest(".feedback-card") ?? null
    requestAnimationFrame(() => {
      const active = document.activeElement
      if (active && active !== document.body && !card?.contains(active)) return
      const target = before.current
      before.current = null
      if (target instanceof HTMLElement && target.isConnected && target !== trigger.current)
        target.focus({ preventScroll: true })
      else trigger.current?.focus({ preventScroll: true })
    })
  }
  const submit = (): void => {
    if (inFlight.current || send === "sending" || !sendable(text)) return
    inFlight.current = true
    setSend((now) => nextSend(now, "send"))
    const note = { kind, text: text.trim() }
    const sending = loaded?.draft
    const going = sending ? sendDraft(feedback, sending.id, note) : feedback.send(note)
    going.then(
      () => {
        inFlight.current = false
        if (sending) markDone(sending.id, "sent")
        if (!alive.current) return
        setLoaded(null)
        setSend((now) => nextSend(now, "resolved"))
        // A retry in the background leaves the focus where it is.
        if (isOpen.current) {
          setOpen(false)
          giveFocusBack()
        }
        setKind(null)
        setText("")
      },
      () => {
        inFlight.current = false
        if (alive.current) setSend((now) => nextSend(now, "rejected"))
      },
    )
  }
  useEffect(() => {
    isOpen.current = open
    latestSubmit.current = submit
  })
  // A note that did not go is sent again by itself once the network is back.
  const retrying = send === "failed" && sendable(text)
  useEffect(() => {
    if (!retrying) return
    const retry = (): void => latestSubmit.current()
    window.addEventListener("online", retry)
    return () => window.removeEventListener("online", retry)
  }, [retrying])
  const discard = (): void => {
    if (!loaded || send === "sending") return
    const { id } = loaded.draft
    markDone(id, "discarded")
    feedback.drafts?.settle(id, "discarded").catch(() => {})
    setLoaded(null)
    setKind(null)
    setText("")
    setSend("idle")
    setOpen(false)
    giveFocusBack()
  }
  const change = (next: boolean): void => {
    setByDraft(false)
    setOpen(next)
    if (!next) giveFocusBack()
    if (!next || opened) return
    setOpened(true)
    writeFeedbackOpened()
  }
  const draftFrom = (loaded?.draft ?? upNext)?.handle
  const word = buttonText(send, opened, draftFrom)
  const agent = loaded?.draft
  const mac = currentPlatform() === "mac"
  return (
    <>
      <Popover
        label="Send feedback"
        open={open}
        onOpenChange={change}
        placement="top-end"
        tooltip="Send feedback"
        restoreFocus={false}
        initialFocus={() => (byDraft ? false : field.current)}
        trigger={
          <button
            ref={trigger}
            type="button"
            className="footer-update feedback-button cursor-pointer"
            // The pointer has not moved focus yet: note where it was.
            onMouseDown={() => (before.current = document.activeElement)}
            onClick={(event) => {
              if (event.detail === 0) before.current = null
            }}
            data-send={send === "idle" ? (draftFrom === undefined ? undefined : "draft") : send}
            aria-label={word === null ? "Send feedback" : undefined}
          >
            {send === "sent" ? (
              <Check size={12} strokeWidth={1.75} aria-hidden="true" />
            ) : send === "failed" ? (
              <WifiOff size={12} strokeWidth={1.75} aria-hidden="true" />
            ) : (
              <MessageSquareText size={12} strokeWidth={1.75} aria-hidden="true" />
            )}
            {word !== null && (
              <span
                className={`feedback-button-text ${send === "idle" && draftFrom === undefined ? "max-[701px]:hidden" : ""}`}
              >
                {send === "failed" ? (
                  <>
                    Not sent · <span className="feedback-retry">Retry</span>
                  </>
                ) : (
                  word
                )}
              </span>
            )}
          </button>
        }
      >
        <div className="feedback-card">
          <div className="feedback-body">
            <div className="feedback-head">
              {agent ? (
                <h2 className="feedback-title feedback-title-agent text-body">
                  {iconOf &&
                    createElement(iconOf(agent.agent), {
                      size: 14,
                      strokeWidth: 1.5,
                      "aria-hidden": true,
                    })}
                  <span className="truncate">
                    Feedback from <HandleChip handle={agent.handle} />
                  </span>
                </h2>
              ) : (
                <h2 className="feedback-title text-body">Send feedback</h2>
              )}
              <button
                type="button"
                className="icon-button small"
                aria-label="Close"
                onClick={() => change(false)}
              >
                <X size={14} strokeWidth={1.75} aria-hidden="true" />
              </button>
            </div>
            {agent && (
              <p className="ask-agent-line text-control">{draftCaption(agent, loaded.title)}</p>
            )}
            <SegmentGroup
              label="Kind"
              className="feedback-kinds"
              itemClassName="flex h-[30px] items-center justify-center gap-1.5 text-control"
              items={kinds.map(({ value, label }) => ({
                value,
                label,
                icon: kindIcons[value],
              }))}
              value={kind ?? ""}
              onValueChange={(value) => {
                setKind(kinds.find((each) => each.value === value)?.value ?? null)
                // The kind is only a prompt: typing goes on where it was.
                requestAnimationFrame(() => field.current?.focus())
              }}
            />
            <div className="field feedback-field">
              <textarea
                ref={field}
                className="field-input feedback-input text-body"
                aria-label="Your feedback"
                maxLength={feedbackLimit}
                placeholder={promptFor(kind)}
                value={text}
                // Read-only while the note goes, so what is typed then is not lost with the draft.
                readOnly={send === "sending"}
                onChange={(event) => {
                  setText(event.target.value)
                  // A failed note that was emptied has nothing left to retry.
                  if (send === "failed" && !sendable(event.target.value)) setSend("idle")
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || event.nativeEvent.isComposing) return
                  if (!enterSends(event, text)) return
                  event.preventDefault()
                  submit()
                }}
              />
            </div>
            {countShown(text.length) && (
              <p className="feedback-count" data-full={text.length >= feedbackLimit || undefined}>
                {countText(text.length)}
              </p>
            )}
            {loaded?.replaced && <p className="feedback-scrubbed">Replaced {loaded.replaced}.</p>}
            <PrivacyLine about={about} />
            {send === "failed" && (
              <p role="alert" className="feedback-failed">
                Not sent. Check your connection and try again.
              </p>
            )}
          </div>
          <div className="feedback-foot modal-footer">
            {agent ? (
              <button
                type="button"
                className="button ghost text-control"
                disabled={send === "sending"}
                onClick={discard}
              >
                Discard
              </button>
            ) : (
              <span className="feedback-reply">
                Need a reply?{" "}
                <a
                  className="feedback-link"
                  href={issuesUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open an issue
                </a>
              </span>
            )}
            <button
              type="button"
              className="button primary feedback-send text-control"
              disabled={send === "sending" || !sendable(text)}
              onClick={submit}
            >
              {send === "failed" ? "Retry" : "Send"}
              <span className="feedback-hint" aria-hidden="true">
                {mac ? "⌘" : "Ctrl"} ↵
              </span>
            </button>
          </div>
        </div>
      </Popover>
      <span role="status" aria-live="polite" className="sr-only">
        {send === "sent" ? "Sent. Thanks." : send === "failed" ? "Not sent." : ""}
      </span>
    </>
  )
}
