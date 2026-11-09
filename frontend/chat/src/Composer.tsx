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
import { CornerDownLeft } from "lucide-react"
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react"

import type { Attachment } from "./attachments"
import { replyImagesNote, shellImagesNote } from "./commands"
import type { ComposerMode } from "./composer-mode"
import { Hint } from "./Hint"
import { recall, walksAt, type Walk } from "./history"
import { Mark } from "./Mark"
import { cleaned, splitDraft, unitEdit } from "./placeholders"
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
export type Failure = { readonly text: string; readonly terminal: boolean }

export const failed = (failure: unknown): Failure => ({
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
  imagesAlone,
  onAttach,
  onDetach,
  mode,
  sending,
  replySending,
  working,
  onSend,
  stopError,
  onClearBox,
  focusInput,
  onInputFocused,
  onCancelReply,
  onOpenTerminal,
  refused: refuses,
  box,
  passing,
  onPress,
  history,
}: {
  // The agent it writes to, for the box's name.
  readonly label: string
  readonly draft: string
  readonly onDraft: (draft: string) => void
  // The images pasted in, to go with the next message, each with its placeholder in the draft,
  // and how a paste of more adds them (it types their placeholders over the selection, answers
  // where the caret goes after them and why some weren't added, or null; absent where the backend
  // takes no images) and one goes, its placeholder with it.
  readonly attachments: readonly Attachment[]
  // What the person is told of the images, as that some went for want of room.
  readonly imageNote?: string | undefined
  // Whether the agent takes a message of images and no words; Antigravity refuses one, and an
  // agent not known yet is not trusted to take it.
  readonly imagesAlone: boolean
  readonly onAttach?:
    | ((
        files: readonly File[],
        selection: { readonly start: number; readonly end: number },
      ) => { readonly refusal: string | null; readonly caret: number | null })
    | undefined
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
  // Why a Stop, which the working line makes, didn't go.
  readonly stopError: Failure | null
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
  // The prompts the person gave this agent, oldest first, which Up and Down walk through.
  readonly history: readonly string[]
}): React.JSX.Element => {
  const input = useRef<HTMLTextAreaElement>(null)
  // Where Up and Down are in the history, and whether the caret is due at the end of the words
  // they put in the box once it shows them.
  const walk = useRef<Walk | null>(null)
  const caretAtEnd = useRef(false)
  // Where the caret is due once the draft shows the placeholders a paste typed in.
  const caretAt = useRef<number | null>(null)
  const [clearing, setClearing] = useState(false)
  const [error, setError] = useState<Failure | null>(null)
  const mounted = useMounted()
  const shownError = error ?? stopError
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
    if (caretAtEnd.current) {
      caretAtEnd.current = false
      field.setSelectionRange(draft.length, draft.length)
    }
    if (caretAt.current !== null) {
      field.setSelectionRange(caretAt.current, caretAt.current)
      caretAt.current = null
    }
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Sized to the text it holds.
  }, [draft])
  // Sending answers the agent's question with the words, until the person cancels.
  const replying = mode === "reply" || mode === "waiting"
  // The question a reply was written for went: the words wait for an edit before they go.
  const held = mode === "held"
  // The agent's field takes what a prompt can't start with; only control characters stop it.
  const long = replying && oneLine(draft).trim().length > replyMax
  // Whether the images pasted go with what is sent now: only a plain message takes them.
  const carries = mode === "message" && !passing
  // Whether the words are only the images' placeholders.
  const bare =
    carries && attachments.length > 0 && splitDraft(draft, attachments).text === "" && !imagesAlone
  // Images the box holds that this mode can't send.
  const stuck = attachments.length > 0 && !carries && !passing && (replying || mode === "shell")
  // What goes to the agent is judged without the placeholders, as the runner judges it.
  const sentWords = carries && attachments.length > 0 ? splitDraft(draft, attachments).text : draft
  const refused =
    held ||
    bare ||
    stuck ||
    (replying ? hasControlCharacters(draft) || long : refuses(sentWords, { shell: true }))
  const command = mode === "shell" ? shellCommand(draft) : undefined
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
    walk.current = null
    onSend(text).catch((failure: unknown) => {
      if (mounted.current) setError(failed(failure))
    })
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
    const field = input.current
    const blocked = pasteRefusal()
    const result =
      blocked === null && onAttach
        ? onAttach(files, {
            start: field?.selectionStart ?? draft.length,
            end: field?.selectionEnd ?? draft.length,
          })
        : { refusal: blocked ?? "This backend can't take images.", caret: null }
    if (result.caret !== null) caretAt.current = result.caret
    setError(result.refusal ? { text: result.refusal, terminal: false } : null)
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
      {shownError && (
        <p className="chat-error" role="alert" data-terminal={shownError.terminal || undefined}>
          <span>{shownError.text}</span>
          {shownError.terminal && (
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
            ? stuck
              ? replying
                ? replyImagesNote
                : shellImagesNote
              : bare
                ? `${label} needs a few words with the images.`
                : replying
                  ? long
                    ? "A reply takes at most 16,384 characters."
                    : controlHint
                  : messageHint(sentWords)
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
              <span className="chat-attachment-n" aria-hidden>
                #{each.n}
              </span>
              <button
                type="button"
                className="chat-key chat-attachment-remove"
                aria-label={`Remove ${each.name}`}
                title={`Remove #${each.n}`}
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
      {attachments.length > 0 && !carries && !stuck && (
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
            // An edit that would leave part of a placeholder takes the whole of it.
            const fixed = cleaned(draft, event.target.value, attachments, event.target.selectionEnd)
            if (fixed) caretAt.current = fixed.caret
            onDraft(fixed ? fixed.text : event.target.value)
            if (error) setError(null)
          }}
          onKeyDown={(event) => {
            // Backspace after a placeholder, or Delete before one, takes it whole.
            if (
              (event.key === "Backspace" || event.key === "Delete") &&
              !passing &&
              !event.nativeEvent.isComposing &&
              !(event.shiftKey || event.ctrlKey || event.metaKey || event.altKey)
            ) {
              const field = event.currentTarget
              const unit = unitEdit(
                draft,
                field.selectionStart,
                field.selectionEnd,
                event.key,
                attachments,
              )
              if (unit) {
                event.preventDefault()
                caretAt.current = unit.caret
                onDraft(unit.text)
                if (error) setError(null)
                return
              }
            }
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
            // Up and Down walk the person's earlier prompts, from the start of the box and then
            // wherever the caret is; the agent's question has its own field, and a held reply
            // its own words.
            if (
              (event.key === "ArrowUp" || event.key === "ArrowDown") &&
              !replying &&
              !held &&
              // A walk would take the placeholders, and so the images, out of the box.
              attachments.length === 0 &&
              !event.nativeEvent.isComposing &&
              !(event.shiftKey || event.ctrlKey || event.metaKey || event.altKey)
            ) {
              const field = event.currentTarget
              if (
                walksAt(walk.current, event.key, draft, field.selectionStart, field.selectionEnd)
              ) {
                const step = recall(history, walk.current, draft, event.key)
                if (step) {
                  event.preventDefault()
                  walk.current = step.walk
                  caretAtEnd.current = step.draft !== draft
                  onDraft(step.draft)
                  if (error) setError(null)
                }
              }
              return
            }
            // The agent's field takes one line.
            submitOnEnter(send, replying)(event)
          }}
        />
        <div className="chat-composer-actions">
          {mode === "shell" && <span aria-hidden>shell</span>}
          {!empty && (
            <Tooltip content={working ? "Queue · Enter" : "Send · Enter"}>
              <button
                type="submit"
                className="icon-button small chat-send"
                aria-label="Send"
                disabled={sending || refused || (imaged && uploading)}
                aria-busy={sending || undefined}
              >
                <CornerDownLeft size={14} />
              </button>
            </Tooltip>
          )}
        </div>
      </div>
    </form>
  )
}
