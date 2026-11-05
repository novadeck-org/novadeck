/** What an engine's `scripts/build.ts` names as its own; the rest of the build is shared. */
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
  /**
   * The patches in `patches/`, in the order they apply: a later one may change lines an
   * earlier one wrote. The folder must hold exactly these.
   */
  readonly patches: readonly string[]
  /** The CMake target that builds the server (and, through dependencies, its modules). */
  readonly target: string
  /** The server's executable, without `.exe`. */
  readonly executable: string
  /** The project's own CMake options, beside the common and platform ones. */
  readonly options: readonly string[]
  /** The environment variable that moves the Windows build folder, and that folder's name at the drive's root. */
  readonly windowsBuild: { readonly env: string; readonly folder: string }
  /**
   * Checks the patched source before it is built, so a check that fails stops the build
   * before minutes of compiling. It sees the source as `extras` does.
   */
  readonly checkSource?: (source: string) => Promise<void>
  /** Copies the engine's own extra files from the source into the staging folder. */
  readonly extras: (source: string, staging: string) => Promise<void>
}
