// The pictures the demo shows for the images of prompts: two small mood-board swatches in the
// demo's colours, as data URLs (SVG here, where the real runner answers PNG, JPEG, GIF or WebP),
// so a seeded prompt's thumbnails need no files. A picture the person pasted shows as pasted.

const swatch = (ground: string, shapes: string): string =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200">` +
      `<rect width="320" height="200" fill="${ground}"/>${shapes}</svg>`,
  )}`

const samples: readonly string[] = [
  swatch(
    "#f4efe6",
    `<rect x="24" y="24" width="272" height="30" rx="4" fill="#2b2b2b"/>` +
      `<rect x="24" y="72" width="168" height="104" rx="6" fill="#d9a441"/>` +
      `<rect x="208" y="72" width="88" height="48" rx="6" fill="#4d7c6f"/>` +
      `<rect x="208" y="128" width="88" height="48" rx="6" fill="#c4553b"/>`,
  ),
  swatch(
    "#1d2733",
    `<circle cx="96" cy="100" r="56" fill="#e8b94a"/>` +
      `<rect x="176" y="44" width="120" height="14" rx="3" fill="#f4efe6"/>` +
      `<rect x="176" y="72" width="96" height="10" rx="3" fill="#8aa0b4"/>` +
      `<rect x="176" y="92" width="108" height="10" rx="3" fill="#8aa0b4"/>` +
      `<rect x="176" y="136" width="64" height="24" rx="12" fill="#c4553b"/>`,
  ),
]

/** The sample picture for the `index`th image of a prompt. */
export const samplePicture = (index: number): string => samples[index % samples.length]!

const types: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
}

/** The media type a pasted file's name says, else PNG, the pasted screenshot's. */
export const typeOfName = (name: string): string =>
  types[name.split(".").pop()?.toLowerCase() ?? ""] ?? "image/png"

/** Bytes as a data URL of `type`. */
export const dataUrl = (type: string, data: Uint8Array): string => {
  let binary = ""
  for (let at = 0; at < data.length; at += 0x8000)
    binary += String.fromCharCode(...data.subarray(at, at + 0x8000))
  return `data:${type};base64,${btoa(binary)}`
}
