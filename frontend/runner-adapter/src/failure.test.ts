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

  context("when the app and the runner are outside each other's window", () => {
    const behind = (side: "client" | "server") =>
      new WireError("INCOMPATIBLE_PROTOCOL", "Outside the window.", {
        data: { behind: side, server: 4, client: 3 },
      })

    it("says to update the runner when the runner is behind", () => {
      expect(connectFailure(behind("server"), true)).toEqual({
        kind: "incompatible",
        update: "runner",
        message: "The runner is older than this app. Update Novadeck where the runner runs.",
        code: "INCOMPATIBLE_PROTOCOL",
        detail: "Outside the window.",
      })
      // One the wire couldn't place came from a runner older than every window.
      expect(connectFailure(new WireError("INCOMPATIBLE_PROTOCOL"), true)).toMatchObject({
        update: "runner",
      })
    })

    it("says to update the app in the desktop app, which quits", () => {
      expect(connectFailure(behind("client"), true)).toMatchObject({
        kind: "incompatible",
        update: "app",
        message: "This app is older than its runner. Update Novadeck to connect.",
      })
      expect(connectFailure(behind("client"), true).reload).toBeUndefined()
    })

    it("offers a reload in a browser, which loads the runner's newer page", () => {
      expect(connectFailure(behind("client"), false)).toMatchObject({
        kind: "incompatible",
        update: "app",
        reload: true,
        message: "This page is older than its runner. Reload it to load the newer Novadeck.",
      })
    })
  })

  context("when the runner refuses the app", () => {
    it("says so", () => {
      expect(connectFailure(new WireError("UNAUTHORIZED"))).toMatchObject({
        kind: "unauthorized",
        message: "The runner didn't accept this app.",
      })
    })

    it("says this device was signed out once its credential is revoked, and who can let it in", () => {
      const failure = connectFailure(
        new WireError("UNAUTHORIZED", "Unauthorized", { data: { reason: "revoked" } }),
      )
      expect(failure).toEqual({
        kind: "unauthorized",
        revoked: true,
        message:
          "This device was signed out of the runner. The runner's owner can let it in again with a new credential.",
        code: "UNAUTHORIZED",
        detail: "Unauthorized",
      })
      // A reason it doesn't know is no reason: a plain refusal.
      expect(
        connectFailure(
          new WireError("UNAUTHORIZED", "Unauthorized", { data: { reason: "later" } }),
        ),
      ).not.toHaveProperty("revoked")
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
