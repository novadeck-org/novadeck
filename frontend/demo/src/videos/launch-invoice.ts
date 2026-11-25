// The one-page PDF the order-status agent shows in the launch demo: Northwind's invoice for the
// order its page is about (1042), as bytes a PDF viewer reads. Plain ASCII, one page, Helvetica.

const escape = (text: string): string => text.replace(/[\\()]/g, (char) => `\\${char}`)

// A line of text at a point, in the bold or the plain face.
const text = (x: number, y: number, size: number, words: string, bold = false): string =>
  `BT /${bold ? "F2" : "F1"} ${size} Tf ${x} ${y} Td (${escape(words)}) Tj ET`

const row = (y: number, name: string, quantity: string, price: string): string =>
  [
    text(56, y, 12, name),
    text(380, y, 12, quantity),
    text(500, y, 12, price),
    `0.88 0.9 0.92 RG 56 ${y - 10} m 556 ${y - 10} l S`,
  ].join("\n")

const content = [
  "0.145 0.388 0.922 rg 56 726 22 22 re f",
  "0.067 0.094 0.153 rg",
  text(88, 730, 20, "Northwind", true),
  text(56, 660, 11, "INVOICE", true),
  text(56, 630, 28, "Invoice 1042", true),
  text(56, 606, 12, "Placed Tuesday. Shipped Thursday. Paid by card ending 4242."),
  text(56, 556, 11, "ITEM", true),
  text(380, 556, 11, "QTY", true),
  text(500, 556, 11, "PRICE", true),
  row(526, "Canvas tote, natural", "1", "$38.00"),
  row(496, "Enamel mug, 350 ml", "2", "$32.00"),
  row(466, "Notebook, dotted", "3", "$27.00"),
  text(380, 420, 12, "Total", true),
  text(500, 420, 12, "$97.00", true),
  text(56, 90, 10, "Northwind, 12 Quay Street. Questions about this order: help@northwind.example"),
].join("\n")

const objects = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>",
  `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
]

/** The invoice's bytes. */
export const invoiceBytes = (): Uint8Array<ArrayBuffer> => {
  let out = "%PDF-1.4\n"
  const offsets = objects.map((body, index) => {
    const at = out.length
    out += `${index + 1} 0 obj\n${body}\nendobj\n`
    return at
  })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const at of offsets) out += `${String(at).padStart(10, "0")} 00000 n \n`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(out)
}
