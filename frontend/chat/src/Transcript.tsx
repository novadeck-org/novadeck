import { sameBlock, type ChatBlock } from "@novadeck/core/conversation/turns"
import type { MessageParty } from "@novadeck/core/messages"
import { counted } from "@novadeck/core/units"
import { Markdown } from "@novadeck/toolkit/Markdown"
import { memo, useId, useLayoutEffect, useMemo, useRef, useState } from "react"

import { withBubbles, type SentBubble } from "./bubbles"
import { Mark } from "./Mark"
import { shownControls } from "./shown-controls"
import { ToolCalls } from "./ToolCalls"

const Shortened = (): React.JSX.Element => (
  <p className="chat-shortened">Shortened here; the rest isn't carried over.</p>
)

// What a turn the doorbell started brought: other agents' messages, and the person's own answers
// through the Inbox, which are theirs and read as such.
type Ring = Extract<ChatBlock, { kind: "doorbell" }>
const fromAgents = ({ messages }: Ring) =>
  messages?.filter(({ from }) => from.kind === "agent") ?? []
const fromPerson = ({ messages }: Ring) =>
  messages?.filter(({ from }) => from.kind === "person") ?? []

// What the doorbell's line says it brought, after `doorbell`: nothing where that isn't known,
// which is no saying that it brought nothing.
const ringBrought = (ring: Ring): string =>
  [
    ...(fromAgents(ring).length > 0 ? [counted(fromAgents(ring).length, "message")] : []),
    ...(ring.replies || fromPerson(ring).length > 0 ? ["your reply"] : []),
  ].join(", ")

// Another agent's handle.
const handleOf = (party: MessageParty): string => (party.kind === "agent" ? `@${party.handle}` : "")

// How another Novadeck agent looks where the app knows it: its face for the gutter (the app's
// own avatar), the terminal it runs in, and its hue (1 to 8) for its handle. The chat draws
// no face of its own, so where the app says nothing the message has none.
export type PeerLook = {
  readonly face: React.ReactNode
  // "program · terminal name", where known.
  readonly where: string | null
  readonly hue: number
}
export type PeerLooks = (handle: string) => PeerLook | null

// Whether focus came by the keys rather than a click, as the browser shows its ring only then.
const keyFocus = (target: EventTarget): boolean => {
  if (!(target instanceof Element)) return false
  try {
    return target.matches(":focus-visible")
  } catch {
    return true
  }
}

// A message shows its first lines when it runs past this many, and the key opens the rest.
const foldedAt = 5
const shownLines = foldedAt - 1

// Another agent's message: its face in the gutter, its handle and where it runs, its words. A
// long one is cut to its first lines, with a key that says how many more.
const PeerMessage = ({
  from,
  text,
  truncated,
  looks,
}: {
  // As the harness names it: "@handle" for a Novadeck agent.
  readonly from: string
  readonly text: string
  readonly truncated: boolean
  readonly looks: PeerLooks | undefined
}): React.JSX.Element => {
  const look = from.startsWith("@") ? (looks?.(from.slice(1)) ?? null) : null
  const words = useRef<HTMLDivElement>(null)
  const [lines, setLines] = useState(0)
  const [open, setOpen] = useState(false)
  const id = useId()
  // The lines the words take at the column's width, whether cut short or not.
  useLayoutEffect(() => {
    const element = words.current
    if (!element) return
    const measure = (): void => {
      const height = parseFloat(getComputedStyle(element).lineHeight)
      setLines(height > 0 ? Math.round(element.scrollHeight / height) : 0)
    }
    measure()
    if (typeof ResizeObserver === "undefined") return
    const watch = new ResizeObserver(measure)
    // The Markdown inside, which the cut doesn't clamp: it changes with the words and the width.
    if (element.firstElementChild) watch.observe(element.firstElementChild)
    return () => watch.disconnect()
  }, [])
  const folds = lines > foldedAt
  return (
    <article
      className="chat-message"
      data-role="agent"
      data-hue={look?.hue}
      aria-label={`Message from ${from}`}
    >
      {look && <span className="chat-agent-face">{look.face}</span>}
      <p className="chat-agent-head">
        <span className="chat-author">{from}</span>
        {look?.where && <span className="chat-agent-where">{look.where}</span>}
      </p>
      <div
        ref={words}
        id={id}
        className="chat-words"
        data-folded={(folds && !open) || undefined}
        // The keys taking a link or a field into the cut-off lines would put focus out of sight:
        // the rest opens to them. A click (on a link, a code block, its copy key) leaves it shut.
        onFocus={folds && !open ? (event) => keyFocus(event.target) && setOpen(true) : undefined}
        style={
          folds && !open
            ? ({ "--_shown": `calc(${shownLines} * var(--_lh))` } as React.CSSProperties)
            : undefined
        }
      >
        <Markdown text={text} />
      </div>
      {truncated && <Shortened />}
      {folds && (
        <button
          type="button"
          className="chat-key chat-more nodrag nopan"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? "show less" : `… ${lines - shownLines} more lines`}
        </button>
      )}
    </article>
  )
}

// A subagent's report: one dim line, the name and what it said cut to the line, which opens to
// the whole of it as a tool line does. Its words are Markdown, but the line is plain, as a
// line of a command is.
type Subagent = Extract<ChatBlock, { kind: "subagent" }>
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim()
// What core names the parent `/root` in a Codex subagent's own rollout.
const parentAgent = "parent agent"

const SubagentLine = ({
  block,
  gone,
}: {
  readonly block: Subagent
  // The agent's session has ended: what still ran stopped with it, saying nothing more.
  readonly gone: boolean
}): React.JSX.Element => {
  const [open, setOpen] = useState(false)
  const body = useId()
  const running = block.running && !gone
  const stopped = block.running && gone
  const said =
    block.text !== null ? oneLine(block.text) : stopped ? "stopped with its session" : "running…"
  const subagent = block.name !== parentAgent
  // Named by who and how it stands, not by the whole report its line holds.
  const label = [
    shownControls(block.name),
    ...(subagent ? ["subagent"] : []),
    ...(running ? ["running"] : []),
    ...(stopped ? ["stopped"] : []),
    ...(block.failed ? ["failed"] : []),
  ].join(", ")
  return (
    <div
      className="chat-subagent"
      data-running={running || undefined}
      data-stopped={stopped || undefined}
      data-failed={block.failed || undefined}
      aria-label={`Subagent ${block.name}`}
      role="group"
    >
      <button
        type="button"
        className="chat-subagent-summary nodrag nopan"
        aria-expanded={open}
        aria-controls={open ? body : undefined}
        aria-label={label}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="chat-subagent-name">{shownControls(block.name)}</span>
        {/* Inside a subagent's own record, its parent's words: not a subagent's. */}
        {subagent && <span className="chat-subagent-tag">· subagent</span>}
        {/* In words as well as red, and still there open. */}
        {block.failed && <span className="chat-subagent-failed">· failed</span>}
        {said && (
          <span className="chat-subagent-said" aria-hidden="true">
            {shownControls(said)}
          </span>
        )}
      </button>
      {open && (
        <div id={body} className="chat-tool-body">
          {block.text === null ? (
            <p className="chat-tool-note">
              {stopped ? "It stopped with its session, before it reported." : "Running…"}
            </p>
          ) : (
            <Markdown text={block.text} />
          )}
          {block.truncated && <Shortened />}
        </div>
      )}
    </div>
  )
}

// A line of the record that is no one's words: a compaction, a part the chat can't read. It reads
// as a tool line does, dim, and opens to what it holds, where it holds anything.
const RecordLine = ({
  kind,
  words,
  what,
  said,
  body,
  truncated,
}: {
  readonly kind: "compaction" | "gap"
  readonly words: string
  readonly what?: string
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
      {what && (
        <>
          {" "}
          <span className="chat-tool-detail">{what}</span>
        </>
      )}
      {said && opens && <span className="chat-tool-end"> · {said}</span>}
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

// Whether a block draws other agents, and so their looks.
const drawsPeers = (block: ChatBlock): boolean =>
  block.kind === "agent" || (block.kind === "doorbell" && fromAgents(block).length > 0)

const BlockView = memo(
  ({
    block,
    agent,
    live,
    looks,
    gone,
  }: {
    readonly block: ChatBlock
    // The agent's name, for what it said.
    readonly agent: string
    // The latest block of a conversation whose agent works.
    readonly live: boolean
    readonly looks: PeerLooks | undefined
    // The agent's session has ended.
    readonly gone: boolean
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
          <PeerMessage
            from={block.author}
            text={block.text}
            truncated={block.truncated}
            looks={looks}
          />
        )
      case "note":
        return <p className="chat-note">{block.text}</p>
      case "doorbell": {
        const brought = ringBrought(block)
        return (
          <article
            className="chat-message chat-ring"
            data-role="doorbell"
            aria-label={brought ? `Doorbell, ${brought}` : "Doorbell"}
          >
            {/* The block hollow: a prompt, and not the person's. */}
            <Mark hollow />
            <p className="chat-note">{brought ? `doorbell · ${brought}` : "doorbell"}</p>
            {fromAgents(block).map((message) => (
              <PeerMessage
                key={message.id}
                from={handleOf(message.from)}
                text={message.text}
                truncated={false}
                looks={looks}
              />
            ))}
            {fromPerson(block).map((message) => (
              <article
                key={message.id}
                className="chat-message chat-ring-reply"
                data-role="user"
                aria-label="You, from the Inbox"
              >
                <Mark />
                <p className="chat-text">
                  {message.text} <span className="chat-sent-tag">from the Inbox</span>
                </p>
              </article>
            ))}
          </article>
        )
      }
      case "compaction":
        return (
          <RecordLine
            kind="compaction"
            words="compacted"
            what="the conversation"
            // Codex keeps its summary sealed: there is none to open, so none is said to be kept.
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
      case "subagent":
        return <SubagentLine block={block} gone={gone} />
      case "tools":
        return <ToolCalls entries={block.entries} live={live} />
    }
  },
  // Grouping makes new blocks each time; a block drawn again only when its content changed. The
  // looks change as any agent starts or stops work, so only blocks that draw them heed that.
  (before, after) =>
    before.agent === after.agent &&
    before.live === after.live &&
    (before.gone === after.gone || after.block.kind !== "subagent") &&
    (before.looks === after.looks || !drawsPeers(after.block)) &&
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
        {bubble.images.length > 0 && (
          <ul className="chat-images" aria-label="Images sent">
            {bubble.images.map((image) => (
              <li key={image.id}>
                {image.preview ? (
                  <img src={image.preview} alt={image.name} />
                ) : (
                  <span>{image.name}</span>
                )}
              </li>
            ))}
          </ul>
        )}
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
  gone = false,
  sent = noBubbles,
  looks,
  onResend,
  onEdit,
  onShowTerminal,
}: SentActions & {
  readonly blocks: readonly ChatBlock[]
  readonly agent: string
  readonly working: boolean
  // The agent's session has ended: a subagent still running shows it stopped with it.
  readonly gone?: boolean
  readonly sent?: readonly SentBubble[]
  // How other Novadeck agents look, where the app knows them (see `PeerLooks`).
  readonly looks?: PeerLooks | undefined
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
            looks={looks}
            gone={gone}
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
