import { describe, expect, it } from "vitest"

import { trackMouse } from "./mouse.js"
import { createScreen, written, type Screen } from "./screen.js"
import { snapshot } from "./snapshot.js"

const text = (screen: Screen) =>
  Array.from({ length: screen.rows }, (_, index) =>
    screen.buffer.active.getLine(screen.buffer.active.baseY + index)?.translateToString(true),
  ).join("\n")

const lines = Array.from({ length: 100 }, (_, index) => `LINE_${index}\r\n`).join("")

describe("a snapshot", () => {
  it("keeps the most scrollback that fits, halving it, and the visible screen whole", async () => {
    const screen = createScreen({ cols: 20, rows: 4, scrollback: 1000 })
    await written(screen, `${lines}\u001b[31mVISIBLE`)
    const sizes: number[] = []
    const whole = snapshot(screen, { fits: () => true, mouse: "default" })!
    const limit = 400
    expect(whole.length).toBeGreaterThan(limit)
    const bounded = snapshot(screen, {
      fits: (data) => {
        sizes.push(data.length)
        return data.length <= limit
      },
      mouse: "default",
    })!
    expect(bounded.length).toBeLessThanOrEqual(limit)
    expect(bounded).not.toContain("LINE_0")
    // Each try has less than the last.
    expect(sizes.length).toBeGreaterThan(1)
    expect(sizes).toEqual(sizes.toSorted((a, b) => b - a))
    const restored = createScreen({ cols: 20, rows: 4, scrollback: 1000 })
    await written(restored, bounded)
    expect(text(restored)).toBe(text(screen))
    screen.dispose()
    restored.dispose()
  })

  it("is undefined when not even the visible screen fits, and leaves the screen as it was", async () => {
    const screen = createScreen({ cols: 20, rows: 4, scrollback: 1000 })
    await written(screen, `${lines}\u001b[31mVISIBLE`)
    const tried: string[] = []
    expect(
      snapshot(screen, {
        fits: (data) => {
          tried.push(data)
          return false
        },
        mouse: "default",
      }),
    ).toBeUndefined()
    // The last try has no scrollback.
    expect(tried.at(-1)).not.toContain("LINE_0")
    expect(text(screen)).toContain("VISIBLE")
    screen.dispose()
  })

  it("measures what it returns, the mouse's encoding included", async () => {
    const screen = createScreen({ cols: 20, rows: 4, scrollback: 0 })
    await written(screen, "> ")
    const plain = snapshot(screen, { fits: () => true, mouse: "default" })!
    expect(snapshot(screen, { fits: (data) => data === plain, mouse: "default" })).toBe(plain)
    expect(snapshot(screen, { fits: (data) => data === plain, mouse: "sgr" })).toBeUndefined()
    screen.dispose()
  })

  it("keeps the alternate screen showing when it trims normal scrollback", async () => {
    const screen = createScreen({ cols: 20, rows: 4, scrollback: 1000 })
    await written(screen, `${lines}\u001b[?1049h\u001b[32mALT_VIEWPORT`)
    const data = snapshot(screen, {
      fits: (candidate) => candidate.length <= 600,
      mouse: "default",
    })!
    const restored = createScreen({ cols: 20, rows: 4, scrollback: 1000 })
    await written(restored, data)
    expect(restored.buffer.active.type).toBe("alternate")
    expect(text(restored)).toContain("ALT_VIEWPORT")
    screen.dispose()
    restored.dispose()
  })

  it("carries an SGR program's mouse encoding to a fresh screen, which then reports the mouse as SGR", async () => {
    const screen = createScreen({ cols: 20, rows: 4, scrollback: 0 })
    const encoding = trackMouse(screen)
    const restored = createScreen({ cols: 20, rows: 4, scrollback: 0 })
    // A full-screen program: the alternate screen, any motion of the mouse in SGR, and focus.
    await written(screen, "\u001b[?1049h\u001b[?1003h\u001b[?1006h\u001b[?1004h> ")
    const data = snapshot(screen, { fits: () => true, mouse: encoding() })!
    await written(restored, data)
    const sent: string[] = []
    restored.onData((reply) => sent.push(reply))
    restored.onBinary((reply) => sent.push(reply))
    // The wheel down over it, as a client's own mouse handling reports it.
    // xterm.js has no public way to press the mouse on a headless terminal.
    const { coreMouseService } = (
      restored as unknown as {
        _core: { coreMouseService: { triggerMouseEvent: (event: object) => boolean } }
      }
    )
      // eslint-disable-next-line no-underscore-dangle -- As above.
      ._core
    coreMouseService.triggerMouseEvent({
      col: 9,
      row: 2,
      x: 0,
      y: 0,
      button: 4,
      action: 1,
      ctrl: false,
      alt: false,
      shift: false,
    })
    expect(sent).toEqual(["\u001b[<65;10;3M"])
    screen.dispose()
    restored.dispose()
  })
})
