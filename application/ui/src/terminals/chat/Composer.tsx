import { ArrowUp, Square, X } from "lucide-react"
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react"

import {
  controlHint,
  hasControlCharacters,
  messageHint,
  promptRefused,
  shellCommand,
} from "../../model/prompt-refusal"
import { Tooltip } from "../../ui-toolkit/Tooltip"
import { oneLine } from "./answers"
import { Hint } from "./Hint"

// The most a reply to the agent's question carries.
const replyMax = 16_384

const reason = (failure: unknown): string =>
  failure instanceof Error && failure.message ? failure.message : "It didn't go through."

// Where the person writes to the agent. Enter sends what's typed into the agent's own
// box; Shift+Enter starts a new line. While one goes, the box holds its text, and a
// send that fails says why and keeps it. While it replies to the agent's question, what's
// typed is the answer for the agent's own field, which takes one line. A message that starts
// with `!` is a shell command, which the agent runs in its shell mode.
export const Composer = ({
  label,
  draft,
  onDraft,
  working,
  onSend,
  onStop,
  focusInput,
  onInputFocused,
  replying,
  orphaned,
  onCancelReply,
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
  // Sending answers the agent's question with the words, until the person cancels.
  readonly replying: boolean
  // The question a reply was written for went: the words wait for an edit before they go.
  readonly orphaned: boolean
  readonly onCancelReply: () => void
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
  // The agent's field takes what a prompt can't start with; only control characters stop it.
  const long = replying && oneLine(draft).trim().length > replyMax
  const refused =
    orphaned ||
    (replying ? hasControlCharacters(draft) || long : promptRefused(draft, { shell: true }))
  const command = replying || orphaned ? undefined : shellCommand(draft)
  // A `!` still waiting for its command: nothing to send yet, nothing to warn about either.
  const waiting = command === ""
  const send = (): void => {
    const text = draft.trim()
    // The draft is judged as the hint judges it, so Enter refuses what Send does.
    if (!text || sending || refused) return
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
  const hint = useId()
  const note = useId()
  const shellNote = useId()
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
      {replying && (
        <p className="chat-reply" id={note}>
          <span>Replying to {label}'s question. Its field takes one line.</span>
          <button
            type="button"
            className="button quiet chat-reply-cancel"
            aria-label="Cancel the reply"
            disabled={sending}
            onClick={onCancelReply}
          >
            <X size={12} aria-hidden />
            Cancel
          </button>
        </p>
      )}
      {orphaned && (
        <p className="chat-reply" id={note}>
          <span>
            {label}'s question went, so this is no longer a reply. Edit it to send it as a message.
          </span>
        </p>
      )}
      {command !== undefined && (
        <p className="chat-reply" id={shellNote}>
          <span>Runs in {label}'s shell, as if typed in its terminal.</span>
        </p>
      )}
      <Hint
        id={hint}
        className="chat-error"
        text={
          refused && !waiting && !orphaned
            ? replying
              ? long
                ? "A reply takes at most 16,384 characters."
                : controlHint
              : messageHint(draft)
            : ""
        }
      />
      <div className="chat-composer-box">
        <textarea
          ref={input}
          data-terminal-input
          className="chat-input"
          aria-label={`Message ${label}`}
          placeholder={replying ? `Reply to ${label}'s question…` : `Message ${label}…`}
          rows={1}
          value={draft}
          aria-describedby={
            replying || orphaned
              ? `${note} ${hint}`
              : command !== undefined
                ? `${shellNote} ${hint}`
                : hint
          }
          // What the agent's field takes, as the protocol carries it.
          maxLength={replying ? replyMax : undefined}
          readOnly={sending}
          aria-busy={sending}
          spellCheck
          onChange={(event) => {
            onDraft(event.target.value)
            if (error) setError(null)
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.nativeEvent.isComposing) return
            if (event.shiftKey) {
              // The agent's field takes one line.
              if (replying) event.preventDefault()
              return
            }
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
