import type { ScreenText } from "@novadeck/emulator/headless"
import { describe, expect, it } from "vitest"

import type { BoxProfile, InputBox } from "./box/box.js"
import { placeholderImages } from "./box/box.js"
import { PromptRefusal, Prompts, type PromptHost } from "./prompts.js"
import { InputQueue } from "./queue.js"
import { screen as screenOf } from "./testing/screens.js"

/**
 * How the fake program takes an image path pasted alone:
 * - `chips`: as `[Image #N]` at the start of its box, as Claude Code and Codex do;
 * - `media`: as a row above the box, its box staying as it was, as Antigravity does;
 * - `text`: not at all, the path stays words in the box.
 */
type Style = "chips" | "media" | "text"

const paste = (data: string): string | undefined =>
  // eslint-disable-next-line no-control-regex -- A bracketed paste's markers.
  /^\x1b\[200~([\s\S]*)\x1b\[201~$/.exec(data)?.[1]

const terminal = (
  style: Style,
  options: { alone?: boolean; draft?: string; bare?: boolean } = {},
) => {
  let words = options.draft ?? ""
  let images = 0
  const written: string[] = []
  const sent: { words: string; images: number }[] = []
  const chips = () => Array.from({ length: images }, (_, at) => `[Image #${at + 1}]`).join(" ")
  const boxText = () => (style === "chips" && images > 0 ? `${chips()} ${words}` : words)
  const screenRows = (): string[] => [
    "header",
    ...Array<string>(10).fill(""),
    style === "media" && images > 0 ? `▸ ${images} media attached` : "",
    `> ${boxText()}`,
    "footer",
  ]
  const profile: BoxProfile = {
    read: (screen: ScreenText): InputBox | undefined => {
      const first = screen.rows.findLastIndex((row) => row.startsWith("> "))
      return first < 0
        ? undefined
        : { text: screen.rows[first]!.slice(2).trimEnd(), mode: "prompt", first, last: first }
    },
    stands: () => false,
    textWidth: (columns) => columns - 3,
    collapsed: ({ text }) => /^\[Pasted text #\d+ \+\d+ lines\]$/.test(text),
    shell: { expands: true, starts: false, footer: () => false },
    queued: () => false,
    overlay: () => false,
    collapses: () => false,
    room: (rows) => rows - 3,
    ...(!options.bare && {
      images:
        style === "media"
          ? {
              attached: (screen) =>
                Number(
                  screen.rows.map((row) => /^▸ (\d+) media/.exec(row)?.[1]).find(Boolean) ?? 0,
                ),
              alone: options.alone ?? false,
              discard: () => "\x1b",
            }
          : {
              ...placeholderImages((screen) => profile.read(screen)),
              alone: true,
              discard: () => "\x15",
            },
    }),
  }
  const host: PromptHost = {
    admit: () => profile,
    write: (_, data) => host.type("t", data),
    bound: () => true,
    ringing: () => undefined,
    screen: () => {
      const all = screenRows()
      return Promise.resolve(
        screenOf({
          rows: all,
          columns: 40,
          cursor: { row: all.length - 2, column: 2 },
          bracketedPaste: true,
        }),
      )
    },
    type: (_, data) => {
      written.push(data)
      if (data === "\x1b" || data === "\x15") {
        images = 0
        return true
      }
      if (data === "\r") {
        sent.push({ words, images })
        words = ""
        images = 0
        return true
      }
      const pasted = paste(data)
      if (pasted === undefined) return true
      if (pasted.endsWith(".png") && style !== "text") images += 1
      else words += pasted
      return true
    },
  }
  const queue = new InputQueue({
    hold: () => ({
      release: () => {},
      settle: () => {},
      settleAfter: () => {},
      holding: () => true,
      discard: () => {},
    }),
  })
  return {
    prompts: new Prompts(host, queue, { pollMs: 5, pasteMs: 150, emptyMs: 60, settleMs: 5 }),
    written,
    sent,
  }
}

const reason = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise
  } catch (error) {
    return error instanceof PromptRefusal ? error.reason : (error as Error).message
  }
  return "none"
}

describe("a prompt with images", () => {
  it.each<Style>(["chips", "media"])(
    "pastes each image path on its own before the text in a program that shows it as %s",
    async (style) => {
      const { prompts, written, sent } = terminal(style)
      await prompts.prompt("t", "Look at this", "alone", undefined, ["/up/a/one.png"])
      expect(written).toEqual([
        "\x1b[200~/up/a/one.png\x1b[201~",
        "\x1b[200~ Look at this\x1b[201~",
        "\r",
      ])
      expect(sent).toEqual([{ words: " Look at this", images: 1 }])
    },
  )

  it("takes two images, the second only once the first shows", async () => {
    const { prompts, written, sent } = terminal("chips")
    await prompts.prompt("t", "Compare them", "alone", undefined, [
      "/up/a/one.png",
      "/up/b/two.png",
    ])
    expect(written.slice(0, 2)).toEqual([
      "\x1b[200~/up/a/one.png\x1b[201~",
      "\x1b[200~/up/b/two.png\x1b[201~",
    ])
    expect(sent).toEqual([{ words: " Compare them", images: 2 }])
  })

  it("sends images alone with one Enter where the program sends them", async () => {
    const { prompts, written, sent } = terminal("chips")
    await prompts.prompt("t", "", "alone", undefined, ["/up/a/one.png"])
    expect(written).toEqual(["\x1b[200~/up/a/one.png\x1b[201~", "\r"])
    expect(sent).toEqual([{ words: "", images: 1 }])
  })

  it("refuses images alone, writing nothing, where Enter would send nothing", async () => {
    const { prompts, written } = terminal("media")
    expect(await reason(prompts.prompt("t", "", "alone", undefined, ["/up/a/one.png"]))).toBe(
      "refused",
    )
    expect(written).toEqual([])
  })

  it("fails when an image never shows, never presses Enter, and takes back what landed", async () => {
    const { prompts, written, sent } = terminal("text")
    expect(await reason(prompts.prompt("t", "Look", "alone", undefined, ["/up/a/one.png"]))).toBe(
      "image-not-shown",
    )
    expect(written).toEqual(["\x1b[200~/up/a/one.png\x1b[201~", "\x15"])
    expect(sent).toEqual([])
  })

  it("takes back the images that landed when a later one never shows", async () => {
    const { prompts, written } = terminal("chips")
    expect(
      await reason(
        prompts.prompt("t", "Look", "alone", undefined, ["/up/a/one.png", "/up/b/notimage.txt"]),
      ),
    ).toBe("image-not-shown")
    expect(written.at(-1)).toBe("\x15")
    expect(written).not.toContain("\r")
  })

  it("leaves a draft the person has alone, refusing the prompt before any key", async () => {
    const { prompts, written } = terminal("chips", { draft: "Mine" })
    expect(await reason(prompts.prompt("t", "Look", "freed", undefined, ["/up/a/one.png"]))).toBe(
      "draft",
    )
    expect(written).toEqual([])
  })

  it("refuses a shell command with images", async () => {
    const { prompts, written } = terminal("chips")
    expect(await reason(prompts.prompt("t", "!ls", "alone", undefined, ["/up/a/one.png"]))).toBe(
      "refused",
    )
    expect(written).toEqual([])
  })

  it("refuses images for a program that takes none, writing nothing", async () => {
    const { prompts, written } = terminal("chips", { bare: true })
    expect(await reason(prompts.prompt("t", "Look", "alone", undefined, ["/up/a/one.png"]))).toBe(
      "refused",
    )
    expect(written).toEqual([])
  })
})
