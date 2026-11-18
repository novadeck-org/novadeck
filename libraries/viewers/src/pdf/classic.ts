// pdf.js ships as ES modules, which a frame of no origin can't load as modules from the app's
// files. As the frame runs them, from blob addresses, as classic scripts: the one export list
// at the end becomes a global (`pdfjsLib`, as pdf.js's own legacy builds name it, or
// `pdfjsWorker`, which pdf.js looks for), and `import.meta.url`, which a classic script can't
// name, becomes a fixed address: pdf.js uses it only to find Node's canvas and the decoders'
// own files, which the app hands it instead.

const exports = /export\s*\{([^}]*)\}\s*;?\s*$/

/** A pdf.js module's text as a classic script that puts its exports on `global`. */
export const asClassic = (text: string, global: "pdfjsLib" | "pdfjsWorker"): string => {
  const found = exports.exec(text.trimEnd())
  if (!found || text.indexOf("export{") !== text.lastIndexOf("export{"))
    throw new Error("pdf.js's module doesn't end in its one export list")
  const names = found[1]!
    .split(",")
    .map((each) => each.trim())
    .filter(Boolean)
    .map((each) => {
      const [local, , exported] = each.split(/\s+/)
      return `${JSON.stringify(exported ?? local)}:${local}`
    })
  const body = text.trimEnd().slice(0, found.index).replaceAll("import.meta.url", '"about:blank"')
  // Strict, as a module is.
  return `"use strict";\n${body}\nglobalThis.${global}={${names.join(",")}};\n`
}
