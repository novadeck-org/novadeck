import { useSyncExternalStore } from "react"

import type { Chat, ChatState } from "./state"

// Subscribes a component to one derived value of the chat's state; `select` picks values the
// state already holds, so the same state gives the same value.
export const useChat = <T>(chat: Chat, select: (state: ChatState) => T): T =>
  useSyncExternalStore(chat.store.subscribe, () => select(chat.store.getSnapshot()))
