import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

const root = join(import.meta.dirname, "..", "..")

type Manifest = { readonly [kind: string]: unknown }

// Every package.json in the workspace, by its folder: the root's and each package's.
const manifests = (): readonly (readonly [string, Manifest])[] =>
  [
    ".",
    "atlas",
    ...[
      "application",
      "apps",
      "backend",
      "contract",
      "engines",
      "frontend",
      "harnesses",
      "libraries",
      "tools",
    ].flatMap((folder) =>
      existsSync(join(root, folder))
        ? readdirSync(join(root, folder)).map((name) => `${folder}/${name}`)
        : [],
    ),
  ]
    .filter((folder) => existsSync(join(root, folder, "package.json")))
    .map((folder) => [
      folder,
      JSON.parse(readFileSync(join(root, folder, "package.json"), "utf8")) as Manifest,
    ])

const kinds = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]

/** The xterm packages a manifest installs, each as its kind, name and version. */
const xterm = (manifest: Manifest): readonly (readonly [string, string, string])[] =>
  kinds.flatMap((kind) =>
    Object.entries((manifest[kind] ?? {}) as Record<string, string>)
      .filter(([name]) => name.startsWith("@xterm/"))
      .map(([name, version]) => [kind, name, version] as const),
  )

// xterm and its addons are released together and must move together, so the emulator library
// installs them, and every other package reaches them through it.
describe("the emulator's packages", () => {
  it("are installed by the emulator library alone", () => {
    const elsewhere = manifests()
      .filter(([folder]) => folder !== "libraries/emulator")
      .flatMap(([folder, manifest]) =>
        xterm(manifest).map(([kind, name]) => `${folder}: ${kind} ${name}`),
      )
    expect(elsewhere).toEqual([])
  })

  it("are pinned to exact versions", () => {
    const manifest = manifests().find(([folder]) => folder === "libraries/emulator")?.[1]
    const loose = xterm(manifest ?? {}).filter(([, , version]) => !/^\d+\.\d+\.\d+$/.test(version))
    expect(manifest).toBeDefined()
    expect(loose).toEqual([])
  })
})
