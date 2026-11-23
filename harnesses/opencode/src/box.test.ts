import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { ScreenText } from "@novadeck/emulator/headless"
import { loadProbe } from "@novadeck/harness-core/testing/probes"
import { hidesText, leftoverOf, tailOf } from "@novadeck/tui-input/box"
import { describe, expect, it } from "vitest"

import { box, shellCommandOf, shellFooter } from "./box.js"

// Probed 2026-11-22, 1.19.6 (fixtures/input-box.probe.json): the states of its box on the home
// screen, in a session, with a turn running, and at 60x20.
const { screens } = loadProbe<{ screens: { [name: string]: ScreenText } }>(
  import.meta.dirname,
  "input-box.probe.json",
)
const { screens: dialogScreens } = loadProbe<{ screens: { [name: string]: ScreenText } }>(
  import.meta.dirname,
  "dialogs.probe.json",
)
const screen = (name: string): ScreenText => {
  const found = screens[name] ?? dialogScreens[name]
  if (!found) throw new Error(`no state ${name}`)
  return found
}
const text = (name: string) => box.read(screen(name))?.text

describe("opencode's empty box", () => {
  it("reads the home screen's placeholder as empty", () => {
    expect(box.read(screen("homeEmpty"))).toMatchObject({ text: "", mode: "prompt" })
    expect(box.read(screen("homeEmpty60"))).toMatchObject({ text: "", mode: "prompt" })
  })

  it("reads a placeholder that wraps over two rows on a narrow screen as empty", () => {
    const base = screen("homeEmpty60")
    const rows = base.rows.map((row) =>
      row.includes("Ask anything")
        ? `${row.slice(0, row.indexOf("Ask"))}Ask anything… "What is the tech stack of`
        : row,
    )
    const at = rows.findIndex((row) => row.includes("Ask anything"))
    const wrapped = [
      ...rows.slice(0, at + 1),
      `${rows[at]!.slice(0, rows[at]!.indexOf("Ask"))}this project?"`,
      ...rows.slice(at + 1),
    ]
    const tall = { ...base, rows: wrapped, bright: wrapped }
    expect(box.read(tall)).toMatchObject({ text: "", first: at, last: at + 1 })
  })

  it("reads the box of a session, and of one with a turn running, as empty", () => {
    for (const name of ["sessEmpty", "sessEmpty60", "busy", "busy60", "queued"])
      expect(box.read(screen(name)), name).toMatchObject({ text: "", mode: "prompt" })
  })

  it("reads rows as the terminal gives them, each as wide as the screen with its background", () => {
    const padded = (name: string): ScreenText => {
      const shown = screen(name)
      const pad = (rows: readonly string[]) => rows.map((row) => row.padEnd(shown.columns))
      return { ...shown, rows: pad(shown.rows), bright: pad(shown.bright) }
    }
    for (const name of ["homeEmpty", "homeDraft", "typed3", "sessSlash", "busy", "sessBangCmd"])
      expect(box.read(padded(name)), name).toEqual(box.read(screen(name)))
    expect(box.read(padded("homeAt"))?.text).toBe("@")
    expect(box.queued(padded("queued"))).toBe(true)
  })

  it("does not take a draft that says the placeholder's words for one, with the cursor after them", () => {
    const empty = screen("homeEmpty")
    const first = box.read(empty)!.first
    const typed = { ...empty, cursor: { row: first, column: empty.rows[first]!.length } }
    expect(box.read(typed)?.text).toContain("Ask anything…")
  })

  it("is one row of text, the bare rows and the footer around it left out", () => {
    const found = box.read(screen("sessEmpty"))!
    expect(found.last - found.first).toBe(0)
    expect(screen("sessEmpty").rows[found.last + 2]).toContain("Build · Fake Sonnet Fake")
  })
})

describe("opencode's draft", () => {
  it("reads typed words, in a session and on the home screen, at both sizes", () => {
    expect(text("homeDraft")).toBe("hello")
    expect(text("homeDraft60")).toBe("hello")
    expect(text("sessDraft")).toBe("hi")
    expect(text("sessDraft60")).toBe("hi")
    expect(text("busyDraft")).toBe("draft in busy")
  })

  it("reads each line of a draft of several", () => {
    expect(text("typed3")).toBe("one\ntwo\nthree")
    expect(text("paste2")).toBe("a\nb")
    const tall = box.read(screen("tall12"))!
    expect(tall.text.split("\n")).toHaveLength(12)
    expect(tall.last - tall.first).toBe(11)
  })

  it("reads a wrapped line as the rows it is drawn in", () => {
    const rows = text("wrap200")!.split("\n")
    expect(rows.length).toBeGreaterThan(1)
    expect(rows.join("")).toMatch(/^w{200}$/)
  })

  it("holds a text taller than its box to the end of it, a third of the rows", () => {
    expect(box.viewport?.(40)).toBe(13)
    expect(box.viewport?.(20)).toBe(6)
    const tall = box.read(screen("tall40"))!
    expect(tall.last - tall.first + 1).toBe(box.viewport!(40))
    const narrow = box.read(screen("tall40_60"))!
    expect(narrow.text.split("\n")).toEqual(["L34", "L35", "L36", "L37", "L38", "L39"])
  })

  it("erases it row by row, Ctrl-U then Backspace", () => {
    const found = box.read(screen("typed3"))!
    expect(box.erase?.(found)).toBe("\x03")
  })
})

describe("opencode's pasted text", () => {
  it("shows three lines, or more than 150 characters, as a placeholder", () => {
    expect(text("homePaste3")).toBe("[Pasted ~3 lines]")
    expect(text("homePaste30")).toBe("[Pasted ~30 lines]")
    expect(text("sessLong")).toBe("[Pasted ~1 lines]")
    expect(text("len151")).toBe("[Pasted ~1 lines]")
    for (const name of ["homePaste3", "homePaste30", "sessLong", "len151"])
      expect(box.collapsed(box.read(screen(name))!), name).toBe(true)
  })

  it("shows two lines, and 150 characters, whole", () => {
    expect(text("paste2")).toBe("a\nb")
    expect(text("len150")!.replaceAll("\n", "")).toMatch(/^z{150}$/)
    expect(box.collapsed(box.read(screen("paste2"))!)).toBe(false)
    expect(box.collapses("a\nb")).toBe(false)
    expect(box.collapses("z".repeat(150))).toBe(false)
  })

  it("counts what collapses on the trimmed text, as it does", () => {
    expect(box.collapses("a\nb\n")).toBe(false)
    expect(box.collapses("\n\na\nb\n\n")).toBe(false)
    expect(box.collapses("a\r\nb\r\nc")).toBe(true)
    expect(box.collapses(`${"z".repeat(150)}\n\n`)).toBe(false)
  })

  it("reads a long paste shown whole, with its summary turned off, as the tail of a box that fills its viewport", () => {
    const shown = box.read(screen("noSummaryLong"))!
    expect(shown.text.split("\n")).toHaveLength(box.viewport!(40))
    expect(shown.text.endsWith("Line 40 of a paste")).toBe(true)
    expect(hidesText(box, shown, 40)).toBe(true)
    expect(
      tailOf(
        box,
        shown,
        40,
        Array.from({ length: 40 }, (_, i) => `Line ${i + 1} of a paste`).join("\n"),
      ),
    ).toBe(shown.text)
  })

  it("knows what collapses before it is pasted", () => {
    expect(box.collapses("a\nb\nc")).toBe(true)
    expect(box.collapses("z".repeat(151))).toBe(true)
  })

  it("knows a placeholder stands for more than it shows", () => {
    expect(box.stands("[Pasted ~3 lines] and then")).toBe(true)
    expect(box.stands("[Pasted ~1 lines]")).toBe(true)
    expect(box.stands("[Image 1] describe it")).toBe(true)
    expect(box.stands("a [Pasted by hand]")).toBe(false)
  })
})

describe("opencode's menus", () => {
  it("reads a / draft with its menu open as a command", () => {
    expect(text("homeSlash")).toBe("/")
    expect(text("sessSlash")).toBe("/")
    expect(text("busySlash")).toBe("/")
    expect(text("homeSlash60")).toBe("/")
    expect(box.overlay(screen("sessSlash"))).toBe(false)
    expect(leftoverOf(box, screen("sessSlash")).kind).toBe("command")
    expect(leftoverOf(box, screen("busySlash60")).kind).toBe("command")
  })

  it("reads an @ draft with its menu open as text, which stops where its rows end, as before Escape closed it", () => {
    expect(text("homeAt")).toBe("@")
    expect(text("sessAt")).toBe("@")
    expect(leftoverOf(box, screen("homeAt")).kind).toBe("text")
    expect(box.overlay(screen("homeAt"))).toBe(false)
    expect(text("homeAtEsc")).toBe("@")
    expect(box.read(screen("homeAt"))!.first).toBe(box.read(screen("homeAtEsc"))!.first)
  })

  it("is no overlay with no menu open", () => {
    for (const name of ["homeEmpty", "sessEmpty", "busy", "homeDraft", "queued"])
      expect(box.overlay(screen(name)), name).toBe(false)
  })
})

describe("opencode's dialogs over its screen", () => {
  it("count as an overlay while one is open over a box that shows under it", () => {
    for (const name of ["models", "help", "palette"]) {
      expect(box.overlay(screen(name)), name).toBe(true)
      expect(leftoverOf(box, screen(name)).kind, name).toBe("none")
    }
  })

  it("leave no box to read where they cover it", () => {
    expect(box.read(screen("models60"))).toBeUndefined()
    expect(box.read(screen("help60"))).toBeUndefined()
    expect(box.overlay(screen("models60"))).toBe(true)
  })

  it("replace the box, which then reads as none", () => {
    for (const name of ["permBash", "permBash60", "qOne", "qTwo", "qMulti", "qOne60"])
      expect(box.read(screen(name)), name).toBeUndefined()
  })

  it("draws a key prompt that shows what is typed", () => {
    expect(box.overlay(screen("connectTyped"))).toBe(true)
  })
})

describe("opencode's shell mode", () => {
  it("is entered by `!` typed, which shows its own placeholder and footer", () => {
    expect(box.read(screen("homeBang"))).toMatchObject({ mode: "shell", text: "" })
    expect(box.read(screen("homeBang60"))).toMatchObject({ mode: "shell", text: "" })
    expect(box.read(screen("sessBang"))).toMatchObject({ mode: "shell", text: "" })
    expect(shellFooter(screen("homeBang").rows)).toBe(true)
    expect(shellFooter(screen("sessEmpty").rows)).toBe(false)
  })

  it("holds a command, and a pasted one as its placeholder", () => {
    expect(box.read(screen("sessBangCmd"))).toMatchObject({ mode: "shell", text: "echo hi" })
    expect(box.read(screen("shellPaste3"))).toMatchObject({ mode: "shell" })
    expect(box.collapsed(box.read(screen("shellPaste3"))!)).toBe(true)
    expect(leftoverOf(box, screen("sessBangCmd")).kind).toBe("shell")
  })

  it("is left by Backspace in the empty box, a command erased first", () => {
    const empty = box.read(screen("sessBang"))!
    expect(box.shell.leave?.(empty)).toBe("\x7f")
    expect(box.shell.leave?.(box.read(screen("sessBangCmd"))!)).toBe("\x03\0\x7f")
  })

  it("opens a session from its home screen, and expands a placeholder as the command", () => {
    expect(box.shell.starts).toBe(true)
    expect(box.shell.expands).toBe(true)
  })

  it("reads the box once a command typed in a running turn went, with no mark of it", () => {
    expect(box.read(screen("shellMid"))).toMatchObject({ mode: "shell", text: "echo mid" })
  })
})

describe("opencode's shell command", () => {
  it("goes as written when it is one line, and as one line that evaluates the lines when it is more", () => {
    expect(shellCommandOf("  echo hi > f ", "linux")).toBe("echo hi > f")
    const many = shellCommandOf("echo a\necho b", "linux")!
    expect(many).not.toContain("\n")
    expect(shellCommandOf("echo a\necho b", "win32")).toBe(
      `Invoke-Expression ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from("echo a\necho b").toString("base64")}')))`,
    )
  })

  it("runs every line of one of several, quotes, backslashes and a heredoc included", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-shell-"))
    const script = [
      "echo 'it''s' > a.txt",
      "printf 'x\\ty\\n' >> a.txt",
      "cat <<'E' > b.txt",
      "  heredoc \\n line",
      "E",
      "echo done > c.txt",
    ].join("\n")
    execFileSync("sh", ["-c", shellCommandOf(script, "linux")!], { cwd: dir })
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("its\nx\ty\n")
    expect(readFileSync(join(dir, "b.txt"), "utf8")).toBe("  heredoc \\n line\n")
    expect(readFileSync(join(dir, "c.txt"), "utf8")).toBe("done\n")
  })
})

describe("opencode's images", () => {
  it("counts the `[Image 1]` placeholders in its box", () => {
    expect(text("sessImage")).toBe("[Image 1]")
    expect(box.images!.attached(screen("sessImage"))).toBe(1)
    expect(box.images!.attached(screen("sessEmpty"))).toBe(0)
  })

  it("takes images back out with the keys that erase the box's rows", () => {
    expect(box.images!.discard(screen("sessImage"))).toBe("\x03")
    expect(box.images!.alone).toBe(true)
  })
})

describe("opencode's interrupt", () => {
  it("is armed by a first Escape, which the row under the box says", () => {
    expect(box.armed?.(screen("busyEsc1"))).toBe(true)
    expect(box.armed?.(screen("busy"))).toBe(false)
    expect(box.armed?.(screen("sessEmpty"))).toBe(false)
  })

  it("says a turn runs by its status row, armed or not, at either size, and none at idle", () => {
    for (const name of ["busy", "busy60", "busyEsc1", "queued"])
      expect(box.working?.(screen(name)), name).toBe(true)
    for (const name of ["sessEmpty", "sessEmpty60", "homeEmpty", "sessSlash"])
      expect(box.working?.(screen(name)), name).toBe(false)
  })

  it("drops a shell command typed while a turn runs", () => {
    expect(box.shell.midTurn).toBe("drops")
  })
})

describe("opencode's sent prompt", () => {
  it("is taken once its first line stands in the history with the assistant's row after it", () => {
    const home = screen("homeEmpty")
    expect(box.echoed?.(screen("sessEmpty"), "SLOW one", home)).toBe(true)
    expect(box.echoed?.(screen("sessEmpty"), "SLOW one\nand more", home)).toBe(true)
    // Typed in the box, not yet sent: nothing new in the history.
    expect(box.echoed?.(screen("sessDraft"), "hi", screen("sessDraft"))).toBe(false)
  })

  it("is not taken for an earlier prompt with the same words, until one more stands there", () => {
    const sent = screen("sessEmpty")
    expect(box.echoed?.(sent, "SLOW one", sent)).toBe(false)
    // The same prompt a second time: another row of it, with the assistant's row after.
    const rows = [...sent.rows]
    const at = rows.findIndex((row) => row.includes("┃  SLOW one"))
    const again = {
      ...sent,
      rows: [
        ...rows.slice(0, at + 3),
        "  ┃",
        "  ┃  SLOW one",
        "  ┃",
        "     ▣  Build · Fake Sonnet",
        ...rows.slice(at + 3).slice(4),
      ],
    }
    expect(box.echoed?.(again, "SLOW one", sent)).toBe(true)
  })

  it("is taken on any new prompt row where its first line shows otherwise, on a narrow screen", () => {
    const sent = screen("sessEmpty60")
    const rows = [...sent.rows]
    const at = rows.findIndex((row) => row.includes("┃  SLOW one"))
    const longer = {
      ...sent,
      rows: [
        ...rows.slice(0, at + 3),
        "  ┃",
        "  ┃  a prompt that wrapped before",
        "  ┃",
        "     ▣  Build",
        ...rows.slice(at + 3).slice(4),
      ],
    }
    expect(box.echoed?.(longer, "a prompt that wrapped before its thirtieth character", sent)).toBe(
      true,
    )
    expect(box.echoed?.(sent, "a prompt that wrapped before its thirtieth character", sent)).toBe(
      false,
    )
  })

  it("is taken as queued once its badge stands under it", () => {
    expect(box.echoed?.(screen("queued"), "second while busy")).toBe(true)
  })
})

describe("opencode's queued messages", () => {
  it("shows one sent mid-turn under its own words with a QUEUED badge", () => {
    expect(box.queued(screen("queued"))).toBe(true)
    expect(box.queued(screen("busy"))).toBe(false)
    expect(box.queued(screen("sessEmpty"))).toBe(false)
  })
})

describe("opencode's widths", () => {
  it("lets a word reach nine columns short of the screen, and 70 on the home screen's centred box", () => {
    expect(box.textWidth(60)).toBe(51)
    expect(box.textWidth(80)).toBe(70)
    expect(box.textWidth(120)).toBe(70)
    expect(box.textWidth(200)).toBe(70)
  })

  it("gives a draft the box's room: a third of the rows", () => {
    expect(box.room(40)).toBe(13)
    expect(box.room(2)).toBe(1)
  })
})
