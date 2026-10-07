import { ArrowUp, Square, X } from "lucide-react"
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react"

import { SettleInTerminal } from "../../model/conversation"
import {
  controlHint,
  hasControlCharacters,
  messageHint,
  shellCommand,
  type Refused,
} from "../../model/prompt-refusal"
import { Tooltip } from "../../ui-toolkit/Tooltip"
import { oneLine } from "./answers"
import { Hint } from "./Hint"
import type { ComposerMode } from "./mode-state"

// The most a reply to the agent's question carries.
const replyMax = 16_384

// What a failure says, and whether the person settles it in the agent's terminal.
type Failure = { readonly text: string; readonly terminal: boolean }

const failed = (failure: unknown): Failure => ({
  text: failure instanceof Error && failure.message ? failure.message : "It didn't go through.",
  terminal: failure instanceof SettleInTerminal,
})

// Where the person writes to the agent. Enter sends what's typed into the agent's own
// box; Shift+Enter starts a new line. The words leave the box as they go, which is free for
// the next ones meanwhile, though those wait to be sent until the first arrive; a send that
// fails says why, its words back in the box. Its `mode` says what the words are: while it
// replies to the agent's question, the answer for the agent's own field, which takes one
// line; a message that starts with `!`, a shell command the agent runs in its shell mode.
export const Composer = ({
  label,
  draft,
  onDraft,
  mode,
  sending,
  replySending,
  working,
  onSend,
  onStop,
  focusInput,
  onInputFocused,
  onCancelReply,
  onOpenTerminal,
  refused: refusedText,
}: {
  // The agent it writes to, for the box's name.
  readonly label: string
  readonly draft: string
  readonly onDraft: (draft: string) => void
  readonly mode: ComposerMode
  // Whether earlier words are still on their way, which the owner keeps, and whether they
  // are this reply's, which can't be cancelled meanwhile.
  readonly sending: boolean
  readonly replySending: boolean
  readonly working: boolean
  // Resolves once the agent has it. Taking the words out of the draft, and putting them
  // back on a failure, is the owner's, which may outlive this box.
  readonly onSend: (text: string) => Promise<void>
  readonly onStop: () => Promise<void>
  // Keyboard navigation asks for focus here; call `onInputFocused` once it's there.
  readonly focusInput: boolean
  readonly onInputFocused: () => void
  readonly onCancelReply: () => void
  // Shows the agent's terminal, where the person settles what failed there.
  readonly onOpenTerminal: () => void
  // Whether a message would be refused for its shape, as the backend says.
  readonly refused: Refused
}): React.JSX.Element => {
  const input = useRef<HTMLTextAreaElement>(null)
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState<Failure | null>(null)
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
  // Sending answers the agent's question with the words, until the person cancels.
  const replying = mode === "reply" || mode === "waiting"
  // The question a reply was written for went: the words wait for an edit before they go.
  const orphaned = mode === "held"
  // The agent's field takes what a prompt can't start with; only control characters stop it.
  const long = replying && oneLine(draft).trim().length > replyMax
  const refused =
    orphaned ||
    (replying ? hasControlCharacters(draft) || long : refusedText(draft, { shell: true }))
  const command = mode === "shell" ? shellCommand(draft) : undefined
  // A `!` still waiting for its command: nothing to send yet, nothing to warn about either.
  const waiting = command === ""
  const send = (): void => {
    const text = draft.trim()
    // The draft is judged as the hint judges it, so Enter refuses what Send does.
    if (!text || sending || refused) return
    setError(null)
    onSend(text).catch((failure: unknown) => {
      if (mounted.current) setError(failed(failure))
    })
  }
  const stop = (): void => {
    if (stopping) return
    setStopping(true)
    onStop().then(
      () => mounted.current && setStopping(false),
      (failure: unknown) => {
        if (!mounted.current) return
        setStopping(false)
        setError(failed(failure))
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
        <p className="chat-error" role="alert" data-terminal={error.terminal || undefined}>
          <span>{error.text}</span>
          {error.terminal && (
            <button type="button" className="button quiet nodrag nopan" onClick={onOpenTerminal}>
              Open terminal
            </button>
          )}
        </p>
      )}
      {replying && (
        <p className="chat-reply" id={note}>
          <span>Replying to {label}'s question. Its field takes one line.</span>
          <button
            type="button"
            className="button quiet chat-reply-cancel"
            aria-label="Cancel the reply"
            disabled={replySending}
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
              aria-busy={sending || undefined}
            >
              <ArrowUp size={15} strokeWidth={2} aria-hidden />
            </button>
          </Tooltip>
        </div>
      </div>
    </form>
  )
}
