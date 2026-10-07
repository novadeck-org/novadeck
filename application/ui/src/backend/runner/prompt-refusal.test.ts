import { promptRefusal as protocolRefusal } from "@novadeck/protocol"
import { describe, expect, it } from "vitest"

import { promptRefused } from "../../model/prompt-refusal"

const cases = [
  "/tmp is full",
  "  !ls",
  "see @src/app",
  "@",
  "x @a ",
  "x @a\n",
  "a\u001bb",
  "a\u007fb",
  "a\u0085b",
  "a\rb",
  "tmp is full",
  "look at $skill",
  "costs $5",
  "hi\f",
  "\u000bhi",
  "\r",
  "a\r\nb",
  "run it!",
  "mail me@example.com now",
  "@src/app is broken",
  "a/b",
  "",
  "   ",
  "a\tb\nc",
  "look at $skill",
  "list $image-gen",
  "$",
  "costs $5",
  "pay $5 now",
  "use $skill please",
  "x\u001b[201~\u0015!touch /tmp/pwned\r",
  "hi\f",
  "\u000bhi",
  "\r",
  "a\r\nb",
  "one\r\ntwo\rthree",
  "use $pdf2",
  "use $s3-upload",
  "use $a.b",
  "use $ns:skill",
  "use $_x",
  "use $imagégen",
  "costs $1.50",
  "a $-",
  "a $.x",
  "a $é",
  "costs $5x",
]

// Shell commands, as the chat's box sends them.
const shellCases = [
  "!ls",
  "  ! git status  ",
  "!",
  "!   ",
  "! \n ",
  "!echo $",
  "!echo $HOME",
  "!echo @src",
  "!echo a\necho b",
  "!x\u001b",
  "!!",
  "/!ls",
  "!echo $5",
]

describe("The mirror of the protocol's rule", () => {
  it.each(shellCases)("agrees with it on %j as a shell command", (text) => {
    expect(promptRefused(text, { shell: true })).toBe(
      protocolRefusal(text, { shell: true }) !== undefined,
    )
  })

  it.each(cases.filter((text) => text.trim() !== ""))("agrees with it on %j", (text) => {
    expect(promptRefused(text)).toBe(protocolRefusal(text) !== undefined)
  })

  // The one difference on purpose: blank text has nothing to warn about yet in the chat.
  it.each(cases.filter((text) => text.trim() === ""))("lets %j be, which it refuses", (text) => {
    expect(promptRefused(text)).toBe(false)
    expect(protocolRefusal(text)).toBeDefined()
  })
})
