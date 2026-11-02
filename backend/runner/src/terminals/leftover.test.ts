import { doorbellLine, replyLine } from "@novadeck/harness-core/prompts"

import { describe, expect, it } from "../test.js"
import { leftoverNonce } from "./leftover.js"

describe("the line a failed ring left in a box", () => {
  it("is told by its nonce when it is all the box holds, wrapped anywhere", () => {
    expect(leftoverNonce(doorbellLine("n7Q2"))).toBe("n7Q2")
    expect(leftoverNonce("[Novadeck: automatic notice,\nagent messages waiting, n7Q2]")).toBe(
      "n7Q2",
    )
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
  })
})
