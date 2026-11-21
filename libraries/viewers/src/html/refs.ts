// The addresses a web page names beside it, and what they stand for: the page's own text and
// the stylesheets it draws with give each as it writes it, and these read it as a name from the
// page's folder, the one the runner reads the file by. Pure text, so the app that reads the
// files and the frame that draws the page agree on every name.

/** The folder a name is in, `/` between names, "" for the page's own. */
export const folderOf = (name: string): string => name.slice(0, Math.max(0, name.lastIndexOf("/")))

/**
 * The name from the page's folder of an address `ref` written in a file in `folder` (a name
 * from the page's folder; "" for the page itself), or undefined where it names nothing beside
 * the page: a scheme (`https:`, `data:`, `file:`), another host (`//`), a root (`/` or `\`), only
 * a fragment, or a path that leaves the page's folder. A query or a fragment is dropped, and
 * percent-escapes are read, as the browser does.
 */
export const nameOf = (folder: string, ref: string): string | undefined => {
  const address = ref.trim()
  if (address === "" || address.startsWith("#")) return undefined
  if (/^[a-z][a-z0-9+.-]*:/i.test(address) || /^[\\/]/.test(address)) return undefined
  let path = address.replace(/[?#].*$/s, "")
  try {
    path = decodeURIComponent(path)
  } catch {
    return undefined
  }
  if (path.includes("\0")) return undefined
  const parts = folder === "" ? [] : folder.split("/")
  for (const part of path.replaceAll("\\", "/").split("/")) {
    if (part === "" || part === ".") continue
    if (part !== "..") {
      parts.push(part)
      continue
    }
    // A page can't reach above its own folder.
    if (parts.length === 0) return undefined
    parts.pop()
  }
  return parts.length === 0 ? undefined : parts.join("/")
}

// A stylesheet's text with its comments taken out, which name nothing.
const uncommented = (css: string): string => css.replace(/\/\*.*?\*\//gs, "")

/** The addresses a stylesheet writes, as it writes them: its `url()`s and `@import`s. */
export const cssAddresses = (css: string): string[] => {
  const text = uncommented(css)
  const found: string[] = []
  for (const match of text.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gis)) found.push(match[2]!)
  for (const match of text.matchAll(/@import\s+(['"])(.*?)\1/gi)) found.push(match[2]!)
  return found
}

/** The names a stylesheet in `folder` draws with, each once, in the order it writes them. */
export const cssNames = (css: string, folder: string): string[] => [
  ...new Set(cssAddresses(css).flatMap((ref) => nameOf(folder, ref) ?? [])),
]

/** What a name is as a file, by its extension: its media type, which a data address carries. */
const types: { readonly [extension: string]: string } = {
  css: "text/css",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  bmp: "image/bmp",
  woff2: "font/woff2",
  woff: "font/woff",
  ttf: "font/ttf",
  otf: "font/otf",
}

export const typeOf = (name: string): string =>
  types[/\.([^./]+)$/.exec(name)?.[1]?.toLowerCase() ?? ""] ?? "application/octet-stream"

export const isStyle = (name: string): boolean => typeOf(name) === "text/css"
