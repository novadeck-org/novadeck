import { describe, expect, it } from "vitest"

import { signedOnWindows } from "./sign.ts"

describe("signing an engine on Windows", () => {
  it("signs the server and its modules, however their extension is cased", () => {
    for (const name of ["whisper-server.exe", "ggml-vulkan.dll", "LLAMA.DLL"]) {
      expect(signedOnWindows(name), name).toBe(true)
    }
  })

  it("leaves the files beside them, which SignTool cannot sign", () => {
    for (const name of ["LICENSE", "check.wav", "notes.dll.txt"]) {
      expect(signedOnWindows(name), name).toBe(false)
    }
  })
})
