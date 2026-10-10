import { updateNoteLength, updateNotesLength } from "@novadeck/protocol/bridge"

import { context, describe, expect, it } from "../test"
import { releaseNamed, releaseNotesLines, updateNotesLines } from "./update-notes"

describe("release notes for the page", () => {
  it("makes a line of each list item", () => {
    const html =
      "<h2>What's new</h2>\n<ul>\n<li>Faster startup.</li>\n<li>A <code>--help</code> flag.</li>\n</ul>"
    expect(releaseNotesLines(html)).toEqual(["What's new", "Faster startup.", "A --help flag."])
  })

  it("makes a line of each paragraph and line break", () => {
    expect(releaseNotesLines("<p>First.</p><p>Second<br>and third.</p>")).toEqual([
      "First.",
      "Second",
      "and third.",
    ])
  })

  it("keeps the text of nested lists and links", () => {
    const html =
      '<ul><li>One<ul><li>Inner <a href="https://example.com">link</a>.</li></ul></li></ul>'
    expect(releaseNotesLines(html)).toEqual(["One", "Inner link."])
  })

  it("decodes entities once, and keeps text that looks like an entity but is not one", () => {
    expect(
      releaseNotesLines("<li>Fish &amp; chips &#8212; &#x2603; &quot;ok&quot; &nbsp;done</li>"),
    ).toEqual(['Fish & chips — ☃ "ok" done'])
    expect(releaseNotesLines("<li>&amp;lt; stays &unknown; and &#1114112;</li>")).toEqual([
      "&lt; stays &unknown; and",
    ])
  })

  it("gives no lines for notes with no text, or that are not notes", () => {
    for (const value of ["", "   ", "<ul></ul>", null, undefined, 3, {}, []])
      expect(releaseNotesLines(value)).toEqual([])
  })

  it("reads a full changelog's list of notes in order", () => {
    const notes = [
      { version: "1.1.0", note: "<li>Newer.</li>" },
      { version: "1.0.0", note: "<li>Older.</li>" },
      { version: "0.9.0", note: null },
      "not an entry",
    ]
    expect(releaseNotesLines(notes)).toEqual(["Newer.", "Older."])
  })

  context("with hostile input", () => {
    it("drops markup, scripts and what they contain", () => {
      const html =
        '<li>Safe</li><script>alert("x")</script><style>body{display:none}</style><li><img src=x onerror="alert(1)">Image</li><!-- <b>hidden</b> -->'
      expect(releaseNotesLines(html)).toEqual(["Safe", "Image"])
    })

    it("never lets an escaped tag come back as markup", () => {
      const lines = releaseNotesLines(
        "<li>&lt;img src=x onerror=alert(1)&gt;</li><li>&lt;script&gt;x&lt;/script&gt;</li>",
      )
      expect(lines).toEqual(["img src=x onerror=alert(1)", "scriptx/script"])
      for (const line of lines) expect(line).not.toMatch(/[<>]/u)
    })

    it("replaces control, direction and zero-width characters, and entities that make them", () => {
      const html = "<li>a\u0000b\u0007c‮d⁦e​f g﻿h&#0;i&#x202e;j&#1;k</li>"
      const [line, ...rest] = releaseNotesLines(html)
      expect(rest).toEqual([])
      expect(line).toBe("a b c d e f g h i j k")
    })

    it("survives unterminated tags and huge input quickly, without leaving markup", () => {
      const started = Date.now()
      const [line, ...rest] = releaseNotesLines(`<li>start${"<a ".repeat(100_000)}`)
      expect(rest).toEqual([])
      expect(line).toMatch(/^start/u)
      expect(line).not.toMatch(/[<>]/u)
      expect(releaseNotesLines("x".repeat(1_000_000))).toHaveLength(1)
      expect(Date.now() - started).toBeLessThan(1_000)
    })
  })

  context("within the page's caps", () => {
    it("cuts a long line to the length a note may have", () => {
      const [line] = releaseNotesLines(`<li>${"w".repeat(500)}</li>`)
      expect(Array.from(line!)).toHaveLength(updateNoteLength)
      expect(line!.endsWith("…")).toBe(true)
    })

    it("does not split a character when cutting", () => {
      const [line] = releaseNotesLines(`<li>${"\u{1F600}".repeat(500)}</li>`)
      expect(Array.from(line!)).toHaveLength(updateNoteLength)
      expect(line).not.toMatch(/[\ud800-\udfff](?![\udc00-\udfff])/u)
    })

    it("keeps no more lines than an offer may carry", () => {
      const html = Array.from({ length: 40 }, (_, index) => `<li>Note ${index}</li>`).join("")
      const lines = releaseNotesLines(html)
      expect(lines).toHaveLength(updateNotesLength)
      expect(lines[0]).toBe("Note 0")
    })
  })
})

describe("common named entities", () => {
  it("decode to their characters", () => {
    const html =
      "<li>Wait&hellip; a&mdash;b c&ndash;d &lsquo;x&rsquo; &ldquo;y&rdquo; &bull; &copy; &rarr;</li>"
    expect(releaseNotesLines(html)).toEqual([
      "Wait\u2026 a\u2014b c\u2013d \u2018x\u2019 \u201cy\u201d \u2022 \u00a9 \u2192",
    ])
  })
})

describe("whose release the notes are", () => {
  it("is the release named for the version, with or without the v", () => {
    expect(releaseNamed("Novadeck v1.2.3", "1.2.3")).toBe(true)
    expect(releaseNamed("v1.2.3", "1.2.3")).toBe(true)
    expect(releaseNamed("1.2.3", "1.2.3")).toBe(true)
    expect(releaseNamed(" Novadeck 1.2.3 ", "1.2.3")).toBe(true)
  })

  it("is not another release, nor one without a name", () => {
    for (const name of [
      "Novadeck v1.2.4",
      "Novadeck v11.2.3",
      "Novadeck v1.2.3-beta.1",
      "",
      null,
      undefined,
      3,
    ])
      expect(releaseNamed(name, "1.2.3")).toBe(false)
  })

  it("gives the notes only for the named release", () => {
    const notes = "<li>Faster.</li>"
    const info = { version: "1.2.3", releaseNotes: notes }
    expect(updateNotesLines({ ...info, releaseName: "Novadeck v1.2.3" })).toEqual(["Faster."])
    // The updater fell back to the newest entry of the feed, another version's.
    expect(updateNotesLines({ ...info, releaseName: "Novadeck v1.2.4" })).toEqual([])
    expect(updateNotesLines(info)).toEqual([])
  })
})
