import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { Install } from "@novadeck/harness-core/harness"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { choose, launchConfig, readModels, stripJsonc } from "./models.js"

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "novadeck-opencode-models-"))
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

const install = (env: NodeJS.ProcessEnv = {}): Install => ({
  env,
  home,
  platform: "linux",
  plugin: join(home, "plugin"),
})
const catalog = (connected = true) => {
  if (connected) {
    mkdirSync(join(home, "plugin"), { recursive: true })
    writeFileSync(join(home, "plugin", "connected"), "")
  }
  mkdirSync(join(home, ".cache", "opencode"), { recursive: true })
  copyFileSync(
    join(import.meta.dirname, "fixtures", "models.json"),
    join(home, ".cache", "opencode", "models.json"),
  )
}
const data = (file: string, content: unknown) => {
  mkdirSync(join(home, ".local", "share", "opencode"), { recursive: true })
  writeFileSync(join(home, ".local", "share", "opencode", file), JSON.stringify(content))
}
const config = (file: string, text: string) => {
  mkdirSync(join(home, ".config", "opencode"), { recursive: true })
  writeFileSync(join(home, ".config", "opencode", file), text)
}
const byId = (models: readonly { id: string }[]) => models.map(({ id }) => id)

describe("the models opencode can start with", () => {
  it("are none before opencode has cached its catalog", async () => {
    expect(await readModels(install())).toEqual([])
  })

  it("are, with no login or key, opencode's own free models, with the variants of theirs", async () => {
    catalog()
    expect(await readModels(install())).toEqual([
      // "none" and "minimal" have no Novadeck effort; a deprecated model and a priced one are out.
      { id: "opencode/hy4-flash-free", efforts: ["high"] },
      { id: "opencode/big-pickle", efforts: [] },
    ])
  })

  it("add a provider whose key the environment holds", async () => {
    catalog()
    const models = await readModels(install({ ANTHROPIC_API_KEY: "sk-x" }))
    expect(models).toContainEqual({
      id: "anthropic/claude-opus-4-8",
      efforts: ["low", "medium", "high", "xhigh", "max"],
    })
    // Effort values and a token budget's own high and max, together.
    expect(models).toContainEqual({
      id: "anthropic/claude-sonnet-4-6",
      efforts: ["low", "medium", "high", "max"],
    })
    expect(byId(models)).not.toContain("anthropic/claude-sonnet-4-5")
    expect(byId(models)).not.toContain("openai/gpt-5.4")
  })

  it("add a provider the person logged in to, whatever the kind of login, and use a key for opencode's own", async () => {
    catalog()
    data("auth.json", {
      openai: { type: "oauth", refresh: "r" },
      opencode: { type: "api", key: "k" },
    })
    const models = byId(await readModels(install()))
    expect(models).toContain("openai/gpt-5.4")
    // With a key, its priced models too.
    expect(models).toContain("opencode/claude-opus-5")
  })

  it("add a provider and models of their config, and take away what it disables or blacklists", async () => {
    catalog()
    config(
      "opencode.jsonc",
      `{
        // their own server
        "provider": {
          "local": { "npm": "@ai-sdk/openai-compatible", "models": {
            "mine": { "reasoning": true, "variants": { "high": {}, "max": {}, "low": { "disabled": true }, "odd": {} } },
            "plain": {},
          } },
          "anthropic": { "options": { "apiKey": "k" }, "blacklist": ["claude-sonnet-4-6"],
            "models": { "claude-opus-4-8": { "variants": { "xhigh": { "disabled": true } } } } },
        },
      }`,
    )
    expect(await readModels(install())).toEqual(
      expect.arrayContaining([
        { id: "local/mine", efforts: ["high", "max"] },
        { id: "local/plain", efforts: [] },
        { id: "anthropic/claude-opus-4-8", efforts: ["low", "medium", "high", "max"] },
      ]),
    )
    expect(byId(await readModels(install()))).not.toContain("anthropic/claude-sonnet-4-6")
  })

  it("leave out disabled providers and those outside enabled_providers", async () => {
    catalog()
    data("auth.json", { openai: { type: "api", key: "k" }, anthropic: { type: "api", key: "k" } })
    config("opencode.json", JSON.stringify({ disabled_providers: ["openai"] }))
    const ids = byId(await readModels(install()))
    expect(ids.some((id) => id.startsWith("openai/"))).toBe(false)
    expect(ids.some((id) => id.startsWith("anthropic/"))).toBe(true)
    config("opencode.json", JSON.stringify({ enabled_providers: ["openai"] }))
    expect(new Set(byId(await readModels(install())).map((id) => id.split("/")[0]))).toEqual(
      new Set(["openai"]),
    )
  })

  it("follow XDG_* in the person's environment", async () => {
    mkdirSync(join(home, "c", "opencode"), { recursive: true })
    copyFileSync(
      join(import.meta.dirname, "fixtures", "models.json"),
      join(home, "c", "opencode", "models.json"),
    )
    expect(byId(await readModels(install({ XDG_CACHE_HOME: join(home, "c") })))).toContain(
      "opencode/big-pickle",
    )
  })
})

describe("a config file", () => {
  it("is read without its comments and trailing commas, strings whole", () => {
    expect(JSON.parse(stripJsonc('{ /* a */ "u": "http://x//y", // b\n "a": [1,2,], }'))).toEqual({
      u: "http://x//y",
      a: [1, 2],
    })
  })
})

describe("starting on a model and effort", () => {
  it("gives the model as --model and the effort as Novadeck's own --variant word", () => {
    expect(choose({ model: "anthropic/claude-opus-4-8", effort: "high" })).toEqual([
      "--model",
      "anthropic/claude-opus-4-8",
      "--variant",
      "high",
    ])
    expect(choose({ model: "p/m" })).toEqual(["--model", "p/m"])
    expect(choose({})).toEqual([])
  })

  it("offers no effort where Novadeck isn't connected, as only its shim takes that word", async () => {
    catalog(false)
    expect(await readModels(install({ ANTHROPIC_API_KEY: "k" }))).toContainEqual({
      id: "anthropic/claude-opus-4-8",
      efforts: [],
    })
  })

  it("sets the effort as the variant of its agents, with the model that makes it count", () => {
    const text = launchConfig({ model: "p/m", effort: "high" })
    expect(JSON.parse(text!)).toEqual({
      agent: { build: { model: "p/m", variant: "high" }, plan: { model: "p/m", variant: "high" } },
    })
    expect(launchConfig({ model: "p/m" })).toBeUndefined()
    expect(launchConfig({ effort: "high" })).toBeUndefined()
  })
})
