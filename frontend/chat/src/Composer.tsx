import { SettleInTerminal, type ChatBox } from "@novadeck/core/conversation"
import { oneLine } from "@novadeck/core/conversation/picks"
import {
  controlHint,
  hasControlCharacters,
  messageHint,
  shellCommand,
  type Refused,
} from "@novadeck/core/conversation/prompt-refusal"
import { clipboardImages, pastedFiles, pastedText } from "@novadeck/terminal/view"
import { Tooltip } from "@novadeck/toolkit/Tooltip"
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react"

import type { Attachment } from "./attachments"
import type { ComposerMode } from "./composer-mode"
import { Hint } from "./Hint"
import { Mark } from "./Mark"
import { submitOnEnter } from "./submit-on-enter"
import { useMounted } from "./use-mounted"

// The most a reply to the agent's question carries.
const replyMax = 16_384

// The keys of the box that go to a harness's menu rather than edit the text.
const menuKeys: Readonly<Record<string, string>> = {
  Enter: "\r",
  Tab: "\t",
  Escape: "\x1b",
  ArrowUp: "\x1b[A",
  ArrowDown: "\x1b[B",
}

// What a failure says, and whether the person settles it in the agent's terminal.
type Failure = { readonly text: string; readonly terminal: boolean }

const failed = (failure: unknown): Failure => ({
  text: failure instanceof Error && failure.message ? failure.message : "It didn't go through.",
  terminal: failure instanceof SettleInTerminal,
})

// Whether what the agent's own input holds is a command, which nothing is sent over.
const boxRefused = (box: ChatBox): boolean =>
  box.mode !== "shell" && !box.tail && /^\s*[/!]/.test(box.text)

// What the note over the box says of what the agent's own input holds, and what happens to it.
export const boxNote = (label: string, box: ChatBox): string => {
  if (box.mode === "shell")
    return `${label}'s terminal input is in shell mode, with this in it. Your next message leaves it.`
  if (boxRefused(box)) return `${label}'s terminal input holds a command. Clear it to send here.`
  if (box.tail) return `${label}'s terminal input ends with this. There may be more above it.`
  if (box.known)
    return `${label}'s terminal input holds your message. It comes back here as you send.`
  return `${label}'s terminal input holds this. It goes with your next message.`
}

// Where the person writes to the agent. Enter sends what's typed into the agent's own
// box; Shift+Enter starts a new line. The words leave the box as they go, which is free for
// the next ones meanwhile, though those wait to be sent until the first arrive; a send that
// fails says why, its words back in the box. Its `mode` says what the words are: while it
// replies to the agent's question, the answer for the agent's own field, which takes one
// line; a message that starts with `!`, a shell command the agent runs in its shell mode.
// Pasting images (Ctrl+V, Ctrl+Shift+V or ⌘V) adds them to the next message, which only a plain
// message takes: the other modes refuse the paste and say why.
export const Composer = ({
  label,
  draft,
  onDraft,
  attachments,
  imageNote,
  onAttach,
  onDetach,
  mode,
  sending,
  replySending,
  working,
  onSend,
  onStop,
  onClearBox,
  focusInput,
  onInputFocused,
  onCancelReply,
  onOpenTerminal,
  refused: refuses,
  box,
  passing,
  onPress,
}: {
  // The agent it writes to, for the box's name.
  readonly label: string
  readonly draft: string
  readonly onDraft: (draft: string) => void
  // The images pasted in, to go with the next message, and how a paste of more adds them (it
  // answers why some weren't, or null; absent where the backend takes no images) and one goes.
  readonly attachments: readonly Attachment[]
  // What the person is told of the images, as that some went for want of room.
  readonly imageNote?: string | undefined
  readonly onAttach?: ((files: readonly File[]) => string | null) | undefined
  readonly onDetach: (id: string) => void
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
  // Empties the agent's own box of the text shown of it. Rejects where it didn't.
  readonly onClearBox: (seen: string) => Promise<void>
  // Keyboard navigation asks for focus here; call `onInputFocused` once it's there.
  readonly focusInput: boolean
  readonly onInputFocused: () => void
  readonly onCancelReply: () => void
  // Shows the agent's terminal, where the person settles what failed there.
  readonly onOpenTerminal: () => void
  // Whether a message would be refused for its shape, as the backend says.
  readonly refused: Refused
  // What the agent's own box holds, which a message sent now goes out with.
  readonly box: ChatBox | null
  // Whether what is typed goes to the agent's terminal, for a menu of its own, and the way a
  // key of the box's goes there: true where it went.
  readonly passing: boolean
  readonly onPress: (keys: string) => boolean
}): React.JSX.Element => {
  const input = useRef<HTMLTextAreaElement>(null)
  const [stopping, setStopping] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [error, setError] = useState<Failure | null>(null)
  const mounted = useMounted()
  useEffect(() => {
    if (!focusInput || !input.current) return
    input.current.focus({ preventScroll: true })
    onInputFocused()
  }, [focusInput, onInputFocused])
  // The box grows with its text, up to what its recipe allows.
  useLayoutEffect(() => {
    const field = input.current
    if (!field) return
    field.style.height = "auto"
    field.style.height = `${field.scrollHeight}px`
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Sized to the text it holds.
  }, [draft])
  // Sending answers the agent's question with the words, until the person cancels.
  const replying = mode === "reply" || mode === "waiting"
  // The question a reply was written for went: the words wait for an edit before they go.
  const held = mode === "held"
  // The agent's field takes what a prompt can't start with; only control characters stop it.
  const long = replying && oneLine(draft).trim().length > replyMax
  const refused =
    held || (replying ? hasControlCharacters(draft) || long : refuses(draft, { shell: true }))
  const command = mode === "shell" ? shellCommand(draft) : undefined
  // Whether the images pasted go with what is sent now: only a plain message takes them.
  const carries = mode === "message" && !passing
  const uploading = attachments.some((each) => each.state === "uploading")
  const imaged = carries && attachments.length > 0
  // A `!` still waiting for its command: nothing to send yet, nothing to warn about either.
  const awaitingCommand = command === ""
  const send = (): void => {
    // Send is gone with the words, should it hold focus.
    input.current?.focus({ preventScroll: true })
    if (passing) {
      onPress("\r")
      return
    }
    const text = draft.trim()
    // The draft is judged as the hint judges it, so Enter refuses what Send does.
    if ((!text && !imaged) || sending || refused) return
    // Enter, which the Send key waits for: it says why nothing went.
    if (imaged && uploading) {
      setError({ text: "An image is still uploading. Send again once it has.", terminal: false })
      return
    }
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
  const clearBox = (seen: string): void => {
    if (clearing) return
    setClearing(true)
    setError(null)
    onClearBox(seen).then(
      () => mounted.current && setClearing(false),
      (failure: unknown) => {
        if (!mounted.current) return
        setClearing(false)
        setError(failed(failure))
      },
    )
  }
  const empty = draft.trim() === "" && !imaged
  // Why a paste of images can't join the next message, where it can't.
  const pasteRefusal = (): string | null => {
    if (passing) return `What you type goes to ${label}'s own menu, which takes no images.`
    if (replying) return "A reply to the agent's question takes text only."
    if (held) return "Edit the held reply to send it as a message first, then paste the images."
    if (mode === "shell") return "A shell command takes text only."
    return null
  }
  const attach = (files: readonly File[]): void => {
    const refusal =
      pasteRefusal() ?? (onAttach ? onAttach(files) : "This backend can't take images.")
    setError(refusal ? { text: refusal, terminal: false } : null)
  }
  // A paste of images, which the field would drop: a paste with text stays the field's, as a
  // page's copied cells come. One that carries nothing (as Ctrl+Shift+V pastes an image alone)
  // asks the clipboard, once the page may read it.
  const pasted = (event: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    const data = event.clipboardData
    if (pastedText(data)) return
    const files = pastedFiles(data)
    event.preventDefault()
    if (files.length > 0) return attach(files)
    void clipboardImages(new Date()).then((images) => {
      if (mounted.current && images && images.length > 0) attach(images)
    })
  }
  const hint = useId()
  const note = useId()
  const shellNote = useId()
  const boxNoteId = useId()
  return (
    <form
      className="chat-composer nodrag nopan"
      data-mode={mode}
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
            <button
              type="button"
              className="chat-key nodrag nopan"
              aria-label="Open terminal"
              onClick={onOpenTerminal}
            >
              terminal
            </button>
          )}
        </p>
      )}
      {replying && (
        <p className="chat-reply" id={note}>
          <span>Replying to {label}'s question. Its field takes one line.</span>
          <button
            type="button"
            className="chat-key"
            aria-label="Cancel the reply"
            disabled={replySending}
            onClick={onCancelReply}
          >
            cancel
          </button>
        </p>
      )}
      {held && (
        <p className="chat-reply" id={note}>
          <span>
            {label}'s question went, so this is no longer a reply. Edit it to send it as a message.
          </span>
        </p>
      )}
      {passing && (
        <p className="sr-only" id={note}>
          What you type goes to {label}'s own menu.
        </p>
      )}
      {box && !passing && (
        <div
          className="chat-reply chat-box"
          id={boxNoteId}
          data-refused={boxRefused(box) || undefined}
        >
          <div className="chat-box-head">
            <span>{boxNote(label, box)}</span>
            <button
              type="button"
              className="chat-key"
              aria-label={`Clear ${label}'s terminal input`}
              disabled={clearing}
              onClick={() => clearBox(box.text)}
            >
              clear
            </button>
          </div>
          <pre className="chat-box-text">{box.tail ? `…${box.text}` : box.text}</pre>
        </div>
      )}
      {command !== undefined && (
        <p className="sr-only" id={shellNote}>
          Runs in {label}'s shell, as if typed in its terminal.
        </p>
      )}
      <Hint
        id={hint}
        className="chat-error"
        text={
          refused && !awaitingCommand && !held
            ? replying
              ? long
                ? "A reply takes at most 16,384 characters."
                : controlHint
              : messageHint(draft)
            : ""
        }
      />
      {attachments.length > 0 && (
        <ul className="chat-attachments" aria-label="Images for the next message">
          {attachments.map((each) => (
            <li
              key={each.id}
              className="chat-attachment"
              data-state={each.state}
              data-held={!carries || undefined}
              aria-busy={each.state === "uploading" || undefined}
            >
              {each.preview ? (
                <img src={each.preview} alt={each.name} title={each.error ?? each.name} />
              ) : (
                <span className="chat-attachment-name">{each.name}</span>
              )}
              {each.state !== "ready" && (
                // A failure is announced once, by the line under the row.
                <span
                  className="chat-attachment-state"
                  {...(each.state === "uploading" ? { role: "status" } : { "aria-hidden": true })}
                >
                  {each.state === "uploading" ? "uploading" : "failed"}
                </span>
              )}
              <button
                type="button"
                className="chat-key chat-attachment-remove"
                aria-label={`Remove ${each.name}`}
                onClick={() => onDetach(each.id)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {attachments.map(
        (each) =>
          each.state === "failed" && (
            <p key={each.id} className="chat-error" role="alert">
              {each.name} didn't upload. {each.error}
            </p>
          ),
      )}
      {imageNote && <p className="chat-reply">{imageNote}</p>}
      {attachments.length > 0 && !carries && (
        <p className="chat-reply">
          <span>The images wait for a message of your own.</span>
        </p>
      )}
      <div className="chat-composer-box">
        <Mark />
        <textarea
          ref={input}
          data-terminal-input
          className="chat-input"
          aria-label={`Message ${label}`}
          placeholder={replying ? `Reply to ${label}'s question…` : `Message ${label}…`}
          rows={1}
          value={draft}
          aria-describedby={[
            ...(box && !passing ? [boxNoteId] : []),
            ...(replying || held || passing ? [note] : command !== undefined ? [shellNote] : []),
            hint,
          ].join(" ")}
          // What the agent's field takes, as the protocol carries it.
          maxLength={replying ? replyMax : undefined}
          spellCheck
          onPaste={pasted}
          onChange={(event) => {
            onDraft(event.target.value)
            if (error) setError(null)
          }}
          onKeyDown={(event) => {
            if (passing && !event.nativeEvent.isComposing) {
              // A modified key stays the app's, and the field's; Shift+Enter has no line to start.
              if (event.key === "Enter" && event.shiftKey) event.preventDefault()
              if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return
              const keys = menuKeys[event.key]
              // Tab stays in the box with no menu to take it, as what is typed still goes.
              if ((keys !== undefined && onPress(keys)) || event.key === "Tab")
                event.preventDefault()
              return
            }
            // The agent's field takes one line.
            submitOnEnter(send, replying)(event)
          }}
        />
        <div className="chat-composer-actions">
          {mode === "shell" && <span aria-hidden>shell</span>}
          {working && (
            <button
              type="button"
              className="chat-key"
              aria-label="Stop"
              aria-disabled={stopping || undefined}
              onClick={stop}
            >
              stop
            </button>
          )}
          {!empty && (
            <Tooltip content="Send · Enter">
              <button
                type="submit"
                className="chat-key"
                aria-label="Send"
                disabled={sending || refused || (imaged && uploading)}
                aria-busy={sending || undefined}
              >
                ⏎
              </button>
            </Tooltip>
          )}
        </div>
      </div>
    </form>
  )
}
