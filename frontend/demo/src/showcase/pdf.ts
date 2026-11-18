// The demo's PDFs, written as bytes in code so the pane's viewer has something to draw: a
// short quarterlyReport on Letter pages, each saying its number, in the plain Helvetica every viewer has.

const encoder = new TextEncoder()

// A PDF string's text with its delimiters escaped.
const escaped = (text: string): string => text.replace(/[\\()]/g, (char) => `\\${char}`)

// One page's content: a heading, its number large, and a line of text.
const pageStream = (title: string, number: number, count: number): string =>
  [
    "BT /F1 28 Tf 72 700 Td",
    `(${escaped(title)}) Tj`,
    "ET",
    "BT /F1 160 Tf 72 400 Td",
    `(${number}) Tj`,
    "ET",
    "BT /F1 14 Tf 72 72 Td",
    `(Page ${number} of ${count}) Tj`,
    "ET",
  ].join("\n")

// A PDF of `count` Letter pages (612 × 792 points), with the cross-reference table its
// readers need: object 1 is the catalog, 2 the page tree, 3 the font, then a page and its
// content for each.
export const makePdf = (title: string, count: number): Uint8Array<ArrayBuffer> => {
  const pages = Array.from({ length: count }, (_, index) => 4 + index * 2)
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.map((id) => `${id} 0 R`).join(" ")}] /Count ${count} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ...pages.flatMap((id, index) => {
      const stream = pageStream(title, index + 1, count)
      return [
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${id + 1} 0 R >>`,
        `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
      ]
    }),
  ]
  let out = "%PDF-1.4\n"
  const offsets = objects.map((object, index) => {
    const at = out.length
    out += `${index + 1} 0 obj\n${object}\nendobj\n`
    return at
  })
  const table = out.length
  out +=
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((at) => `${String(at).padStart(10, "0")} 00000 n \n`).join("") +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${table}\n%%EOF\n`
  return encoder.encode(out)
}

// The quarterlyReport an agent shows: five pages.
export const quarterlyReport = makePdf("Quarterly quarterlyReport", 5)

// Bytes that aren't a PDF, under a PDF's name.
export const notAPdf = encoder.encode("This is not a PDF. ".repeat(200))
