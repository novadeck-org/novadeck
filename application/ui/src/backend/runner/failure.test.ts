import { RunnerError } from "@novadeck/protocol/client"

import { context, describe, expect, it } from "../../test"
import { connectFailure } from "./index"

describe("connection failure", () => {
  context("when the runner is away or busy", () => {
    it("counts as transient, so the splash retries on its own", () => {
      const kinds = ["DISCONNECTED", "CLOSED", "RUNTIME_CLOSING", "RESOURCE_LIMIT"].map(
        (code) => connectFailure(new RunnerError(code as RunnerError["code"])).kind,
      )
      expect(kinds).toEqual(["transient", "transient", "transient", "transient"])
      expect(connectFailure(new RunnerError("DISCONNECTED")).message).toBe(
        "The runner didn't start.",
      )
    })
  })

  context("when the runner is another version or refuses the app", () => {
    it("says so and sorts them apart", () => {
      expect(connectFailure(new RunnerError("INCOMPATIBLE_PROTOCOL"))).toMatchObject({
        kind: "incompatible",
        message: "This runner is from a different NovaDeck version.",
      })
      expect(connectFailure(new RunnerError("UNAUTHORIZED"))).toMatchObject({
        kind: "unauthorized",
        message: "The runner didn't accept this app.",
      })
    })
  })

  context("with anything else", () => {
    it("says something went wrong and keeps the details", () => {
      expect(connectFailure(new RunnerError("INTERNAL_SERVER_ERROR", "boom"))).toEqual({
        kind: "unknown",
        message: "Something went wrong starting NovaDeck.",
        code: "INTERNAL_SERVER_ERROR",
        detail: "boom",
      })
      expect(connectFailure(new Error("listing broke"))).toMatchObject({
        code: "UNKNOWN",
        detail: "listing broke",
      })
    })
  })

  it("keeps the transport's own reason as the detail", () => {
    expect(
      connectFailure(new RunnerError("CLOSED", "No desktop host provides a runner.")).detail,
    ).toBe("No desktop host provides a runner.")
  })
})
