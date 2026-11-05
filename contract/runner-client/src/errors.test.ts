import type { contract } from "@novadeck/protocol"
import { WireError } from "@novadeck/wire"
import type { Session } from "@novadeck/wire/client"
import { ORPCError } from "@orpc/server"
import { describe as context, describe, expect, it } from "vitest"

import { lost } from "./errors.js"

// Only its channel is looked at.
const session = (open: boolean) =>
  ({ channel: { open, closed: new Promise<void>(() => {}) } }) as unknown as Session<
    typeof contract
  >

describe("lost", () => {
  context("with the runner's error", () => {
    it("gives its code, open channel or not", () => {
      const error = new ORPCError("TERMINAL_NOT_FOUND", { status: 404, message: "Gone." })
      for (const open of [true, false]) {
        const result = lost(error, session(open))
        expect(result).toBeInstanceOf(WireError)
        expect(result).toMatchObject({ code: "TERMINAL_NOT_FOUND", message: "Gone." })
      }
    })
  })

  context("with a failure that isn't the runner's", () => {
    it("says the connection was lost when the channel is closed", () => {
      const cause = new SyntaxError("Unexpected token")
      expect(lost(cause, session(false))).toMatchObject({ code: "DISCONNECTED", cause })
    })

    it("still gives a code when the channel is open", () => {
      const cause = new TypeError("Cannot read properties of null")
      const result = lost(cause, session(true))
      expect(result).toBeInstanceOf(WireError)
      expect(result).toMatchObject({
        code: "INTERNAL_SERVER_ERROR",
        message: "Cannot read properties of null",
        cause,
      })
    })
  })

  context("with a wire error", () => {
    it("passes it on as it is", () => {
      const error = new WireError("SLOW_CONSUMER")
      expect(lost(error, session(false))).toBe(error)
    })
  })
})
