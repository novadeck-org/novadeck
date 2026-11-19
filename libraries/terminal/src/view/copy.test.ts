import { afterEach, describe as context, describe, expect, it, vi } from "vitest"

import {
  clipboardWrite,
  copyOnSelect,
  programCopyMs,
  readClipboard,
  takeClipboardWrites,
} from "./copy.js"
import type { Platform } from "./paste.js"

const base64 = (text: string): string =>
  btoa(String.fromCharCode(...new TextEncoder().encode(text)))

describe("a mouse selection in a terminal", () => {
  const undos: (() => void)[] = []
  afterEach(() => {
    undos.splice(0).forEach((undo) => undo())
    vi.useRealTimers()
  })

  // A terminal in the page whose selection the test sets, telling of each change as the
  // emulator does.
  const selecting = () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const container = document.createElement("div")
    document.body.append(container)
    let selection = ""
    const listeners = new Set<() => void>()
    const copied: string[] = []
    const undo = copyOnSelect(
      {
        hasSelection: () => selection !== "",
        getSelection: () => selection,
        onSelectionChange: (listener: () => void) => {
          listeners.add(listener)
          return { dispose: () => void listeners.delete(listener) }
        },
      },
      container,
      (text) => void copied.push(text),
    )
    undos.push(undo, () => container.remove())
    const press = (button = 0) =>
      container.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button }))
    // The release lands where `on` says: on the terminal, or past its edge.
    const release = (button = 0, on: EventTarget = container) =>
      on.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button }))
    return {
      container,
      copied,
      undo,
      press,
      release,
      select: (text: string) => {
        selection = text
        listeners.forEach((listener) => listener())
      },
      // A selection already there, made before the test's presses.
      had: (text: string) => void (selection = text),
      settle: () => vi.advanceTimersByTime(0),
    }
  }

  it("goes on the clipboard as the button comes up, with no key after it", () => {
    const page = selecting()
    page.press()
    page.select("npm test")
    page.release()
    expect(page.copied).toEqual([])
    page.settle()
    expect(page.copied).toEqual(["npm test"])
  })

  it("counts the change the emulator tells of in its own handler of the release", () => {
    const page = selecting()
    page.press()
    page.release()
    // The emulator's own handler of the release runs after this one, and tells of it.
    page.select("a word")
    page.settle()
    expect(page.copied).toEqual(["a word"])
  })

  it("copies when the drag ends past the terminal's edge", () => {
    const page = selecting()
    page.press()
    page.select("two\nlines")
    page.release(0, document.body)
    page.settle()
    expect(page.copied).toEqual(["two\nlines"])
  })

  it("copies nothing on a click that leaves no selection", () => {
    const page = selecting()
    page.press()
    page.release()
    page.settle()
    expect(page.copied).toEqual([])
  })

  it("copies nothing for a right-click, which selects a word on macOS", () => {
    const page = selecting()
    page.press(2)
    page.select("word")
    page.release(2)
    page.settle()
    expect(page.copied).toEqual([])
  })

  it("copies nothing for a release whose press began elsewhere", () => {
    const page = selecting()
    page.select("old selection")
    page.release(0, document.body)
    page.settle()
    expect(page.copied).toEqual([])
  })

  it("never copies a selection left from before, as a click in a program with the mouse leaves it", () => {
    const page = selecting()
    page.had("copied before")
    page.press()
    page.release()
    page.settle()
    expect(page.copied).toEqual([])
  })

  it("copies a drag over the very cells of a cleared selection, which the emulator tells nothing of", () => {
    const page = selecting()
    page.press()
    page.select("same cells")
    page.release()
    page.settle()
    // Ctrl+C's copy clears it; the emulator keeps the range as its last one.
    page.select("")
    page.press()
    page.had("same cells")
    page.release()
    page.settle()
    expect(page.copied).toEqual(["same cells", "same cells"])
  })

  it("copies again when a later press makes a new selection", () => {
    const page = selecting()
    page.press()
    page.select("first")
    page.release()
    page.settle()
    page.press()
    page.select("second")
    page.release()
    page.settle()
    expect(page.copied).toEqual(["first", "second"])
  })

  it("stops with its undo, a release already heard included", () => {
    const page = selecting()
    page.press()
    page.select("late")
    page.release()
    page.undo()
    page.settle()
    page.press()
    page.release()
    page.settle()
    expect(page.copied).toEqual([])
  })
})

describe("an OSC 52 write", () => {
  it("carries UTF-8 text for the clipboard", () => {
    expect(clipboardWrite(`c;${base64("zażółć ✓")}`)).toBe("zażółć ✓")
  })

  it("means the clipboard when it names no target, or names it among others", () => {
    expect(clipboardWrite(`;${base64("a")}`)).toBe("a")
    expect(clipboardWrite(`pc;${base64("b")}`)).toBe("b")
  })

  it("is left alone when it names only another selection", () => {
    expect(clipboardWrite(`p;${base64("a")}`)).toBeUndefined()
    expect(clipboardWrite(`s0;${base64("a")}`)).toBeUndefined()
  })

  it("never reads the clipboard, nor clears it", () => {
    expect(clipboardWrite("c;?")).toBeUndefined()
    expect(clipboardWrite("c;")).toBeUndefined()
  })

  it("is left alone when malformed", () => {
    expect(clipboardWrite("c")).toBeUndefined()
    expect(clipboardWrite("c;not base64!")).toBeUndefined()
  })
})

describe("a program copying with OSC 52", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  // A terminal whose OSC 52 handler the test calls as the parser would, over a clipboard
  // that holds `held` as the page reads it (undefined where it may not read it), on
  // `platform` (Linux unless said).
  const terminal = ({
    focused = true,
    held,
    platform = "other",
  }: { focused?: boolean; held?: string; platform?: Platform } = {}) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    let handler: ((data: string) => boolean | Promise<boolean>) | undefined
    const disposed = vi.fn<() => void>()
    const copied: string[] = []
    const said = vi.fn<() => void>()
    const state = { held, focused, reads: 0 }
    // A read the test answers itself, when it sets `answer`.
    let answer: ((text: string | undefined) => void) | undefined
    const deferred = { on: false }
    const parser = {
      registerOscHandler: (ident: number, callback: (data: string) => boolean) => {
        expect(ident).toBe(52)
        handler = callback
        return { dispose: disposed }
      },
    }
    const taken = takeClipboardWrites(
      { parser } as unknown as Parameters<typeof takeClipboardWrites>[0],
      {
        focused: () => state.focused,
        read: async () => {
          state.reads += 1
          if (!deferred.on) return state.held
          return new Promise((settle) => (answer = settle))
        },
        copy: (text) => void copied.push(text),
        copied: said,
      },
      { platform },
    )
    return {
      copied,
      said,
      state,
      taken,
      disposed,
      deferred,
      answer: (text: string | undefined) => answer?.(text),
      send: (data: string) => handler?.(data),
      // Lets the wait for the program's own copy pass, and the read after it.
      settle: async () => {
        await vi.advanceTimersByTimeAsync(programCopyMs)
      },
    }
  }

  it("puts its text on the clipboard while the person is in the terminal", async () => {
    const page = terminal({ held: "copied before" })
    expect(page.send(`c;${base64("copied in vim")}`)).toBe(true)
    await page.settle()
    expect(page.copied).toEqual(["copied in vim"])
  })

  it("writes where the page can't read the clipboard", async () => {
    const page = terminal()
    page.send(`c;${base64("copied over ssh")}`)
    await page.settle()
    expect(page.copied).toEqual(["copied over ssh"])
  })

  context("when the program copied the same text itself, as Claude Code does with wl-copy", () => {
    it("leaves the clipboard be and still says it's copied", async () => {
      const page = terminal({ held: "copied before" })
      page.send(`c;${base64("selected in Claude Code")}`)
      page.state.held = "selected in Claude Code"
      await page.settle()
      expect(page.copied).toEqual([])
      expect(page.said).toHaveBeenCalledOnce()
    })

    it("counts it the same across line endings and a final line break", async () => {
      const page = terminal({ held: "copied before" })
      page.send(`c;${base64("one\ntwo")}`)
      page.state.held = "one\r\ntwo\n"
      await page.settle()
      expect(page.copied).toEqual([])
    })
  })

  it("waits for the program's own copy before it writes", async () => {
    const page = terminal({ held: "copied before" })
    page.send(`c;${base64("copied in vim")}`)
    await vi.advanceTimersByTimeAsync(programCopyMs - 1)
    expect(page.copied).toEqual([])
  })

  it("writes only the last of several in quick succession", async () => {
    const page = terminal({ held: "copied before" })
    page.send(`c;${base64("first")}`)
    page.send(`c;${base64("second")}`)
    await page.settle()
    expect(page.copied).toEqual(["second"])
  })

  it("still writes in time for a program that copies more often than it waits", async () => {
    const page = terminal({ held: "copied before" })
    page.send(`c;${base64("first")}`)
    await vi.advanceTimersByTimeAsync(programCopyMs - 100)
    page.send(`c;${base64("second")}`)
    await vi.advanceTimersByTimeAsync(100)
    expect(page.copied).toEqual(["second"])
  })

  it("drops a write the person left the terminal during, so it can't replace their own copy", async () => {
    const page = terminal({ held: "copied before" })
    page.send(`c;${base64("copied in vim")}`)
    page.state.focused = false
    await page.settle()
    expect(page.copied).toEqual([])
  })

  it("drops a write whose read a later one overtook", async () => {
    const page = terminal({ held: "copied before" })
    page.deferred.on = true
    page.send(`c;${base64("first")}`)
    await page.settle()
    expect(page.state.reads).toBe(1)
    page.send(`c;${base64("second")}`)
    page.answer("copied before")
    await vi.advanceTimersByTimeAsync(0)
    expect(page.copied).toEqual([])
  })

  it("is dropped while the person is elsewhere, and never reaches the screen", async () => {
    const page = terminal({ focused: false })
    expect(page.send(`c;${base64("out of sight")}`)).toBe(true)
    await page.settle()
    expect(page.copied).toEqual([])
  })

  it("answers no read", async () => {
    const page = terminal()
    expect(page.send("c;?")).toBe(true)
    await page.settle()
    expect(page.copied).toEqual([])
  })

  it("stops with its disposal, a write still waiting included", async () => {
    const page = terminal({ held: "copied before" })
    page.send(`c;${base64("copied in vim")}`)
    page.taken.dispose()
    await page.settle()
    expect(page.disposed).toHaveBeenCalledOnce()
    expect(page.copied).toEqual([])
  })

  it("writes nothing when disposed while its read is under way", async () => {
    const page = terminal({ held: "copied before" })
    page.deferred.on = true
    page.send(`c;${base64("copied in vim")}`)
    await page.settle()
    page.taken.dispose()
    page.answer("copied before")
    await vi.advanceTimersByTimeAsync(0)
    expect(page.copied).toEqual([])
  })

  context.each(["mac", "windows"] as const)(
    "on %s, where no compositor drops the write",
    (platform) => {
      it("writes at once, without reading the clipboard", () => {
        const page = terminal({ held: "copied before", platform })
        page.send(`c;${base64("copied in vim")}`)
        expect(page.copied).toEqual(["copied in vim"])
        expect(page.state.reads).toBe(0)
      })
    },
  )
})

describe("reading the clipboard for a program's copy", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // A page whose clipboard holds `text`, with `state` as the read permission's.
  const page = (state: PermissionState | Error, text = "on the clipboard") => {
    const readText = vi.fn<() => Promise<string>>(async () => text)
    vi.stubGlobal("navigator", {
      permissions: {
        query: async () => {
          if (state instanceof Error) throw state
          return { state }
        },
      },
      clipboard: { readText },
    })
    return readText
  }

  it("reads it where the page may without asking, as the desktop app's", async () => {
    page("granted")
    expect(await readClipboard()).toBe("on the clipboard")
  })

  it("never asks the person", async () => {
    const readText = page("prompt")
    expect(await readClipboard()).toBeUndefined()
    expect(readText).not.toHaveBeenCalled()
  })

  it("reads nothing where the browser doesn't know the permission", async () => {
    page(new TypeError("clipboard-read is not a valid PermissionName"))
    expect(await readClipboard()).toBeUndefined()
  })
})
