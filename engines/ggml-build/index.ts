import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs"
import { cp, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises"
import { availableParallelism } from "node:os"
import { join, parse } from "node:path"
import { gzipSync } from "node:zlib"

// The build the ggml engines share: whisper.cpp's `whisper-server` for voice input and
// llama.cpp's `llama-server` for murmur. Each engine's `scripts/build.ts` names what is its
// own (the pinned source, its CMake options and target, its patches, any extra files) and
// calls `buildEngine`; this module fetches the pinned source, patches it, builds it for this
// platform, signs it and packs the engine as `dist/<archive>` and `dist/engine.json`.
//
// The archive is flat, so the runner can unpack it with the system `tar` and run the server
// where it stands. Linux and Windows build Vulkan and the CPU variants as modules loaded at
// run time; macOS builds Metal into one universal binary, as the universal app needs.

export type EngineSpec = {
  /** The package's folder: its `patches`, `.cache` and `dist` live here. */
  readonly root: string
  /** The engine's name in the archive: `novadeck-<name>-<platform>-<arch>.tar.gz`. */
  readonly name: string
  /** What the engine is called in errors, such as "voice engine". */
  readonly label: string
  /** The project the source comes from, such as "whisper.cpp". */
  readonly project: string
  readonly version: string
  /** The full commit the source tarball is pinned to. */
  readonly commit: string
  readonly sourceUrl: string
  readonly sourceSha256: string
  /** The interface the runner launches the server through; bump it with any change to its flags or HTTP surface. */
  readonly engineInterface: number
  /** The CMake target that builds the server (and, through dependencies, its modules). */
  readonly target: string
  /** The server's executable, without `.exe`. */
  readonly executable: string
  /** The project's own CMake options, beside the common and platform ones. */
  readonly options: readonly string[]
  /** The environment variable that moves the Windows build folder, and that folder's name at the drive's root. */
  readonly windowsBuild: { readonly env: string; readonly folder: string }
  /** Copies the engine's own extra files from the source into the staging folder. */
  readonly extras: (source: string, staging: string) => Promise<void>
}

// The oldest macOS Electron 44 runs on; a newer target would drop computers the app runs on.
const macosTarget = "12.0"

const windows = process.platform === "win32"
const macos = process.platform === "darwin"
const platform = process.platform

// Every command runs in a directory of its own with relative paths where it can: GNU tar
// reads `C:` in a path as a host name.
const run = (
  label: string,
  root: string,
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
        ? `Building the ${label} needs ${command} on the PATH.`
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
const requireTools = (label: string): void => {
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

// The source tarball at the pinned commit, checked against its SHA-256 before anything
// reads it, and kept so later builds need no network.
const download = async (spec: EngineSpec, cache: string): Promise<string> => {
  const { project, version, commit, sourceUrl, sourceSha256 } = spec
  const tarball = join(cache, `${project}-${commit}.tar.gz`)
  if (existsSync(tarball) && sha256(readFileSync(tarball)) === sourceSha256) return tarball
  console.log(`Downloading ${project} ${version}`)
  const response = await fetch(sourceUrl)
  if (!response.ok) throw new Error(`Downloading ${sourceUrl} failed: ${response.status}`)
  const data = new Uint8Array(await response.arrayBuffer())
  if (sha256(data) !== sourceSha256) {
    throw new Error(`${project}'s source tarball is not the one pinned (${sourceUrl}).`)
  }
  await mkdir(cache, { recursive: true })
  const temporary = `${tarball}.${process.pid}.tmp`
  await writeFile(temporary, data)
  await rename(temporary, tarball)
  return tarball
}

// The source with the patches applied, in a folder named for them, so a changed patch
// extracts and builds afresh and an unchanged one reuses the last build.
const prepare = async (
  spec: EngineSpec,
  cache: string,
  tarball: string,
): Promise<{ source: string; build: string }> => {
  const { root, label, commit } = spec
  const patchesDirectory = join(root, "patches")
  const patches = readdirSync(patchesDirectory)
    .filter((name) => name.endsWith(".patch"))
    .toSorted()
  const hash = createHash("sha256")
  for (const name of patches) hash.update(readFileSync(join(patchesDirectory, name)))
  const key = `${commit.slice(0, 12)}-${hash.digest("hex").slice(0, 12)}`
  const directory = join(cache, key)
  const source = join(directory, "source")
  if (!existsSync(join(directory, "patched"))) {
    await rm(directory, { recursive: true, force: true })
    await mkdir(source, { recursive: true })
    run(label, root, tar, ["-xzf", tarball, "--strip-components=1", "-C", source], root)
    for (const name of patches) {
      const patch = join(patchesDirectory, name)
      // The source is a bare folder to git: inside this repository it would skip every
      // file this repository ignores, as the cache is, and report success.
      const bare = { ...process.env, GIT_CEILING_DIRECTORIES: cache }
      run(label, root, "git", ["apply", "--whitespace=nowarn", patch], source, bare)
      // A patch that did not take must stop the build, not ship an unpatched server.
      run(label, root, "git", ["apply", "--reverse", "--check", patch], source, bare)
    }
    await writeFile(join(directory, "patched"), "")
  }
  return { source, build: windows ? shortBuild(spec, key) : join(directory, "build") }
}

// MSBuild fails past 260 characters, and the Vulkan backend's shader generator is a
// project nested deep inside the build tree, so on Windows the build goes to a short
// folder at the drive's root, or where the engine's environment variable says.
const shortBuild = (spec: EngineSpec, key: string): string =>
  process.env[spec.windowsBuild.env] ??
  join(parse(spec.root).root, spec.windowsBuild.folder, shorten(key))

// The commit's first eight characters and the patches' first six, so a changed patch gets a
// folder of its own, not the last build's CMake cache.
const shorten = (key: string): string => {
  const [commit = "", patches = ""] = key.split("-")
  return `${commit.slice(0, 8)}-${patches.slice(0, 6)}`
}

// Options for every platform: shared libraries, no OpenMP runtime to ship, and no native CPU
// tuning (the engine runs on other computers than it is built on).
const common = [
  "-DCMAKE_BUILD_TYPE=Release",
  "-DBUILD_SHARED_LIBS=ON",
  "-DGGML_NATIVE=OFF",
  "-DGGML_OPENMP=OFF",
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

const compile = (spec: EngineSpec, cache: string, source: string, build: string): void => {
  const { label, root } = spec
  // The same source must build the same engine, or every installed app fetches it again.
  // ggml stamps the git commit it finds into its library: inside this repository that is
  // Novadeck's own, which changes with every commit, so git is kept from finding one. MSVC
  // stamps the time unless told not to; CMake takes these as its first flags.
  const reproducible = {
    ...process.env,
    GIT_CEILING_DIRECTORIES: cache,
    ...(windows && { CFLAGS: "/Brepro", CXXFLAGS: "/Brepro", LDFLAGS: "/Brepro" }),
  }
  run(
    label,
    root,
    "cmake",
    ["-S", source, "-B", build, ...common, ...spec.options, ...platformOptions()],
    root,
    reproducible,
  )
  // Backend modules are dependencies of the library, so building the server builds them.
  run(label, root, "cmake", [
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

const isLibrary = (name: string): boolean =>
  windows
    ? name.endsWith(".dll")
    : macos
      ? name.endsWith(".dylib")
      : name.endsWith(".so") || name.includes(".so.")

// The server and every library and module it loads, wherever the generator put them,
// gathered flat. Links keep their names, as the server asks for them by soname.
const gather = async (
  build: string,
  staging: string,
  source: string,
  executable: string,
  extras: EngineSpec["extras"],
): Promise<void> => {
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
  await extras(source, staging)
}

// Apple silicon runs only signed code, and the linker's signature does not survive the
// rewrites above, so on macOS every Mach-O is signed again: with the Developer ID that
// NOVADECK_MAC_IDENTITY names, under the hardened runtime as the app is, or else ad hoc.
const signMac = async (
  label: string,
  root: string,
  staging: string,
  executable: string,
): Promise<void> => {
  const identity = process.env.NOVADECK_MAC_IDENTITY
  const how = identity
    ? ["--options", "runtime", "--timestamp", "--sign", identity]
    : ["--sign", "-"]
  for (const name of await readdir(staging)) {
    const path = join(staging, name)
    // A link points at a file signed under its own name.
    if (lstatSync(path).isFile() && (name === executable || isLibrary(name))) {
      run(label, root, "codesign", ["--force", ...how, path])
    }
  }
}

// The signing module, pinned: it runs with the Azure credentials in its environment.
// electron-builder installs its own, the newest, to sign the app.
const trustedSigning = "0.5.8"

// A PowerShell string literal.
const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`

// On Windows the server and its modules are signed through Azure Artifact Signing, as the
// app is, when the release names the account; the module reads its credentials from
// AZURE_TENANT_ID, AZURE_CLIENT_ID and AZURE_CLIENT_SECRET.
const signWindows = (label: string, root: string, staging: string): void => {
  const endpoint = process.env.AZURE_SIGNING_ENDPOINT
  const account = process.env.AZURE_SIGNING_ACCOUNT
  const profile = process.env.AZURE_SIGNING_PROFILE
  if (!endpoint || !account || !profile) return
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `Install-Module -Name TrustedSigning -RequiredVersion ${trustedSigning} -Force -Repository PSGallery -Scope CurrentUser`,
    `Import-Module -Name TrustedSigning -RequiredVersion ${trustedSigning}`,
    [
      "Invoke-TrustedSigning",
      `-Endpoint ${quote(endpoint)}`,
      `-CodeSigningAccountName ${quote(account)}`,
      `-CertificateProfileName ${quote(profile)}`,
      `-FilesFolder ${quote(staging)}`,
      "-FilesFolderFilter 'exe,dll'",
      "-FileDigest SHA256",
      "-TimestampRfc3161 'http://timestamp.acs.microsoft.com'",
      "-TimestampDigest SHA256",
    ].join(" "),
  ].join("\n")
  run(label, root, "pwsh", ["-NoProfile", "-NonInteractive", "-Command", script])
}

const sign = async (
  label: string,
  root: string,
  staging: string,
  executable: string,
): Promise<void> => {
  if (macos) await signMac(label, root, staging, executable)
  if (windows) signWindows(label, root, staging)
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
const place = async (
  dist: string,
  archive: string,
  engineInterface: number,
  staging: string,
): Promise<void> => {
  await mkdir(dist, { recursive: true })
  const data = pack(staging, (await readdir(staging)).toSorted())
  const manifest = {
    file: archive,
    sha256: sha256(data),
    size: data.length,
    interface: engineInterface,
  }
  const temporary = join(dist, `${archive}.${process.pid}.tmp`)
  await writeFile(temporary, data)
  await rename(temporary, join(dist, archive))
  const manifestTemporary = join(dist, `engine.json.${process.pid}.tmp`)
  await writeFile(manifestTemporary, `${JSON.stringify(manifest, null, 2)}\n`)
  await rename(manifestTemporary, join(dist, "engine.json"))
  console.log(`Built ${archive} (${data.length} bytes, sha256 ${manifest.sha256})`)
}

/** Builds the engine for this platform into `<root>/dist`: the archive and its `engine.json`. */
export const buildEngine = async (spec: EngineSpec): Promise<void> => {
  const cache = join(spec.root, ".cache")
  const arch = macos ? "universal" : process.arch
  const archive = `novadeck-${spec.name}-${platform}-${arch}.tar.gz`
  const executable = windows ? `${spec.executable}.exe` : spec.executable
  requireTools(spec.label)
  const { source, build } = await prepare(spec, cache, await download(spec, cache))
  compile(spec, cache, source, build)
  const staging = join(cache, "staging")
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  await gather(build, staging, source, executable, spec.extras)
  await sign(spec.label, spec.root, staging, executable)
  await place(join(spec.root, "dist"), archive, spec.engineInterface, staging)
}
