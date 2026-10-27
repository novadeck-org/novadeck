import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { codex } from "./index.js"
import { parseModels, readModels } from "./models.js"

// The shape of Codex's models_cache.json (codex-cli 0.164.0), cut to what is read.
const cache = JSON.stringify({
  fetched_at: "2026-10-27T10:00:00Z",
  models: [
    {
      slug: "gpt-5.5",
      visibility: "list",
      supported_reasoning_levels: [
        { effort: "low", description: "" },
        { effort: "medium", description: "" },
        { effort: "high", description: "" },
        { effort: "xhigh", description: "" },
        { effort: "ultra", description: "" },
      ],
    },
    { slug: "gpt-5.5-mini", visibility: "list", supported_reasoning_levels: [{ effort: "low" }] },
    { slug: "internal", visibility: "hide", supported_reasoning_levels: [{ effort: "low" }] },
    { visibility: "list" },
  ],
})

describe("Codex's models", () => {
  it("are the listed ones, with the efforts Novadeck names", () => {
    expect(parseModels(cache)).toEqual([
      { id: "gpt-5.5", efforts: ["low", "medium", "high", "xhigh"] },
      { id: "gpt-5.5-mini", efforts: ["low"] },
    ])
  })

  it("are none for text that isn't its cache", () => {
    for (const text of ["", "{", "[]", '{"models":3}', "null"])
      expect(parseModels(text)).toEqual([])
  })

  it("are read from the cache in its home, none where it is missing", async () => {
    const home = mkdtempSync(join(tmpdir(), "codex-models-"))
    try {
      expect(await readModels(home)).toEqual([])
      writeFileSync(join(home, "models_cache.json"), cache)
      expect(await readModels(home)).toHaveLength(2)
      const env = { CODEX_HOME: home }
      expect(
        await codex.messaging.models({ env, home: "/nowhere", platform: "linux", plugin: "" }),
      ).toHaveLength(2)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("start with the model and the effort as config", () => {
    const { choose } = codex.messaging
    expect(choose({})).toEqual([])
    expect(choose({ model: "gpt-5.5", effort: "high" })).toEqual([
      "--model",
      "gpt-5.5",
      "-c",
      "model_reasoning_effort=high",
    ])
    expect(choose({ effort: "max" })).toEqual(["-c", "model_reasoning_effort=max"])
  })
})
