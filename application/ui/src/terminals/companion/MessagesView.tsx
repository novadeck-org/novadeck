import { ArrowDownLeft, ArrowUpRight } from "lucide-react"
import { useEffect, useId, useRef, type ReactNode } from "react"

import type { AgentMessage, MessageThread } from "../../model/messages"
import { Switch } from "../../ui-toolkit/Switch"
import { Tooltip } from "../../ui-toolkit/Tooltip"
import type { MailHandle } from "./mail"

// When a message was sent or delivered: the time, with the date when it wasn't today.
const clock = (at: number): string => {
  const when = new Date(at)
  return when.toDateString() === new Date().toDateString()
    ? when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : when.toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
}

// Where a message is on its way, in a word or two.
const stateText = (message: AgentMessage): string => {
  switch (message.state) {
    case "queued":
      return "Waiting"
    case "leased":
      return "Delivering"
    case "delivered":
      return message.deliveredAt === null ? "Delivered" : `Delivered ${clock(message.deliveredAt)}`
    case "held":
      return message.held === "release" ? "Held for release" : "Held while paused"
    case "gone":
      return "Not delivered"
  }
}

const stateHint: Partial<Record<AgentMessage["state"], string>> = {
  leased: "Handed to the agent's hook, which hasn't confirmed it yet",
  gone: "Its recipient's session ended before it arrived",
}

const MessageItem = ({
  message,
  handle,
}: {
  message: AgentMessage
  handle: string
}): React.JSX.Element => {
  const sent = message.from === handle
  const Direction = sent ? ArrowUpRight : ArrowDownLeft
  return (
    <li className="mail-message" data-direction={sent ? "sent" : "received"}>
      {/* The thread names the peer, so the arrow says which way it went; the words stay
          for screen readers. Delivered is the quiet default: only a message still on its
          way, held or lost shows its state. */}
      <div className="mail-message-meta">
        <span className="mail-message-direction">
          <Direction size={12} strokeWidth={1.75} aria-hidden />
          <span className="sr-only">{sent ? `Sent to ${message.to}` : `From ${message.from}`}</span>
        </span>
        <time dateTime={new Date(message.sentAt).toISOString()}>{clock(message.sentAt)}</time>
        <Tooltip content={stateHint[message.state]}>
          <span
            className={`mail-state${message.state === "delivered" ? " sr-only" : ""}`}
            data-state={message.state}
          >
            {stateText(message)}
          </span>
        </Tooltip>
      </div>
      {/* The agent's words, exactly as it wrote them: never formatted or interpreted. */}
      <p className="mail-text">{message.text}</p>
    </li>
  )
}

const ThreadItem = ({
  thread,
  handle,
  peerName,
  releasing,
  failure,
  onRelease,
}: {
  thread: MessageThread
  handle: string
  // Undefined for a terminal no longer in the session: its handle stands alone.
  peerName: string | undefined
  releasing: boolean
  // Why its last release didn't take.
  failure: string | undefined
  onRelease: () => void
}): React.JSX.Element => {
  const peer = peerName ?? thread.peer
  const label = peerName === undefined ? thread.peer : `${peerName} (${thread.peer})`
  const count = thread.messages.length
  const heading = useRef<HTMLHeadingElement>(null)
  const held = useRef(thread.held)
  // Released, its button goes: focus that was on it moves to the thread.
  useEffect(() => {
    const lost = !document.activeElement || document.activeElement === document.body
    if (held.current && !thread.held && lost) heading.current?.focus({ preventScroll: true })
    held.current = thread.held
  }, [thread.held])
  return (
    <section className="mail-thread" aria-label={`Thread with ${label}`}>
      <header className="mail-thread-head">
        <h3 ref={heading} tabIndex={-1} className="mail-thread-peer">
          {peer}
        </h3>
        {peerName !== undefined && <code>{thread.peer}</code>}
        <span className="mail-thread-count">
          {count} message{count === 1 ? "" : "s"}
        </span>
        {thread.held && (
          <button
            type="button"
            className="button mail-release"
            aria-label={`Release the thread with ${peer}`}
            // Kept focusable while it's on its way, so focus stays until the thread follows.
            aria-disabled={releasing}
            onClick={() => {
              if (!releasing) onRelease()
            }}
          >
            {releasing ? "Releasing…" : "Release"}
          </button>
        )}
      </header>
      {failure && (
        <p className="mail-thread-error" role="alert">
          {failure}
        </p>
      )}
      {thread.held && (
        <p className="mail-thread-note">
          Held after {thread.allowed} messages back and forth. Release it to let them go on.
        </p>
      )}
      <ol className="mail-list">
        {thread.messages.map((message) => (
          <MessageItem key={message.id} message={message} handle={handle} />
        ))}
      </ol>
    </section>
  )
}

// A terminal's messages with the other agents in its session: a thread per peer, latest
// first, each message with its direction, time, text and where it is on its way. The
// header holds the pause, which holds every agent's messages.
export const MessagesView = ({
  mail,
  peerName,
  actions,
}: {
  mail: MailHandle
  peerName: (handle: string) => string | undefined
  // What the pane does, at the end of the header.
  actions?: ReactNode
}): React.JSX.Element => {
  const label = useId()
  const hint = useId()
  const threads = mail.mail?.threads ?? []
  return (
    <div className="mail-view">
      <div className="artifact-meta mail-meta">
        <code>Messages</code>
        {mail.mail && <span>{mail.mail.handle}</span>}
        <span className="artifact-meta-push" />
        <span className="mail-pause">
          <span id={label} className="mail-pause-label">
            Pause all agents' messages
          </span>
          <span id={hint} className="sr-only">
            In every project and session, until you resume.
          </span>
          <Switch
            checked={mail.paused}
            onChange={mail.pause}
            labelledBy={label}
            describedBy={hint}
            pending={mail.pending}
          />
        </span>
        {actions}
      </div>
      {mail.error && (
        <p className="mail-error" data-tone="danger" role="alert">
          {mail.error}
        </p>
      )}
      {mail.paused && (
        <p className="mail-paused" data-tone="warning" role="status">
          Messaging is paused. Agents' messages wait, held, until you resume.
        </p>
      )}
      <div className="mail-scroll">
        {threads.length ? (
          threads.map((thread) => (
            <ThreadItem
              key={thread.id}
              thread={thread}
              handle={mail.mail!.handle}
              peerName={peerName(thread.peer)}
              releasing={mail.releasing.includes(thread.id)}
              failure={mail.failed[thread.id]}
              onRelease={() => mail.release(thread.id)}
            />
          ))
        ) : (
          <div className="artifact-status mail-empty">
            No messages yet. Threads with the other agents in this session show here.
          </div>
        )}
      </div>
    </div>
  )
}
