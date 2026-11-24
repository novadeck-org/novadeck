import type { ScreenText } from "@novadeck/emulator/headless"
import { loadProbe } from "@novadeck/harness-core/testing/probes"
import { isEmpty, takesQueue } from "@novadeck/tui-input/box"
import { describe as context, describe, expect, it } from "vitest"

import { box, emptyBox, slice } from "./box.js"

type Probe = { screens: { [name: string]: ScreenText } }

// Probed 2026-11-24, pi 1.6.0 (fixtures/*.probe.json; the rig in backups/pi-harness-2026-11-24).
const probes = ["input-box", "busy", "bash", "dialogs", "startup"].map(
  (name) => loadProbe<Probe>(import.meta.dirname, `${name}.probe.json`).screens,
)
const screen = (name: string): ScreenText => {
  const found = probes.find((screens) => name in screens)?.[name]
  if (!found) throw new Error(`no state ${name}`)
  return found
}
const read = (name: string) => box.read(screen(name))

/** A screen with its box's rows put in place of what it showed. */
const withBox = (name: string, lines: readonly string[]): ScreenText => {
  const shown = screen(name)
  const found = box.read(shown)!
  const rows = [
    ...shown.rows.slice(lines.length - 1, found.first),
    ...lines,
    ...shown.rows.slice(found.last + 1),
  ]
  return { ...shown, rows, bright: rows }
}

describe("pi's input box", () => {
  context("at rest", () => {
    it("reads an empty box as empty, on every screen size", () => {
      for (const name of ["ready", "ready60", "answered", "escaped", "trustedReady"])
        expect(read(name), name).toMatchObject({ text: "", mode: "prompt" })
      expect(read("ready")).toMatchObject({ first: 36, last: 36 })
      expect(emptyBox(screen("ready"))).toBe(true)
    })

    it("reads the box empty with no provider, its warning above it", () => {
      expect(read("empty")).toMatchObject({ text: "" })
    })

    it("reads what was typed, from the first column", () => {
      expect(read("typed")?.text).toBe("hello there")
      expect(read("typed60")?.text).toBe("hello there")
      expect(emptyBox(screen("typed"))).toBe(false)
    })

    it("reads a draft of lines whole, and one wrapped over rows as those rows", () => {
      expect(read("pasteMulti")?.text).toBe("line one\nline two\nline three")
      expect(read("typedWrap60")).toMatchObject({
        text: "a long prompt that will wrap over more than one row of\nthis narrow box for sure",
        first: 15,
        last: 16,
      })
    })

    it("keeps a blank line inside a draft", () => {
      expect(read("pasteOverDraft120x40")?.text).toBe("draft\n\nafter blank")
    })

    it("reads rows the terminal gives as wide as the screen as it reads them trimmed", () => {
      const padded = (name: string): ScreenText => {
        const shown = screen(name)
        const pad = (rows: readonly string[]) => rows.map((row) => row.padEnd(shown.columns))
        return { ...shown, rows: pad(shown.rows), bright: pad(shown.bright) }
      }
      for (const name of ["ready", "typed", "pasteMulti", "busy", "slash", "tall120x40"])
        expect(box.read(padded(name)), name).toEqual(read(name))
    })
  })

  context("with a turn running", () => {
    it("reads the box under a working rule, and under a retrying one, as empty", () => {
      for (const name of ["busy", "busy60", "retrying", "retrying2", "ctrlCBusy"])
        expect(read(name), name).toMatchObject({ text: "", mode: "prompt" })
    })

    it("reads a draft typed while it runs", () => {
      expect(read("busyTyped")?.text).toBe("steer this")
    })

    it("says messages wait behind the turn, steering or following up", () => {
      expect(box.queued(screen("steerQueued"))).toBe(true)
      expect(box.queued(screen("followQueued"))).toBe(true)
      for (const name of ["busy", "ready", "altUp", "escapedWithQueue"])
        expect(box.queued(screen(name)), name).toBe(false)
      expect(takesQueue(box, screen("steerQueued"))).toBe(true)
    })

    it("tells a turn Escape stopped", () => {
      expect(box.interrupted?.(screen("escaped"))).toBe(true)
      expect(box.interrupted?.(screen("escapedWithQueue"))).toBe(true)
      expect(box.interrupted?.(screen("answered"))).toBe(false)
      expect(box.interrupted?.(screen("busy"))).toBe(false)
    })

    it("reads the messages Escape put back as a draft", () => {
      expect(read("escapedWithQueue")?.text).toBe("steer again")
      expect(read("altUp")?.text).toBe("steer me\n\nfollow me")
    })
  })

  context("with pastes", () => {
    it("reads a long paste as its placeholder, which stands for the text", () => {
      const found = read("pasteLong")!
      expect(found.text).toBe("[paste #1 +40 lines]")
      expect(box.collapsed(found)).toBe(true)
      expect(box.stands(found.text)).toBe(true)
      expect(box.stands("[paste #2 1234 chars]")).toBe(true)
      expect(box.stands("hello")).toBe(false)
    })

    it("reads a placeholder after a draft as not collapsed", () => {
      const found = read("bigPasteOverDraft120x40")!
      expect(found.text).toBe("draft[paste #1 +14 lines]")
      expect(box.collapsed(found)).toBe(false)
      expect(box.stands(found.text)).toBe(true)
    })

    it("knows which pastes collapse: more than 10 lines or 1000 characters", () => {
      expect(box.collapses(Array.from({ length: 11 }, () => "x").join("\n"))).toBe(true)
      expect(box.collapses(Array.from({ length: 10 }, () => "x").join("\n"))).toBe(false)
      expect(box.collapses("y".repeat(1001))).toBe(true)
      expect(box.collapses("y".repeat(1000))).toBe(false)
      expect(read("paste9120x40")?.text.split("\n")).toHaveLength(9)
    })
  })

  context("taller than it shows", () => {
    it("reads a scrolled box as scrolled, above and below", () => {
      expect(read("tall120x40")).toMatchObject({ scrolled: true, first: 25, last: 36 })
      expect(read("tall120x40")?.text.split("\n")[0]).toBe("line 29")
      expect(read("tallTop120x40")).toMatchObject({ scrolled: true })
      expect(read("tallTop120x40")?.text.split("\n")[0]).toBe("line 1")
    })

    it("shows at most 30% of the screen's rows, and at least 5", () => {
      expect(box.viewport?.(40)).toBe(12)
      expect(box.viewport?.(20)).toBe(6)
      expect(box.viewport?.(12)).toBe(5)
      for (const [name, rows] of [
        ["tall120x40", 12],
        ["tall60x20", 6],
        ["tall80x12", 5],
      ] as const) {
        const found = read(name)!
        expect(found.last - found.first + 1, name).toBe(rows)
        expect(box.viewport?.(screen(name).rows.length), name).toBe(rows)
      }
    })

    it("fills all but one column of a row with text", () => {
      expect(box.textWidth(120)).toBe(119)
      const long = read("wrapLong120x40")!.text.split("\n")
      expect(long[0]).toHaveLength(119)
    })
  })

  context("emptied", () => {
    it("goes Down to the last line, then takes each line with Ctrl-E and Ctrl-U twice", () => {
      expect(box.erase?.(read("typed")!)).toBe("\x05\x15\x15")
      expect(box.erase?.(read("pasteMulti")!)).toBe(
        `${"\x1b[B".repeat(2)}${"\x05\x15\x15".repeat(3)}`,
      )
    })

    it("counts the rows out of sight its rules name", () => {
      const keys = box.erase?.(read("tall120x40")!) ?? ""
      expect(keys.split("\x05\x15\x15")).toHaveLength(41)
    })

    it("never presses Ctrl-C, which twice within a second ends pi", () => {
      for (const name of ["typed", "pasteMulti", "tall120x40", "pasteLong", "bangTyped"])
        expect(box.erase?.(read(name)!), name).not.toContain("\x03")
      expect(box.clear?.(read("escapedWithQueue")!)).not.toContain("\x03")
    })
  })

  context("in bash mode", () => {
    it("reads a box led by ! as its shell mode", () => {
      for (const name of ["bang", "bangbang", "bangTyped", "bangTwoLines120x40"])
        expect(read(name)?.mode, name).toBe("shell")
      expect(read("bangTyped")?.text).toBe("!echo from-bash")
      expect(read("typed")?.mode).toBe("prompt")
    })

    it("runs a command given while a turn works at once", () => {
      expect(box.shell.midTurn).toBe("runs")
      expect(box.shell.starts).toBe(false)
    })
  })

  context("with its own things drawn", () => {
    it("reads the box over the / menu drawn under it", () => {
      expect(read("slash")).toMatchObject({ text: "/", first: 30, last: 30 })
      expect(slice.side(screen("slash"))).toBe("below")
    })

    it("reads no box where a dialog takes its place", () => {
      for (const name of [
        "select",
        "selectDown",
        "selectMultiline",
        "confirm",
        "confirmNo",
        "input2",
        "inputTyped2",
        "editor",
        "question",
        "permissionGate",
        "model",
        "thinking",
        "settings",
        "resume",
        "tree",
        "modelWhileBusy",
        "login",
        "loginPicked",
        "trust",
        "select60",
        "model60",
      ])
        expect(read(name), name).toBeUndefined()
    })

    it("tells the transcript's search over the box", () => {
      expect(box.overlay(screen("searchCsiU120x40"))).toBe(true)
      expect(read("searchCsiU120x40")).toBeUndefined()
      expect(box.overlay(screen("ready"))).toBe(false)
      expect(box.overlay(screen("select"))).toBe(true)
      expect(box.overlay(screen("tree"))).toBe(true)
      // A `/` draft's menu is no view over the box: the draft reads as a command.
      expect(box.overlay(screen("slash"))).toBe(false)
    })
  })

  context("with an image pasted", () => {
    const path =
      "/home/a/.local/share/novadeck/uploads/0f8e2b8e-6d1a-4b8a-9d6e-3b2a1c0d9e8f/shot.png"

    it("shows a path Novadeck pasted from its uploads as an image", () => {
      const found = box.read(withBox("ready", [`${path} what is this`]))!
      expect(found.text).toBe("[Image #1] what is this")
      expect(box.images?.attached(withBox("ready", [`${path} what is this`]))).toBe(1)
      expect(box.stands(found.text)).toBe(true)
    })

    it("joins a path pi wrapped at the row's end before reading it", () => {
      const width = box.textWidth(60)
      const line = `${path} and more`
      const rows = [line.slice(0, width), line.slice(width)]
      const found = box.read({ ...withBox("ready60", rows), columns: 60 })!
      expect(found.text).toBe("[Image #1] and more")
    })

    it("leaves a path the person typed as text", () => {
      expect(read("pathTyped")?.text).toMatch(/^\/tmp\/.*shot\.png what is this$/)
      expect(box.images?.attached(screen("pathTyped"))).toBe(0)
    })

    it("takes the images out with the rest of the box", () => {
      expect(box.images?.discard(withBox("ready", [path]))).toBe("\x05\x15\x15")
      expect(box.images?.alone).toBe(true)
    })
  })

  it("reads isEmpty as the shared rules do", () => {
    expect(isEmpty(read("ready")!)).toBe(true)
    expect(isEmpty(read("typed")!)).toBe(false)
  })
})
