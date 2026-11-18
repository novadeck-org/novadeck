import type { PdfAssets } from "@novadeck/viewers/pdf"

// pdf.js's own files, as the PDF viewer asks for them: the Adobe CMaps a PDF's fonts may name,
// the standard fonts, and the decoders of scanned images (JPEG 2000, JBIG2). Each is its own
// chunk holding the file inline, loaded only when a PDF needs it: the desktop app's page is a
// file:// one, which can't fetch a file by its address.
const files = import.meta.glob<string>(
  [
    "../../../node_modules/pdfjs-dist/cmaps/*.bcmap",
    "../../../node_modules/pdfjs-dist/standard_fonts/*.{pfb,ttf}",
    "../../../node_modules/pdfjs-dist/wasm/*.wasm",
  ],
  { query: "?url&inline", import: "default" },
)

const folders = { cmap: "cmaps", font: "standard_fonts", wasm: "wasm" } as const

export const pdfAssets: PdfAssets = async (kind, name) => {
  const load = files[`../../../node_modules/pdfjs-dist/${folders[kind]}/${name}`]
  if (!load) throw new Error(`pdf.js has no ${kind} ${name}`)
  const url = await load()
  const data = url.slice(url.indexOf(",") + 1)
  return Uint8Array.from(atob(data), (char) => char.charCodeAt(0))
}
