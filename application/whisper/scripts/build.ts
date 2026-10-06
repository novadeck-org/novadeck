import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs"
import { cp, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises"
import { availableParallelism } from "node:os"
import { join, parse } from "node:path"
import { fileURLToPath } from "node:url"
import { gzipSync } from "node:zlib"

// The whisper.cpp engine voice input downloads, built for this platform:
//
//   node scripts/build.ts     builds dist/novadeck-whisper-<platform>-<arch>.tar.gz and
//                             dist/engine.json, which names it with its SHA-256 and size
//
// The archive holds `whisper-server`, the libraries and backend modules it loads, a
// sample of speech for the post-install check and whisper.cpp's licence, all flat, so
// the runner can unpack it with the system `tar` and run the server where it stands.
// Linux and Windows build Vulkan and the CPU variants as modules loaded at run time, so a
// computer without a Vulkan driver still transcribes on its CPU; macOS builds Metal into
// one universal binary, as the universal app needs.

const root = fileURLToPath(new URL("..", import.meta.url))
const cache = join(root, ".cache")
const dist = join(root, "dist")

const version = "v1.9.4"
const commit = "927cfce34f31707e17f2bff35c349632fb9e2c3a"
const sourceUrl = `https://github.com/ggml-org/whisper.cpp/archive/${commit}.tar.gz`
const sourceSha256 = "41b664fee09e79176ac277b5237debec34f8d74af3c7d71f333f1ec67989ecde"

// The oldest macOS Electron 44 runs on; a newer target would drop computers the app runs on.
const macosTarget = "12.0"

const windows = process.platform === "win32"
const macos = process.platform === "darwin"
const platform = process.platform
const arch = macos ? "universal" : process.arch
const archive = `novadeck-whisper-${platform}-${arch}.tar.gz`
const executable = windows ? "whisper-server.exe" : "whisper-server"

// Every command runs in a directory of its own with relative paths where it can: GNU tar
// reads `C:` in a path as a host name.
const run = (
  command: string,
  args: readonly string[],
  cwd: string = root,
  env: NodeJS.ProcessEnv = process.env,
): void => {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" })
  if (result.error) {
    const missing = (result.error as NodeJS.ErrnoException).code === "ENOENT"
    throw new Error(
      missing
        ? `Building the voice engine needs ${command} on the PATH.`
        : `${command} failed to start: ${result.error.message}`,
    )
  }
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`)
}

// Windows ships bsdtar in System32; the `tar` first on a CI runner's PATH may be GNU tar
// from Git, which reads `C:` in a path as a host name.
const tar = windows ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar"

const has = (command: string, flag = "--version"): boolean =>
  !spawnSync(command, [flag], { stdio: "ignore" }).error

const sha256 = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex")

// What the toolchain needs, named before a build spends minutes finding out it is absent.
const requireTools = (): void => {
  if (!has("cmake")) {
    throw new Error("Building the voice engine needs CMake: install it from https://cmake.org.")
  }
  if (!has("git"))
    throw new Error("Building the voice engine needs git, which applies its patches.")
  if (!has(tar)) throw new Error("Building the voice engine needs tar.")
  if (macos) {
    if (!has("xcrun", "--version")) {
      throw new Error("Building the voice engine on macOS needs Xcode's command line tools.")
    }
    return
  }
  if (!windows && !has("c++") && !has("g++") && !has("clang++")) {
    throw new Error("Building the voice engine needs a C++ compiler, such as g++.")
  }
  // The Vulkan backend compiles its shaders with glslc, from the Vulkan SDK or a package.
  const sdk = process.env.VULKAN_SDK
  const glslc = windows ? "glslc.exe" : "glslc"
  const found =
    has("glslc") || (sdk !== undefined && existsSync(join(sdk, windows ? "Bin" : "bin", glslc)))
  if (!found) {
    throw new Error(
      "Building the voice engine's Vulkan backend needs glslc: install the Vulkan SDK " +
        "(https://vulkan.lunarg.com) and set VULKAN_SDK, or your distribution's glslc package.",
    )
  }
}

// The source tarball at the pinned commit, checked against its SHA-256 before anything
// reads it, and kept so later builds need no network.
const download = async (): Promise<string> => {
  const tarball = join(cache, `whisper.cpp-${commit}.tar.gz`)
  if (existsSync(tarball) && sha256(readFileSync(tarball)) === sourceSha256) return tarball
  console.log(`Downloading whisper.cpp ${version}`)
  const response = await fetch(sourceUrl)
  if (!response.ok) throw new Error(`Downloading ${sourceUrl} failed: ${response.status}`)
  const data = new Uint8Array(await response.arrayBuffer())
  if (sha256(data) !== sourceSha256) {
    throw new Error(`whisper.cpp's source tarball is not the one pinned (${sourceUrl}).`)
  }
  await mkdir(cache, { recursive: true })
  const temporary = `${tarball}.${process.pid}.tmp`
  await writeFile(temporary, data)
  await rename(temporary, tarball)
  return tarball
}

const patchesDirectory = join(root, "patches")
const patches = (): string[] =>
  readdirSync(patchesDirectory)
    .filter((name) => name.endsWith(".patch"))
    .toSorted()

// The source with the patches applied, in a folder named for them, so a changed patch
// extracts and builds afresh and an unchanged one reuses the last build.
const prepare = async (tarball: string): Promise<{ source: string; build: string }> => {
  const hash = createHash("sha256")
  for (const name of patches()) hash.update(readFileSync(join(patchesDirectory, name)))
  const key = `${commit.slice(0, 12)}-${hash.digest("hex").slice(0, 12)}`
  const directory = join(cache, key)
  const source = join(directory, "source")
  if (!existsSync(join(directory, "patched"))) {
    await rm(directory, { recursive: true, force: true })
    await mkdir(source, { recursive: true })
    run(tar, ["-xzf", tarball, "--strip-components=1", "-C", source], root)
    for (const name of patches()) {
      const patch = join(patchesDirectory, name)
      // The source is a bare folder to git: inside this repository it would skip every
      // file this repository ignores, as the cache is, and report success.
      const bare = { ...process.env, GIT_CEILING_DIRECTORIES: cache }
      run("git", ["apply", "--whitespace=nowarn", patch], source, bare)
      // A patch that did not take must stop the build, not ship an unpatched server.
      run("git", ["apply", "--reverse", "--check", patch], source, bare)
    }
    await writeFile(join(directory, "patched"), "")
  }
  return { source, build: windows ? shortBuild(key) : join(directory, "build") }
}

// MSBuild fails past 260 characters, and the Vulkan backend's shader generator is a
// project nested deep inside the build tree, so on Windows the build goes to a short
// folder at the drive's root, or where NOVADECK_WHISPER_BUILD says.
const shortBuild = (key: string): string =>
  process.env.NOVADECK_WHISPER_BUILD ?? join(parse(root).root, "nvw", key.slice(0, 8))

// Options for every platform: shared libraries, no OpenMP runtime to ship, no native CPU
// tuning (the engine runs on other computers than it is built on), and no tests.
const common = [
  "-DCMAKE_BUILD_TYPE=Release",
  "-DBUILD_SHARED_LIBS=ON",
  "-DGGML_NATIVE=OFF",
  "-DGGML_OPENMP=OFF",
  "-DWHISPER_BUILD_TESTS=OFF",
  "-DWHISPER_BUILD_EXAMPLES=ON",
  "-DWHISPER_BUILD_SERVER=ON",
  "-DWHISPER_CURL=OFF",
  "-DWHISPER_SDL2=OFF",
]

const platformOptions = (): string[] => {
  if (macos) {
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
    ...(process.env.VULKAN_SDK ? [`-DCMAKE_PREFIX_PATH=${process.env.VULKAN_SDK}`] : []),
    "-DGGML_BACKEND_DL=ON",
    // Variants are x86; arm64 Linux builds one CPU module.
    ...(process.arch === "x64" ? ["-DGGML_CPU_ALL_VARIANTS=ON"] : []),
  ]
  if (windows) {
    // The C runtime inside the executable and modules, so no redistributable is needed.
    return [...modules, "-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded"]
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

const compile = (source: string, build: string): void => {
  // The same source must build the same engine, or every installed app fetches it again.
  // ggml stamps the git commit it finds into its library: inside this repository that is
  // Novadeck's own, which changes with every commit, so git is kept from finding one. MSVC
  // stamps the time unless told not to; CMake takes these as its first flags.
  const reproducible = {
    ...process.env,
    GIT_CEILING_DIRECTORIES: cache,
    ...(windows && { CFLAGS: "/Brepro", CXXFLAGS: "/Brepro", LDFLAGS: "/Brepro" }),
  }
  run("cmake", ["-S", source, "-B", build, ...common, ...platformOptions()], root, reproducible)
  // Backend modules are dependencies of the library, so building the server builds them.
  run("cmake", [
    "--build",
    build,
    "--config",
    "Release",
    "--target",
    "whisper-server",
    // As many jobs as cores: a bare --parallel lets make start every compile at once,
    // which a small CI machine runs out of memory for.
    "--parallel",
    String(availableParallelism()),
  ])
}

const isLibrary = (name: string): boolean =>
  windows
    ? name.endsWith(".dll")
    : macos
      ? name.endsWith(".dylib")
      : name.endsWith(".so") || name.includes(".so.")

// The server and every library and module it loads, wherever the generator put them,
// gathered flat. Links keep their names, as the server asks for them by soname.
const gather = async (build: string, staging: string, source: string): Promise<void> => {
  const files = (await readdir(build, { recursive: true, withFileTypes: true })).filter(
    (entry) => !entry.isDirectory(),
  )
  const wanted = files.filter(
    (entry) =>
      (entry.name === executable || isLibrary(entry.name)) &&
      !entry.parentPath.includes("CMakeFiles"),
  )
  if (!wanted.some((entry) => entry.name === executable)) {
    throw new Error(`The build produced no ${executable}.`)
  }
  await Promise.all(
    wanted.map((entry) =>
      cp(join(entry.parentPath, entry.name), join(staging, entry.name), {
        verbatimSymlinks: true,
      }),
    ),
  )
  await cp(join(source, "samples", "jfk.wav"), join(staging, "check.wav"))
  await cp(join(source, "LICENSE"), join(staging, "LICENSE"))
}

// Apple silicon runs only signed code, and the linker's signature does not survive the
// rewrites above, so on macOS every Mach-O is signed again, ad hoc, as the app is.
const sign = async (staging: string): Promise<void> => {
  if (!macos) return
  for (const name of await readdir(staging)) {
    const path = join(staging, name)
    // A link points at a file signed under its own name.
    if (lstatSync(path).isFile() && (name === executable || isLibrary(name))) {
      run("codesign", ["--force", "--sign", "-", path])
    }
  }
}

const block = 512

const field = (header: Buffer, offset: number, length: number, value: string): void => {
  header.write(value, offset, length, "latin1")
}

const octal = (header: Buffer, offset: number, length: number, value: number): void => {
  field(header, offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`)
}

// One ustar entry, with the owner, group and time every build gives it, so the same files
// always make the same bytes. Staged names are flat and short; links keep their target.
const entry = (name: string, path: string): Buffer[] => {
  if (Buffer.byteLength(name) > 100) throw new Error(`${name} is too long for the archive.`)
  const stat = lstatSync(path)
  const link = stat.isSymbolicLink()
  const data = link ? Buffer.alloc(0) : readFileSync(path)
  const header = Buffer.alloc(block)
  field(header, 0, 100, name)
  octal(header, 100, 8, link ? 0o777 : stat.mode & 0o111 ? 0o755 : 0o644)
  octal(header, 108, 8, 0)
  octal(header, 116, 8, 0)
  octal(header, 124, 12, data.length)
  octal(header, 136, 12, 0)
  header.fill(" ", 148, 156)
  field(header, 156, 1, link ? "2" : "0")
  if (link) field(header, 157, 100, readlinkSync(path))
  field(header, 257, 6, "ustar\0")
  field(header, 263, 2, "00")
  const sum = header.reduce((total, byte) => total + byte, 0)
  field(header, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `)
  const padding = Buffer.alloc((block - (data.length % block)) % block)
  return [header, data, padding]
}

// The archive written here, not by whichever tar the computer has, so it is the same bytes
// on every run and every platform: entries sorted, no timestamps, owner and group 0, and
// a gzip header with no time and the Unix operating system. bsdtar and GNU tar extract it.
const pack = (staging: string, names: readonly string[]): Buffer => {
  const parts = names.flatMap((name) => entry(name, join(staging, name)))
  const gzipped = gzipSync(Buffer.concat([...parts, Buffer.alloc(block * 2)]), { level: 9 })
  gzipped.writeUInt32LE(0, 4)
  gzipped[9] = 3
  return gzipped
}

// The archive and manifest replaced whole, the manifest last, so a runner reading
// meanwhile sees the old engine or the new one and never a manifest without its archive.
const place = async (staging: string): Promise<void> => {
  await mkdir(dist, { recursive: true })
  const data = pack(staging, (await readdir(staging)).toSorted())
  const manifest = { file: archive, sha256: sha256(data), size: data.length }
  const temporary = join(dist, `${archive}.${process.pid}.tmp`)
  await writeFile(temporary, data)
  await rename(temporary, join(dist, archive))
  const manifestTemporary = join(dist, `engine.json.${process.pid}.tmp`)
  await writeFile(manifestTemporary, `${JSON.stringify(manifest, null, 2)}\n`)
  await rename(manifestTemporary, join(dist, "engine.json"))
  console.log(`Built ${archive} (${data.length} bytes, sha256 ${manifest.sha256})`)
}

export const main = async (): Promise<void> => {
  requireTools()
  const { source, build } = await prepare(await download())
  compile(source, build)
  const staging = join(cache, "staging")
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  await gather(build, staging, source)
  await sign(staging)
  await place(staging)
}

if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
