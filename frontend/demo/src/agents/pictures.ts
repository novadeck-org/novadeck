// What the demo needs to show the images of prompts as the person pasted them: their type by
// name, and their bytes as data URLs. Its sample pictures, for the images it seeds, are in
// `sample-pictures.ts`, loaded only when a thumbnail asks for one.

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
