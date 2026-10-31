import { logs } from "../log.js"
import {
  freshId,
  holdOf,
  isNotice,
  retentionMs,
  undelivered,
  waiting,
  type Message,
  type Thread,
} from "./messages.js"
import type { MessageRecords } from "./records.js"

const log = logs.for("messaging")

/**
 * A change listeners hear of: a terminal's messages, threads or delivery state changed, or
 * messaging was paused or resumed, which changes what every terminal's listing says.
 */
export type MessagingChange =
  | { readonly kind: "terminal"; readonly terminalId: string }
  | { readonly kind: "pause"; readonly paused: boolean }

/** What the message store asks of the rest of messaging. */
export type MessageStoreHost = {
  /** Whether a terminal exists, running or kept, for the sweep. */
  readonly exists: (terminalId: string) => boolean
  /** A message was forgotten: what others keep of it goes too. */
  readonly forgot: (messageId: string) => void
  /** A thread was forgotten: what others keep of it goes too. */
  readonly forgotThread: (threadId: string) => void
}

/**
 * The message store: every message and thread, kept in memory and saved to the records,
 * the pause, and who follows their changes. A message's state changes only here (`put`,
 * `wait`, `gone`), which also times how long each queued message has waited.
 */
export class MessageStore {
  /** Everyone following changes: the doorbell, and each `messages.watch`. */
  private readonly listeners = new Set<(change: MessagingChange) => void>()
  private readonly byId = new Map<string, Message>()
  private readonly threadById = new Map<string, Thread>()
  /** Each person reply's message, by the Inbox ask it answers. */
  private readonly responses = new Map<string, string>()
  /** Each queued message whose sender was told of its hold, by when that hold began. */
  private readonly holdsTold = new Map<string, number>()
  /** When each queued message last came to wait: sent, or put back by a pause, release or lapse. */
  private readonly queuedSince = new Map<string, number>()
  private paused: boolean
  /**
   * Whether the runner closed it: what its end does to its terminals, each shell's exit
   * unregistering it, is the runner stopping, not its agents ending, so no message changes.
   */
  private ended = false

  constructor(
    private readonly records: MessageRecords,
    private readonly now: () => number,
    private readonly host: MessageStoreHost,
  ) {
    this.paused = this.read(() => this.records.messagingPaused(), false)
    for (const thread of this.read(() => this.records.threads(), []))
      this.threadById.set(thread.id, thread)
    for (const message of this.read(() => this.records.messages(), [])) {
      this.byId.set(message.id, message)
      if (message.response) this.responses.set(message.response.askId, message.id)
      // A lease held when the runner stopped is gone with it: its messages wait again.
      if (message.state === "leased" || message.state === "queued" || message.state === "held")
        this.wait(message)
    }
  }

  /** Whether the runner closed messaging: nothing is saved or changed from then on. */
  get closed(): boolean {
    return this.ended
  }

  close(): void {
    this.ended = true
  }

  /** Every message, in the order they came; the live view, which may change as it is read. */
  messages(): IterableIterator<Message> {
    return this.byId.values()
  }

  message(id: string): Message | undefined {
    return this.byId.get(id)
  }

  /** Every thread; the live view, as `messages`. */
  threads(): IterableIterator<Thread> {
    return this.threadById.values()
  }

  thread(id: string): Thread | undefined {
    return this.threadById.get(id)
  }

  /** When the queued message last came to wait, if it is queued and that was seen. */
  queuedAt(id: string): number | undefined {
    return this.queuedSince.get(id)
  }

  /**
   * Notes that the sender of a queued message was told of its hold, which began `since`;
   * false when it already was, for that hold.
   */
  tellHold(id: string, since: number): boolean {
    if (this.holdsTold.get(id) === since) return false
    this.holdsTold.set(id, since)
    return true
  }

  /** The reply for one Inbox ask, used to retain pending replies with their question. */
  inboxReply(askId: string): Message | undefined {
    const id = this.responses.get(askId)
    return id ? this.byId.get(id) : undefined
  }

  /** Whether messaging is paused, across the whole runner. */
  isPaused(): boolean {
    return this.paused
  }

  /**
   * Pauses messaging across the whole runner, or resumes it, keeping the switch: waiting
   * agent messages are held while paused, and wait in order again once resumed. Person
   * replies are unaffected, including after a restart or lost delivery lease.
   */
  pause(paused: boolean): void {
    this.write(() => this.records.pauseMessaging(paused))
    const changed = this.paused !== paused
    this.paused = paused
    for (const message of this.byId.values())
      if (message.state === "queued" || message.state === "held") this.wait(message)
    if (changed) this.emit({ kind: "pause", paused })
  }

  /**
   * Hears of every change to a terminal's messages, threads or delivery state, and of the
   * pause, as the doorbell and each watch of a terminal's messages do, until the returned
   * function is called.
   */
  subscribe(listener: (change: MessagingChange) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Tells listeners the terminal's messages, threads or delivery state changed. */
  changed(terminalId: string): void {
    this.emit({ kind: "terminal", terminalId })
  }

  private emit(change: MessagingChange): void {
    for (const listener of this.listeners)
      try {
        listener(change)
      } catch (error) {
        // One listener failing never stops messaging, nor the others hearing.
        log.error("messaging.listener-failed", "Novadeck could not follow its messages", {
          err: error,
        })
      }
  }

  freshMessageId(): string {
    let id = freshId("m")
    while (this.byId.has(id)) id = freshId("m")
    return id
  }

  freshThreadId(): string {
    let id = freshId("t")
    while (this.threadById.has(id)) id = freshId("t")
    return id
  }

  /** Why the message is held: the pause, or its thread's hold for release; null for neither. */
  holdOf(message: Message): "paused" | "release" | null {
    return message.response
      ? null
      : holdOf(message, this.threadById.get(message.thread), this.paused)
  }

  put(message: Message): void {
    if (this.ended) return
    const before = this.byId.get(message.id)
    this.byId.set(message.id, message)
    if (message.state !== "queued") {
      this.holdsTold.delete(message.id)
      this.queuedSince.delete(message.id)
    } else if (before?.state !== "queued") this.queuedSince.set(message.id, this.now())
    if (message.response) this.responses.set(message.response.askId, message.id)
    this.write(() => this.records.saveMessage(message))
    this.changed(message.to.terminalId)
    if (message.from.kind === "agent") this.changed(message.from.terminalId)
  }

  /**
   * Takes in a person's reply its Inbox entry already saved with it (see `personReply`),
   * which only then becomes visible and deliverable.
   */
  committed(message: Message & { readonly response: NonNullable<Message["response"]> }): void {
    this.byId.set(message.id, message)
    this.responses.set(message.response.askId, message.id)
    this.changed(message.to.terminalId)
  }

  putThread(thread: Thread): void {
    if (this.ended) return
    this.threadById.set(thread.id, thread)
    this.write(() => this.records.saveThread(thread))
  }

  /** Puts an undelivered message back to waiting: held for a reason, else queued. */
  wait(message: Message): void {
    // A stopped thread's message never waits again: one a lease held is gone with it (a lead
    // message the person released, kept leased to finish, is marked so too).
    if (message.stopped) {
      if (message.state === "leased") {
        this.noteGone(message, "stopped")
        this.put({ ...message, state: "gone", notified: false })
      }
      return
    }
    const thread = this.threadById.get(message.thread)
    if (thread?.stoppedAt != null && undelivered(message)) {
      this.noteGone(message, "thread-stopped")
      this.put({ ...message, state: "gone", notified: false, stopped: true })
      return
    }
    const state = message.response ? "queued" : waiting(message, thread, this.paused)
    if (state !== message.state) this.put({ ...message, state })
  }

  /** Logs that a message that waited can't be delivered, and why. */
  noteGone(message: Message, reason: string): void {
    if (message.state === "gone") return
    log.info("delivery.gone", "A message could not be delivered.", {
      data: {
        message: message.id,
        terminal: message.to.terminalId,
        reason,
        state: message.state,
        waitedMs: this.now() - message.sentAt,
      },
    })
  }

  /** The message can't be delivered now, for `reason`; it waits again if its session comes back. */
  gone(message: Message, reason: string): void {
    this.noteGone(message, reason)
    // Novadeck's notice for a session that cannot take it is dropped, never revived later.
    if (isNotice(message)) return this.discard(message)
    const response =
      message.response && message.state !== "gone" && message.deliveredAt === null
        ? { ...message.response, goneAt: this.now() }
        : message.response
    this.put({ ...message, state: "gone", notified: false, ...(response && { response }) })
  }

  /** Forgets a message wholly, as a notice that went gone is. */
  private discard(message: Message): void {
    if (this.ended) return
    this.forget(message)
    this.write(() => this.records.removeMessages([message.id]))
    this.changed(message.to.terminalId)
  }

  /** Drops only resolved person replies whose questions have left retained history. */
  forgetResponses(ids: readonly string[]): void {
    const messages = ids.flatMap((id) => {
      const message = this.inboxReply(id)
      return message && !undelivered(message) ? [message] : []
    })
    if (!messages.length) return
    this.records.removeMessages(messages.map((message) => message.id))
    for (const message of messages) {
      this.forget(message)
      this.changed(message.to.terminalId)
    }
  }

  /**
   * Forgets a removed project's messages and threads, once its terminals are gone. The
   * records keep them until the project's own are deleted, with them.
   */
  forgetProject(projectId: string): void {
    for (const message of this.byId.values())
      if (message.projectId === projectId) this.forget(message)
    for (const thread of this.threadById.values())
      if (thread.projectId === projectId) this.forgetThread(thread.id)
  }

  /**
   * Deletes each message once neither of its terminals exists and its latest activity is
   * a day old, and the threads only they kept.
   */
  sweep(): void {
    const now = this.now()
    const old = [...this.byId.values()].filter(
      (message) =>
        (message.from.kind !== "agent" || !this.host.exists(message.from.terminalId)) &&
        !this.host.exists(message.to.terminalId) &&
        now - Math.max(message.sentAt, message.deliveredAt ?? 0, message.response?.goneAt ?? 0) >=
          retentionMs,
    )
    for (const message of old) this.forget(message)
    if (old.length > 0) this.write(() => this.records.removeMessages(old.map(({ id }) => id)))
    const kept = new Set([...this.byId.values()].map(({ thread }) => thread))
    const threads = [...this.threadById.keys()].filter((id) => !kept.has(id))
    for (const id of threads) this.forgetThread(id)
    if (threads.length > 0) this.write(() => this.records.removeThreads(threads))
  }

  /** Forgets a message in memory, with all that is kept of it. */
  private forget(message: Message): void {
    this.byId.delete(message.id)
    this.holdsTold.delete(message.id)
    this.queuedSince.delete(message.id)
    if (message.response) this.responses.delete(message.response.askId)
    this.host.forgot(message.id)
  }

  /** Forgets a thread in memory, with all that is kept of it. */
  private forgetThread(id: string): void {
    this.threadById.delete(id)
    this.host.forgotThread(id)
  }

  /** Reads the records; a failure is logged and gives `fallback`. */
  private read<T>(work: () => T, fallback: T): T {
    try {
      return work()
    } catch (error) {
      log.error("messaging.read-failed", "Novadeck could not read its messages", { err: error })
      return fallback
    }
  }

  /** Writes to the records; a failure is logged, and the runner carries on. */
  private write(work: () => void): void {
    try {
      work()
    } catch (error) {
      log.error("messaging.save-failed", "Novadeck could not save its messages", { err: error })
    }
  }
}
