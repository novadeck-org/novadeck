// novadeck.dev, which update checks and feedback notes go through.

export const novadeckSite = "https://novadeck.dev"

/**
 * The origin of an address on this computer (localhost, 127.0.0.1 or [::1], over http or
 * https), which is all a replacement for the website may be; anything else is undefined.
 */
export const localOrigin = (site: string): string | undefined => {
  try {
    const url = new URL(site)
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    return local && (url.protocol === "https:" || url.protocol === "http:") ? url.origin : undefined
  } catch {
    return undefined
  }
}
