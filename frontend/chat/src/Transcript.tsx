import { sameBlock, type ChatBlock } from "@novadeck/core/conversation/turns"
import { counted } from "@novadeck/core/units"
import { Markdown } from "@novadeck/toolkit/Markdown"
import { memo } from "react"

import { withBubbles, type SentBubble } from "./bubbles"
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
            <div className="chat-bubble">
              <p className="chat-text">{block.text}</p>
              {block.truncated && <Shortened />}
            </div>
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
            <div className="chat-bubble">
              <p className="chat-author">From {block.author}</p>
              <Markdown text={block.text} />
              {block.truncated && <Shortened />}
            </div>
          </article>
        )
      case "note":
        return <p className="chat-note">{block.text}</p>
      case "doorbell":
        return <p className="chat-note">{ringLabel(block)}</p>
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

// How a prompt shown before the record has it reads, under its words.
const sentNote = (bubble: SentBubble, agent: string): string => {
  switch (bubble.state) {
    case "queued":
      return "Queued"
    case "sending":
      return "Sending…"
    case "unrecorded":
      return "Sent, but not in the agent's record."
    case "in-box":
      return `It's back in ${agent}'s box in the terminal.`
  }
}

const SentView = memo(
  ({
    bubble,
    agent,
    onShowTerminal,
  }: {
    readonly bubble: SentBubble
    readonly agent: string
    readonly onShowTerminal: (() => void) | undefined
  }): React.JSX.Element => {
    const settled = bubble.state === "unrecorded" || bubble.state === "in-box"
    return (
      <article className="chat-message" data-role="user" data-sent={bubble.state} aria-label="You">
        <div className="chat-bubble">
          <p className="chat-text">{bubble.text}</p>
        </div>
        <p className="chat-sent" role={settled ? "status" : undefined}>
          <span>{sentNote(bubble, agent)}</span>
          {settled && onShowTerminal && (
            <button type="button" className="button quiet nodrag nopan" onClick={onShowTerminal}>
              Show terminal
            </button>
          )}
        </p>
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
  onShowTerminal,
}: {
  readonly blocks: readonly ChatBlock[]
  readonly agent: string
  readonly working: boolean
  readonly sent?: readonly SentBubble[]
  // Shows the agent's terminal, from a prompt the record doesn't have.
  readonly onShowTerminal?: () => void
}): React.JSX.Element => {
  const last = blocks.at(-1)
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
            onShowTerminal={onShowTerminal}
          />
        ),
      )}
    </>
  )
}
