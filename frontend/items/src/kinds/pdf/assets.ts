import type { PdfAssets, PdfFrame } from "@novadeck/viewers/pdf"

// What the PDF viewer's frame is handed: pdf.js itself and its worker, as text, and pdf.js's
// own files as the frame asks for them, the Adobe CMaps a PDF's fonts may name, the standard
// fonts, and the decoders of scanned images (JPEG 2000, JBIG2). Each is a chunk of its own
// holding the file inline, loaded only when a PDF needs it: the desktop app's page is a file://
// one, which can't fetch a file by its address, and the frame can't load one at all.
const files = import.meta.glob<string>(
  [
    "../../../node_modules/pdfjs-dist/cmaps/*.bcmap",
    "../../../node_modules/pdfjs-dist/standard_fonts/*.{pfb,ttf}",
    // The image decoders only: pdf.js's script engine (quickjs) is never run, and its
    // colour-profile module (qcms) isn't used when the app hands it its files.
    "../../../node_modules/pdfjs-dist/wasm/{openjpeg,jbig2}.wasm",
  ],
  { query: "?url&inline", import: "default" },
)
const code = import.meta.glob<string>(
  [
    "../../../node_modules/pdfjs-dist/build/pdf.min.mjs",
    "../../../node_modules/pdfjs-dist/build/pdf.worker.min.mjs",
  ],
  { query: "?url&inline", import: "default" },
)

const folders = { cmap: "cmaps", font: "standard_fonts", wasm: "wasm" } as const

// A data URL's bytes.
const bytesOf = (url: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(url.slice(url.indexOf(",") + 1)), (char) => char.charCodeAt(0))

const textOf = async (path: string): Promise<string> => {
  const load = code[`../../../node_modules/pdfjs-dist/build/${path}`]
  if (!load) throw new Error(`pdf.js has no ${path}`)
  return new TextDecoder().decode(bytesOf(await load()))
}

export const pdfAssets: PdfAssets = async (kind, name) => {
  const load = files[`../../../node_modules/pdfjs-dist/${folders[kind]}/${name}`]
  if (!load) throw new Error(`pdf.js has no ${kind} ${name}`)
  return bytesOf(await load())
}

/** The frame: its page beside the app's (frontend/ui/public/pdf-frame.html), and pdf.js. */
export const pdfFrame = (): PdfFrame => ({
  url: new URL("pdf-frame.html", document.baseURI).href,
  code: pdfCode,
})
const pdfCode = async () => {
  const [library, worker] = await Promise.all([textOf("pdf.min.mjs"), textOf("pdf.worker.min.mjs")])
  return { library, worker }
}
