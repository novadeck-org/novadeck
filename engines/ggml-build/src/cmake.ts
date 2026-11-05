import { readFileSync } from "node:fs"
import { availableParallelism } from "node:os"
import { join } from "node:path"

import { type Machine, machine, type Run, windows } from "./machine.ts"
import type { EngineSpec } from "./spec.ts"

// The oldest macOS Electron 44 runs on; a newer target would drop computers the app runs on.
const macosTarget = "12.0"

// Options for every platform: shared libraries, no OpenMP runtime to ship, and no native CPU
// tuning (the engine runs on other computers than it is built on).
const common = [
  "-DCMAKE_BUILD_TYPE=Release",
  "-DBUILD_SHARED_LIBS=ON",
  "-DGGML_NATIVE=OFF",
  "-DGGML_OPENMP=OFF",
]

/** An architecture macOS builds a slice of the universal engine for. */
export type Slice = "arm64" | "x86_64"

// macOS's universal engine is one build per architecture, merged with lipo (universal.ts).
// One build for both would leave ggml unable to tell which CPU it compiles for: it reads
// CMAKE_OSX_ARCHITECTURES only when that names one architecture, so both slices would fall
// back to its generic C kernels, with no NEON or AVX.
export const macSlices: readonly Slice[] = ["arm64", "x86_64"]

// The Intel slice's CPU kernels: SSE 4.2, AVX and F16C, which every Intel Mac macOS 12 runs
// on has (upstream's "ivybridge" CPU variant). AVX2, FMA and BMI2 would stop the 2013 Mac
// Pro. Set outright, as ggml turns AVX2 on by default when it builds for one architecture.
const intelMac = [
  "-DGGML_SSE42=ON",
  "-DGGML_AVX=ON",
  "-DGGML_F16C=ON",
  "-DGGML_AVX2=OFF",
  "-DGGML_FMA=OFF",
  "-DGGML_BMI2=OFF",
]

const macOptions = (slice: Slice): string[] => [
  "-DGGML_METAL=ON",
  "-DGGML_METAL_EMBED_LIBRARY=ON",
  `-DCMAKE_OSX_ARCHITECTURES=${slice}`,
  ...(slice === "x86_64" ? intelMac : []),
  `-DCMAKE_OSX_DEPLOYMENT_TARGET=${macosTarget}`,
  // Next to the server, as the app unpacks them.
  "-DCMAKE_BUILD_WITH_INSTALL_RPATH=ON",
  "-DCMAKE_INSTALL_RPATH=@loader_path",
  // The compile commands, which the build reads to check the slice's CPU kernels.
  "-DCMAKE_EXPORT_COMPILE_COMMANDS=ON",
]

const platformOptions = ({ platform, arch, vulkanSdk }: Machine): string[] => {
  // The Vulkan backend and every CPU variant are modules beside the server, which picks
  // the best CPU module for the computer and Vulkan only where a driver answers.
  const modules = [
    "-DGGML_VULKAN=ON",
    // The SDK's CMake packages, such as SPIRV-Headers, which the Vulkan backend looks for.
    ...(vulkanSdk ? [`-DCMAKE_PREFIX_PATH=${vulkanSdk}`] : []),
    "-DGGML_BACKEND_DL=ON",
    // Variants are x86; arm64 Linux builds one CPU module.
    ...(arch === "x64" ? ["-DGGML_CPU_ALL_VARIANTS=ON"] : []),
  ]
  if (platform === "win32") {
    // The C runtime inside the executable and modules, so no redistributable is needed.
    // whisper.cpp asks for CMake 3.5, which would leave policy CMP0091 off and the runtime
    // setting unread: the policy is turned on for every project.
    return [
      ...modules,
      "-DCMAKE_POLICY_DEFAULT_CMP0091=NEW",
      "-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded",
    ]
  }
  return [
    ...modules,
    "-DCMAKE_BUILD_WITH_INSTALL_RPATH=ON",
    "-DCMAKE_INSTALL_RPATH=$ORIGIN",
    // The compiler's runtimes inside the binaries: the computer's own may be older.
    "-DCMAKE_EXE_LINKER_FLAGS=-static-libstdc++ -static-libgcc",
    "-DCMAKE_SHARED_LINKER_FLAGS=-static-libstdc++ -static-libgcc",
    "-DCMAKE_MODULE_LINKER_FLAGS=-static-libstdc++ -static-libgcc",
  ]
}

/** One CMake build of the source: a slice of the universal engine on macOS, else the engine. */
export type Configuration = {
  readonly slice: Slice | undefined
  readonly options: readonly string[]
}

/**
 * The builds the engine takes on `on`, each with the options CMake configures it with: the
 * common ones, the project's own, then the platform's.
 */
export const configurations = (options: readonly string[], on: Machine): Configuration[] =>
  on.platform === "darwin"
    ? macSlices.map((slice) => ({ slice, options: [...common, ...options, ...macOptions(slice)] }))
    : [{ slice: undefined, options: [...common, ...options, ...platformOptions(on)] }]

/** A file CMake compiles, from its `compile_commands.json`. */
export type CompileCommand = {
  readonly file: string
  readonly command?: string
  readonly arguments?: readonly string[]
}

// An instruction set past Ivy Bridge, or a whole -march, which would stop an Intel Mac that
// lacks it.
const pastIvyBridge = (flag: string): boolean =>
  ["-mavx2", "-mfma", "-mbmi2"].includes(flag) ||
  /^-m(avx512|avxvnni|amx)/.test(flag) ||
  flag.startsWith("-march=")

/**
 * What is wrong with the CPU kernels a slice compiles, or nothing: its architecture's
 * quantized kernels must be in the build, with the Intel slice's instruction sets and no
 * more, and nothing may fall back to ggml's generic C.
 */
export const kernelProblems = (commands: readonly CompileCommand[], slice: Slice): string[] => {
  const line = (entry: CompileCommand): string => entry.command ?? entry.arguments?.join(" ") ?? ""
  const folder = slice === "arm64" ? "arm" : "x86"
  const kernels = commands.filter((entry) =>
    entry.file.replaceAll("\\", "/").endsWith(`/ggml-cpu/arch/${folder}/quants.c`),
  )
  const problems: string[] = []
  if (kernels.length === 0) problems.push(`ggml compiles no ${folder} CPU kernels for ${slice}`)
  if (commands.some((entry) => line(entry).includes("GGML_CPU_GENERIC"))) {
    problems.push(`ggml falls back to its generic CPU kernels for ${slice}`)
  }
  if (slice === "x86_64") {
    const flags = (entry: CompileCommand) => new Set(line(entry).split(/\s+/))
    for (const entry of kernels) {
      const used = flags(entry)
      const lacking = ["-msse4.2", "-mavx", "-mf16c"].filter((flag) => !used.has(flag))
      const beyond = [...used].filter(pastIvyBridge)
      if (lacking.length > 0)
        problems.push(`the x86_64 kernels are built without ${lacking.join(" ")}`)
      if (beyond.length > 0) problems.push(`the x86_64 kernels are built with ${beyond.join(" ")}`)
    }
  }
  return problems
}

// Stops the build when a configured slice's CPU kernels are wrong, before it compiles.
const checkKernels = (folder: string, slice: Slice): void => {
  const commands = JSON.parse(
    readFileSync(join(folder, "compile_commands.json"), "utf8"),
  ) as CompileCommand[]
  const problems = kernelProblems(commands, slice)
  if (problems.length > 0) {
    throw new Error(`The ${slice} build is configured wrong: ${problems.join("; ")}.`)
  }
}

/** A configured and compiled build, in its folder. */
export type Built = { readonly slice: Slice | undefined; readonly folder: string }

/**
 * Configures and builds the engine's server, and through it the backend modules it loads:
 * once on Linux and Windows, and once per slice on macOS, each slice in its own folder.
 */
export const compile = (
  spec: EngineSpec,
  cache: string,
  source: string,
  build: string,
  run: Run,
): Built[] => {
  // The same source must build the same engine, or every installed app fetches it again.
  // ggml stamps the git commit it finds into its library: inside this repository that is
  // Novadeck's own, which changes with every commit, so git is kept from finding one. MSVC
  // stamps the time unless told not to; CMake takes these as its first flags.
  const reproducible = {
    ...process.env,
    GIT_CEILING_DIRECTORIES: cache,
    ...(windows && { CFLAGS: "/Brepro", CXXFLAGS: "/Brepro", LDFLAGS: "/Brepro" }),
  }
  return configurations(spec.options, machine).map(({ slice, options }) => {
    const folder = slice ? join(build, slice) : build
    run("cmake", ["-S", source, "-B", folder, ...options], { env: reproducible })
    if (slice) checkKernels(folder, slice)
    // Backend modules are dependencies of the library, so building the server builds them.
    run("cmake", [
      "--build",
      folder,
      "--config",
      "Release",
      "--target",
      spec.target,
      // As many jobs as cores: a bare --parallel lets make start every compile at once,
      // which a small CI machine runs out of memory for.
      "--parallel",
      String(availableParallelism()),
    ])
    return { slice, folder }
  })
}
