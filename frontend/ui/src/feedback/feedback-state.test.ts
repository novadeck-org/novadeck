import { context, describe, expect, it } from "../test"
import {
  buttonText,
  countShown,
  enterSends,
  feedbackLimit,
  nextSend,
  privacyText,
  promptFor,
} from "./feedback-state"

const bare = { ctrlKey: false, metaKey: false, shiftKey: false }

describe("the prompts", () => {
  it("ask for what the picked kind is about", () => {
    expect(promptFor(null)).toBe("What's broken, missing or good?")
    expect(promptFor("bug")).toBe("What went wrong? What did you expect?")
    expect(promptFor("idea")).toBe("What would help?")
    expect(promptFor("other")).toBe("What's on your mind?")
  })
})

describe("the count", () => {
  it("shows only near the limit", () => {
    expect(countShown(0)).toBe(false)
    expect(countShown(1_500)).toBe(false)
    expect(countShown(1_800)).toBe(true)
    expect(countShown(feedbackLimit)).toBe(true)
  })
})

describe("which Enter sends", () => {
  it("sends a one-line note, and types a new line once there is one", () => {
    expect(enterSends(bare, "one line")).toBe(true)
    expect(enterSends(bare, "two\nlines")).toBe(false)
    expect(enterSends({ ...bare, shiftKey: true }, "one line")).toBe(false)
  })

  it("always sends with Ctrl or ⌘", () => {
    expect(enterSends({ ...bare, ctrlKey: true }, "two\nlines")).toBe(true)
    expect(enterSends({ ...bare, metaKey: true }, "two\nlines")).toBe(true)
  })
})

describe("the send's states", () => {
  it("goes from idle to sending to sent, and back to idle", () => {
    const sending = nextSend("idle", "send")
    expect(sending).toBe("sending")
    const sent = nextSend(sending, "resolved")
    expect(sent).toBe("sent")
    expect(nextSend(sent, "expired")).toBe("idle")
  })

  it("lands on failed when the send rejects, and sends again from there", () => {
    const failed = nextSend("sending", "rejected")
    expect(failed).toBe("failed")
    expect(nextSend(failed, "send")).toBe("sending")
    expect(nextSend(failed, "expired")).toBe("failed")
  })
})

context("the button's words", () => {
  it("shows the word only until the card was opened, and the outcome of a send", () => {
    expect(buttonText("idle", false)).toBe("Feedback")
    expect(buttonText("idle", true)).toBeNull()
    expect(buttonText("sent", true)).toBe("Sent · thanks")
    expect(buttonText("failed", true)).toBe("Not sent · Retry")
  })

  it("puts the app's version and OS in the privacy line", () => {
    expect(privacyText({ version: "0.15.0", os: "Linux x64" })).toBe(
      "Anonymous. We get this note, 0.15.0, Linux x64.",
    )
  })
})
