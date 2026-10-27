import type { Feedback } from "@novadeck/core/feedback"
import { HandleChip } from "@novadeck/toolkit/HandleChip"
import { Popover } from "@novadeck/toolkit/Popover"
import { Inbox, X } from "lucide-react"
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"

import { focusTerminalInput } from "../interaction/dom"

import "./ask-agent.css"
import { askAgentStore, closeAskAgent, headerOf, type AskTarget } from "./ask-agent-state"
import { feedbackLimit } from "./feedback-state"

// The small card that asks the agent in a window to write feedback from what it just did:
// opened from that window's menu, hung from its header. There is no kind to pick (the agent
// decides) and an optional hint. Ask sends the request and closes the card; the draft
// opens later in the feedback card.
// The hint box starts at three lines and grows to six before it scrolls.
const fit = (element: HTMLTextAreaElement): void => {
  element.style.height = "auto"
  element.style.height = `${Math.min(element.scrollHeight, 120)}px`
}

const Card = ({
  feedback,
  target,
}: {
  readonly feedback: Feedback
  readonly target: AskTarget
}): React.JSX.Element => {
  const [hint, setHint] = useState("")
  const [asking, setAsking] = useState(false)
  const [failed, setFailed] = useState(false)
  const titleId = useId()
  const field = useRef<HTMLTextAreaElement>(null)
  // The hint box is where typing starts, once the menu that opened the card has let go of focus.
  useEffect(() => {
    field.current?.focus({ preventScroll: true })
    const frame = requestAnimationFrame(() => field.current?.focus({ preventScroll: true }))
    return () => cancelAnimationFrame(frame)
  }, [])
  const ask = (): void => {
    if (asking) return
    setAsking(true)
    setFailed(false)
    const asked = feedback.ask
      ? feedback.ask(target.key, hint.trim())
      : Promise.reject(new Error("This backend can't ask an agent."))
    asked.then(
      () => {
        // A late answer closes only this card, not one opened for another window since.
        if (askAgentStore.getSnapshot() !== target) return
        closeAskAgent()
        focusTerminalInput(target.key.terminalId)
      },
      () => {
        setAsking(false)
        setFailed(true)
      },
    )
  }
  return (
    <div className="ask-agent-card" role="group" aria-labelledby={titleId}>
      <div className="ask-agent-body">
        <div className="ask-agent-head">
          <h2 id={titleId} className="ask-agent-title text-body">
            Ask <HandleChip handle={target.handle} /> to write feedback
          </h2>
          <button
            type="button"
            className="icon-button small"
            aria-label="Close"
            onClick={() => {
              closeAskAgent()
              focusTerminalInput(target.key.terminalId)
            }}
          >
            <X size={14} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>
        <p className="ask-agent-line text-control">
          It writes it up from what it just did here and decides whether it&apos;s a bug, an idea or
          something else.
        </p>
        <div className="field ask-agent-field">
          <textarea
            ref={field}
            data-ask-agent-hint=""
            className="field-input ask-agent-input text-body"
            aria-label="Anything it should cover? (optional)"
            placeholder="Anything it should cover? (optional)"
            rows={3}
            maxLength={feedbackLimit}
            value={hint}
            onChange={(event) => {
              fit(event.target)
              setHint(event.target.value)
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return
              event.preventDefault()
              ask()
            }}
          />
        </div>
        {failed && (
          <p role="alert" className="ask-agent-failed">
            Couldn&apos;t ask: no agent is running there.
          </p>
        )}
      </div>
      <div className="ask-agent-foot modal-footer">
        <span className="ask-agent-inbox">
          <Inbox size={12} strokeWidth={1.75} aria-hidden="true" />
          The draft opens in the feedback card.
        </span>
        <button
          type="button"
          className="button primary text-control"
          disabled={asking}
          onClick={ask}
        >
          Ask
        </button>
      </div>
    </div>
  )
}

// Mounted once in the app. Opens for the window a menu named, below the right of its header.
export const AskAgent = ({ feedback }: { readonly feedback: Feedback }): React.JSX.Element => {
  const target = useSyncExternalStore(askAgentStore.subscribe, askAgentStore.getSnapshot)
  // The window it hangs from, kept while the card closes. Its header is read again at each
  // placement, as a window moves in Grid and Canvas; where it has gone, the card stays put.
  const shown = useRef(target)
  useLayoutEffect(() => {
    if (target) shown.current = target
  }, [target])
  // Where that window's header last was, for that window only.
  const last = useRef<{ readonly id: string; readonly rect: DOMRect } | null>(null)
  const anchorRect = useCallback((): DOMRect | null => {
    const id = shown.current?.key.terminalId
    const rect = id === undefined ? null : headerOf(id)?.getBoundingClientRect()
    if (id !== undefined && rect) last.current = { id, rect }
    // A window that isn't on screen has no header: the card opens at the top of the page.
    return (
      (last.current?.id === id ? last.current?.rect : undefined) ??
      new DOMRect(globalThis.innerWidth / 2, 0, 0, 0)
    )
  }, [])
  // A card open as the app goes (a demo restarting) doesn't come back against a stale window.
  useEffect(() => closeAskAgent, [])
  return (
    <Popover
      // Placed from nothing for each window it opens for.
      key={target?.key.terminalId ?? "closed"}
      label="Ask the agent to write feedback"
      open={target !== null}
      onOpenChange={(open) => {
        if (open) return
        // Esc or a click outside: back to the window's terminal, as a closed menu would.
        const id = askAgentStore.getSnapshot()?.key.terminalId
        closeAskAgent()
        if (id !== undefined) focusTerminalInput(id)
      }}
      placement="bottom-end"
      restoreFocus={false}
      initialFocus={() => document.querySelector<HTMLElement>("[data-ask-agent-hint]")}
      anchorRect={anchorRect}
    >
      {target ? <Card feedback={feedback} target={target} /> : null}
    </Popover>
  )
}
