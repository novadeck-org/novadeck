// What the app runs on beside its own code: what a packaged build ships in its resources
// folder, or a development run finds in the repository.
import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"

import { app } from "electron"

import { releaseDownloadsUrl, releaseRepositoryOf } from "./releases/repository.js"

/** Where a development run's UI dev server serves the app's page. */
export const developmentOrigin = "http://127.0.0.1:5173"

/** The packaged UI's page, which the app's windows load once packaged. */
export const uiFile = (): string => join(process.resourcesPath, "ui", "index.html")

/** The address of the app's own page: the packaged UI's file, or the dev server. */
export const uiAddress = (): string =>
  app.isPackaged ? pathToFileURL(uiFile()).href : developmentOrigin

/** Waits for the UI dev server to answer, as a development run starts beside it. */
export const waitForUi = async (origin: string, attempts = 100): Promise<void> => {
  try {
    const response = await fetch(origin)
    if (response.ok) return
  } catch {
    // The UI dev server is still starting.
  }

  if (attempts === 1) throw new Error(`UI did not become ready at ${origin}`)

  await new Promise((resolve) => setTimeout(resolve, 100))
  return waitForUi(origin, attempts - 1)
}

/**
 * The relay agents start for Novadeck's MCP server and hooks: shipped beside the UI, or built
 * in the relay's package, which the app's dependency on it finds wherever its folder is.
 */
export const relayPath = (): string => {
  const name = process.platform === "win32" ? "novadeck-relay.exe" : "novadeck-relay"
  if (app.isPackaged) return join(process.resourcesPath, "relay", name)
  const relay = createRequire(join(app.getAppPath(), "package.json")).resolve("@novadeck/relay")
  return join(dirname(relay), "dist", name)
}

/**
 * The repository the packaged build was released from, as `resources/app-update.yml`
 * names it, or undefined when that file is missing or names none GitHub could have.
 */
export const releaseRepository = async (): Promise<ReturnType<typeof releaseRepositoryOf>> =>
  releaseRepositoryOf(
    await readFile(join(process.resourcesPath, "app-update.yml"), "utf8").catch(() => ""),
  )

/** An engine's manifest, and the folder or address its archive is downloaded from. */
export type EngineFiles = { readonly manifest: string; readonly source: string }

/**
 * Where an engine is found: the manifest shipped beside the UI in `packaged`, or the one
 * `pnpm build:engine` leaves in engines/`built`/dist; and where its archive is downloaded
 * from, which is the release this build came from once packaged, in the repository
 * app-update.yml names. Without one the source is empty, and installing the engine fails
 * rather than download from a guess. The `sourceVariable` points a build at another folder
 * or address, as a local or pull request build needs: it has no release of its own to
 * download from.
 */
const engineFiles = async (
  built: string,
  packaged: string,
  sourceVariable: string,
): Promise<EngineFiles> => {
  if (!app.isPackaged) {
    const dist = join(app.getAppPath(), "..", "..", "engines", built, "dist")
    return { manifest: join(dist, "engine.json"), source: dist }
  }
  const override = process.env[sourceVariable]
  const repository = override ? undefined : await releaseRepository()
  return {
    manifest: join(process.resourcesPath, packaged, "engine.json"),
    source: override || (repository && releaseDownloadsUrl(repository, app.getVersion())) || "",
  }
}

/** Where voice input finds its engine; see `engineFiles`. */
export const voiceEngine = (): Promise<EngineFiles> =>
  engineFiles("whisper", "voice", "NOVADECK_VOICE_SOURCE")

/** Where murmur finds its engine; see `engineFiles`. */
export const murmurEngine = (): Promise<EngineFiles> =>
  engineFiles("murmur", "murmur", "NOVADECK_MURMUR_SOURCE")
