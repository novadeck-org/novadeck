// The demo's PDFs: a five-page report, bytes that aren't a PDF under a PDF's name, and one
// locked with a password. Their bytes (pdf-data.ts, locked-pdf-data.ts) load only when a pane
// reads them, so they stay out of the demo's load; their sizes, which an item gives before
// they're read, are here (the showcase's tests check them against the bytes).

export const quarterlyReport = async (): Promise<Uint8Array<ArrayBuffer>> =>
  (await import("./pdf-data")).quarterlyReport
export const quarterlyReportSize = 2063

export const notAPdf = async (): Promise<Uint8Array<ArrayBuffer>> =>
  (await import("./pdf-data")).notAPdf
export const notAPdfSize = 3800

export const lockedPdf = async (): Promise<Uint8Array<ArrayBuffer>> =>
  (await import("./locked-pdf-data")).lockedPdfBytes()
export const lockedPdfSize = 2846
