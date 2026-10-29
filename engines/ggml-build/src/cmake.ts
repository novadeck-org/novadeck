import { availableParallelism } from "node:os"

import { type Run, windows } from "./host.ts"
import type { EngineSpec } from "./spec.ts"

/** The computer the engine is built for: this one, except that macOS builds both architectures. */
export type Machine = {
  readonly platform: NodeJS.Platform
  readonly arch: string
  /** Where the Vulkan SDK is, when `VULKAN_SDK` names it. */
  readonly vulkanSdk: string | undefined
}

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

const platformOptions = ({ platform, arch, vulkanSdk }: Machine): string[] => {
  if (platform === "darwin") {
    return [
      "-DGGML_METAL=ON",
      "-DGGML_METAL_EMBED_LIBRARY=ON",
      "-DCMAKE_OSX_ARCHITECTURES=arm64;x86_64",
      `-DCMAKE_OSX_DEPLOYMENT_TARGET=${macosTarget}`,
      // Next to the server, as the app unpacks them.
      "-DCMAKE_BUILD_WITH_INSTALL_RPATH=ON",
      "-DCMAKE_INSTALL_RPATH=@loader_path",
    ]
  }
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

/** The options CMake configures the project with: the common ones, the project's own, then the platform's. */
export const cmakeOptions = (options: readonly string[], machine: Machine): string[] => [
  ...common,
  ...options,
  ...platformOptions(machine),
]

/** Configures and builds the engine's server, and through it the backend modules it loads. */
export const compile = (
  spec: EngineSpec,
  cache: string,
  source: string,
  build: string,
  run: Run,
): void => {
  // The same source must build the same engine, or every installed app fetches it again.
  // ggml stamps the git commit it finds into its library: inside this repository that is
  // Novadeck's own, which changes with every commit, so git is kept from finding one. MSVC
  // stamps the time unless told not to; CMake takes these as its first flags.
  const reproducible = {
    ...process.env,
    GIT_CEILING_DIRECTORIES: cache,
    ...(windows && { CFLAGS: "/Brepro", CXXFLAGS: "/Brepro", LDFLAGS: "/Brepro" }),
  }
  const machine = {
    platform: process.platform,
    arch: process.arch,
    vulkanSdk: process.env.VULKAN_SDK,
  }
  run("cmake", ["-S", source, "-B", build, ...cmakeOptions(spec.options, machine)], {
    env: reproducible,
  })
  // Backend modules are dependencies of the library, so building the server builds them.
  run("cmake", [
    "--build",
    build,
    "--config",
    "Release",
    "--target",
    spec.target,
    // As many jobs as cores: a bare --parallel lets make start every compile at once,
    // which a small CI machine runs out of memory for.
    "--parallel",
    String(availableParallelism()),
  ])
}
