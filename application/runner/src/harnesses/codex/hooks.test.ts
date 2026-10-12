import { createHash } from "node:crypto"
import { join } from "node:path"

import { describe, expect, it } from "../../test.js"
import type { Launchers } from "../harness.js"
import { codex } from "./index.js"

const launchers: Launchers = { mcp: { command: "/data/shell/mcp" } }

// The hooks file Novadeck's plugin gives Codex, as written.
const hooks = (platform: NodeJS.Platform) =>
  codex
    .files(platform, launchers)
    .find((each) => each.path === join("novadeck", "hooks", "hooks.json"))!.content

describe("the hooks Novadeck gives Codex", () => {
  // Codex asks every person who connected it to review its hooks again whenever their text
  // changes, as an update brings: change them only meaning to, and pin the new text here.
  // Last changed for an Interrupt hook's 3 s, Codex's most, so it warns at no start.
  it("are what people reviewed", () => {
    const digest = (platform: NodeJS.Platform) =>
      createHash("sha256").update(hooks(platform)).digest("hex")
    expect({ linux: digest("linux"), win32: digest("win32") }).toEqual({
      linux: "a8d4fb0d03a33b226c2d26d4250023d41e28a5b360b2794cf6a5cc4a91f50ccf",
      win32: "d0489122108a4f5f25045e770f098e4acd21f2e5816816db6e77cff1bad1ed3e",
    })
  })
})
