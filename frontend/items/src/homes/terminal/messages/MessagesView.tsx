import { handleText } from "@novadeck/core/handle"
import { waitsText, type AgentMessage, type MailPeer } from "@novadeck/core/messages"
import { Switch } from "@novadeck/toolkit/Switch"
import { ChevronLeft, ChevronRight, ExternalLink } from "lucide-react"
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"

import { ArtifactMeta } from "../../../ArtifactViewer"
import { Avatar, type AvatarLive } from "./avatars/Avatar"
import { hueOf } from "./avatars/critters"
import {
  chatOf,
  conversationsOf,
  cornerOf,
  latestOf,
  letterLabel,
  listed,
  openAsks,
  waitsOnPerson,
  youKey,
  type ChatEntry,
  type Conversation,
  type Corner,
  type Note,
} from "./conversations"
import type { MailHandle, MailLinks } from "./mail"

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

const party = (handle: string): string => (handle === "you" ? "You" : handleText(handle))

const nameOf = (peer: string, found: MailPeer | undefined): string =>
  peer === "you" ? "You" : (found?.name ?? handleText(peer))

const liveOf = (found: MailPeer | undefined): AvatarLive => found?.live ?? "gone"

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
        <span className="mail-chip" data-tone="warning">
          Asks you
        </span>
      )
    case "undelivered":
      return (
        <span className="mail-chip" data-tone="danger">
          Not delivered
        </span>
      )
    case "unread":
      return <span className="mail-row-time">Unread</span>
    case "time":
      return (
        <time className="mail-row-time" dateTime={new Date(corner.at).toISOString()}>
          {rowTime(corner.at)}
        </time>
      )
  }
}

const Row = ({
  conversation,
  peer,
  seenAt,
  onOpen,
}: {
  conversation: Conversation
  peer: MailPeer | undefined
  seenAt: number
  onOpen: () => void
}): React.JSX.Element => {
  const last = conversation.messages.at(-1)
  const corner = cornerOf(conversation, seenAt)
  const name = nameOf(conversation.peer, peer)
  const you = conversation.key === youKey
  return (
    <li>
      <button
        type="button"
        className="mail-row"
        data-conversation={conversation.key}
        data-unread={corner.kind === "unread" || waitsOnPerson(conversation) || undefined}
        aria-label={peer ? `${name}, ${handleText(conversation.peer)}` : name}
        onClick={onOpen}
      >
        <Avatar
          handle={conversation.peer}
          size={30}
          live={you ? "idle" : liveOf(peer)}
          program={you ? undefined : peer?.program}
        />
        <span className="mail-row-main">
          <span className="mail-row-top">
            <strong className="mail-row-name">{name}</strong>
            {peer && <code className="mail-row-handle">{handleText(conversation.peer)}</code>}
          </span>
          {last && (
            <span className="mail-preview">
              <span className="mail-preview-who">{party(last.from)}:</span>{" "}
              {last.text.replace(/\s+/g, " ")}
            </span>
          )}
        </span>
        <span className="mail-row-end">
          <CornerText corner={corner} />
        </span>
        <ChevronRight className="mail-row-go" size={14} strokeWidth={1.75} aria-hidden />
      </button>
    </li>
  )
}

// One message as a bubble on its side: its sender's critter at the start of a run of the
// other side's, a letter's label in plain words, the question a reply answers, Answer on a
// question still open, and its note under it while there's one worth a look.
const Bubble = ({
  entry,
  conversation,
  peer,
  onAnswer,
}: {
  entry: Extract<ChatEntry, { kind: "message" }>
  conversation: Conversation
  peer: MailPeer | undefined
  onAnswer: (letter: AgentMessage) => void
}): React.JSX.Element => {
  const { message, side, grouped, note } = entry
  const label = letterLabel(message)
  const asked = conversation.asked.get(message.id)
  const open = message.inbox === "ask" && message.inboxState === "open"
  const sender = party(message.from)
  return (
    <li
      className="mail-bubble-row"
      data-side={side}
      data-grouped={grouped || undefined}
      data-hue={message.from === "you" ? "you" : hueOf(message.from)}
      data-state={message.state}
      data-open={open || undefined}
      title={exact(message.sentAt)}
    >
      {side === "in" && (
        <span className="mail-bubble-av">
          {!grouped && (
            <Avatar
              handle={message.from}
              size={22}
              live={message.from === "you" ? "idle" : liveOf(peer)}
            />
          )}
        </span>
      )}
      <div className="mail-bubble-col">
        <div className="mail-bubble">
          {/* Who sent it is plain from its side; the words stay for screen readers. */}
          <span className="sr-only">{sender}: </span>
          {label && (
            <span
              className="mail-letter"
              data-kind={message.inbox}
              data-open={message.inboxState === "open" || undefined}
            >
              {label}
            </span>
          )}
          {asked && <span className="mail-quote">{asked.text.replace(/\s+/g, " ")}</span>}
          {/* The agent's words, exactly as it wrote them: never formatted or interpreted. */}
          <p className="mail-text">{message.text}</p>
          {open && (
            <div className="mail-answer">
              <button type="button" className="button" onClick={() => onAnswer(message)}>
                Answer
              </button>
            </div>
          )}
        </div>
        {note && (
          <div className="mail-bubble-meta">
            <span className="mail-note" data-note={note} title={noteHint[note]}>
              {noteText[note]}
            </span>
          </div>
        )}
      </div>
    </li>
  )
}

const ChatEntryItem = ({
  entry,
  conversation,
  peer,
  onUnfold,
  onAnswer,
}: {
  entry: ChatEntry
  conversation: Conversation
  peer: MailPeer | undefined
  onUnfold: () => void
  onAnswer: (letter: AgentMessage) => void
}): React.JSX.Element => {
  switch (entry.kind) {
    case "time":
      return (
        <li className="mail-time">
          <time dateTime={new Date(entry.at).toISOString()} title={exact(entry.at)}>
            {clock(entry.at)}
          </time>
        </li>
      )
    case "new":
      return (
        <li className="mail-new">
          <span>New</span>
        </li>
      )
    case "fold":
      return (
        <li className="mail-fold">
          <button type="button" onClick={onUnfold}>
            <span className="mail-fold-count">
              {entry.rounds} more round{entry.rounds === 1 ? "" : "s"} like this
            </span>
            <span className="mail-fold-text">{entry.first.text.replace(/\s+/g, " ")}</span>
            <span className="mail-fold-show">Show</span>
          </button>
        </li>
      )
    case "message":
      return <Bubble entry={entry} conversation={conversation} peer={peer} onAnswer={onAnswer} />
  }
}

// An open conversation: its head, with the way back, who it's with and the way to their
// terminal (or, with the person, what waits for them), and its chat, kept at its end as
// messages come unless the person scrolled up.
const Chat = ({
  conversation,
  self,
  peer,
  links,
  onBack,
}: {
  conversation: Conversation
  self: string
  peer: MailPeer | undefined
  links: MailLinks
  onBack: () => void
}): React.JSX.Element => {
  const [unfolded, setUnfolded] = useState(false)
  const entries = useMemo(
    () => chatOf(conversation, self, unfolded),
    [conversation, self, unfolded],
  )
  const you = conversation.key === youKey
  const name = nameOf(conversation.peer, peer)
  const asks = openAsks(conversation)
  const scroll = useRef<HTMLDivElement>(null)
  const atEnd = useRef(true)
  const back = useRef<HTMLButtonElement>(null)
  useEffect(() => back.current?.focus({ preventScroll: true }), [])
  // At its end as entries come, unless the person scrolled up.
  useLayoutEffect(() => {
    const element = scroll.current
    if (element && atEnd.current && entries.length) element.scrollTop = element.scrollHeight
  }, [entries])
  const gone =
    !you &&
    liveOf(peer) === "gone" &&
    conversation.messages.some((message) => message.from === self && message.state === "gone")
  return (
    <>
      <div className="mail-chat-head">
        <button
          ref={back}
          type="button"
          className="icon-button mail-back"
          aria-label="All conversations"
          onClick={onBack}
        >
          <ChevronLeft size={16} strokeWidth={1.75} aria-hidden />
        </button>
        <Avatar
          handle={conversation.peer}
          size={26}
          live={you ? "idle" : liveOf(peer)}
          program={you ? undefined : peer?.program}
        />
        <h3 className="mail-chat-name">
          <strong>{name}</strong>
          {!you && peer && <code>{handleText(conversation.peer)}</code>}
        </h3>
        <span className="mail-chat-side">
          {you && asks > 0 && (
            <span className="mail-asks">
              {asks === 1 ? "1 question waits for you" : `${asks} questions wait for you`}
            </span>
          )}
          {!you && peer && (
            <button
              type="button"
              className="icon-button mail-go"
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
        className="mail-scroll"
        onScroll={(event) => {
          const element = event.currentTarget
          atEnd.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24
        }}
      >
        <ol className="mail-chat" aria-label={`Messages with ${you ? "you" : name}`}>
          {entries.map((entry) => (
            <ChatEntryItem
              key={entry.key}
              entry={entry}
              conversation={conversation}
              peer={peer}
              onUnfold={() => setUnfolded(true)}
              onAnswer={links.answer}
            />
          ))}
        </ol>
        {gone && (
          <p className="mail-footnote">
            The agent in {name} ended before this arrived, so nothing more reaches it.
          </p>
        )}
      </div>
    </>
  )
}

// A terminal's messages: one list of its conversations, the person's letters first while
// they wait on them, then latest first; one opened reads as a chat. The header holds the
// pause for messages between agents; the person's replies go through. Holds stay with the
// runner and the Inbox, never here.
export const MessagesView = ({
  mail,
  links,
  actions,
}: {
  mail: MailHandle
  links: MailLinks
  // What the pane does, at the end of the header.
  actions?: ReactNode
}): React.JSX.Element => {
  const label = useId()
  const hint = useId()
  const [open, setOpen] = useState<string | null>(null)
  const list = useRef<HTMLUListElement>(null)
  const returnTo = useRef<string | null>(null)
  const conversations = useMemo(
    () => (mail.mail ? listed(conversationsOf(mail.mail)) : []),
    [mail.mail],
  )
  const opened = conversations.find((each) => each.key === open)
  const latest = opened ? latestOf(opened) : 0
  const { seen } = mail
  // What the person has open, they've seen, up to its latest message.
  useEffect(() => {
    if (open !== null && latest) seen(open, latest)
  }, [open, latest, seen])
  // Back in the list, focus is on the row the person came from.
  useEffect(() => {
    if (opened || returnTo.current === null) return
    list.current
      ?.querySelector<HTMLElement>(`[data-conversation="${CSS.escape(returnTo.current)}"]`)
      ?.focus({ preventScroll: true })
    returnTo.current = null
  }, [opened])
  return (
    <div className="mail-view">
      <ArtifactMeta className="mail-meta" actions={actions}>
        <code>Messages</code>
        {mail.mail && <span>{handleText(mail.mail.handle)}</span>}
        <span className="mail-pause">
          <span id={label} className="mail-pause-label">
            Pause all agents' messages
          </span>
          <span id={hint} className="sr-only">
            Between agents in every project and session, until you resume. Your replies still go
            through.
          </span>
          <Switch
            checked={mail.paused}
            onChange={mail.pause}
            labelledBy={label}
            describedBy={hint}
            pending={mail.pending}
          />
        </span>
      </ArtifactMeta>
      {mail.error && (
        <p className="mail-error" data-tone="danger" role="alert">
          {mail.error}
        </p>
      )}
      {mail.paused && (
        <p className="mail-paused" data-tone="warning" role="status">
          Messaging is paused between agents. Your replies still go through.
        </p>
      )}
      {mail.mail?.waits && mail.badge?.kind === "waiting" && (
        <p className="mail-waits" data-tone="warning" role="status">
          {waitsText[mail.mail.waits]}
        </p>
      )}
      {opened && mail.mail ? (
        <Chat
          key={opened.key}
          conversation={opened}
          self={mail.mail.handle}
          peer={links.peer(opened.peer)}
          links={links}
          onBack={() => {
            returnTo.current = opened.key
            setOpen(null)
          }}
        />
      ) : (
        <div className="mail-scroll">
          {conversations.length ? (
            <ul ref={list} className="mail-rows" aria-label="Conversations">
              {conversations.map((conversation) => (
                <Row
                  key={conversation.key}
                  conversation={conversation}
                  peer={links.peer(conversation.peer)}
                  seenAt={mail.seenAt(conversation.key)}
                  onOpen={() => setOpen(conversation.key)}
                />
              ))}
            </ul>
          ) : (
            <div className="artifact-status mail-empty">
              No messages yet. Conversations with the other agents in this session show here.
            </div>
          )}
        </div>
      )}
    </div>
  )
}
