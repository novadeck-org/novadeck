import { createContext, useContext } from "react"

// What a terminal's companion lets a pane say to its agent: drafts words into the box of the
// terminal's chat, for the person to look over and send, never sending them. Absent where the
// terminal has no chat to draft in (the chat view is off, or the agent has no conversation
// to show), and in a window of its own, which no terminal's chat sits beside.
export type Tell = (words: string) => void

export const TellContext = createContext<Tell | undefined>(undefined)

export const useTell = (): Tell | undefined => useContext(TellContext)
