import { describe as context, describe, expect, it } from "vitest"

import type { Machine } from "./machine.ts"
import { missingTool } from "./toolchain.ts"

const win: Machine = { platform: "win32", arch: "x64", vulkanSdk: undefined }
const mac: Machine = { platform: "darwin", arch: "arm64", vulkanSdk: undefined }
const signing = {
  AZURE_SIGNING_ENDPOINT: "https://weu.codesigning.azure.net",
  AZURE_SIGNING_ACCOUNT: "novadeck",
  AZURE_SIGNING_PROFILE: "release",
}
const all = () => true
const without =
  (...missing: string[]) =>
  (command: string) =>
    !missing.includes(command)

describe("the toolchain", () => {
  it("is whole when every tool answers", () => {
    expect(missingTool("voice engine", win, signing, all)).toBeUndefined()
    expect(missingTool("voice engine", mac, {}, all)).toBeUndefined()
  })

  context("on Windows", () => {
    it("needs .NET before building when the release signs, not after", () => {
      expect(missingTool("voice engine", win, signing, without("dotnet"))).toBe(
        "Signing the voice engine needs the .NET runtime, 8 or later (dotnet on the PATH).",
      )
    })

    it("does without .NET when nothing is signed", () => {
      expect(missingTool("voice engine", win, {}, without("dotnet"))).toBeUndefined()
    })
  })
})
