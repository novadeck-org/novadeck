import { describe, expect, it } from "../test.js"
import { decodeValue, encodeValue, shown, silenced, unwrapped } from "./autorun-value.js"

const refusal = (value: string): string | undefined => {
  const result = silenced(value)
  return "refusal" in result ? result.refusal : undefined
}

describe("the rewrite that silences an AutoRun", () => {
  it("wraps a simple command and sends its output to nul", () => {
    expect(silenced("chcp 65001")).toEqual({ value: "(chcp 65001) >nul 2>&1" })
    expect(silenced("(echo novadeck-ci: an AutoRun printed this) >nul 2>&1")).toHaveProperty(
      "refusal",
    )
  })

  it("keeps the commands a value joins with &, &&, || and |", () => {
    for (const value of ["a & b", "a && b", "a || b", "a | b"])
      expect(silenced(value)).toEqual({ value: `(${value}) >nul 2>&1` })
  })

  it("reads quotes as cmd does: a quote holds anything, and ^ is an ordinary character inside one", () => {
    // A parenthesis, a >, a % and a rem inside quotes can't move the wrapper's end.
    expect(silenced('echo "a (b) > c %NAME% rem d ^ e"')).toEqual({
      value: '(echo "a (b) > c %NAME% rem d ^ e") >nul 2>&1',
    })
    // A quote that is closed again leaves what follows outside quotes.
    expect(refusal('echo "a"(x)')).toContain("parenthesis")
  })

  it("refuses every ^ outside quotes, as an escape can spell rem or a label out of other letters", () => {
    for (const value of [
      "echo hi & r^em x",
      "^rem x",
      "^:label",
      "echo ^(x^)",
      'echo ^"(x)',
      "echo a ^& b",
      "echo a ^",
      "echo ^%PATH^%",
    ])
      expect([value, refusal(value)]).toEqual([value, expect.stringContaining("^")])
  })

  it("skips the delimiters cmd skips before a command's word when it looks for rem or a label", () => {
    for (const value of [
      ";:label",
      ",:x",
      "=:x",
      " ;, :x",
      "echo a & ;:x",
      "@:x",
      ";rem x",
      ",rem x",
    ])
      expect(refusal(value), value).toBeDefined()
  })

  it("refuses a parenthesis outside quotes, so every block and 'title Dev (x64)'", () => {
    expect(refusal("title Dev (x64)")).toContain("parenthesis")
    expect(refusal("if 1==1 (echo a)")).toContain("parenthesis")
    // Which is also what an already silenced value is.
    expect(refusal("(chcp 65001) >nul 2>&1")).toBeDefined()
  })

  it("refuses a % outside quotes, escaped or not, and keeps one inside quotes", () => {
    expect(refusal("set PATH=%PATH%;x")).toContain("%")
    expect(refusal("echo %ProgramFiles(x86)%")).toBeDefined()
    expect(silenced('echo "%NAME%"')).toEqual({ value: '(echo "%NAME%") >nul 2>&1' })
  })

  it("refuses a > outside quotes, rem as a word, :: and a label", () => {
    expect(refusal("echo a > file")).toContain(">")
    expect(refusal("echo a 2>&1")).toContain(">")
    expect(refusal("rem anything")).toContain("rem")
    expect(refusal("echo a & REM b")).toContain("rem")
    expect(refusal(":: comment")).toBeDefined()
    expect(refusal("echo a :: b")).toBeDefined()
    expect(refusal(":label")).toContain("label")
    expect(refusal("echo a & :label")).toContain("label")
    // A word that only holds rem, or a rem in quotes, is no comment.
    expect(silenced("echo remember")).toEqual({ value: "(echo remember) >nul 2>&1" })
    expect(silenced('echo "rem"')).toEqual({ value: '(echo "rem") >nul 2>&1' })
  })

  it("refuses a quote left open, a trailing ^, line breaks, NUL, a blank value and a long one", () => {
    expect(refusal('echo "open')).toContain("quote")
    expect(refusal("echo a ^")).toContain("^")
    expect(refusal("echo a\nb")).toBeDefined()
    expect(refusal("echo a\r")).toBeDefined()
    expect(refusal("echo a\0")).toBeDefined()
    expect(refusal("   ")).toContain("blank")
    expect(refusal("")).toContain("blank")
    expect(refusal(`echo ${"a".repeat(4_000)}`)).toContain("4000")
    expect(silenced(`echo ${"a".repeat(3_990)}`)).toHaveProperty("value")
  })
})

describe("the wrapper Undo takes off", () => {
  it("gives the inner value back only for exactly Novadeck's wrapper", () => {
    expect(unwrapped("(chcp 65001) >nul 2>&1")).toBe("chcp 65001")
    expect(unwrapped("(a & b) >nul 2>&1")).toBe("a & b")
    expect(unwrapped("chcp 65001")).toBeUndefined()
    expect(unwrapped("(chcp 65001) >nul")).toBeUndefined()
    expect(unwrapped("(chcp 65001)  >nul 2>&1")).toBeUndefined()
    // Somebody else's wrapper round something silenced() would refuse.
    expect(unwrapped("(if 1==1 (echo a)) >nul 2>&1")).toBeUndefined()
    expect(unwrapped("(echo a) >nul 2>&1 & echo b")).toBeUndefined()
    expect(unwrapped("() >nul 2>&1")).toBeUndefined()
  })
})

describe("an AutoRun value in normal form", () => {
  const base64 = (buffer: Buffer) => buffer.toString("base64")

  it("is the UTF-16LE text and one NUL, of type sz or expand, and encodes back to the same bytes", () => {
    const withoutNul = base64(Buffer.from("chcp 65001", "utf16le"))
    const withNul = base64(Buffer.concat([Buffer.from("chcp 65001", "utf16le"), Buffer.alloc(2)]))
    expect(decodeValue("sz", withNul)).toEqual({ kind: "sz", text: "chcp 65001" })
    expect(decodeValue("expand", withNul)).toEqual({ kind: "expand", text: "chcp 65001" })
    expect(encodeValue("chcp 65001")).toBe(withNul)
    expect(decodeValue("sz", withoutNul)).toBeUndefined()
    expect(decodeValue("other", withNul)).toBeUndefined()
  })

  it("is refused for extra NULs, an odd length, a lone surrogate, a text with NUL and bad base64", () => {
    const nul = Buffer.alloc(2)
    const text = (value: string) => Buffer.from(value, "utf16le")
    expect(decodeValue("sz", base64(Buffer.concat([text("a"), nul, nul])))).toBeUndefined()
    expect(
      decodeValue("sz", base64(Buffer.concat([text("a"), nul, Buffer.from([1])]))),
    ).toBeUndefined()
    expect(
      decodeValue("sz", base64(Buffer.concat([Buffer.from([0x00, 0xd8]), nul]))),
    ).toBeUndefined()
    expect(decodeValue("sz", "not base64!")).toBeUndefined()
    expect(decodeValue("sz", "")).toBeUndefined()
    // Non-ASCII text survives the round trip.
    expect(decodeValue("sz", encodeValue("echo Łódź"))).toEqual({ kind: "sz", text: "echo Łódź" })
  })

  it("is shown as far as it reads for a value that is not in normal form", () => {
    expect(shown(base64(Buffer.concat([Buffer.from("a b", "utf16le"), Buffer.alloc(4)])))).toBe(
      "a b",
    )
  })
})
