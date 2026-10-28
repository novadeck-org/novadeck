import { handleText } from "@novadeck/core/handle"
import { waitsText, type MessageParty, type MessagePeer } from "@novadeck/core/messages"
import { useShown } from "@novadeck/toolkit/shown"
import { Switch } from "@novadeck/toolkit/Switch"
import { ChevronLeft, ChevronRight, ExternalLink } from "lucide-react"
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react"

import { ArtifactMeta } from "../../../ArtifactViewer"
import { Avatar, type AvatarLive } from "./avatars/Avatar"
import { hueOf } from "./avatars/critters"
import {
  chatOf,
  conversationsOf,
  cornerOf,
  latestOf,
  entryLabel,
  handleOf,
  listed,
  openAsks,
  waitsOnPerson,
  youKey,
  type ChatLine,
  type Conversation,
  type Corner,
  type Note,
} from "./conversations"
import { usePeers, type MessagesHandle, type MessageLinks } from "./messages"

const sameDay = (a: Date, b: Date): boolean => a.toDateString() === b.toDateString()

const timeOf = (at: Date): string =>
  at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })

// When a burst started: the time, with the date when it wasn't today.
const clock = (at: number): string => {
  const when = new Date(at)
  return sameDay(when, new Date())
    ? timeOf(when)
    : `${when.toLocaleDateString([], { month: "short", day: "numeric" })}, ${timeOf(when)}`
}

// When a conversation last had a message, as its row says it: the time today, Yesterday,
// or the day.
const rowTime = (at: number): string => {
  const when = new Date(at)
  const now = new Date()
  if (sameDay(when, now)) return timeOf(when)
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  return sameDay(when, yesterday)
    ? "Yesterday"
    : when.toLocaleDateString([], { month: "short", day: "numeric" })
}

// The exact time, on hover.
const exact = (at: number): string =>
  new Date(at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })

const onVisibility = (listener: () => void): (() => void) => {
  document.addEventListener("visibilitychange", listener)
  return () => document.removeEventListener("visibilitychange", listener)
}

const party = (who: MessageParty): string =>
  who.kind === "person" ? "You" : handleText(who.handle)

const nameOf = (conversation: Conversation, found: MessagePeer | undefined): string =>
  conversation.key === youKey ? "You" : (found?.name ?? handleText(conversation.peer))

const liveOf = (found: MessagePeer | undefined): AvatarLive => found?.live ?? "gone"

const noteText: Readonly<Record<Note, string>> = {
  queued: "Waiting",
  leased: "Delivering",
  gone: "Not delivered",
  delivered: "Delivered",
}

const noteHint: Partial<Record<Note, string>> = {
  leased: "Handed to the agent's hook, which hasn't confirmed it yet",
  gone: "Its recipient's session ended before it arrived",
}

// A row's one thing in its corner: a chip for what asks of the person or failed, else
// Unread or the time, said alike.
const CornerText = ({ corner }: { corner: Corner }): React.JSX.Element => {
  switch (corner.kind) {
    case "asks":
      return (
        <span className="message-chip" data-tone="warning">
          Asks you
        </span>
      )
    case "undelivered":
      return (
        <span className="message-chip" data-tone="danger">
          Not delivered
        </span>
      )
    case "unread":
      return <span className="message-row-time">Unread</span>
    case "time":
      return (
        <time className="message-row-time" dateTime={new Date(corner.at).toISOString()}>
          {rowTime(corner.at)}
        </time>
      )
  }
}

// What a row's corner says, in words for its name.
const cornerWords = (corner: Corner): string =>
  corner.kind === "asks"
    ? "asks you"
    : corner.kind === "undelivered"
      ? "not delivered"
      : corner.kind === "unread"
        ? "unread"
        : `last at ${rowTime(corner.at)}`

const Row = ({
  conversation,
  peer,
  seenAt,
  onOpen,
}: {
  conversation: Conversation
  peer: MessagePeer | undefined
  seenAt: number
  onOpen: () => void
}): React.JSX.Element => {
  const last = conversation.messages.at(-1)
  const corner = cornerOf(conversation, seenAt)
  const name = nameOf(conversation, peer)
  const you = conversation.key === youKey
  const preview = useId()
  return (
    <li>
      <button
        type="button"
        className="message-row"
        data-conversation={conversation.key}
        data-unread={corner.kind === "unread" || waitsOnPerson(conversation) || undefined}
        aria-label={[
          name,
          ...(peer ? [handleText(conversation.peer)] : []),
          cornerWords(corner),
        ].join(", ")}
        aria-describedby={last ? preview : undefined}
        onClick={onOpen}
      >
        <Avatar
          handle={conversation.peer}
          person={you}
          size={30}
          live={you ? "idle" : liveOf(peer)}
          program={you ? undefined : peer?.program}
        />
        <span className="message-row-main">
          <span className="message-row-top">
            <strong className="message-row-name">{name}</strong>
            {peer && <code className="message-row-handle">{handleText(conversation.peer)}</code>}
          </span>
          {last && (
            <span id={preview} className="message-preview">
              <span className="message-preview-who">{party(last.from)}:</span>{" "}
              {last.text.replace(/\s+/g, " ")}
            </span>
          )}
        </span>
        <span className="message-row-end">
          <CornerText corner={corner} />
        </span>
        <ChevronRight className="message-row-go" size={14} strokeWidth={1.75} aria-hidden />
      </button>
    </li>
  )
}

// One message as a bubble on its side: its sender's critter at the start of a run of the
// other side's, an entry's label in plain words, the question a reply answers, Answer on a
// question still open, and its note under it while there's one worth a look.
const Bubble = ({
  line,
  conversation,
  peers,
  links,
}: {
  line: Extract<ChatLine, { kind: "message" }>
  conversation: Conversation
  peers: Readonly<Record<string, MessagePeer>>
  links: MessageLinks
}): React.JSX.Element => {
  const { message, side, grouped, note } = line
  const label = entryLabel(message)
  const asked = conversation.asked.get(message.id)
  const open = message.inbox === "ask" && message.inboxState === "open"
  const sender = party(message.from)
  return (
    <li
      className="message-bubble-row"
      data-side={side}
      data-grouped={grouped || undefined}
      data-hue={message.from.kind === "person" ? "you" : hueOf(message.from.handle)}
      data-state={message.state}
      data-open={open || undefined}
      title={exact(message.sentAt)}
    >
      {side === "in" && (
        <span className="message-bubble-av">
          {!grouped && (
            <Avatar
              handle={handleOf(message.from)}
              person={message.from.kind === "person"}
              size={22}
              live={message.from.kind === "person" ? "idle" : liveOf(peers[message.from.handle])}
            />
          )}
        </span>
      )}
      <div className="message-bubble-col">
        <div className="message-bubble">
          {/* Who sent it is plain from its side; the words stay for screen readers. */}
          <span className="sr-only">{sender}: </span>
          {label && (
            <span
              className="message-entry"
              data-kind={message.inbox}
              data-open={message.inboxState === "open" || undefined}
            >
              {label}
            </span>
          )}
          {asked && <span className="message-quote">{asked.text.replace(/\s+/g, " ")}</span>}
          {/* The agent's words, exactly as it wrote them: never formatted or interpreted. */}
          <p className="message-text">{message.text}</p>
          {open && (
            <div className="message-answer">
              <button
                type="button"
                className="button"
                aria-label={`Answer: ${message.text.split("\n")[0]}`}
                onClick={() => links.answer(message)}
              >
                Answer
              </button>
            </div>
          )}
        </div>
        {note && (
          <div className="message-bubble-meta">
            <span className="message-note" data-note={note} title={noteHint[note]}>
              {note === "gone" && message.inbox === "answer"
                ? "Reply not delivered"
                : noteText[note]}
            </span>
          </div>
        )}
      </div>
    </li>
  )
}

const ChatLineItem = ({
  line,
  conversation,
  peers,
  links,
  onUnfold,
}: {
  line: ChatLine
  conversation: Conversation
  peers: Readonly<Record<string, MessagePeer>>
  links: MessageLinks
  onUnfold: () => void
}): React.JSX.Element => {
  switch (line.kind) {
    case "time":
      return (
        <li className="message-time">
          <time dateTime={new Date(line.at).toISOString()} title={exact(line.at)}>
            {clock(line.at)}
          </time>
        </li>
      )
    case "new":
      return (
        <li className="message-new">
          <span>New</span>
        </li>
      )
    case "fold":
      return (
        <li className="message-fold">
          <button type="button" onClick={onUnfold}>
            <span className="message-fold-count">
              {line.rounds} more round{line.rounds === 1 ? "" : "s"} like this
            </span>
            <span className="message-fold-text">{line.first.text.replace(/\s+/g, " ")}</span>
            <span className="message-fold-show">Show</span>
          </button>
        </li>
      )
    case "message":
      return <Bubble line={line} conversation={conversation} peers={peers} links={links} />
  }
}

// An open conversation: its head, with the way back, who it's with and the way to their
// terminal (or, with the person, what waits for them), and its chat, kept at its end as
// messages come unless the person scrolled up.
const Chat = ({
  conversation,
  self,
  peers,
  links,
  onBack,
}: {
  conversation: Conversation
  self: string
  peers: Readonly<Record<string, MessagePeer>>
  links: MessageLinks
  onBack: () => void
}): React.JSX.Element => {
  const peer = peers[conversation.peer]
  const [unfolded, setUnfolded] = useState(false)
  const lines = useMemo(() => chatOf(conversation, self, unfolded), [conversation, self, unfolded])
  const you = conversation.key === youKey
  const name = nameOf(conversation, peer)
  const asks = openAsks(conversation)
  const scroll = useRef<HTMLDivElement>(null)
  const atEnd = useRef(true)
  const back = useRef<HTMLButtonElement>(null)
  useEffect(() => back.current?.focus({ preventScroll: true }), [])
  // At its end as lines come, unless the person scrolled up.
  useLayoutEffect(() => {
    const element = scroll.current
    if (element && atEnd.current && lines.length) element.scrollTop = element.scrollHeight
  }, [lines])
  const gone =
    !you &&
    liveOf(peer) === "gone" &&
    conversation.messages.some(
      (message) => handleOf(message.from) === self && message.state === "gone",
    )
  return (
    <>
      <div className="message-chat-head">
        <button
          ref={back}
          type="button"
          className="icon-button message-back"
          aria-label="All conversations"
          onClick={onBack}
        >
          <ChevronLeft size={16} strokeWidth={1.75} aria-hidden />
        </button>
        <Avatar
          handle={conversation.peer}
          person={you}
          size={26}
          live={you ? "idle" : liveOf(peer)}
          program={you ? undefined : peer?.program}
        />
        <h3 className="message-chat-name">
          <strong>{name}</strong>
          {!you && peer && <code>{handleText(conversation.peer)}</code>}
        </h3>
        <span className="message-chat-side">
          {you && asks > 0 && (
            <span className="message-asks">
              {asks === 1 ? "1 question waits for you" : `${asks} questions wait for you`}
            </span>
          )}
          {!you && peer && peer.live !== "gone" && (
            <button
              type="button"
              className="icon-button message-go"
              aria-label={`Go to ${peer.name}`}
              title={`Go to ${peer.name}`}
              onClick={() => links.goTo(peer.terminalId)}
            >
              <ExternalLink size={14} strokeWidth={1.75} aria-hidden />
            </button>
          )}
        </span>
      </div>
      <div
        ref={scroll}
        className="message-scroll"
        onScroll={(event) => {
          const element = event.currentTarget
          atEnd.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24
        }}
      >
        <ol className="message-chat" aria-label={`Messages with ${you ? "you" : name}`}>
          {lines.map((line) => (
            <ChatLineItem
              key={line.key}
              line={line}
              conversation={conversation}
              peers={peers}
              links={links}
              onUnfold={() => {
                // The rounds open where they were, not under the chat's end.
                atEnd.current = false
                setUnfolded(true)
              }}
            />
          ))}
        </ol>
        {gone && (
          <p className="message-footnote">
            The agent in {name} ended before this arrived, so nothing more reaches it.
          </p>
        )}
      </div>
    </>
  )
}

// A terminal's messages: one list of its conversations, the person's entries first while
// they wait on them, then latest first; one opened reads as a chat. The header holds the
// pause for messages between agents; the person's replies go through. Holds stay with the
// runner and the Inbox, never here.
export const MessagesView = ({
  messagesHandle,
  links,
  actions,
}: {
  messagesHandle: MessagesHandle
  links: MessageLinks
  // What the pane does, at the end of the header.
  actions?: ReactNode
}): React.JSX.Element => {
  const label = useId()
  const hint = useId()
  const [open, setOpen] = useState<string | null>(null)
  const list = useRef<HTMLUListElement>(null)
  const returnTo = useRef<string | null>(null)
  const conversations = useMemo(
    () => (messagesHandle.threads ? listed(conversationsOf(messagesHandle.threads)) : []),
    [messagesHandle.threads],
  )
  const opened = conversations.find((each) => each.key === open)
  const latest = opened ? latestOf(opened) : 0
  const peers = usePeers(links)
  const { seen } = messagesHandle
  // What the person has open on screen, they've seen, up to its latest message: not one
  // left open in a terminal kept out of sight, or in a window in the background, until it
  // comes back.
  const shown = useShown()
  const visible = useSyncExternalStore(onVisibility, () => !document.hidden)
  useEffect(() => {
    if (shown && visible && open !== null && latest) seen(open, latest)
  }, [shown, visible, open, latest, seen])
  // Back in the list, focus is on the row the person came from.
  useEffect(() => {
    if (opened || returnTo.current === null) return
    list.current
      ?.querySelector<HTMLElement>(`[data-conversation="${CSS.escape(returnTo.current)}"]`)
      ?.focus({ preventScroll: true })
    returnTo.current = null
  }, [opened])
  return (
    <div className="message-view">
      <ArtifactMeta className="message-meta" actions={actions}>
        <code>Messages</code>
        {messagesHandle.threads && <span>{handleText(messagesHandle.threads.handle)}</span>}
        <span className="message-pause">
          <span id={label} className="message-pause-label">
            Pause all agents' messages
          </span>
          <span id={hint} className="sr-only">
            Between agents in every project and session, until you resume. Your replies still go
            through.
          </span>
          <Switch
            checked={messagesHandle.paused}
            onChange={messagesHandle.pause}
            labelledBy={label}
            describedBy={hint}
            pending={messagesHandle.pending}
          />
        </span>
      </ArtifactMeta>
      {messagesHandle.error && (
        <p className="message-error" data-tone="danger" role="alert">
          {messagesHandle.error}
        </p>
      )}
      {messagesHandle.paused && (
        <p className="message-paused" data-tone="warning" role="status">
          Messaging is paused between agents. Your replies still go through.
        </p>
      )}
      {messagesHandle.threads?.waits && messagesHandle.badge?.kind === "waiting" && (
        <p className="message-waits" data-tone="warning" role="status">
          {waitsText[messagesHandle.threads.waits]}
        </p>
      )}
      {opened && messagesHandle.threads ? (
        <Chat
          key={opened.key}
          conversation={opened}
          self={messagesHandle.threads.handle}
          peers={peers}
          links={links}
          onBack={() => {
            returnTo.current = opened.key
            setOpen(null)
          }}
        />
      ) : (
        <div className="message-scroll">
          {conversations.length ? (
            <ul ref={list} className="message-rows" aria-label="Conversations">
              {conversations.map((conversation) => (
                <Row
                  key={conversation.key}
                  conversation={conversation}
                  peer={peers[conversation.peer]}
                  seenAt={messagesHandle.seenAt(conversation.key)}
                  onOpen={() => setOpen(conversation.key)}
                />
              ))}
            </ul>
          ) : (
            <div className="artifact-status message-empty">
              No messages yet. Conversations with the other agents in this session show here.
            </div>
          )}
        </div>
      )}
    </div>
  )
}
