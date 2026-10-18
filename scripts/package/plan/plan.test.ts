import { describe, expect, it } from "vitest"

import { packages, parseFolders, plan } from "./plan.ts"

// The host and what it's built from, as turbo lists them on 2026-10-18.
const packaged = [
  "application/host",
  "contract/protocol",
  "backend/relay",
  "backend/runner",
  "contract/runner-client",
  "application/ui",
  "engines/ggml-build",
  "engines/murmur",
  "engines/whisper",
  "harnesses/agy",
  "harnesses/claude",
  "harnesses/codex",
  "harnesses/core",
  "libraries/sandbox",
  "libraries/terminal",
  "libraries/wire",
]

const pullRequest = (files: readonly string[]) => plan({ event: "pull_request", packaged, files })

describe("packaging a pull request", () => {
  it("packages a change to the host, the UI, the runner or what they're built from", () => {
    for (const file of [
      "application/host/src/main/index.ts",
      "application/host/electron-builder.yml",
      "application/ui/src/app/App.tsx",
      "application/ui/vite.config.ts",
      "backend/runner/src/terminals/manager.ts",
      "libraries/wire/src/client.ts",
      "harnesses/claude/src/index.ts",
      "engines/whisper/scripts/build.ts",
      "backend/relay/src/main.rs",
    ])
      expect(pullRequest([file]), file).toBe(true)
  })

  it("packages a change to the pins, the patches, the shared settings or the workflows that package", () => {
    for (const file of [
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "package.json",
      "turbo.json",
      "tsconfig.base.json",
      "libraries/terminal/patches/node-pty@1.2.0-beta.14.patch",
      ".github/workflows/package.yml",
      ".github/workflows/quality.yml",
      "scripts/install/install.sh",
      "scripts/package/plan/plan.ts",
    ])
      expect(pullRequest([file]), file).toBe(true)
  })

  it("doesn't package a change to tests, specs, scenarios or prose alone", () => {
    expect(
      pullRequest([
        "backend/runner/src/terminals/manager.test.ts",
        "application/ui/src/specs/agents.spec.tsx",
        "application/ui/src/backend/runner/switches.test.ts",
        "backend/runner/src/e2e/chat.e2e.ts",
        "backend/runner/src/e2e/trace.ts",
        "libraries/wire/README.md",
        "application/host/src/main/menu.test.ts",
      ]),
    ).toBe(false)
  })

  it("doesn't package a change outside what the app is built from", () => {
    expect(
      pullRequest([
        "docs/e2e-testing.md",
        "tools/atlas/content/flows.ts",
        "libraries/viewers/src/code.ts",
        "scripts/e2e/plan/plan.ts",
        "scripts/flakes/register.json",
        ".github/workflows/e2e.yml",
        ".github/workflows/release.yml",
      ]),
    ).toBe(false)
  })

  it("packages when any one changed file can change the app", () => {
    expect(pullRequest(["docs/e2e-testing.md", "application/ui/src/app/App.tsx"])).toBe(true)
  })

  it("matches a package's folder whole, not a sibling that begins alike", () => {
    expect(packages("libraries/wire-extra/src/a.ts", packaged)).toBe(false)
    expect(packages("application/hostess/a.ts", packaged)).toBe(false)
  })
})

describe("packaging anything else", () => {
  it("packages on every event but a pull request", () => {
    expect(plan({ event: "push", packaged, files: ["docs/a.md"] })).toBe(true)
    expect(plan({ event: "repository_dispatch", packaged: undefined, files: undefined })).toBe(true)
  })

  it("packages a pull request whose facts couldn't be read", () => {
    expect(plan({ event: "pull_request", packaged: undefined, files: ["docs/a.md"] })).toBe(true)
    expect(plan({ event: "pull_request", packaged, files: undefined })).toBe(true)
  })
})

describe("turbo's package list", () => {
  it("reads the folders, in the repository's own separators", () => {
    expect(
      parseFolders(
        JSON.stringify({
          packages: {
            items: [
              { name: "@novadeck/host", path: "application/host" },
              { name: "@novadeck/wire", path: "libraries\\wire\\" },
            ],
          },
        }),
      ),
    ).toEqual(["application/host", "libraries/wire"])
  })

  it("is unknown when it isn't one, or lists nothing", () => {
    expect(parseFolders("not json")).toBeUndefined()
    expect(parseFolders(JSON.stringify({ packages: { items: [] } }))).toBeUndefined()
    expect(parseFolders(JSON.stringify({ packages: { items: [{ name: "x" }] } }))).toBeUndefined()
  })
})
