import { existsSync } from "node:fs"
import { join } from "node:path"

import { has, type Machine, machine, tarOf } from "./machine.ts"
import { windowsSigning } from "./signtool.ts"

/** What a build on `on` lacks, said as its error, or nothing when the toolchain is whole. */
export const missingTool = (
  label: string,
  on: Machine,
  env: NodeJS.ProcessEnv,
  found: (command: string, flag?: string) => boolean,
): string | undefined => {
  const windows = on.platform === "win32"
  if (!found("cmake"))
    return `Building the ${label} needs CMake: install it from https://cmake.org.`
  if (!found("git")) return `Building the ${label} needs git, which applies its patches.`
  if (!found(tarOf(on.platform, env))) return `Building the ${label} needs tar.`
  if (on.platform === "darwin") {
    // They hold lipo too, which merges the architectures' builds into one universal binary.
    if (!found("xcrun", "--version")) {
      return `Building the ${label} on macOS needs Xcode's command line tools.`
    }
    return undefined
  }
  // Signing runs last, after many minutes of building, and its client runs on .NET.
  if (windows && windowsSigning(env) && !found("dotnet")) {
    return `Signing the ${label} needs the .NET runtime, 8 or later (dotnet on the PATH).`
  }
  if (!windows && !found("c++") && !found("g++") && !found("clang++")) {
    return `Building the ${label} needs a C++ compiler, such as g++.`
  }
  // The Vulkan backend compiles its shaders with glslc, from the Vulkan SDK or a package.
  const sdk = on.vulkanSdk
  const glslc = windows ? "glslc.exe" : "glslc"
  if (
    found("glslc") ||
    (sdk !== undefined && existsSync(join(sdk, windows ? "Bin" : "bin", glslc)))
  ) {
    return undefined
  }
  return (
    `Building the ${label}'s Vulkan backend needs glslc: install the Vulkan SDK ` +
    "(https://vulkan.lunarg.com) and set VULKAN_SDK, or your distribution's glslc package."
  )
}

/** Names what the toolchain lacks, before a build spends minutes finding out. */
export const requireTools = (label: string): void => {
  const missing = missingTool(label, machine, process.env, has)
  if (missing) throw new Error(missing)
}
