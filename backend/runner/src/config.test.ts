import { join, resolve } from "node:path"

import {
  engineDirectory as murmurDirectory,
  engineManifest as murmurManifest,
} from "@novadeck/murmur"
import { engineDirectory, engineManifest } from "@novadeck/whisper"

import { readConfig } from "./config.js"
import { describe, expect, it } from "./test.js"

describe("server configuration", () => {
  it("reads the terminal API token and database path", () => {
    const token = "configuration-tests-only-not-a-real-credential"
    expect(
      readConfig({
        NOVADECK_TOKEN: token,
        NOVADECK_DATABASE: "/tmp/novadeck-test.sqlite",
      }),
    ).toMatchObject({ token, database: resolve("/tmp/novadeck-test.sqlite") })
  })

  it("makes a relative database path absolute, with the shell integration and uploads beside it", () => {
    const token = "configuration-tests-only-not-a-real-credential"
    const config = readConfig({ NOVADECK_TOKEN: token, NOVADECK_DATABASE: "data/workspace.sqlite" })
    expect(config.database).toBe(resolve("data/workspace.sqlite"))
    expect(config.shell).toBe(join(resolve("data"), "shell"))
    expect(config.uploads).toBe(join(resolve("data"), "uploads"))
  })

  it("installs voice input beside the database, from the engine built here unless another is named", () => {
    const token = "configuration-tests-only-not-a-real-credential"
    const base = { NOVADECK_TOKEN: token, NOVADECK_DATABASE: "data/workspace.sqlite" }

    expect(readConfig(base).voice).toEqual({
      engine: engineManifest,
      source: engineDirectory,
      directory: join(resolve("data"), "voice"),
    })
    expect(
      readConfig({
        ...base,
        NOVADECK_VOICE_ENGINE: "pack/engine.json",
        NOVADECK_VOICE_SOURCE: "https://downloads.test/voice/",
      }).voice,
    ).toMatchObject({
      engine: resolve("pack/engine.json"),
      source: "https://downloads.test/voice/",
    })
  })

  it("installs murmur beside the database, from the engine built here unless another is named", () => {
    const token = "configuration-tests-only-not-a-real-credential"
    const base = { NOVADECK_TOKEN: token, NOVADECK_DATABASE: "data/workspace.sqlite" }

    expect(readConfig(base).murmur).toEqual({
      engine: murmurManifest,
      source: murmurDirectory,
      directory: join(resolve("data"), "murmur"),
    })
    expect(
      readConfig({
        ...base,
        NOVADECK_MURMUR_ENGINE: "pack/engine.json",
        NOVADECK_MURMUR_SOURCE: "https://downloads.test/murmur/",
      }).murmur,
    ).toMatchObject({
      engine: resolve("pack/engine.json"),
      source: "https://downloads.test/murmur/",
    })
    expect(readConfig({ ...base, NOVADECK_MURMUR_SOURCE: "pack" }).murmur?.source).toBe(
      resolve("pack"),
    )
  })

  it("takes another build of the relay, as an absolute path, or leaves it to the package", () => {
    expect(readConfig({ NOVADECK_RELAY: "bin/novadeck-relay" }).relay).toBe(
      resolve("bin/novadeck-relay"),
    )
    expect(readConfig({ NOVADECK_RELAY: " " })).not.toHaveProperty("relay")
    expect(readConfig({})).not.toHaveProperty("relay")
  })

  it("rejects empty, short, and oversized credentials", () => {
    for (const token of ["", " ", "short", "x".repeat(513)]) {
      expect(() => readConfig({ NOVADECK_TOKEN: token })).toThrow("NOVADECK_TOKEN")
    }
  })

  it("reads server and CORS settings from environment variables", () => {
    expect(
      readConfig({
        HOST: "0.0.0.0",
        NOVADECK_ALLOW_REMOTE_HOST: "1",
        PORT: "4321",
        CORS_ORIGINS: "https://novadeck.example, https://mzpkdev.github.io",
      }),
    ).toEqual({
      hostname: "0.0.0.0",
      port: 4321,
      origins: ["https://novadeck.example", "https://mzpkdev.github.io"],
    })
  })

  it("refuses a host off this machine unless allowed", () => {
    for (const HOST of ["0.0.0.0", "192.168.1.5", "::", "example.com"]) {
      expect(() => readConfig({ HOST })).toThrow("NOVADECK_ALLOW_REMOTE_HOST")
    }
    for (const HOST of ["127.0.0.1", "127.1.2.3", "localhost", "::1", "[::1]"]) {
      expect(readConfig({ HOST }).hostname).toBe(HOST)
    }
    expect(readConfig({ HOST: "0.0.0.0", NOVADECK_ALLOW_REMOTE_HOST: "true" }).hostname).toBe(
      "0.0.0.0",
    )
    expect(() => readConfig({ HOST: "0.0.0.0", NOVADECK_ALLOW_REMOTE_HOST: "0" })).toThrow()
  })

  it("uses local defaults without environment variables", () => {
    expect(readConfig({})).toEqual({
      hostname: "127.0.0.1",
      port: 8787,
      origins: ["http://127.0.0.1:5173"],
    })
  })

  it("rejects invalid port values", () => {
    expect(() => readConfig({ PORT: "not-a-port" })).toThrow(
      "PORT must be an integer between 0 and 65535",
    )
  })
})
