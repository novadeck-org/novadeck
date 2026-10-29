import { createHash } from "node:crypto"
import { join } from "node:path"

import type { Launchers } from "@novadeck/harness-core/harness"
import { describe, expect, it } from "vitest"

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
  // Last changed for the PreToolUse matcher naming the async question, `request_user_input_async`
  // (before that, an Interrupt hook's 3 s, Codex's most, so it warns at no start).
  it("are what people reviewed", () => {
    const digest = (platform: NodeJS.Platform) =>
      createHash("sha256").update(hooks(platform)).digest("hex")
    expect({ linux: digest("linux"), win32: digest("win32") }).toEqual({
      linux: "95937995adee748f8bdb8878e2702652f5c5308e881955b63912cf679bb350a0",
      win32: "58c26f8bb0ceba420dafabfe89f44ff74cf7d0ab63c4db5794a562f3ac22aa21",
    })
  })
})
