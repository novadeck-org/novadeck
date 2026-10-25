import type { Feedback, FeedbackAbout, FeedbackKind } from "@novadeck/core/feedback"
import { Popover } from "@novadeck/toolkit/Popover"
import { SegmentGroup } from "@novadeck/toolkit/SegmentGroup"
import { Bug, Check, Lightbulb, MessageCircle, MessageSquareText, WifiOff, X } from "lucide-react"
import { useEffect, useId, useRef, useState } from "react"

import { currentPlatform } from "../interaction/shortcuts"

import "./feedback.css"
import {
  buttonText,
  countShown,
  countText,
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
const kindIcons: Record<FeedbackKind, React.JSX.Element> = {
  bug: <Bug size={14} strokeWidth={1.6} aria-hidden="true" />,
  idea: <Lightbulb size={14} strokeWidth={1.6} aria-hidden="true" />,
  other: <MessageCircle size={14} strokeWidth={1.6} aria-hidden="true" />,
}

export const FeedbackButton = ({
  feedback,
}: {
  readonly feedback: Feedback
}): React.JSX.Element => {
  const [open, setOpen] = useState(false)
  const [opened, setOpened] = useState(readFeedbackOpened)
  const [kind, setKind] = useState<FeedbackKind | null>(null)
  const [text, setText] = useState("")
  const [send, setSend] = useState<Send>("idle")
  const [about, setAbout] = useState<FeedbackAbout | null>(null)
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
  const titleId = useId()
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
    feedback.send({ kind, text: text.trim() }).then(
      () => {
        inFlight.current = false
        if (!alive.current) return
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
  const change = (next: boolean): void => {
    setOpen(next)
    if (!next) giveFocusBack()
    if (!next || opened) return
    setOpened(true)
    writeFeedbackOpened()
  }
  const word = buttonText(send, opened)
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
        initialFocus={() => field.current}
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
            data-send={send === "idle" ? undefined : send}
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
                className={`feedback-button-text ${send === "idle" ? "max-[701px]:hidden" : ""}`}
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
              <h2 id={titleId} className="feedback-title text-body">
                Send feedback
              </h2>
              <button
                type="button"
                className="icon-button small"
                aria-label="Close"
                onClick={() => change(false)}
              >
                <X size={14} strokeWidth={1.75} aria-hidden="true" />
              </button>
            </div>
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
            <PrivacyLine about={about} />
            {send === "failed" && (
              <p role="alert" className="feedback-failed">
                Not sent. Check your connection and try again.
              </p>
            )}
          </div>
          <div className="feedback-foot modal-footer">
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
