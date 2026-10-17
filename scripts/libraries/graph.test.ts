import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { strayDependencies } from "./graph.ts"

const root = join(import.meta.dirname, "..", "..")

describe("a library's dependencies", () => {
  it("may name the libraries its design depends on", () => {
    expect(
      strayDependencies("terminal", {
        name: "@novadeck/terminal",
        dependencies: { "@novadeck/emulator": "workspace:^0.0.0", "@xterm/xterm": "6.0.0" },
        devDependencies: { "@novadeck/emulator": "workspace:*", "@xterm/headless": "~6.0.0" },
        peerDependencies: { "@novadeck/emulator": "workspace:~" },
      }),
    ).toEqual([])
  })

  it("may name no app package or other library, in any kind of dependency", () => {
    expect(
      strayDependencies("terminal", {
        name: "@novadeck/terminal",
        dependencies: { "@novadeck/protocol": "workspace:*" },
        devDependencies: { "@novadeck/runner": "workspace:*" },
        peerDependencies: { "@novadeck/wire": "workspace:*" },
        optionalDependencies: { "@novadeck/harness-core": "workspace:*" },
      }),
    ).toEqual([
      "dependencies @novadeck/protocol",
      "devDependencies @novadeck/runner",
      "peerDependencies @novadeck/wire",
      "optionalDependencies @novadeck/harness-core",
    ])
  })

  it("may reach no app package or other library through an alias", () => {
    expect(
      strayDependencies("terminal", {
        name: "@novadeck/terminal",
        dependencies: {
          r: "npm:@novadeck/runner@*",
          p: "workspace:@novadeck/protocol@*",
          "@novadeck/emulator": "workspace:@novadeck/wire@*",
          latest: "npm:@novadeck/ui",
          xterm: "npm:@xterm/xterm@6.0.0",
        },
      }),
    ).toEqual([
      "dependencies r",
      "dependencies p",
      "dependencies @novadeck/emulator",
      "dependencies latest",
    ])
  })

  it("may install nothing from a path", () => {
    expect(
      strayDependencies("emulator", {
        name: "@novadeck/emulator",
        dependencies: { u: "link:../../application/ui", h: "file:../../harnesses/core" },
        devDependencies: {
          v: "portal:./vendor",
          w: "workspace:../../application/runner",
          b: "../../application/host",
          home: "~/novadeck/application/ui",
          drive: "C:/novadeck/application/runner",
          relativeDrive: "C:../application/ui",
          share: "\\\\server\\share\\ui",
          packed: "vendor/ui.tgz",
          tarred: "vendor/ui.tar",
          gzipped: "vendor/ui.tar.gz",
          // A tarball fetched from an address is a package's, from no folder here.
          fetched: "https://example.com/ui.tgz",
        },
      }),
    ).toEqual([
      "dependencies u",
      "dependencies h",
      "devDependencies v",
      "devDependencies w",
      "devDependencies b",
      "devDependencies home",
      "devDependencies drive",
      "devDependencies relativeDrive",
      "devDependencies share",
      "devDependencies packed",
      "devDependencies tarred",
      "devDependencies gzipped",
    ])
  })

  it("may name no workspace package at all for a library not in the order", () => {
    expect(
      strayDependencies("unlisted", {
        name: "@novadeck/unlisted",
        dependencies: { "@novadeck/emulator": "workspace:*" },
      }),
    ).toEqual(["dependencies @novadeck/emulator"])
  })

  it("stay inside the order for every library in libraries/", () => {
    const folder = join(root, "libraries")
    const strays = (existsSync(folder) ? readdirSync(folder) : [])
      .filter((name) => existsSync(join(folder, name, "package.json")))
      .flatMap((name) =>
        strayDependencies(
          name,
          JSON.parse(readFileSync(join(folder, name, "package.json"), "utf8")),
        ).map((stray) => `${name}: ${stray}`),
      )

    expect(strays).toEqual([])
  })
})
