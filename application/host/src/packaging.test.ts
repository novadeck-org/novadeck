import { existsSync, readFileSync, realpathSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "./test"

const host = fileURLToPath(new URL("..", import.meta.url))
const required = createRequire(join(host, "package.json"))
const manifest = (folder: string) =>
  JSON.parse(readFileSync(join(folder, "package.json"), "utf8")) as {
    name: string
    devDependencies?: Record<string, string>
  }

/** The folder a package the host depends on resolves to, by its manifest or else its entry. */
const folderOf = (name: string): string => {
  try {
    return dirname(required.resolve(`${name}/package.json`))
  } catch {
    // A package whose `exports` doesn't name its manifest: its entry sits at its root.
    return dirname(required.resolve(name))
  }
}

/** The folders electron-builder copies into the app's resources, as its config names them. */
const copied = (): string[] =>
  [...readFileSync(join(host, "electron-builder.yml"), "utf8").matchAll(/^\s*- from: (.+)$/gm)].map(
    (match) => match[1]!.trim(),
  )

describe("the packaged app's resources", () => {
  it("is read whole: every `from:` the config holds is one the checks below see", () => {
    const config = readFileSync(join(host, "electron-builder.yml"), "utf8")
    expect(copied()).toHaveLength(config.match(/\bfrom:/g)?.length ?? 0)
  })

  it("names at least the UI and the relay", () => {
    expect(copied()).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/\/ui\/dist$/),
        expect.stringMatching(/\/relay\/dist$/),
      ]),
    )
  })

  // A build's output isn't there in a test, so each is checked by the package that builds it: a
  // path one level off, as a moved folder leaves it, fails here and not in the release run.
  it("copies each from a package's build output", () => {
    for (const from of copied()) {
      const [folder] = from.split("/dist")
      expect(from, `${from} is no package's dist`).toMatch(/^[./a-z-]+\/dist(\/|$)/)
      expect(existsSync(join(host, folder!, "package.json")), `${from} is in no package`).toBe(true)
    }
  })

  it("copies each package the host depends on from the folder that dependency resolves to", () => {
    const declared = Object.keys(manifest(host).devDependencies ?? {})
    const checked = copied().flatMap((from) => {
      const folder = join(host, from.split("/dist")[0]!)
      const { name } = manifest(folder)
      if (!declared.includes(name)) return []
      expect(realpathSync(folder), from).toBe(realpathSync(folderOf(name)))
      return [name]
    })
    expect(checked).toEqual(expect.arrayContaining(["@novadeck/ui", "@novadeck/relay"]))
  })
})

describe("the development run", () => {
  it("waits for the UI on the port its dev server takes", () => {
    const origin = /developmentOrigin = "http:\/\/127\.0\.0\.1:(\d+)"/.exec(
      readFileSync(join(host, "src/main/index.ts"), "utf8"),
    )?.[1]
    const port = /server: \{\s*port: (\d+),/.exec(
      readFileSync(join(folderOf("@novadeck/ui"), "vite.config.ts"), "utf8"),
    )?.[1]
    expect(origin).toBeDefined()
    expect(origin).toBe(port)
  })
})
