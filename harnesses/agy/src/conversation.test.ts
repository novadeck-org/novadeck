import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { conversation } from "./conversation.js"

const id = "54b55b93-27d6-484f-be89-dd7c2fbf2081"
let home = ""
const install = () => ({ env: {}, home, platform: process.platform, plugin: "" })
const store = () => join(home, ".gemini", "antigravity-cli")
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agy-conversation-"))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe("Antigravity's conversation", () => {
  it("is found by its database, gone without it, and unknown with no conversations folder", async () => {
    expect(await conversation(install(), id)).toBe("unknown")
    mkdirSync(join(store(), "conversations"), { recursive: true })
    expect(await conversation(install(), id)).toBe("gone")
    writeFileSync(join(store(), "conversations", `${id}.db`), "")
    expect(await conversation(install(), id)).toBe("found")
  })

  it("is not kept alive by the brain folder a removed conversation leaves", async () => {
    mkdirSync(join(store(), "conversations"), { recursive: true })
    mkdirSync(join(store(), "brain", id), { recursive: true })
    expect(await conversation(install(), id)).toBe("gone")
  })

  it("is unknown when conversations is a file, not a folder", async () => {
    mkdirSync(store(), { recursive: true })
    writeFileSync(join(store(), "conversations"), "")
    expect(await conversation(install(), id)).toBe("unknown")
  })

  it("reads the home its brain transcript names, though the install's own has none", async () => {
    const wrapped = join(home, "elsewhere", "antigravity-cli")
    mkdirSync(join(wrapped, "conversations"), { recursive: true })
    writeFileSync(join(wrapped, "conversations", `${id}.db`), "")
    const transcript = join(wrapped, "brain", id, "logs", "00000000.jsonl")
    expect(await conversation(install(), id)).toBe("unknown")
    expect(await conversation(install(), id, { transcript })).toBe("found")
    rmSync(join(wrapped, "conversations", `${id}.db`))
    expect(await conversation(install(), id, { transcript })).toBe("gone")
  })
})
