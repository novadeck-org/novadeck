import { memo } from "react"

import { sameBlock, type ChatBlock } from "../../model/conversation-turns"
import { Markdown } from "./Markdown"
import { ToolRun } from "./ToolRun"

const Shortened = (): React.JSX.Element => (
  <p className="chat-shortened">Shortened here; the rest isn't carried over.</p>
)

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
      case "tools":
        return <ToolRun entries={block.entries} live={live} />
    }
  },
  // Grouping makes new blocks each time; a block drawn again only when its content changed.
  (before, after) =>
    before.agent === after.agent &&
    before.live === after.live &&
    sameBlock(before.block, after.block),
)

// The blocks of a conversation, in order.
export const Transcript = ({
  blocks,
  agent,
  working,
}: {
  readonly blocks: readonly ChatBlock[]
  readonly agent: string
  readonly working: boolean
}): React.JSX.Element => (
  <>
    {blocks.map((block, index) => (
      <BlockView
        key={block.id}
        block={block}
        agent={agent}
        live={working && index === blocks.length - 1}
      />
    ))}
  </>
)
