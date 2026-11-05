import { afterEach, describe, expect, it, vi } from "vitest"

import { clipboardWrite, copyOnSelect, takeClipboardWrites } from "./copy.js"

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
  // A terminal whose OSC 52 handler the test calls as the parser would.
  const terminal = (focused: () => boolean) => {
    let handler: ((data: string) => boolean | Promise<boolean>) | undefined
    const disposed = vi.fn<() => void>()
    const copied: string[] = []
    const parser = {
      registerOscHandler: (ident: number, callback: (data: string) => boolean) => {
        expect(ident).toBe(52)
        handler = callback
        return { dispose: disposed }
      },
    }
    const taken = takeClipboardWrites(
      { parser } as unknown as Parameters<typeof takeClipboardWrites>[0],
      (text) => void copied.push(text),
      focused,
    )
    return { copied, taken, disposed, send: (data: string) => handler?.(data) }
  }

  it("puts its text on the clipboard while the person is in the terminal", () => {
    const page = terminal(() => true)
    expect(page.send(`c;${base64("copied in vim")}`)).toBe(true)
    expect(page.copied).toEqual(["copied in vim"])
  })

  it("is dropped while the person is elsewhere, and never reaches the screen", () => {
    const page = terminal(() => false)
    expect(page.send(`c;${base64("out of sight")}`)).toBe(true)
    expect(page.copied).toEqual([])
  })

  it("answers no read", () => {
    const page = terminal(() => true)
    expect(page.send("c;?")).toBe(true)
    expect(page.copied).toEqual([])
  })

  it("stops with its disposal", () => {
    const page = terminal(() => true)
    page.taken.dispose()
    expect(page.disposed).toHaveBeenCalledOnce()
  })
})
