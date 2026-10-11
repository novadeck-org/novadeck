import { context, describe, expect, it } from "../../test"
import { parseInline, parseMarkdown, safeHref } from "./markdown-parse"

const kinds = (text: string) => parseMarkdown(text).map((block) => block.t)

describe("markdown blocks", () => {
  it("reads paragraphs, headings and rules", () => {
    expect(kinds("# Title\n\nSome *text*.\n\n---\n\n### Sub")).toEqual(["h", "p", "hr", "h"])
    expect(parseMarkdown("## Two")[0]).toMatchObject({ t: "h", level: 2 })
  })

  it("joins the lines of a paragraph and breaks at two trailing spaces", () => {
    const [block] = parseMarkdown("one\ntwo  \nthree")
    expect(block).toMatchObject({ t: "p" })
    expect(block!.t === "p" && block!.inline.map((node) => node.t)).toEqual(["text", "br", "text"])
  })

  it("reads fenced code with its language, and an unclosed fence to the end", () => {
    expect(parseMarkdown("```ts\nconst a = 1\n```\nafter")).toEqual([
      { t: "code", lang: "ts", text: "const a = 1" },
      { t: "p", inline: [{ t: "text", text: "after" }] },
    ])
    expect(parseMarkdown("```\nstill coming")).toEqual([
      { t: "code", lang: "", text: "still coming" },
    ])
  })

  it("keeps markup inside code as text", () => {
    expect(parseMarkdown("```\n<script>alert(1)</script> **x**\n```")[0]).toMatchObject({
      text: "<script>alert(1)</script> **x**",
    })
  })

  it("reads bullet and numbered lists, nested", () => {
    const [list] = parseMarkdown("- a\n- b\n  - c\n  - d\n- e")
    expect(list).toMatchObject({ t: "list", ordered: false })
    expect(list!.t === "list" && list!.items).toHaveLength(3)
    const nested = list!.t === "list" ? list!.items[1]!.map((block) => block.t) : []
    expect(nested).toEqual(["p", "list"])
    const [numbered] = parseMarkdown("3. x\n4. y")
    expect(numbered).toMatchObject({ t: "list", ordered: true, start: 3 })
  })

  it("tells a tight list from a loose one", () => {
    expect(parseMarkdown("- a\n- b")[0]).toMatchObject({ tight: true })
    expect(parseMarkdown("- a\n\n- b")[0]).toMatchObject({ tight: false })
    expect(parseMarkdown("- a\n\n  more\n- b")[0]).toMatchObject({ tight: false })
  })

  it("starts a list after a paragraph without a blank line", () => {
    expect(kinds("Steps:\n- one\n- two")).toEqual(["p", "list"])
  })

  it("reads quotes, recursively", () => {
    const [quote] = parseMarkdown("> a\n> - b")
    expect(quote).toMatchObject({ t: "quote" })
    expect(quote!.t === "quote" && quote!.blocks.map((block) => block.t)).toEqual(["p", "list"])
  })

  it("reads tables with alignment", () => {
    const [table] = parseMarkdown("| a | b |\n| :-- | --: |\n| 1 | 2 |\n| 3 |")
    expect(table).toMatchObject({ t: "table", align: ["left", "right"] })
    expect(table!.t === "table" && table!.rows).toHaveLength(2)
    expect(table!.t === "table" && table!.rows[1]!).toHaveLength(2)
  })

  it("leaves a lone pipe line as a paragraph", () => {
    expect(kinds("a | b")).toEqual(["p"])
  })
})

const plain = (text: string) => JSON.stringify(parseInline(text))

describe("markdown inline", () => {
  it("reads emphasis, strong and strikethrough", () => {
    expect(parseInline("a **b** *c* ~~d~~").map((node) => node.t)).toEqual([
      "text",
      "strong",
      "text",
      "em",
      "text",
      "del",
    ])
  })

  it("leaves snake_case and lone stars alone", () => {
    expect(parseInline("use snake_case_name and 2 * 3 * 4")).toEqual([
      { t: "text", text: "use snake_case_name and 2 * 3 * 4" },
    ])
  })

  it("reads inline code without reading its inside", () => {
    expect(parseInline("run `a **b**` now")).toEqual([
      { t: "text", text: "run " },
      { t: "code", text: "a **b**" },
      { t: "text", text: " now" },
    ])
  })

  it("honours escapes", () => {
    expect(parseInline("\\*not\\*")).toEqual([{ t: "text", text: "*not*" }])
  })

  it("reads links and bare addresses, giving back sentence punctuation", () => {
    expect(parseInline("[docs](https://example.com/a)")).toEqual([
      { t: "link", href: "https://example.com/a", children: [{ t: "text", text: "docs" }] },
    ])
    expect(parseInline("see https://example.com/x.")).toEqual([
      { t: "text", text: "see " },
      {
        t: "link",
        href: "https://example.com/x",
        children: [{ t: "text", text: "https://example.com/x" }],
      },
      { t: "text", text: "." },
    ])
  })

  context("with an address that could do harm", () => {
    it.each([
      "javascript:alert(1)",
      "data:text/html,<b>x</b>",
      "file:///etc/passwd",
      "https://user:pass@evil.example/",
    ])("shows %s as text, not a link", (href) => {
      expect(safeHref(href)).toBeUndefined()
      expect(plain(`[click](${href})`)).not.toContain('"link"')
    })

    it("allows web addresses, and not mail, which the desktop host won't open", () => {
      expect(safeHref("https://example.com")).toBe("https://example.com/")
      expect(safeHref("mailto:a@b.co")).toBeUndefined()
    })

    it("keeps raw HTML as text", () => {
      expect(parseInline("<img src=x onerror=alert(1)>")).toEqual([
        { t: "text", text: "<img src=x onerror=alert(1)>" },
      ])
    })
  })
})

describe("markdown on pathological text", () => {
  const size = 16 * 1024
  it.each([
    ["unclosed stars", "*a ".repeat(size / 3)],
    ["unclosed double stars", "**a ".repeat(size / 4)],
    ["unclosed underscores", "_a ".repeat(size / 3)],
    ["unclosed brackets", "[a ".repeat(size / 3)],
    ["nested brackets", "[".repeat(size)],
    ["unclosed backticks of changing length", "`a ``b ```c ".repeat(size / 12)],
    ["links without addresses", "[a](".repeat(size / 4)],
    ["blank lines in a list", "- a\n\n".repeat(size / 5)],
    ["unclosed tildes", "~~a ".repeat(size / 4)],
  ])("reads %s in well under the second a quadratic reading took", (_name, text) => {
    // Warmed up first, so the bound measures the reading, not the compiler; generous for
    // slow CI machines, yet far below the ~1 s a quadratic reading took here. The quickest
    // of three readings counts: a busy machine slows one now and then (433 ms once on a
    // Windows runner), never every one of a quadratic reading's.
    parseMarkdown(text.slice(0, 1024))
    const took = Math.min(
      ...[1, 2, 3].map(() => {
        const started = performance.now()
        parseMarkdown(text)
        return performance.now() - started
      }),
    )
    expect(took).toBeLessThan(400)
  })
})
