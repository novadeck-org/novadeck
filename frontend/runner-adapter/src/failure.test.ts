import { WireError } from "@novadeck/wire"

import { connectFailure } from "./index"
import { context, describe, expect, it } from "./test"

describe("connection failure", () => {
  context("when the runner is away or busy", () => {
    it("counts as transient, so the splash retries on its own", () => {
      const kinds = ["DISCONNECTED", "CLOSED", "CLOSING", "RESOURCE_LIMIT"].map(
        (code) => connectFailure(new WireError(code)).kind,
      )
      expect(kinds).toEqual(["transient", "transient", "transient", "transient"])
      expect(connectFailure(new WireError("DISCONNECTED")).message).toBe("The runner didn't start.")
    })
  })

  context("when the runner is another version or refuses the app", () => {
    it("says so and sorts them apart", () => {
      expect(connectFailure(new WireError("INCOMPATIBLE_PROTOCOL"))).toMatchObject({
        kind: "incompatible",
        message: "This runner is from a different Novadeck version.",
      })
      expect(connectFailure(new WireError("UNAUTHORIZED"))).toMatchObject({
        kind: "unauthorized",
        message: "The runner didn't accept this app.",
      })
    })
  })

  context("when a newer Novadeck has used the workspace", () => {
    it("says this copy is out of date, as a failure only Quit answers", () => {
      expect(connectFailure(new WireError("WORKSPACE_TOO_NEW"))).toMatchObject({
        kind: "outdated",
        code: "WORKSPACE_TOO_NEW",
        message:
          "A newer version of Novadeck has used this workspace. Open the newer Novadeck instead; this copy is out of date.",
      })
    })
  })

  context("with anything else", () => {
    it("says something went wrong and keeps the details", () => {
      expect(connectFailure(new WireError("INTERNAL_SERVER_ERROR", "boom"))).toEqual({
        kind: "unknown",
        message: "Something went wrong starting Novadeck.",
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
      connectFailure(new WireError("CLOSED", "No desktop app provides a runner.")).detail,
    ).toBe("No desktop app provides a runner.")
  })
})
