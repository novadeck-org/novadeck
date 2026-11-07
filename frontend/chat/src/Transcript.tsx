import { sameBlock, type ChatBlock } from "@novadeck/core/conversation/turns"
import { counted } from "@novadeck/core/units"
import { Markdown } from "@novadeck/toolkit/Markdown"
import { memo, useMemo } from "react"

import { withBubbles, type SentBubble } from "./bubbles"
import { Mark } from "./Mark"
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
        return <p className="chat-note">{ringLabel(block)}</p>
      case "gap":
        return block.raw ? (
          <details className="chat-note">
            <summary>part of the record the chat can't read</summary>
            <pre className="chat-box-text">{block.raw}</pre>
            {block.truncated && <Shortened />}
          </details>
        ) : (
          <p className="chat-note">part of the record the chat can't read</p>
        )
      case "compaction":
        return (
          <details className="chat-note">
            <summary>compacted the conversation</summary>
            <p className="chat-text">{block.summary}</p>
            {block.truncated && <Shortened />}
          </details>
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
