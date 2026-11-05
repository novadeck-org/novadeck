import { describe as context, describe, expect, it } from "vitest"

import { type CompileCommand, configurations, kernelProblems } from "./cmake.ts"
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

// The options of the one build a platform other than macOS takes.
const cmakeOptions = (options: readonly string[], on: Machine): readonly string[] => {
  const [only, ...more] = configurations(options, on)
  expect(more).toEqual([])
  expect(only!.slice).toBeUndefined()
  return only!.options
}

const macRuntimes = [
  "-DCMAKE_OSX_DEPLOYMENT_TARGET=12.0",
  "-DCMAKE_BUILD_WITH_INSTALL_RPATH=ON",
  "-DCMAKE_INSTALL_RPATH=@loader_path",
  "-DCMAKE_EXPORT_COMPILE_COMMANDS=ON",
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
    const mac: Machine = { platform: "darwin", arch: "arm64", vulkanSdk: "/sdk" }

    it("builds Metal in, once for each architecture, each slice finding its libraries beside it", () => {
      expect(configurations([], mac)).toEqual([
        {
          slice: "arm64",
          options: [
            ...common,
            "-DGGML_METAL=ON",
            "-DGGML_METAL_EMBED_LIBRARY=ON",
            "-DCMAKE_OSX_ARCHITECTURES=arm64",
            ...macRuntimes,
          ],
        },
        {
          slice: "x86_64",
          options: [
            ...common,
            "-DGGML_METAL=ON",
            "-DGGML_METAL_EMBED_LIBRARY=ON",
            "-DCMAKE_OSX_ARCHITECTURES=x86_64",
            "-DGGML_SSE42=ON",
            "-DGGML_AVX=ON",
            "-DGGML_F16C=ON",
            "-DGGML_AVX2=OFF",
            "-DGGML_FMA=OFF",
            "-DGGML_BMI2=OFF",
            ...macRuntimes,
          ],
        },
      ])
    })

    it("never names two architectures in one build, which ggml compiles generic kernels for", () => {
      for (const { options } of configurations(["-DLLAMA_BUILD_SERVER=ON"], mac)) {
        const archs = options.filter((option) => option.startsWith("-DCMAKE_OSX_ARCHITECTURES="))
        expect(archs).toHaveLength(1)
        expect(archs[0]).not.toContain(";")
      }
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

describe("a slice's CPU kernels", () => {
  const source = "/cache/key/source/ggml/src"
  const compiled = (file: string, command: string): CompileCommand => ({
    file: `${source}/${file}`,
    command: `/usr/bin/cc -DGGML_USE_CPU_REPACK ${command} -O3 -c ${source}/${file}`,
  })
  const ivyBridge = "-arch x86_64 -msse4.2 -mf16c -mavx"

  it("are the architecture's own, with nothing generic", () => {
    expect(
      kernelProblems(
        [
          compiled("ggml-cpu/ggml-cpu.c", "-arch arm64"),
          compiled("ggml-cpu/arch/arm/quants.c", "-arch arm64"),
        ],
        "arm64",
      ),
    ).toEqual([])
    expect(
      kernelProblems(
        [
          compiled("ggml-cpu/ggml-cpu.c", ivyBridge),
          compiled("ggml-cpu/arch/x86/quants.c", ivyBridge),
        ],
        "x86_64",
      ),
    ).toEqual([])
  })

  it("are wrong when ggml could not tell the architecture and fell back to generic C", () => {
    // What ggml configures for CMAKE_OSX_ARCHITECTURES=arm64;x86_64.
    const universal = [
      compiled("ggml-cpu/ggml-cpu.c", "-arch arm64 -arch x86_64 -DGGML_CPU_GENERIC"),
    ]
    expect(kernelProblems(universal, "arm64")).toEqual([
      "ggml compiles no arm CPU kernels for arm64",
      "ggml falls back to its generic CPU kernels for arm64",
    ])
    expect(kernelProblems(universal, "x86_64")).toEqual([
      "ggml compiles no x86 CPU kernels for x86_64",
      "ggml falls back to its generic CPU kernels for x86_64",
    ])
  })

  it("are wrong for one architecture when they are another's", () => {
    expect(kernelProblems([compiled("ggml-cpu/arch/x86/quants.c", ivyBridge)], "arm64")).toEqual([
      "ggml compiles no arm CPU kernels for arm64",
    ])
  })

  it("on Intel go up to AVX and F16C, which every Intel Mac macOS 12 runs on has", () => {
    expect(
      kernelProblems(
        [compiled("ggml-cpu/arch/x86/quants.c", `${ivyBridge} -mfma -mbmi2 -mavx2`)],
        "x86_64",
      ),
    ).toEqual(["the x86_64 kernels are built with -mavx2 -mfma -mbmi2"])
    expect(
      kernelProblems([compiled("ggml-cpu/arch/x86/quants.c", "-arch x86_64 -msse4.2")], "x86_64"),
    ).toEqual(["the x86_64 kernels are built without -mavx -mf16c"])
  })

  it("read Windows paths and argument lists too", () => {
    expect(
      kernelProblems(
        [
          {
            file: "C:\\nvw\\source\\ggml\\src\\ggml-cpu\\arch\\arm\\quants.c",
            arguments: ["cc", "-c", "quants.c"],
          },
        ],
        "arm64",
      ),
    ).toEqual([])
  })
})
