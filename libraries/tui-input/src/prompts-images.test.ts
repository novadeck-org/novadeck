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
 * - `inline`: as `[Image #N]` at the cursor, among the words, as the same two do for a path
 *   pasted after other words;
 * - `media`: as a row above the box, its box staying as it was, as Antigravity does;
 * - `text`: not at all, the path stays words in the box.
 */
type Style = "chips" | "inline" | "media" | "text"

const paste = (data: string): string | undefined =>
  // eslint-disable-next-line no-control-regex -- A bracketed paste's markers.
  /^\x1b\[200~([\s\S]*)\x1b\[201~$/.exec(data)?.[1]

const terminal = (
  style: Style,
  options: {
    alone?: boolean
    draft?: string
    bare?: boolean
    attached?: number
    /** How long an image or the text may take to show; short only where it never will. */
    waitMs?: number
    /** What it types for the `n`th image, where it shows no placeholder of its own. */
    typed?: boolean
    /** A run of words longer than this shows as a placeholder, as a long paste does. */
    collapsesAt?: number
    /** Whether a line break leading a paste is an Enter, as in Codex on Windows. */
    asKeys?: boolean
    /** Whether the keys for its images are offered at an empty box only, as Antigravity's are. */
    idleOnly?: boolean
  } = {},
) => {
  let words = options.draft ?? ""
  let images = options.attached ?? 0
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
    ...(options.asKeys && { pastesAsKeys: () => true }),
    collapses: (text) => text.length > (options.collapsesAt ?? Infinity),
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
              discard: (screen) =>
                options.idleOnly && !screen.rows.some((row) => row === "> ") ? undefined : "\x1b",
              ...(options.typed && { typed: (ordinal: number) => `[Image #${ordinal}]` }),
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
        if (data === "\x15") words = ""
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
      if (pasted.endsWith(".png") && style !== "text") {
        images += 1
        if (style === "inline") words += `[Image #${images}]`
      } else words += pasted
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
    prompts: new Prompts(host, queue, {
      pollMs: 5,
      pasteMs: options.waitMs ?? 3_000,
      emptyMs: 60,
      settleMs: 5,
    }),
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
    const { prompts, written, sent } = terminal("text", { waitMs: 150 })
    expect(await reason(prompts.prompt("t", "Look", "alone", undefined, ["/up/a/one.png"]))).toBe(
      "image-not-shown",
    )
    expect(written).toEqual(["\x1b[200~/up/a/one.png\x1b[201~", "\x15"])
    expect(sent).toEqual([])
  })

  it("takes back the images that landed when a later one never shows", async () => {
    const { prompts, written } = terminal("chips", { waitMs: 150 })
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

  it("refuses as a draft, writing nothing, images already attached that are the person's", async () => {
    const { prompts, written } = terminal("media", { attached: 1 })
    expect(await reason(prompts.prompt("t", "Look", "alone", undefined, ["/up/a/one.png"]))).toBe(
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

describe("a prompt with images among its words", () => {
  const see = "See this:  and fix it"

  it("pastes the words before, the image, and the words after, each on its own", async () => {
    const { prompts, written, sent } = terminal("inline")
    await prompts.prompt("t", see, "alone", undefined, ["/up/a/one.png"], [10])
    expect(written).toEqual([
      "\x1b[200~See this: \x1b[201~",
      "\x1b[200~/up/a/one.png\x1b[201~",
      "\x1b[200~ and fix it\x1b[201~",
      "\r",
    ])
    expect(sent).toEqual([{ words: "See this: [Image #1] and fix it", images: 1 }])
  })

  it("puts two images each where it stands, and none past the last when it ends the text", async () => {
    const { prompts, written, sent } = terminal("inline")
    await prompts.prompt(
      "t",
      "Compare  with ",
      "alone",
      undefined,
      ["/up/a/one.png", "/up/b/two.png"],
      [8, 14],
    )
    expect(written).toEqual([
      "\x1b[200~Compare \x1b[201~",
      "\x1b[200~/up/a/one.png\x1b[201~",
      "\x1b[200~ with\x1b[201~",
      "\x1b[200~/up/b/two.png\x1b[201~",
      "\r",
    ])
    expect(sent).toEqual([{ words: "Compare [Image #1] with[Image #2]", images: 2 }])
  })

  it("keeps images ahead of the words a space from them, as images that lead do", async () => {
    const { prompts, written } = terminal("inline")
    await prompts.prompt(
      "t",
      "Look at it",
      "alone",
      undefined,
      ["/up/a/one.png", "/up/b/two.png"],
      [0, 4],
    )
    expect(written).toEqual([
      "\x1b[200~/up/a/one.png\x1b[201~",
      "\x1b[200~ Look\x1b[201~",
      "\x1b[200~/up/b/two.png\x1b[201~",
      "\x1b[200~ at it\x1b[201~",
      "\r",
    ])
  })

  it("trims the text's edges where an image stands in the white space", async () => {
    const { prompts, written } = terminal("inline")
    await prompts.prompt("t", "  Look\n", "alone", undefined, ["/up/a/one.png"], [7])
    expect(written).toEqual(["\x1b[200~Look\x1b[201~", "\x1b[200~/up/a/one.png\x1b[201~", "\r"])
  })

  it("is what images with no places are when all of them are at the start", async () => {
    const same = terminal("chips")
    await same.prompts.prompt("t", "Look at this", "alone", undefined, ["/up/a/one.png"], [0])
    const lead = terminal("chips")
    await lead.prompts.prompt("t", "Look at this", "alone", undefined, ["/up/a/one.png"])
    expect(same.written).toEqual(lead.written)
  })

  it("types where each image stands after it, for a program that shows no placeholder", async () => {
    const { prompts, written, sent } = terminal("media", { typed: true })
    await prompts.prompt("t", see, "alone", undefined, ["/up/a/one.png"], [10])
    expect(written).toEqual([
      "\x1b[200~See this: \x1b[201~",
      "\x1b[200~/up/a/one.png\x1b[201~",
      "\x1b[200~[Image #1]\x1b[201~",
      "\x1b[200~ and fix it\x1b[201~",
      "\r",
    ])
    expect(sent).toEqual([{ words: "See this: [Image #1] and fix it", images: 1 }])
  })

  it("types nothing for images that lead, as before they had places", async () => {
    const { prompts, written } = terminal("media", { typed: true })
    await prompts.prompt("t", "Look", "alone", undefined, ["/up/a/one.png"], [0])
    expect(written).not.toContain("\x1b[200~[Image #1]\x1b[201~")
  })

  it("refuses places that don't fit the text, writing nothing", async () => {
    const { prompts, written } = terminal("inline")
    const images = ["/up/a/one.png", "/up/b/two.png"]
    expect(await reason(prompts.prompt("t", "Look", "alone", undefined, images, [2]))).toBe(
      "refused",
    )
    expect(await reason(prompts.prompt("t", "Look", "alone", undefined, images, [3, 2]))).toBe(
      "refused",
    )
    expect(await reason(prompts.prompt("t", "Look", "alone", undefined, images, [2, 9]))).toBe(
      "refused",
    )
    expect(written).toEqual([])
  })

  it("sends images first, as without places, where a run of words would show as a placeholder", async () => {
    const { prompts, written, sent } = terminal("media", { collapsesAt: 10, typed: true })
    let told = 0
    await prompts.prompt(
      "t",
      "A long run of words then more",
      "alone",
      undefined,
      ["/up/a/one.png"],
      [20],
      () => (told += 1),
    )
    expect(told).toBe(1)
    expect(written).toEqual([
      "\x1b[200~/up/a/one.png\x1b[201~",
      "\x1b[200~ A long run of words then more\x1b[201~",
      "\r",
    ])
    expect(sent).toEqual([{ words: " A long run of words then more", images: 1 }])
  })

  it("does not tell of places given up where every run shows whole", async () => {
    const { prompts } = terminal("inline", { collapsesAt: 100 })
    let told = 0
    await prompts.prompt("t", see, "alone", undefined, ["/up/a/one.png"], [10], () => (told += 1))
    expect(told).toBe(0)
  })

  it("empties a box that offers the keys for its images only when empty, words first", async () => {
    const { prompts, written, sent } = terminal("media", { waitMs: 150, idleOnly: true })
    expect(
      await reason(
        prompts.prompt(
          "t",
          "Look  here",
          "alone",
          undefined,
          ["/up/a/one.png", "/up/b/no.txt"],
          [5, 5],
        ),
      ),
    ).toBe("image-not-shown")
    expect(written.slice(-2)).toEqual(["\x15", "\x1b"])
    expect(sent).toEqual([])
  })

  it("sends images first where a line break leading a run would be an Enter", async () => {
    const { prompts, written } = terminal("inline", { asKeys: true })
    let told = 0
    await prompts.prompt(
      "t",
      "See this:\nand\nfix it",
      "alone",
      undefined,
      ["/up/a/one.png"],
      [9],
      () => (told += 1),
    )
    expect(told).toBe(1)
    expect(written[0]).toBe("\x1b[200~/up/a/one.png\x1b[201~")
    // One line, or a long first one, goes among the words as before.
    const whole = terminal("inline", { asKeys: true })
    await whole.prompts.prompt("t", see, "alone", undefined, ["/up/a/one.png"], [10])
    expect(whole.written[0]).toBe("\x1b[200~See this: \x1b[201~")
  })

  it("takes back the words and images that landed when an image never shows", async () => {
    const { prompts, written, sent } = terminal("text", { waitMs: 150 })
    expect(
      await reason(prompts.prompt("t", see, "alone", undefined, ["/up/a/one.png"], [10])),
    ).toBe("image-not-shown")
    expect(written).toEqual([
      "\x1b[200~See this: \x1b[201~",
      "\x1b[200~/up/a/one.png\x1b[201~",
      "\x15",
      "\x15",
    ])
    expect(sent).toEqual([])
  })

  it("takes out the words too where the keys for the images leave them", async () => {
    const { prompts, written, sent } = terminal("media", { waitMs: 150 })
    expect(
      await reason(
        prompts.prompt(
          "t",
          "Look  here",
          "alone",
          undefined,
          ["/up/a/one.png", "/up/b/no.txt"],
          [5, 5],
        ),
      ),
    ).toBe("image-not-shown")
    expect(written.slice(-2)).toEqual(["\x15", "\x1b"])
    expect(sent).toEqual([])
  })
})
