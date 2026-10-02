import { context, describe, expect, it } from "../../test"
import { highlightLines, languageOf, type HighlightedLine } from "./highlight"

// Each run's text with its classes, plain text as is.
const runs = (line: HighlightedLine | undefined) =>
  line?.map(({ text, classes }) => (classes ? `${text}:${classes}` : text))

describe("file highlighting", () => {
  context("when choosing a language", () => {
    it("goes by the file's extension, in any case and at any depth", () => {
      expect(languageOf("src/content/projects.json")).toBe("json")
      expect(languageOf("src/pages/Home.tsx")).toBe("tsx")
      expect(languageOf("README.MD")).toBe("markdown")
      expect(languageOf("include/vec.hpp")).toBe("cpp")
    })

    it("knows none for an unknown extension, no extension, or a dotfile", () => {
      expect(languageOf("notes.txt")).toBeUndefined()
      expect(languageOf("Makefile")).toBeUndefined()
      expect(languageOf("config/.env")).toBeUndefined()
      expect(languageOf("archive.tar.gz/README")).toBeUndefined()
    })
  })

  it("leaves a file it doesn't know as plain text", async () => {
    expect(await highlightLines("notes.txt", ["hello"])).toBeNull()
  })

  it("keeps one line of runs per line, blank lines included, with the text unchanged", async () => {
    const lines = ["{", '  "slug": "harbour-press",', "", '  "year": 2025', "}"]
    const highlighted = await highlightLines("projects.json", lines)
    expect(highlighted).toHaveLength(lines.length)
    expect(highlighted!.map((line) => line.map((run) => run.text).join(""))).toEqual(lines)
    expect(highlighted![2]).toEqual([])
    expect(highlighted![1]!.map((run) => run.from)).toEqual(
      highlighted![1]!.map((_, at) =>
        highlighted![1]!.slice(0, at).reduce((length, run) => length + run.text.length, 0),
      ),
    )
  })

  it("classes JSON keys, strings and numbers", async () => {
    const highlighted = await highlightLines("projects.json", [
      '{ "slug": "harbour-press", "year": 2025, "featured": true }',
    ])
    expect(runs(highlighted![0])).toEqual(
      expect.arrayContaining([
        '"slug":tok-propertyName',
        '"harbour-press":tok-string',
        "2025:tok-number",
        "true:tok-bool",
      ]),
    )
  })

  it("parses TSX with its types and markup", async () => {
    const highlighted = await highlightLines("Home.tsx", [
      "export default function Home(): JSX.Element {",
      '  return <main className="home" />',
      "}",
    ])
    expect(runs(highlighted![0])).toEqual(
      expect.arrayContaining(["export:tok-keyword", "Home:tok-variableName tok-definition"]),
    )
    expect(runs(highlighted![1])).toEqual(expect.arrayContaining(["main:tok-typeName"]))
  })

  it("colours every line of a construct that spans lines", async () => {
    const highlighted = await highlightLines("a.ts", ["/* one", "two */", "let x = 1"])
    expect(runs(highlighted![0])).toEqual(["/* one:tok-comment"])
    expect(runs(highlighted![1])).toEqual(["two */:tok-comment"])
  })
})
