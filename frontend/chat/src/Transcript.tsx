import { sameBlock, type ChatBlock } from "@novadeck/core/conversation/turns"
import type { MessageParty } from "@novadeck/core/messages"
import { counted } from "@novadeck/core/units"
import { Markdown } from "@novadeck/toolkit/Markdown"
import { memo, useId, useMemo, useState } from "react"

import { withBubbles, type SentBubble } from "./bubbles"
import { Mark } from "./Mark"
import { shownControls } from "./shown-controls"
import { ToolCalls } from "./ToolCalls"

const Shortened = (): React.JSX.Element => (
  <p className="chat-shortened">Shortened here; the rest isn't carried over.</p>
)

// The line a turn the doorbell started stands as: `doorbell` alone where what it brought isn't
// known, which is no saying that it brought nothing.
const ringLabel = ({ messages, replies }: Extract<ChatBlock, { kind: "doorbell" }>): string => {
  if (messages) return `doorbell · ${counted(messages.length, "message")}`
  return replies ? "doorbell · your reply" : "doorbell"
}

// Who a message the doorbell brought is from: another agent by its handle, or the person's own
// answer through the Inbox.
const partyName = (party: MessageParty): string =>
  party.kind === "agent" ? `@${party.handle}` : "you"

// A line of the record that is no one's words: a compaction, a part the chat can't read. It reads
// as a tool line does, dim, and opens to what it holds, where it holds anything.
const RecordLine = ({
  kind,
  words,
  said,
  body,
  truncated,
}: {
  readonly kind: "compaction" | "gap"
  readonly words: string
  readonly said: string | null
  readonly body: string
  readonly truncated: boolean
}): React.JSX.Element => {
  const [open, setOpen] = useState(false)
  const id = useId()
  const opens = body !== ""
  const line = (
    <>
      <span className="chat-tool-title">{words}</span>
      {said && <span className="chat-tool-end"> · {said}</span>}
    </>
  )
  return (
    <div className="chat-tools chat-record" data-kind={kind}>
      <ul className="chat-tools-list">
        <li className="chat-tool">
          {opens ? (
            <button
              type="button"
              className="chat-tool-summary nodrag nopan"
              aria-expanded={open}
              aria-controls={open ? id : undefined}
              onClick={() => setOpen((value) => !value)}
            >
              {line}
            </button>
          ) : (
            <p className="chat-tool-summary">{line}</p>
          )}
          {open && (
            <div id={id} className="chat-tool-body">
              <section
                className="chat-tool-part"
                aria-label={kind === "gap" ? "As written" : "Summary"}
              >
                <pre tabIndex={0} className="nodrag nopan nowheel">
                  {shownControls(body)}
                </pre>
                {truncated && (
                  <p className="chat-tool-note">Shortened here; the rest isn't carried over.</p>
                )}
              </section>
            </div>
          )}
        </li>
      </ul>
    </div>
  )
}

const BlockView = memo(
  ({
    block,
    agent,
    live,
  }: {
    readonly block: ChatBlock
    // The agent's name, for what it said.
    readonly agent: string
    // The latest block of a conversation whose agent works.
    readonly live: boolean
  }): React.JSX.Element => {
    switch (block.kind) {
      case "user":
        return (
          <article className="chat-message" data-role="user" aria-label="You">
            <Mark />
            <p className="chat-text">{block.text}</p>
            {block.truncated && <Shortened />}
          </article>
        )
      case "assistant":
        return (
          <article className="chat-message" data-role="assistant" aria-label={agent}>
            <Markdown text={block.text} />
            {block.truncated && <Shortened />}
          </article>
        )
      case "agent":
        return (
          <article
            className="chat-message"
            data-role="agent"
            aria-label={`Message from ${block.author}`}
          >
            <p className="chat-author">{block.author}</p>
            <Markdown text={block.text} />
            {block.truncated && <Shortened />}
          </article>
        )
      case "note":
        return <p className="chat-note">{block.text}</p>
      case "doorbell":
        return (
          <article
            className="chat-message chat-ring"
            data-role="doorbell"
            aria-label={`Doorbell: ${ringLabel(block)}`}
          >
            {/* The block hollow: a prompt, and not the person's. */}
            <Mark hollow />
            <p className="chat-note">{ringLabel(block)}</p>
            {block.messages?.map((message) => (
              <div
                key={message.id}
                className="chat-message"
                data-role="agent"
                aria-label={`Message from ${partyName(message.from)}`}
              >
                <p className="chat-author">{partyName(message.from)}</p>
                <Markdown text={message.text} />
              </div>
            ))}
          </article>
        )
      case "compaction":
        return (
          <RecordLine
            kind="compaction"
            words="compacted the conversation"
            said="summary kept"
            body={block.summary}
            truncated={block.truncated}
          />
        )
      case "gap":
        return (
          <RecordLine
            kind="gap"
            words="part of the record the chat can't read"
            said={null}
            body={block.raw}
            truncated={block.truncated}
          />
        )
      case "tools":
        return <ToolCalls entries={block.entries} live={live} />
    }
  },
  // Grouping makes new blocks each time; a block drawn again only when its content changed.
  (before, after) =>
    before.agent === after.agent &&
    before.live === after.live &&
    sameBlock(before.block, after.block),
)

// What became of a prompt the record never got, under its words.
const sentNote = (state: "unrecorded" | "in-box", agent: string): string =>
  state === "unrecorded"
    ? "Sent, but not in the agent's record."
    : `It's back in ${agent}'s box in the terminal.`

// What the person does about such a prompt: send it again or take it back to edit, or look in the
// terminal first, where it may have gone after all.
export type SentActions = {
  // Absent while the box holds words, which sending would take with it, or isn't a plain message.
  readonly onResend?: ((bubble: SentBubble) => void) | undefined
  readonly onEdit?: ((bubble: SentBubble) => void) | undefined
  readonly onShowTerminal?: (() => void) | undefined
}

const SentView = memo(
  ({
    bubble,
    agent,
    actions: { onResend, onEdit, onShowTerminal },
  }: {
    readonly bubble: SentBubble
    readonly agent: string
    readonly actions: SentActions
  }): React.JSX.Element => {
    const { state } = bubble
    return (
      <article className="chat-message" data-role="user" data-sent={state} aria-label="You">
        <Mark />
        <p className="chat-text">
          {bubble.text}
          {(state === "queued" || state === "sending") && (
            <>
              {" "}
              <span className="chat-sent-tag">{state}</span>
            </>
          )}
        </p>
        {(state === "unrecorded" || state === "in-box") && (
          <p className="chat-sent" role="status">
            <span>{sentNote(state, agent)}</span>
            {state === "unrecorded" && onResend && (
              <button
                type="button"
                className="chat-key nodrag nopan"
                onClick={() => onResend(bubble)}
              >
                send again
              </button>
            )}
            {state === "unrecorded" && onEdit && (
              <button
                type="button"
                className="chat-key nodrag nopan"
                onClick={() => onEdit(bubble)}
              >
                edit
              </button>
            )}
            {onShowTerminal && (
              <button
                type="button"
                className="chat-key nodrag nopan"
                aria-label="Show terminal"
                onClick={onShowTerminal}
              >
                terminal
              </button>
            )}
          </p>
        )}
      </article>
    )
  },
)

const noBubbles: readonly SentBubble[] = []

// The blocks of a conversation, in order, with the person's prompts not in the record yet
// among them (see `withBubbles`).
export const Transcript = ({
  blocks,
  agent,
  working,
  sent = noBubbles,
  onResend,
  onEdit,
  onShowTerminal,
}: SentActions & {
  readonly blocks: readonly ChatBlock[]
  readonly agent: string
  readonly working: boolean
  readonly sent?: readonly SentBubble[]
}): React.JSX.Element => {
  const last = blocks.at(-1)
  const actions = useMemo(
    () => ({ onResend, onEdit, onShowTerminal }),
    [onResend, onEdit, onShowTerminal],
  )
  return (
    <>
      {withBubbles(blocks, sent).map((each) =>
        each.kind === "block" ? (
          <BlockView
            key={each.block.id}
            block={each.block}
            agent={agent}
            live={working && each.block === last}
          />
        ) : (
          <SentView
            key={`sent:${each.bubble.ref}`}
            bubble={each.bubble}
            agent={agent}
            actions={actions}
          />
        ),
      )}
    </>
  )
}
