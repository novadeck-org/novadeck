/**
 * What tells two pages apart beside a terminal, one rule for the runner keying an item and
 * for a client matching items: showing a page again updates the item its key names. A
 * fragment never makes another page. A server on this machine is one page whatever route
 * or query it is at, as an agent previewing its dev server moves through it, and
 * `localhost`, `127.0.0.1`, `[::1]`, `0.0.0.0` and `[::]` name the same machine. Any other page
 * is its address without the fragment. An address that isn't one keys as given.
 */
export const pageKey = (address: string): string => {
  let url: URL
  try {
    url = new URL(address)
  } catch {
    return address
  }
  if (local.has(url.hostname)) return `${url.protocol}//localhost${url.port ? `:${url.port}` : ""}`
  url.hash = ""
  return url.href
}

const local = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0", "[::]"])

/**
 * The session live pages load in, named once for both halves of the browser viewer: the
 * UI's page views ask for it, and the desktop app's lockdown keeps them to it, in memory.
 */
export const pagesPartition = "novadeck-pages"
