import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, vi } from "vitest"

import { describe, expect, it } from "../../test.js"
import { failureMs, forgetTrust, hooksTrusted, trustedIn } from "./trust.js"

// One hook as Codex's app-server lists it, as probed with 0.159.3.
const hook = (
  eventName: string,
  trustStatus: string,
  pluginId: string | null = "novadeck@novadeck",
) => ({
  key: `${pluginId ?? "/home/user/.codex/hooks.json"}:${eventName}:0:0`,
  eventName,
  pluginId,
  trustStatus,
})
const listed = (...hooks: object[]) => ({ data: [{ cwd: "/work", hooks }] })
const ours = ["sessionStart", "userPromptSubmit", "stop"]

describe("Novadeck's Codex hooks", () => {
  it("run once each one it needs is trusted", () => {
    expect(trustedIn(listed(...ours.map((event) => hook(event, "trusted"))))).toBe(true)
  })

  it("don't run while any it needs is untrusted, changed since trusted, or missing", () => {
    for (const status of ["untrusted", "modified"])
      expect(
        trustedIn(
          listed(...ours.map((event, index) => hook(event, index === 1 ? status : "trusted"))),
        ),
      ).toBe(false)
    expect(trustedIn(listed(hook("sessionStart", "trusted"), hook("stop", "trusted")))).toBe(false)
  })

  it("count only Novadeck's plugin's, and nothing Codex couldn't list", () => {
    expect(trustedIn(listed(...ours.map((event) => hook(event, "trusted", null))))).toBe(false)
    expect(trustedIn(undefined)).toBe(false)
    expect(trustedIn({ data: "x" })).toBe(false)
  })
})

// Changes a file's time, as an edit would.
const touch = (path: string, at: number) => utimesSync(path, at / 1000, at / 1000)

// A stand-in `codex app-server`: it answers `hooks/list` with what `answer.json` holds,
// and counts each start.
const standIn = (folder: string): string => {
  const program = join(folder, "codex")
  writeFileSync(
    program,
    [
      `#!${process.execPath}`,
      'const fs = require("node:fs")',
      'const dir = require("node:path").dirname(process.argv[1])',
      'fs.appendFileSync(dir + "/starts", "x")',
      'const answer = JSON.parse(fs.readFileSync(dir + "/answer.json", "utf8"))',
      'let buffered = ""',
      'process.stdin.on("data", (chunk) => {',
      "  buffered += chunk",
      '  for (const line of buffered.split("\\n").slice(0, -1)) {',
      "    const message = JSON.parse(line)",
      '    if (message.id === 1) process.stdout.write(JSON.stringify({ id: 1, result: {} }) + "\\n")',
      '    if (message.id === 2) process.stdout.write(JSON.stringify({ id: 2, result: answer }) + "\\n")',
      "  }",
      '  buffered = buffered.slice(buffered.lastIndexOf("\\n") + 1)',
      "})",
    ].join("\n"),
  )
  chmodSync(program, 0o755)
  return program
}

describe.skipIf(process.platform === "win32")("asking Codex whether Novadeck's hooks run", () => {
  let folder: string
  let home: string
  let where: Parameters<typeof hooksTrusted>[0]
  const answer = (value: unknown) =>
    writeFileSync(join(folder, "answer.json"), JSON.stringify(value))
  const starts = () => {
    try {
      return readFileSync(join(folder, "starts"), "utf8").length
    } catch {
      return 0
    }
  }
  const trusted = listed(...ours.map((event) => hook(event, "trusted")))
  beforeEach(() => {
    forgetTrust()
    folder = mkdtempSync(join(tmpdir(), "novadeck-trust-"))
    home = join(folder, "codex-home")
    mkdirSync(join(home, "plugins", "cache", "novadeck", "novadeck", "1.2.0", "hooks"), {
      recursive: true,
    })
    writeFileSync(join(home, "config.toml"), "")
    writeFileSync(
      join(home, "plugins", "cache", "novadeck", "novadeck", "1.2.0", "hooks", "hooks.json"),
      "{}",
    )
    where = {
      env: { CODEX_HOME: home, PATH: process.env.PATH },
      home: folder,
      platform: process.platform,
      plugin: "",
      program: standIn(folder),
    }
  })
  afterEach(() => {
    vi.useRealTimers()
    rmSync(folder, { recursive: true, force: true })
  })

  it("asks its app-server once, and keeps the answer while nothing it rests on changes", async () => {
    answer(trusted)
    expect(await hooksTrusted(where, "/work")).toBe(true)
    expect(await hooksTrusted(where, "/work")).toBe(true)
    expect(starts()).toBe(1)
    // Another folder may run other hooks.
    await hooksTrusted(where, "/elsewhere")
    expect(starts()).toBe(2)
  })

  it("asks again once Codex's configuration or Novadeck's hook definitions change", async () => {
    answer(trusted)
    await hooksTrusted(where, "/work")
    answer(listed(hook("sessionStart", "trusted")))
    touch(join(home, "config.toml"), Date.now() + 5_000)
    expect(await hooksTrusted(where, "/work")).toBe(false)
    answer(trusted)
    touch(
      join(home, "plugins", "cache", "novadeck", "novadeck", "1.2.0", "hooks", "hooks.json"),
      Date.now() + 9_000,
    )
    expect(await hooksTrusted(where, "/work")).toBe(true)
    expect(starts()).toBe(3)
  })

  it("shares an ask under way", async () => {
    answer(trusted)
    const both = await Promise.all([hooksTrusted(where, "/work"), hooksTrusted(where, "/work")])
    expect(both).toEqual([true, true])
    expect(starts()).toBe(1)
  })

  it("takes a program that can't start as unknown, never untrusted, asking again only a while later", async () => {
    const missing = { ...where, program: join(folder, "no-codex-here") }
    vi.useFakeTimers({ toFake: ["Date"] })
    expect(await hooksTrusted(missing, "/work")).toBeUndefined()
    answer(trusted)
    expect(await hooksTrusted(where, "/work")).toBe(true)
    // The same program and folder as the failure: kept for a while, then asked again.
    expect(await hooksTrusted(missing, "/work")).toBeUndefined()
    vi.setSystemTime(Date.now() + failureMs + 1)
    writeFileSync(missing.program, readFileSync(where.program!))
    chmodSync(missing.program, 0o755)
    expect(await hooksTrusted(missing, "/work")).toBe(true)
  })
})
