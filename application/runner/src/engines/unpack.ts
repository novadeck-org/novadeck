import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { access, chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

/** Raised when an engine cannot be unpacked, started or used, in words for a person. */
export class EngineError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "EngineError"
  }
}

/** The file an engine's program has on this system: `llama-server`, or `llama-server.exe`. */
export const programFile = (name: string): string =>
  process.platform === "win32" ? `${name}.exe` : name

// On Windows the system's own tar: a GNU tar from Git or MSYS that comes first on the
// PATH reads `C:\\...` as a host name and fails.
export const tarProgram =
  process.platform === "win32"
    ? `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\tar.exe`
    : "tar"

export const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  )

/** Where engines unpacked from archives live, one folder per archive, under `directory`. */
export const enginesIn = (directory: string): string => join(directory, "engine")

/** The folder an archive with this checksum unpacks to. */
export const engineFolder = (directory: string, sha256: string): string =>
  join(enginesIn(directory), sha256.slice(0, 12))

// Beside the program, the interface the engine was unpacked for, as the manifest named it.
const interfaceMarker = ".interface"

/**
 * The interface of the engine in `folder`: what it was unpacked for. A marker that is
 * missing, unreadable or makes no sense matches nothing.
 */
export const engineInterface = async (folder: string): Promise<number> => {
  const text = await readFile(join(folder, interfaceMarker), "utf8").catch(() => "")
  return /^\d+$/.test(text.trim()) ? Number(text) : 0
}

/**
 * An engine of an earlier build that is still unpacked under `directory`, holds `program`
 * and speaks `wanted`, the interface this runner launches engines with, if there is one.
 */
export const olderEngine = async (
  directory: string,
  program: string,
  wanted: number,
): Promise<string | undefined> => {
  const root = enginesIn(directory)
  // Folders being unpacked start with a dot and are not whole yet.
  const entries = (await readdir(root).catch(() => [])).filter((entry) => !entry.startsWith("."))
  for (const entry of entries.toSorted()) {
    const folder = join(root, entry)
    // eslint-disable-next-line no-await-in-loop -- Stops at the first that runs.
    if ((await exists(join(folder, program))) && (await engineInterface(folder)) === wanted)
      return folder
  }
  return undefined
}

/**
 * Unpacks `archive` into its folder under `directory`, marked with the `version` of the
 * interface it speaks, and removes every other engine there, which an update has replaced:
 * each engine keeps a directory of its own. The archive must hold `program`. The system's
 * `tar` does the unpacking, as Windows 10 and later have one too. It unpacks beside the
 * folder and renames it, so one that is there is whole.
 */
export const unpack = async (
  archive: string,
  directory: string,
  sha256: string,
  version: number,
  program: string,
  signal?: AbortSignal,
): Promise<string> => {
  const target = engineFolder(directory, sha256)
  const staging = join(enginesIn(directory), `.unpacking-${randomUUID()}`)
  await mkdir(staging, { recursive: true })
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(tarProgram, ["-xzf", archive, "-C", staging], {
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
        ...(signal && { signal }),
      })
      let errors = ""
      child.stderr.setEncoding("utf8")
      child.stderr.on("data", (chunk: string) => (errors = (errors + chunk).slice(-500)))
      child.on("error", (error) =>
        reject(
          signal?.aborted
            ? error
            : new EngineError(`Could not unpack the engine: ${error.message}`),
        ),
      )
      child.on("close", (code) =>
        code === 0
          ? resolve()
          : reject(new EngineError(`Could not unpack the engine: ${errors.trim() || code}`)),
      )
    })
    if (!(await exists(join(staging, program))))
      throw new EngineError("The engine's archive does not hold the engine for this system.")
    if (process.platform !== "win32") await chmod(join(staging, program), 0o755)
    await writeFile(join(staging, interfaceMarker), `${version}\n`)
    await rm(target, { recursive: true, force: true })
    await rename(staging, target)
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }
  for (const entry of await readdir(enginesIn(directory)))
    if (join(enginesIn(directory), entry) !== target)
      await rm(join(enginesIn(directory), entry), { recursive: true, force: true })
  return target
}
