import { existsSync } from "node:fs"
import { join } from "node:path"

import { has, macos, tar, windows } from "./host.ts"

/** Names what the toolchain lacks, before a build spends minutes finding out. */
export const requireTools = (label: string): void => {
  if (!has("cmake")) {
    throw new Error(`Building the ${label} needs CMake: install it from https://cmake.org.`)
  }
  if (!has("git")) throw new Error(`Building the ${label} needs git, which applies its patches.`)
  if (!has(tar)) throw new Error(`Building the ${label} needs tar.`)
  if (macos) {
    if (!has("xcrun", "--version")) {
      throw new Error(`Building the ${label} on macOS needs Xcode's command line tools.`)
    }
    return
  }
  if (!windows && !has("c++") && !has("g++") && !has("clang++")) {
    throw new Error(`Building the ${label} needs a C++ compiler, such as g++.`)
  }
  // The Vulkan backend compiles its shaders with glslc, from the Vulkan SDK or a package.
  const sdk = process.env.VULKAN_SDK
  const glslc = windows ? "glslc.exe" : "glslc"
  const found =
    has("glslc") || (sdk !== undefined && existsSync(join(sdk, windows ? "Bin" : "bin", glslc)))
  if (!found) {
    throw new Error(
      `Building the ${label}'s Vulkan backend needs glslc: install the Vulkan SDK ` +
        "(https://vulkan.lunarg.com) and set VULKAN_SDK, or your distribution's glslc package.",
    )
  }
}
