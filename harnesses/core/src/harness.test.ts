import { describe, expect, it } from "vitest"

import { silentFor, type MessagingProfile } from "./harness.js"

const profile = { silent: { "*": "{}", PreToolUse: '{"decision":"ask"}' } } as Pick<
  MessagingProfile,
  "silent"
> as MessagingProfile

describe("what a hook prints with nothing to deliver", () => {
  it("is its event's own answer, else the one for every event", () => {
    expect(silentFor(profile, "PreToolUse")).toBe('{"decision":"ask"}')
    expect(silentFor(profile, "Stop")).toBe("{}")
  })

  it("is never what an object inherits, whatever the event is named", () => {
    for (const event of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"])
      expect(silentFor(profile, event)).toBe("{}")
  })
})
