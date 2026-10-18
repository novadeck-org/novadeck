import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it, onTestFinished } from "vitest"

import { contentSecurityPolicy, type Build } from "./content-security-policy.ts"

// The plugin's hooks, as Vite calls them for a build.
const transform = (
  plugin: ReturnType<typeof contentSecurityPolicy>,
  html: string,
  config: {
    mode?: string
    command?: "build" | "serve"
    envDir?: string | false
    envPrefix?: string
  } = {},
): string => {
  ;(plugin.configResolved as (config: object) => void)({
    mode: "production",
    command: "build",
    envDir: false,
    ...config,
  })
  return (plugin.transformIndexHtml as (html: string) => string)(html)
}

// What the plugin hands the app's policy, for a build.
const seen = (config: Parameters<typeof transform>[2] = {}, envPrefix?: string): Build => {
  let build: Build | undefined
  const plugin = contentSecurityPolicy({
    placeholder: "__SOURCES__",
    connect: (each) => {
      build = each
      return []
    },
    ...(envPrefix !== undefined && { envPrefix }),
  })
  transform(plugin, "__SOURCES__", config)
  return build!
}

describe("contentSecurityPolicy", () => {
  it("fills the placeholder with the sources the app gives for the build", () => {
    const plugin = contentSecurityPolicy({
      placeholder: "__SOURCES__",
      connect: () => ["'self'", "https://api.example.com"],
    })
    expect(transform(plugin, "connect-src __SOURCES__;")).toBe(
      "connect-src 'self' https://api.example.com;",
    )
  })

  it("tells the app the build's mode, and whether it's served", () => {
    expect(seen({ mode: "try", command: "build" })).toMatchObject({ mode: "try", command: "build" })
    expect(seen({ mode: "try", command: "serve" })).toMatchObject({ mode: "try", command: "serve" })
  })

  it("hands the app the variables of the env files the app reads, the process's before them", () => {
    const envDir = mkdtempSync(join(tmpdir(), "build-kit-env-"))
    onTestFinished(() => rmSync(envDir, { recursive: true, force: true }))
    writeFileSync(
      join(envDir, ".env.production"),
      "BUILD_KIT_TEST_API=https://file.example.com\nBUILD_KIT_TEST_RUNNER=wss://file.example.com\nOTHER=x\n",
    )
    process.env.BUILD_KIT_TEST_RUNNER = "wss://process.example.com"
    onTestFinished(() => void delete process.env.BUILD_KIT_TEST_RUNNER)
    expect(seen({ envDir, envPrefix: "BUILD_KIT_TEST_" }).env).toEqual({
      BUILD_KIT_TEST_API: "https://file.example.com",
      BUILD_KIT_TEST_RUNNER: "wss://process.example.com",
    })
    // Its own prefix, where it gives one, over the app's.
    expect(seen({ envDir, envPrefix: "VITE_" }, "BUILD_KIT_TEST_").env).toMatchObject({
      BUILD_KIT_TEST_API: "https://file.example.com",
    })
  })

  it("refuses an empty prefix, which would hand the policy every variable", () => {
    expect(() => seen({}, "")).toThrow("envPrefix can't be empty")
  })

  it("fails a page whose policy has no placeholder", () => {
    const plugin = contentSecurityPolicy({ placeholder: "__SOURCES__", connect: () => [] })
    expect(() => transform(plugin, "connect-src 'self';")).toThrow("placeholder is missing")
  })
})
