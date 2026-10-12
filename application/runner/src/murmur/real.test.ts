import { spawnSync } from "node:child_process"
import { cp, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "../test.js"
import { folder, sha256 } from "../testing/murmur.js"
import { WorkspaceStore } from "../workspaces/store.js"
import { Murmur } from "./service.js"

// The interface the engine package's build wrote, so a bump follows by itself: build the
// engine there first (`pnpm --filter @novadeck/murmur build:engine`).
const builtInterface = async (): Promise<number> =>
  (
    JSON.parse(
      await readFile(
        fileURLToPath(new URL("../../../murmur/dist/engine.json", import.meta.url)),
        "utf8",
      ),
    ) as { interface: number }
  ).interface

// Runs the real engine, which CI has none of. Point these at the `bin` folder of a
// llama.cpp build with Novadeck's patches (see application/murmur) and at the model:
//   NOVADECK_MURMUR_REAL_ENGINE NOVADECK_MURMUR_REAL_MODEL
const { NOVADECK_MURMUR_REAL_ENGINE: engine, NOVADECK_MURMUR_REAL_MODEL: model } = process.env

describe.skipIf(!engine || !model)("murmur with the real engine", () => {
  it(
    "installs, checks on a GPU and describes a terminal",
    { timeout: 300_000 },
    async ({ resources }) => {
      const source = await folder(resources)
      const contents = join(source, "contents")
      await cp(engine ?? "", contents, { recursive: true })
      const packed = spawnSync("tar", ["-czf", join(source, "engine.tar.gz"), "-C", contents, "."])
      expect(packed.status).toBe(0)
      const archive = await readFile(join(source, "engine.tar.gz"))
      const manifest = join(source, "engine.json")
      await writeFile(
        manifest,
        JSON.stringify({
          file: "engine.tar.gz",
          sha256: sha256(archive),
          size: archive.length,
          interface: await builtInterface(),
        }),
      )
      const data = await readFile(model ?? "")
      const store = new WorkspaceStore()
      const murmur = new Murmur(store, {
        engine: manifest,
        directory: await folder(resources),
        model: { url: model ?? "", sha256: sha256(data), size: data.length },
      })
      resources.defer(async () => {
        await murmur.close()
        store.close()
      })

      await murmur.install()
      await murmur.settled()
      const { check, failure } = murmur.state()
      console.info("check", JSON.stringify(check), "failure", failure)
      expect(failure).toBeNull()
      expect(check).not.toBeNull()

      const description = await murmur.describe(
        {
          kind: "shell",
          project: "app",
          folder: "api",
          command: "pnpm vitest --watch",
          screen: [" ✓ src/a.test.ts (12 tests)", " ❯ src/b.test.ts (14 tests | 1 failed)"],
          previous: null,
        },
        { terminal: "t1" },
      )
      console.info("described", JSON.stringify(description))
      expect(description).toBeDefined()
    },
  )
})
