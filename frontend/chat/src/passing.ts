import type { ChatBox, ChatSlice } from "@novadeck/core/conversation"
import { hasControlCharacters } from "@novadeck/core/conversation/prompt-refusal"
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
    // Ctrl+Shift is the app's, and Ctrl+V a paste, which comes as one.
    if (event.shiftKey || event.key === "v" || !/^[a-z]$/i.test(event.key)) return undefined
    return String.fromCharCode(event.key.toLowerCase().charCodeAt(0) - 96)
  }
  return named[event.key] ?? ([...event.key].length === 1 ? event.key : undefined)
}

// The keys that make a box holding `before` hold `after`, its cursor at the end: what was added,
// Backspaces for what went, or the line cleared and written again for an edit in between.
export const editKeys = (before: string, after: string): string => {
  if (after.startsWith(before)) return after.slice(before.length)
  // A Backspace to a character, as a box takes them, not to a UTF-16 unit.
  if (before.startsWith(after)) return "\x7f".repeat(Array.from(before.slice(after.length)).length)
  return `\x15${after}`
}

// How long a box's text may lag what a key did, in milliseconds (`agents.detail`, throttled).
export const boxLagMs = 400

// The most one write takes (`agents.keys`).
const keysMax = 1024

// Clears the box's row, as far as its cursor is at the end, and no more: a box of several rows
// takes a clear of its own. So text passes only while it fits one, a few columns kept for the
// box's marker and rules, and as wide as the terminal once a slice tells that.
const clearLine = "\x15"
const assumedColumns = 60
const boxInset = 8

// Whether what is typed goes to the terminal (`on`), went there and may still show in its box
// as passing ended (`ending`), until the box reads empty, or neither.
export type PassingState = "on" | "ending" | "off"

export type Passing = {
  // Whether what is typed goes to the terminal.
  readonly on: boolean
  // Takes the draft as it changed.
  readonly edit: (text: string) => void
  // A key of the field's that the terminal takes while passing: true where it went.
  readonly press: (keys: string) => boolean
  // Stops passing, the box cleared, once that went: a Stop finds no menu in its way.
  readonly leave: () => Promise<void>
}

// Tab or Enter on its way, and what the box read as it went: the text is the harness's once
// that changes.
type Following = { readonly at: number; readonly keys: string; readonly from: string | null }

// The chat's draft while it calls up a harness's menu. Passing lasts while the text does, and
// the words are the chat's again as it stops: a message that goes on past a mention is a
// message. The box's text is the harness's after Tab or Enter, which may complete, run or keep
// it: the draft then mirrors it, and goes when it reads empty. `write` is absent where the
// backend takes no keys; `onKept` tells of an Enter that left the box holding text, which ran
// nothing.
export const usePassing = (input: {
  readonly agent: string | null
  readonly open: boolean
  readonly draft: string
  readonly onDraft: (draft: string) => void
  readonly box: ChatBox | null
  readonly slice: ChatSlice | null
  readonly write: ((keys: string) => Promise<void>) | undefined
  readonly onKept?: () => void
  // Tells whether keys pass, or may still show in the box, as the handover must keep off the
  // box meanwhile.
  readonly onPassing?: (state: PassingState) => void
  // Lets the draft go as the person leaves with a menu up.
  readonly onLeft?: () => void
}): Passing => {
  const { agent, open, draft, onDraft, box, slice, write, onKept, onPassing, onLeft } = input
  const [passing, setPassing] = useState(false)
  // Waiting to hear what the harness made of Tab or Enter.
  const [following, setFollowing] = useState<Following | null>(null)
  // Passing stopped here: what still shows is on its way out, no menu to go back to.
  const [ended, setEnded] = useState(false)
  if (ended && box === null && slice === null) setEnded(false)

  const opens = (text: string): boolean =>
    open &&
    agent !== null &&
    isAgentName(agent) &&
    write !== undefined &&
    !text.startsWith("!") &&
    text.length <= (slice?.columns ?? assumedColumns) - boxInset &&
    !text.includes("\n") &&
    !hasControlCharacters(text) &&
    opensMenu(text, agent)

  // The box held a menu as the chat came back: it goes on from what the box holds.
  const resumed =
    !passing &&
    !ended &&
    draft === "" &&
    slice?.reason === "menu" &&
    box !== null &&
    opens(box.text)
  if (resumed) setPassing(true)
  const on = (passing || resumed) && open

  const stop = (): void => {
    setPassing(false)
    setFollowing(null)
    setEnded(true)
  }

  const send = (keys: string): void => {
    write?.(keys).catch(() => {
      // The terminal took none of it: the words stay the chat's, and its rule judges them.
      stop()
    })
  }

  const edit = (text: string): void => {
    if (on) {
      // What the harness makes of Tab or Enter is still to come: it judges the text then.
      const keys = opens(text) || following !== null ? editKeys(draft, text) : clearLine
      if (keys === clearLine || keys.length > keysMax) {
        send(clearLine)
        stop()
      } else if (keys !== "") send(keys)
    } else if (opens(text) && box === null && slice?.reason !== "view") {
      send(text)
      setPassing(true)
    }
    onDraft(text)
  }

  const press = (keys: string): boolean => {
    if (!on) return false
    // Only Enter goes with nothing of its own up. Esc on an empty box arms Codex's transcript,
    // and mid-turn stops the turn; Up recalls an earlier prompt; Tab queues on Codex.
    if (keys !== "\r" && slice === null) return false
    send(keys)
    if (keys === "\r" || keys === "\t")
      setFollowing({ at: Date.now(), keys, from: box?.text ?? null })
    return true
  }

  const leave = async (): Promise<void> => {
    if (!on) return
    stop()
    await write?.(clearLine).catch(() => {})
  }

  const latest = useRef({ on, onDraft, onKept, onLeft })
  useEffect(() => {
    latest.current = { on, onDraft, onKept, onLeft }
  }, [on, onDraft, onKept, onLeft])

  const state: PassingState = on ? "on" : ended ? "ending" : "off"
  useEffect(() => {
    onPassing?.(state)
  }, [state, onPassing])

  // The harness's word on Tab or Enter, or on the box as the chat came back: the draft is what
  // the box holds, its wraps aside, as a draft that passes is one line.
  const held = box?.text.replaceAll(/\s*\n\s*/g, " ") ?? null
  const mirrored =
    held !== null &&
    held !== draft &&
    (on && draft === "" ? true : following !== null && box?.text !== following.from)
      ? held
      : null
  const landing = following?.keys ?? null
  useEffect(() => {
    if (mirrored === null) return undefined
    const timer = setTimeout(() => {
      latest.current.onDraft(mirrored)
      setFollowing(null)
      if (landing === "\r") latest.current.onKept?.()
    }, 0)
    return () => clearTimeout(timer)
  }, [mirrored, landing])

  // The box reads empty once it can have told, however late that is: the words went.
  const stopped = useCallback(() => {
    setPassing(false)
    setFollowing(null)
    setEnded(true)
    latest.current.onDraft("")
  }, [])
  const empty = box === null
  useEffect(() => {
    if (following === null || !empty) return undefined
    const timer = setTimeout(stopped, Math.max(following.at + boxLagMs - Date.now(), 0))
    return () => clearTimeout(timer)
  }, [following, empty, stopped])

  // An Enter the box still holds text after ran nothing, or completed the row.
  useEffect(() => {
    if (following?.keys !== "\r" || empty) return undefined
    const timer = setTimeout(
      () => latest.current.onKept?.(),
      Math.max(following.at + boxLagMs - Date.now(), 0),
    )
    return () => clearTimeout(timer)
  }, [following, empty])

  // The person left with a menu up: the box holds its text, and the draft goes.
  useEffect(
    () => () => {
      const { on: passed, onDraft: clear, onLeft: left } = latest.current
      if (!passed) return
      if (left) left()
      else clear("")
    },
    [],
  )

  return { on, edit, press, leave }
}
