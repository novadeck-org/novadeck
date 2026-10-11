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
  it("are what people reviewed", () => {
    const digest = (platform: NodeJS.Platform) =>
      createHash("sha256").update(hooks(platform)).digest("hex")
    expect({ linux: digest("linux"), win32: digest("win32") }).toEqual({
      linux: "4b4d795cede153b605ffbb78bb53ce0af0e4466d95d066738a53725abdf96c0c",
      win32: "c441465c9587415b49cc821a0f02bf65501dba502c68b064b94f3f2db7b72634",
    })
  })
})
