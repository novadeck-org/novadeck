import { describe as context, describe, expect, it } from "vitest"

import { cmakeOptions, type Machine } from "./cmake.ts"

const linux: Machine = { platform: "linux", arch: "x64", vulkanSdk: undefined }

describe("the CMake options", () => {
  it("puts the common options first, then the project's, then the platform's", () => {
    const options = cmakeOptions(["-DWHISPER_BUILD_SERVER=ON"], linux)
    expect(options.slice(0, 5)).toEqual([
      "-DCMAKE_BUILD_TYPE=Release",
      "-DBUILD_SHARED_LIBS=ON",
      "-DGGML_NATIVE=OFF",
      "-DGGML_OPENMP=OFF",
      "-DWHISPER_BUILD_SERVER=ON",
    ])
    expect(options[5]).toBe("-DGGML_VULKAN=ON")
  })

  context("on macOS", () => {
    it("builds Metal into one universal binary that finds its libraries beside it", () => {
      const options = cmakeOptions([], { platform: "darwin", arch: "arm64", vulkanSdk: "/sdk" })
      expect(options).toContain("-DGGML_METAL=ON")
      expect(options).toContain("-DCMAKE_OSX_ARCHITECTURES=arm64;x86_64")
      expect(options).toContain("-DCMAKE_OSX_DEPLOYMENT_TARGET=12.0")
      expect(options).toContain("-DCMAKE_INSTALL_RPATH=@loader_path")
      expect(options.some((option) => option.includes("VULKAN"))).toBe(false)
    })
  })

  context("on Linux", () => {
    it("builds Vulkan and every x86 CPU variant as modules, with the compiler's runtimes inside", () => {
      const options = cmakeOptions([], linux)
      expect(options).toContain("-DGGML_BACKEND_DL=ON")
      expect(options).toContain("-DGGML_CPU_ALL_VARIANTS=ON")
      expect(options).toContain("-DCMAKE_INSTALL_RPATH=$ORIGIN")
      expect(options).toContain("-DCMAKE_SHARED_LINKER_FLAGS=-static-libstdc++ -static-libgcc")
    })

    it("builds one CPU module on arm64", () => {
      expect(cmakeOptions([], { ...linux, arch: "arm64" })).not.toContain(
        "-DGGML_CPU_ALL_VARIANTS=ON",
      )
    })

    it("looks for the Vulkan SDK's packages where VULKAN_SDK says", () => {
      expect(cmakeOptions([], { ...linux, vulkanSdk: "/opt/vulkan" })).toContain(
        "-DCMAKE_PREFIX_PATH=/opt/vulkan",
      )
      expect(
        cmakeOptions([], linux).some((option) => option.startsWith("-DCMAKE_PREFIX_PATH")),
      ).toBe(false)
    })
  })

  context("on Windows", () => {
    it("links the C runtime in, for every project whatever CMake version it asks for", () => {
      const options = cmakeOptions([], { platform: "win32", arch: "x64", vulkanSdk: "C:\\sdk" })
      expect(options).toContain("-DGGML_VULKAN=ON")
      expect(options).toContain("-DCMAKE_PREFIX_PATH=C:\\sdk")
      expect(options).toContain("-DCMAKE_POLICY_DEFAULT_CMP0091=NEW")
      expect(options).toContain("-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded")
      expect(options.some((option) => option.includes("RPATH"))).toBe(false)
    })
  })
})
