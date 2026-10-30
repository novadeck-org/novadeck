import { describe, expect, it } from "vitest"

import { isLibrary } from "./stage.ts"

describe("what the engine stages beside its server", () => {
  it("takes Linux shared objects, versioned ones included", () => {
    expect(isLibrary("libggml.so", "linux")).toBe(true)
    expect(isLibrary("libggml-base.so.0.9.4", "linux")).toBe(true)
    expect(isLibrary("libggml.a", "linux")).toBe(false)
  })

  it("takes dylibs on macOS and DLLs on Windows", () => {
    expect(isLibrary("libggml.dylib", "darwin")).toBe(true)
    expect(isLibrary("libggml.so", "darwin")).toBe(false)
    expect(isLibrary("ggml-vulkan.dll", "win32")).toBe(true)
    expect(isLibrary("ggml-vulkan.lib", "win32")).toBe(false)
  })
})
