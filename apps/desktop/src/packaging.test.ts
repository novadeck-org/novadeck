import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { noticeSounds } from "@novadeck/protocol/sounds"

import { noticeSoundFile } from "./main/notices"
import { describe, expect, it } from "./test"

const app = fileURLToPath(new URL("..", import.meta.url))
const required = createRequire(join(app, "package.json"))
const manifest = (folder: string) =>
  JSON.parse(readFileSync(join(folder, "package.json"), "utf8")) as {
    name: string
    devDependencies?: Record<string, string>
  }

/** The folder a package the app depends on resolves to, by its manifest or else its entry. */
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
  [...readFileSync(join(app, "electron-builder.yml"), "utf8").matchAll(/^\s*- from: (.+)$/gm)].map(
    (match) => match[1]!.trim(),
  )
/**
 * The files copied as they are checked in, not built: the license the GPL asks to ship, and
 * the notification sounds.
 */
const checkedIn = ["../../LICENSE", "../../frontend/ui/src/sounds"]
/** The `from:`s that are a package's build output. */
const built = (): string[] => copied().filter((from) => !checkedIn.includes(from))
/** The package folder a `from:` is a build output of: the app's own for its `dist`. */
const packageOf = (from: string): string => join(app, from.split(/\/?dist/)[0]!)

describe("the packaged app's resources", () => {
  it("is read whole: every `from:` the config holds is one the checks below see", () => {
    const config = readFileSync(join(app, "electron-builder.yml"), "utf8")
    expect(copied()).toHaveLength(config.match(/\bfrom:/g)?.length ?? 0)
  })

  it("names at least the app's own page and the relay", () => {
    expect(copied()).toEqual(
      expect.arrayContaining(["dist", expect.stringMatching(/\/relay\/dist$/)]),
    )
  })

  // A build's output isn't there in a test, so each is checked by the package that builds it: a
  // path one level off, as a moved folder leaves it, fails here and not in the release run.
  it("copies each from a package's build output", () => {
    for (const from of built()) {
      expect(from, `${from} is no package's dist`).toMatch(/^(?:[./a-z-]+\/)?dist(\/|$)/)
      expect(existsSync(join(packageOf(from), "package.json")), `${from} is in no package`).toBe(
        true,
      )
    }
  })

  it("copies each package the app depends on from the folder that dependency resolves to", () => {
    const declared = Object.keys(manifest(app).devDependencies ?? {})
    const checked = built().flatMap((from) => {
      const folder = packageOf(from)
      const { name } = manifest(folder)
      if (!declared.includes(name)) return []
      expect(realpathSync(folder), from).toBe(realpathSync(folderOf(name)))
      return [name]
    })
    expect(checked).toEqual(expect.arrayContaining(["@novadeck/relay"]))
  })

  // The sounds folder is copied whole, so a sound is bundled by being a file there; this holds
  // the folder and `noticeSounds`, which the main process checks a notice against, to each other.
  it("bundles each notification sound the main process names, and names each one bundled", () => {
    const folder = join(app, "../../frontend/ui/src/sounds")
    expect(
      readdirSync(folder)
        .filter((file) => file.endsWith(".wav"))
        .toSorted(),
    ).toEqual(noticeSounds.map(({ id }) => noticeSoundFile(id)).toSorted())
    expect(readFileSync(join(app, "electron-builder.yml"), "utf8")).toMatch(
      /from: \.\.\/\.\.\/frontend\/ui\/src\/sounds\n\s+to: \.\n\s+filter:\n\s+- "\*\.wav"/,
    )
  })

  it("copies each checked-in file from where it is", () => {
    expect(copied()).toEqual(expect.arrayContaining(checkedIn))
    for (const from of checkedIn) expect(existsSync(join(app, from)), from).toBe(true)
  })
})

describe("the development run", () => {
  it("waits for its page on the port the page's dev server takes", () => {
    const origin = /developmentOrigin = "http:\/\/127\.0\.0\.1:(\d+)"/.exec(
      readFileSync(join(app, "src/main/index.ts"), "utf8"),
    )?.[1]
    const port = /server: \{\s*port: (\d+),/.exec(
      readFileSync(join(app, "vite.config.ts"), "utf8"),
    )?.[1]
    expect(origin).toBeDefined()
    expect(origin).toBe(port)
  })
})
