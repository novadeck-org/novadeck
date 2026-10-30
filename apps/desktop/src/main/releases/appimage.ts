import {
  downloadChecked,
  listedChecksum,
  portableAssets,
  type Download,
  type ReleaseText,
} from "./download.js"
import { latestVersionOf } from "./latest-yml.js"
import { isNewerVersion } from "./versions.js"

/** How getting the release's AppImage ready went: the file, or why not. */
export type AppImageOutcome =
  | { readonly kind: "ready"; readonly file: string }
  | { readonly kind: "failed"; readonly reason: string }

/** What getting the AppImage uses of the machine and the network. */
export type AppImageHost = ReleaseText & {
  /**
   * The addresses, each ending in "/", that assets download from: the release of the
   * version the last update offer named, the latest stable release's, and this copy's own.
   * Any is undefined where it cannot be named; there is no `offered` before an offer.
   */
  readonly downloads: {
    readonly offered: string | undefined
    readonly latest: string | undefined
    readonly own: string | undefined
  }
  /** This build's version. */
  readonly version: string
  readonly download: Download
  readonly remove: (file: string) => Promise<void>
  /** Makes the file something the installer can run to read its icon. */
  readonly makeExecutable: (file: string) => Promise<void>
  /** Told the whole percent downloaded, each as it changes. */
  readonly progress: (percent: number) => void
}

const what = "the AppImage"

/**
 * Downloads the release's AppImage into `file` and checks it against the `SHA256SUMS` of
 * the same release, all while the app runs normally, so a failure changes nothing. Which
 * release: the version the last update offer named, since that is what the card advertised;
 * else the latest stable one, as the Windows install does. A latest release older than this
 * copy is not installed (an `experimental` copy can be newer than the latest stable release), and
 * with no stable release at all (`latest` answers 404) this copy's own release is used
 * instead, which is by definition not older. A copy that fails to download is not made up
 * for with a copy of this older file: the person asked for the release, and an install of
 * something else would look like it worked.
 */
export const prepareAppImage = async (
  host: AppImageHost,
  file: string,
): Promise<AppImageOutcome> => {
  const { offered, latest, own } = host.downloads
  let base = offered
  if (base === undefined) {
    if (latest === undefined && own === undefined)
      return {
        kind: "failed",
        reason: "This copy does not know where Novadeck is released.",
      }
    try {
      const yaml = latest === undefined ? undefined : await host.text(`${latest}latest-linux.yml`)
      const version = yaml === undefined ? undefined : latestVersionOf(yaml)
      if (yaml !== undefined && version !== undefined && isNewerVersion(host.version, version))
        host.log("The latest release is older than this copy.", version)
      else if (yaml !== undefined) base = latest
    } catch (error) {
      host.log("The release information could not be fetched.", error)
      return {
        kind: "failed",
        reason: "The latest release could not be fetched. Are you online?",
      }
    }
    base ??= own
  }
  if (base === undefined)
    return {
      kind: "failed",
      reason: "No release with the AppImage was found.",
    }
  const name = portableAssets.linux
  const listed = await listedChecksum(host, base, name, what)
  if (listed.kind === "failed") return listed
  const downloaded = await downloadChecked(host, {
    url: `${base}${name}`,
    file,
    sha256: listed.sha256,
    what,
    progress: host.progress,
  })
  if (downloaded.kind === "failed") return downloaded
  try {
    await host.makeExecutable(file)
  } catch (error) {
    host.log("The AppImage could not be made executable.", error)
    await host.remove(file).catch(() => {})
    return {
      kind: "failed",
      reason: "The downloaded AppImage could not be prepared.",
    }
  }
  return { kind: "ready", file }
}
