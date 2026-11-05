import { join } from "node:path"

import * as murmur from "@novadeck/murmur"
import * as whisper from "@novadeck/whisper"

import { describe, expect, it } from "../test"
import { builtEngine } from "./resources"

// The app's folder, as a development run's app.getAppPath() gives it.
const appPath = join(import.meta.dirname, "..", "..")

describe("where a development run finds an engine", () => {
  it.each([
    ["@novadeck/whisper", whisper],
    ["@novadeck/murmur", murmur],
  ] as const)("is where %s says it builds it", async (name, engine) => {
    expect(await builtEngine(appPath, name)).toEqual({
      manifest: engine.engineManifest,
      source: engine.engineDirectory,
    })
    expect(engine.engineManifest).toBe(join(engine.engineDirectory, "engine.json"))
  })
})
