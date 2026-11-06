import type { ChatBox, ChatSlice } from "@novadeck/core/conversation"
import { isAgentName, opensMenu } from "@novadeck/core/harnesses"
import { useCallback, useEffect, useRef, useState } from "react"

// What passes between the chat and the harness's own menus: while the draft calls one up, what
// is typed goes to the terminal as keys, and what the harness makes of the text comes back.

// A key of the kind a field doesn't type, as a terminal takes it.
const named: Readonly<Record<string, string>> = {
  ArrowUp: "\x1b[A",
  ArrowDown: "\x1b[B",
  ArrowRight: "\x1b[C",
  ArrowLeft: "\x1b[D",
  Home: "\x1b[H",
  End: "\x1b[F",
  PageUp: "\x1b[5~",
  PageDown: "\x1b[6~",
  Delete: "\x1b[3~",
  Backspace: "\x7f",
  Enter: "\r",
  Tab: "\t",
  Escape: "\x1b",
}

type KeyPress = {
  readonly key: string
  readonly ctrlKey: boolean
  readonly metaKey: boolean
  readonly altKey: boolean
  readonly shiftKey: boolean
}

// What a key press writes to a terminal, for a view that takes every key; undefined for one the
// app or the browser keeps.
export const terminalKey = (event: KeyPress): string | undefined => {
  if (event.metaKey || event.altKey) return undefined
  if (event.key === "Tab" && event.shiftKey) return "\x1b[Z"
  if (event.ctrlKey) {
    if (!/^[a-z]$/i.test(event.key)) return undefined
    return String.fromCharCode(event.key.toLowerCase().charCodeAt(0) - 96)
  }
  return named[event.key] ?? ([...event.key].length === 1 ? event.key : undefined)
}

// The keys that make a box holding `before` hold `after`, its cursor at the end: what was added,
// Backspaces for what went, or the line cleared and written again for an edit in between.
export const editKeys = (before: string, after: string): string => {
  if (after.startsWith(before)) return after.slice(before.length)
  if (before.startsWith(after)) return "\x7f".repeat(before.length - after.length)
  return `\x15${after}`
}

// How long a box's text may lag what a key did, in milliseconds (`agents.detail`, throttled).
export const boxLagMs = 400

export type Passing = {
  // Whether what is typed goes to the terminal.
  readonly on: boolean
  // Whether text would call up a menu the terminal can answer, so it is no refused shape.
  readonly opens: (text: string) => boolean
  // Takes the draft as it changed.
  readonly edit: (text: string) => void
  // A key of the field's that the terminal takes while passing: true where it went.
  readonly press: (keys: string) => boolean
}

// The chat's draft while it calls up a harness's menu. The box's text is the harness's after
// Tab or Enter, which may complete, run or keep it: the draft then mirrors it, and goes when
// it reads empty. `write` is absent where the backend takes no keys.
export const usePassing = (input: {
  readonly agent: string | null
  readonly open: boolean
  readonly draft: string
  readonly onDraft: (draft: string) => void
  readonly box: ChatBox | null
  readonly slice: ChatSlice | null
  readonly write: ((keys: string) => Promise<void>) | undefined
}): Passing => {
  const { agent, open, draft, onDraft, box, slice, write } = input
  const [passing, setPassing] = useState(false)
  // Waiting to hear what the harness made of Tab or Enter, since when.
  const [following, setFollowing] = useState<number | null>(null)

  const answers = agent !== null && isAgentName(agent) && open && write !== undefined
  const opens = useCallback(
    (text: string): boolean =>
      answers && !text.includes("\n") && isAgentName(agent) && opensMenu(text, agent),
    [answers, agent],
  )
  // The box held a menu as the chat came back: it goes on from what the box holds.
  const resumed = !passing && draft === "" && slice?.reason === "menu" && opens(box?.text ?? "")
  if (resumed) setPassing(true)
  const on = passing || resumed

  const send = (keys: string): void => {
    write?.(keys).catch(() => {
      // The terminal took none of it: the words stay the chat's, and its rule judges them.
      setPassing(false)
      setFollowing(null)
    })
  }

  const edit = (text: string): void => {
    setFollowing(null)
    if (on) {
      const keys = editKeys(draft, text)
      if (keys !== "") send(keys)
      if (text === "") setPassing(false)
    } else if (opens(text) && box === null) {
      send(text)
      setPassing(true)
    }
    onDraft(text)
  }

  const press = (keys: string): boolean => {
    if (!on) return false
    // One Esc, only while something it closes shows: on an empty box Codex arms it, and
    // mid-turn a further one stops the turn.
    if (keys === "\x1b" && slice === null) return false
    send(keys)
    if (keys === "\r" || keys === "\t") setFollowing(Date.now())
    return true
  }

  // The harness's word on Tab or Enter, or on the box as the chat came back: the draft is what
  // the box holds.
  const mirrored =
    box !== null && box.text !== draft && (following !== null || (on && draft === ""))
      ? box.text
      : null
  useEffect(() => {
    if (mirrored !== null) onDraft(mirrored)
  }, [mirrored, onDraft])

  // Once the box can have told, it says so by reading empty: the words went.
  useEffect(() => {
    if (following === null) return undefined
    const timer = setTimeout(
      () => {
        setFollowing(null)
        if (box !== null) return
        setPassing(false)
        onDraft("")
      },
      Math.max(following + boxLagMs - Date.now(), 0),
    )
    return () => clearTimeout(timer)
  }, [following, box, onDraft])

  // The person left with a menu up: the box holds its text, and the draft goes.
  const latest = useRef({ on, onDraft })
  useEffect(() => {
    latest.current = { on, onDraft }
  }, [on, onDraft])
  useEffect(
    () => () => {
      if (latest.current.on) latest.current.onDraft("")
    },
    [],
  )

  return { on, opens, edit, press }
}
