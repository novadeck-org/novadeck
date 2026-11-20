import { doorbellLine, replyLine, startLine } from "@novadeck/harness-core/prompts"

import { describe, expect, it } from "../test.js"
import {
  closingNonce,
  holdsRingLine,
  leftoverNonce,
  replyLeftover,
  ringNotice,
} from "./leftover.js"

describe("the line a failed ring left in a box", () => {
  it("is told by its nonce when it is all the box holds, wrapped anywhere", () => {
    expect(leftoverNonce(doorbellLine("n7Q2"))).toBe("n7Q2")
    expect(leftoverNonce(doorbellLine("n7Q2", ["moth", "newtz"]))).toBe("n7Q2")
    expect(leftoverNonce(startLine("n7Q2"))).toBe("n7Q2")
    // Anywhere: inside a word, a handle, or a quote.
    expect(leftoverNonce('<novadeck-door\nbell ring="n7\nQ2" from="mo\nth new\ntz"/>')).toBe("n7Q2")
  })

  it("is told for a bracket line from before the tag as well", () => {
    expect(leftoverNonce("[Novadeck: automatic notice,\nagent messages waiting, n7Q2]")).toBe(
      "n7Q2",
    )
    expect(leftoverNonce('[Novadeck Inbox reply, n7Q2] Re your ask "x": yes [n7Q2]')).toBe("n7Q2")
  })

  it("is not told when the person's text is with it, or two lines, or none", () => {
    expect(leftoverNonce(`${doorbellLine("n7Q2")} and then`)).toBeUndefined()
    expect(leftoverNonce(`Hello ${doorbellLine("n7Q2")}`)).toBeUndefined()
    expect(leftoverNonce(`${doorbellLine("n7Q2")}${doorbellLine("k3f9")}`)).toBeUndefined()
    expect(leftoverNonce("")).toBeUndefined()
  })

  it("is told for a reply line alone, wrapped anywhere, but not with text after or a second one", () => {
    const reply = replyLine([{ subject: "Merge #461?", option: "Merge it", text: "" }])!
    const line = reply("n7Q2")
    expect(leftoverNonce(line)).toBe("n7Q2")
    expect(leftoverNonce(line.replace('Re "', 'Re\n"'))).toBe("n7Q2")
    expect(leftoverNonce(`${line} and then`)).toBeUndefined()
    expect(leftoverNonce(`${line}${reply("k3f9")}`)).toBeUndefined()
    expect(leftoverNonce(`${reply("k3f9")} ${doorbellLine("n7Q2")}`)).toBeUndefined()
    // Another ring's end closes nothing.
    expect(leftoverNonce(line.replace('end ring="n7Q2"', 'end ring="k3f9"'))).toBeUndefined()
  })

  it("is the reply line's end alone when a box is too short for its head", () => {
    const line = replyLine([{ subject: "Merge #461?", option: "Merge it", text: "" }])!("n7Q2")
    expect(closingNonce(line.slice(-40))).toBe("n7Q2")
    expect(closingNonce(`${line.slice(-40)} typed after`)).toBeUndefined()
  })

  it("holds a ring's line beside the person's words, a reply line, or the plain tag", () => {
    expect(holdsRingLine(`my words ${doorbellLine("n7Q2")}`)).toBe(true)
    expect(holdsRingLine('my words <novadeck-reply ring="n7Q2">Re')).toBe(true)
    expect(holdsRingLine("my words about <novadeck-doorbell>")).toBe(false)
    expect(ringNotice(doorbellLine("n7Q2"))).toBe(true)
    expect(replyLeftover(doorbellLine("n7Q2"))).toBe(false)
    expect(replyLeftover('<novadeck-reply ring="n7Q2">Re')).toBe(true)
  })
})
