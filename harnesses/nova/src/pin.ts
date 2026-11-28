import { join, posix, win32 } from "node:path"

// Nova's program: a pinned build of pi's standalone binary (Bun-compiled, no Node), which
// Novadeck downloads the first time it starts one, into its own data folder (the runner's
// harnesses/nova.ts fetches it), and runs on an agent folder of its own. It is not the
// person's pi (harnesses/pi, found on PATH), and never reads or writes `~/.pi`.

/** One build of pi for one system: its archive on the release, and its program inside. */
export type PiBuild = {
  readonly file: string
  readonly sha256: string
  readonly size: number
  /** The program, as the archive holds it. */
  readonly program: string
}

/**
 * The pinned pi: its release's archives by system (`<platform>-<arch>`, as Node names them),
 * from its `SHA256SUMS`, and pi's MIT licence, by the commit the release's tag names, which
 * every copy keeps beside its program. Read 2026-11-25 from github.com/earendil-works/pi,
 * release v1.6.0, the version the pi e2e runs.
 */
export const pinnedPi = {
  version: "1.6.0",
  source: "https://github.com/earendil-works/pi/releases/download/v1.6.0/",
  builds: {
    "linux-x64": {
      file: "pi-linux-x64.tar.gz",
      sha256: "ef77dbe4379b3bdeb425a1e1b862fa3c915c255000dfe4965c98eee96a5765d1",
      size: 58_977_130,
      program: "pi/pi",
    },
    "linux-arm64": {
      file: "pi-linux-arm64.tar.gz",
      sha256: "5404547b9739be596d50ae7142c52535899e8e7dd37a7bace9be593e0355b468",
      size: 58_847_610,
      program: "pi/pi",
    },
    "darwin-x64": {
      file: "pi-darwin-x64.tar.gz",
      sha256: "5b69cd87c3b00e74cce2d1499df3b7a1ec73632f11abf64696d110f0f4dc4192",
      size: 50_640_053,
      program: "pi/pi",
    },
    "darwin-arm64": {
      file: "pi-darwin-arm64.tar.gz",
      sha256: "6429287b7ae98d726ec577815d14fd680e7c587e89ecc5153b4a145dc4adba33",
      size: 48_128_107,
      program: "pi/pi",
    },
    "win32-x64": {
      file: "pi-windows-x64.zip",
      sha256: "f5defb6c403ee698f5b3f8886db473e55b78aac670a8ce03620a47f5f0aec57c",
      size: 61_995_847,
      program: "pi.exe",
    },
    "win32-arm64": {
      file: "pi-windows-arm64.zip",
      sha256: "56433d392e1baecf9f1692785a3bf171c125b415a29dd36097d02baca98bc9eb",
      size: 56_672_454,
      program: "pi.exe",
    },
  } satisfies { readonly [system: string]: PiBuild },
  licence: {
    url: "https://raw.githubusercontent.com/earendil-works/pi/faac585884ae2c013a6b1400f3e9e77f10b34bac/LICENSE",
    sha256: "0457f5bcec3b3b211605dfb5d1a49042fd638f3686a410fe099c24a25af13c48",
    size: 1069,
  },
} as const

export type PinnedPi = {
  readonly version: string
  readonly source: string
  readonly builds: { readonly [system: string]: PiBuild }
  readonly licence: { readonly url: string; readonly sha256: string; readonly size: number }
}

/** The build of `pinned` for this system, or undefined where pi publishes none. */
export const buildFor = (
  platform: NodeJS.Platform,
  arch: string,
  pinned: PinnedPi = pinnedPi,
): PiBuild | undefined => pinned.builds[`${platform}-${arch}`]

/** Where Nova lives under Novadeck's data folder `data`. */
export const novaFolder = (data: string): string => join(data, "nova")

/**
 * Where Nova keeps its settings, sign-ins and sessions (its `PI_CODING_AGENT_DIR`): a
 * folder of Novadeck's, never the person's `~/.pi/agent`. It outlives a new pinned version.
 */
export const novaHome = (data: string): string => join(novaFolder(data), "agent")

/**
 * Whether a pi session is Nova's, by its transcript: its sessions are kept in its own
 * agent folder (`novaHome`, its `PI_CODING_AGENT_DIR`), and the person's pi never writes
 * there. False with no transcript, which pi names as its session starts.
 */
export const novaSession = (
  transcript: string | undefined,
  data: string,
  platform: NodeJS.Platform = process.platform,
): boolean => {
  if (transcript === undefined) return false
  const paths = platform === "win32" ? win32 : posix
  const fold = (text: string) =>
    platform === "win32" || platform === "darwin" ? text.toLowerCase() : text
  const inner = paths.relative(fold(paths.resolve(novaHome(data))), fold(paths.resolve(transcript)))
  return inner !== "" && inner.split(paths.sep)[0] !== ".." && !paths.isAbsolute(inner)
}

/** The folder a build unpacks to: its version and the start of its checksum. */
export const buildFolder = (
  data: string,
  build: PiBuild,
  version: string = pinnedPi.version,
): string => join(novaFolder(data), `${version}-${build.sha256.slice(0, 12)}`)

/** The program of `build` once it is in place under `data`. */
export const novaBinary = (
  data: string,
  build: PiBuild,
  version: string = pinnedPi.version,
): string => join(buildFolder(data, build, version), build.program)
