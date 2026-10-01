import type { Message, Thread } from "./mailbox.js"

/**
 * Where the mailbox is kept: the workspace's store, so messages, threads and the pause
 * outlive the runner. Each write is the whole record. Handles are terminals' own, kept
 * in their records.
 */
export type MailboxRecords = {
  messages(): readonly Message[]
  saveMessage(message: Message): void
  removeMessages(ids: readonly string[]): void
  threads(): readonly Thread[]
  saveThread(thread: Thread): void
  removeThreads(ids: readonly string[]): void
  messagingPaused(): boolean
  pauseMessaging(paused: boolean): void
}

/** A mailbox kept in memory only, for a runner without a store. */
export const memoryMailbox = (): MailboxRecords => {
  const messages = new Map<string, Message>()
  const threads = new Map<string, Thread>()
  let paused = false
  return {
    messages: () => [...messages.values()],
    saveMessage: (message) => void messages.set(message.id, message),
    removeMessages(ids) {
      for (const id of ids) messages.delete(id)
    },
    threads: () => [...threads.values()],
    saveThread: (thread) => void threads.set(thread.id, thread),
    removeThreads(ids) {
      for (const id of ids) threads.delete(id)
    },
    messagingPaused: () => paused,
    pauseMessaging(value) {
      paused = value
    },
  }
}
