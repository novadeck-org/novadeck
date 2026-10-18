import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { chmod, mkdir, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

// The relay's build, with Rust as rust-toolchain.toml names it:
//
//   node scripts/build.ts                 builds dist/novadeck-relay[.exe]
//   node scripts/build.ts --test          runs its tests
//   node scripts/build.ts --lint          runs clippy, in CI for every platform it ships for
//   node scripts/build.ts --format        formats its Rust; --format-check checks it
//
// NOVADECK_RELAY_UNIVERSAL=1 on macOS builds both architectures into one binary, as the
// universal app needs.

const root = fileURLToPath(new URL("..", import.meta.url))
const binaryName = process.platform === "win32" ? "novadeck-relay.exe" : "novadeck-relay"

const run = (command: string, args: readonly string[]): void => {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`)
}

const has = (command: string): boolean =>
  !spawnSync(command, ["--version"], { stdio: "ignore" }).error

// Rust as rust-toolchain.toml names it, put in place once: not every rustup installs it
// by itself when cargo first runs.
let rust = false
const pinnedRust = (): void => {
  if (rust) return
  if (!has("cargo")) {
    throw new Error("Building Novadeck needs Rust: install it from https://rustup.rs.")
  }
  rust = true
  if (has("rustup")) run("rustup", ["toolchain", "install", "--no-self-update"])
}

/**
 * On Linux, the Rust target the relay is built for: linked statically against musl, so
 * one binary runs on any distribution, however old its C library, as a server's may be.
 */
export const linuxTriple = (arch: string = process.arch): string =>
  `${arch === "arm64" ? "aarch64" : "x86_64"}-unknown-linux-musl`

// Apple silicon runs only signed code, and stripping or merging architectures can leave a
// binary's own signature broken, so on macOS it is signed again, ad hoc, as the unsigned
// app is. Returns its bytes.
const signed = (path: string): Buffer => {
  if (process.platform === "darwin") run("codesign", ["--force", "--sign", "-", path])
  return readFileSync(path)
}

// The relay for this platform: statically linked on Linux, signed on macOS, and for both
// chips there with NOVADECK_RELAY_UNIVERSAL=1.
const compile = (): Buffer => {
  const cargo = (...args: string[]) => run("cargo", ["build", "--release", "--locked", ...args])
  // Without rustup, as with a distribution's own cargo, it links as that cargo does.
  if (process.platform === "linux" && has("rustup")) {
    const triple = linuxTriple()
    run("rustup", ["target", "add", triple])
    cargo("--target", triple)
    return readFileSync(join(root, "target", triple, "release", binaryName))
  }
  if (process.platform !== "darwin" || process.env.NOVADECK_RELAY_UNIVERSAL !== "1") {
    cargo()
    return signed(join(root, "target", "release", binaryName))
  }
  const triples = ["aarch64-apple-darwin", "x86_64-apple-darwin"]
  run("rustup", ["target", "add", ...triples])
  for (const triple of triples) cargo("--target", triple)
  const merged = join(root, "target", binaryName)
  run("lipo", [
    "-create",
    "-output",
    merged,
    ...triples.map((triple) => join(root, "target", triple, "release", binaryName)),
  ])
  return signed(merged)
}

// Replaced whole, so a runner reading it meanwhile sees the old binary or the new one.
const place = async (data: Uint8Array): Promise<void> => {
  const output = join(root, "dist", binaryName)
  await mkdir(join(root, "dist"), { recursive: true })
  const temporary = `${output}.${process.pid}.tmp`
  await writeFile(temporary, data, { mode: 0o755 })
  await rename(temporary, output)
  await chmod(output, 0o755)
}

/** The platforms clippy checks in CI, as each compiles code of its own. */
export const lintTriples = [
  "x86_64-unknown-linux-gnu",
  "aarch64-apple-darwin",
  "x86_64-pc-windows-msvc",
]

const clippy = (...triple: string[]) =>
  run("cargo", [
    "clippy",
    "--locked",
    "--release",
    "--all-targets",
    ...triple,
    "--",
    "-D",
    "warnings",
  ])

// Clippy for this platform, or in CI for every platform the relay ships for: checking
// needs no linker, so one runner checks them all.
const lint = (): void => {
  if (!process.env.CI) return clippy()
  run("rustup", ["target", "add", ...lintTriples])
  for (const triple of lintTriples) clippy("--target", triple)
}

export const main = async (args: readonly string[]): Promise<void> => {
  const [mode] = args
  pinnedRust()
  if (mode === "--test") return run("cargo", ["test", "--locked"])
  if (mode === "--lint") return lint()
  if (mode === "--format") return run("cargo", ["fmt"])
  if (mode === "--format-check") return run("cargo", ["fmt", "--check"])
  await place(compile())
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
