import { ArrowUp, Square } from "lucide-react"
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react"

import { promptHint, promptRefused } from "../../model/prompt-refusal"
import { Tooltip } from "../../ui-toolkit/Tooltip"
import { Hint } from "./Hint"

const reason = (failure: unknown): string =>
  failure instanceof Error && failure.message ? failure.message : "It didn't go through."

// Where the person writes to the agent. Enter sends what's typed into the agent's own
// box; Shift+Enter starts a new line. While one goes, the box holds its text, and a
// send that fails says why and keeps it.
export const Composer = ({
  label,
  draft,
  onDraft,
  working,
  onSend,
  onStop,
  focusInput,
  onInputFocused,
}: {
  // The agent it writes to, for the box's name.
  readonly label: string
  readonly draft: string
  readonly onDraft: (draft: string) => void
  readonly working: boolean
  // Resolves once the agent has it; clearing the draft is the owner's, which may outlive
  // this box. A failure leaves the draft as it is.
  readonly onSend: (text: string) => Promise<void>
  readonly onStop: () => Promise<void>
  // Keyboard navigation asks for focus here; call `onInputFocused` once it's there.
  readonly focusInput: boolean
  readonly onInputFocused: () => void
}): React.JSX.Element => {
  const input = useRef<HTMLTextAreaElement>(null)
  const [sending, setSending] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    if (!focusInput || !input.current) return
    input.current.focus({ preventScroll: true })
    onInputFocused()
  }, [focusInput, onInputFocused])
  // The box grows with its text, up to what its recipe allows.
  useLayoutEffect(() => {
    const box = input.current
    if (!box) return
    box.style.height = "auto"
    box.style.height = `${box.scrollHeight}px`
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Sized to the text it holds.
  }, [draft])
  const send = (): void => {
    const text = draft.trim()
    // The draft is judged as the hint judges it, so Enter refuses what Send does.
    if (!text || sending || promptRefused(draft)) return
    setSending(true)
    setError(null)
    onSend(text).then(
      () => {
        if (!mounted.current) return
        // The draft goes with the send: the owner clears it, mounted or not.
        setSending(false)
      },
      (failure: unknown) => {
        if (!mounted.current) return
        setSending(false)
        setError(reason(failure))
      },
    )
  }
  const stop = (): void => {
    if (stopping) return
    setStopping(true)
    onStop().then(
      () => mounted.current && setStopping(false),
      (failure: unknown) => {
        if (!mounted.current) return
        setStopping(false)
        setError(reason(failure))
      },
    )
  }
  const empty = draft.trim() === ""
  const refused = promptRefused(draft)
  const hint = useId()
  return (
    <form
      className="chat-composer nodrag nopan"
      aria-label={`Message ${label}`}
      onSubmit={(event) => {
        event.preventDefault()
        send()
      }}
    >
      {error && (
        <p className="chat-error" role="alert">
          {error}
        </p>
      )}
      <Hint id={hint} className="chat-error" text={refused ? promptHint : ""} />
      <div className="chat-composer-box">
        <textarea
          ref={input}
          data-terminal-input
          className="chat-input"
          aria-label={`Message ${label}`}
          placeholder={`Message ${label}…`}
          rows={1}
          value={draft}
          aria-describedby={hint}
          readOnly={sending}
          aria-busy={sending}
          spellCheck
          onChange={(event) => {
            onDraft(event.target.value)
            if (error) setError(null)
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return
            // A modified Enter belongs to the workspace's shortcuts.
            if (event.ctrlKey || event.metaKey || event.altKey) return
            event.preventDefault()
            send()
          }}
        />
        <div className="chat-composer-actions">
          {working && (
            <Tooltip content="Stop">
              <button
                type="button"
                className="chat-stop"
                aria-label="Stop"
                aria-disabled={stopping || undefined}
                onClick={stop}
              >
                <Square size={11} fill="currentColor" aria-hidden />
              </button>
            </Tooltip>
          )}
          <Tooltip content="Send · Enter">
            <button
              type="submit"
              className="chat-send"
              aria-label="Send"
              disabled={empty || sending || refused}
            >
              <ArrowUp size={15} strokeWidth={2} aria-hidden />
            </button>
          </Tooltip>
        </div>
      </div>
    </form>
  )
}
