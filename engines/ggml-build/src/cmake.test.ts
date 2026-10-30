import { describe as context, describe, expect, it } from "vitest"

import { cmakeOptions } from "./cmake.ts"
import type { Machine } from "./machine.ts"

const linux: Machine = { platform: "linux", arch: "x64", vulkanSdk: undefined }

const common = [
  "-DCMAKE_BUILD_TYPE=Release",
  "-DBUILD_SHARED_LIBS=ON",
  "-DGGML_NATIVE=OFF",
  "-DGGML_OPENMP=OFF",
]

const linuxRuntimes = [
  "-DCMAKE_BUILD_WITH_INSTALL_RPATH=ON",
  "-DCMAKE_INSTALL_RPATH=$ORIGIN",
  "-DCMAKE_EXE_LINKER_FLAGS=-static-libstdc++ -static-libgcc",
  "-DCMAKE_SHARED_LINKER_FLAGS=-static-libstdc++ -static-libgcc",
  "-DCMAKE_MODULE_LINKER_FLAGS=-static-libstdc++ -static-libgcc",
]

describe("the CMake options", () => {
  it("puts the common options first, then the project's, then the platform's", () => {
    const options = cmakeOptions(["-DWHISPER_BUILD_SERVER=ON"], linux)
    expect(options.slice(0, 6)).toEqual([
      ...common,
      "-DWHISPER_BUILD_SERVER=ON",
      "-DGGML_VULKAN=ON",
    ])
  })

  context("on macOS", () => {
    it("builds Metal into one universal binary that finds its libraries beside it", () => {
      expect(cmakeOptions([], { platform: "darwin", arch: "arm64", vulkanSdk: "/sdk" })).toEqual([
        ...common,
        "-DGGML_METAL=ON",
        "-DGGML_METAL_EMBED_LIBRARY=ON",
        "-DCMAKE_OSX_ARCHITECTURES=arm64;x86_64",
        "-DCMAKE_OSX_DEPLOYMENT_TARGET=12.0",
        "-DCMAKE_BUILD_WITH_INSTALL_RPATH=ON",
        "-DCMAKE_INSTALL_RPATH=@loader_path",
      ])
    })
  })

  context("on Linux", () => {
    it("builds Vulkan and every x86 CPU variant as modules, with the compiler's runtimes inside", () => {
      expect(cmakeOptions([], linux)).toEqual([
        ...common,
        "-DGGML_VULKAN=ON",
        "-DGGML_BACKEND_DL=ON",
        "-DGGML_CPU_ALL_VARIANTS=ON",
        ...linuxRuntimes,
      ])
    })

    it("builds one CPU module on arm64, and looks for the Vulkan SDK where VULKAN_SDK says", () => {
      expect(cmakeOptions([], { ...linux, arch: "arm64", vulkanSdk: "/opt/vulkan" })).toEqual([
        ...common,
        "-DGGML_VULKAN=ON",
        "-DCMAKE_PREFIX_PATH=/opt/vulkan",
        "-DGGML_BACKEND_DL=ON",
        ...linuxRuntimes,
      ])
    })
  })

  context("on Windows", () => {
    it("links the C runtime in, for every project whatever CMake version it asks for", () => {
      expect(cmakeOptions([], { platform: "win32", arch: "x64", vulkanSdk: "C:\\sdk" })).toEqual([
        ...common,
        "-DGGML_VULKAN=ON",
        "-DCMAKE_PREFIX_PATH=C:\\sdk",
        "-DGGML_BACKEND_DL=ON",
        "-DGGML_CPU_ALL_VARIANTS=ON",
        "-DCMAKE_POLICY_DEFAULT_CMP0091=NEW",
        "-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded",
      ])
    })
  })
})
