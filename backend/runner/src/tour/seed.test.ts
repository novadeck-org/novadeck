import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { DomainError } from "../errors.js"
import { describe, expect, it } from "../test.js"
import { repositoryAssets, seedFiles } from "./seed.js"

describe("the seed project's files", () => {
  it("are the seed's own, text and binary, and the libraries under vendor, from the repository", async () => {
    const files = await seedFiles()
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining([
        ".gitattributes",
        ".gitignore",
        "README.md",
        "dev.mjs",
        "dev.py",
        "index.html",
        "model/hero.gltf",
        "model/shapes.bin",
        "src/city.js",
        "src/score.js",
        "vendor/phaser/phaser.min.js",
        "vendor/phaser/LICENSE.md",
        "vendor/three/build/three.module.js",
        "vendor/three/build/three.core.js",
        "vendor/three/examples/jsm/loaders/GLTFLoader.js",
        "vendor/three/examples/jsm/utils/BufferGeometryUtils.js",
        "vendor/three/examples/jsm/utils/SkeletonUtils.js",
        "vendor/three/LICENSE",
      ]),
    )
    // The seed's `.gitignore` is what keeps the libraries out of the sandbox's repo.
    expect(Buffer.from(files[".gitignore"]!).toString()).toContain("vendor/")
    expect(files["model/shapes.bin"]!.byteLength).toBeGreaterThan(1000)
    // Not the tool that regenerates the shapes, which sits beside the seed.
    expect(files["make-shapes.mjs"]).toBeUndefined()
  })

  it("leave out what a folder collects by itself, and keep the seed's own dotfiles", async ({
    resources,
  }) => {
    const root = await mkdtemp(join(tmpdir(), "novadeck-seed-"))
    resources.defer(() => rm(root, { recursive: true, force: true }))
    for (const name of [
      ".gitignore",
      "src/a.js",
      "src/b.pyc",
      "src/Thumbs.db",
      ".DS_Store",
      "src/.DS_Store",
      "__pycache__/c.cpython-313.pyc",
      "src/__pycache__/d.txt",
    ]) {
      // eslint-disable-next-line no-await-in-loop -- A few small files.
      await mkdir(join(root, name, ".."), { recursive: true })
      // eslint-disable-next-line no-await-in-loop -- As above.
      await writeFile(join(root, name), name)
    }
    const files = await seedFiles({ ...(await repositoryAssets()), seed: root })
    expect(
      Object.keys(files)
        .filter((name) => !name.startsWith("vendor/"))
        .toSorted(),
    ).toEqual([".gitattributes", ".gitignore", "src/a.js"])
  })

  it("come from the folders the desktop app names, in the layout of the packages", async ({
    resources,
  }) => {
    const root = await mkdtemp(join(tmpdir(), "novadeck-seed-"))
    resources.defer(() => rm(root, { recursive: true, force: true }))
    const real = await repositoryAssets()
    const assets = {
      seed: join(root, "seed"),
      phaser: join(root, "phaser"),
      three: join(root, "three"),
    }
    await mkdir(join(assets.seed, "src"), { recursive: true })
    await writeFile(join(assets.seed, "src", "a.js"), "a")
    for (const [folder, file] of [
      ["phaser", "dist/phaser.min.js"],
      ["phaser", "LICENSE.md"],
      ["three", "build/three.module.js"],
      ["three", "build/three.core.js"],
      ["three", "examples/jsm/loaders/GLTFLoader.js"],
      ["three", "examples/jsm/utils/BufferGeometryUtils.js"],
      ["three", "examples/jsm/utils/SkeletonUtils.js"],
      ["three", "LICENSE"],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop -- A few small files.
      await mkdir(join(assets[folder], file, ".."), { recursive: true })
      // eslint-disable-next-line no-await-in-loop -- As above.
      await writeFile(join(assets[folder], file), `${folder}:${file}`)
    }
    const files = await seedFiles(assets)
    expect(Object.keys(files).toSorted()).toEqual(
      [
        ".gitattributes",
        ".gitignore",
        "src/a.js",
        "vendor/phaser/phaser.min.js",
        "vendor/phaser/LICENSE.md",
        "vendor/three/build/three.module.js",
        "vendor/three/build/three.core.js",
        "vendor/three/examples/jsm/loaders/GLTFLoader.js",
        "vendor/three/examples/jsm/utils/BufferGeometryUtils.js",
        "vendor/three/examples/jsm/utils/SkeletonUtils.js",
        "vendor/three/LICENSE",
      ].toSorted(),
    )
    expect(Buffer.from(files["vendor/phaser/phaser.min.js"]!).toString()).toBe(
      "phaser:dist/phaser.min.js",
    )
    expect(real.seed).toContain("assets")
    // A copy without the seed's dotfile still keeps the libraries out of the repo.
    expect(Buffer.from(files[".gitignore"]!).toString()).toBe("vendor/\n")
    // Nor does it lose the line endings' rule, which keeps a worktree's files as committed.
    expect(Buffer.from(files[".gitattributes"]!).toString()).toBe("* text=auto eol=lf\n")
  })

  it("fail with a sentence for the person where a file can't be read", async () => {
    const real = await repositoryAssets()
    const refused = await seedFiles({ ...real, three: "/nowhere" }).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(DomainError)
    expect(refused).toMatchObject({ code: "CONFLICT" })
    expect((refused as Error).message).toMatch(/couldn't be read/)
  })
})
