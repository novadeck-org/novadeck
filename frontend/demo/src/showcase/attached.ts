import { fileLines, ready, svg, type SampleArtifact } from "./artifacts"

// What the demo shows of a file the person opened from the Source panel that no agent showed:
// a short stand-in made from its path, so the pane has something plausible to read.

const imageTypes = /\.(png|jpe?g|gif|webp|svg)$/i

// The runner's secret-looking names that a demo project could hold; such a file is held,
// so the pane asks before it shows it.
const secretNames = [/^\.env(\..*)?$/i, /\.env$/i, /^\.npmrc$/i, /\.(pem|key)$/i]

export const looksSecret = (path: string): boolean => {
  const name = path.split("/").at(-1) ?? path
  return secretNames.some((pattern) => pattern.test(name))
}

// The path below the project's folder, as the Source panel names it; the file's own name where
// the folder isn't known.
const relativeTo = (path: string, directory: string | undefined): string =>
  directory && path.startsWith(`${directory}/`)
    ? path.slice(directory.length + 1)
    : (path.split("/").at(-1) ?? path)

// A name that is a valid identifier: other characters become `_`, and a digit can't lead.
const identifierOf = (name: string): string => {
  const plain = name.replace(/\W+/g, "_")
  return /^\d/.test(plain) ? `_${plain}` : plain
}

const stand = (relative: string): readonly string[] => {
  const name = relative.split("/").at(-1) ?? relative
  const base = name.replace(/\.[^.]+$/, "")
  if (/\.tsx?$/.test(name))
    return [
      `// ${relative}`,
      "",
      `export const ${identifierOf(base)} = () => {`,
      "  // Nothing to see here yet.",
      "}",
    ]
  if (name.endsWith(".json")) return ["{", `  "name": "${base}"`, "}"]
  if (name.endsWith(".md")) return [`# ${base}`, "", "Notes for this part of the project."]
  if (name.startsWith(".env")) return ["API_URL=http://localhost:3000"]
  return [`${relative}`, "", "A file of the project."]
}

// What the showcase gives an id to.
export type AttachedArtifact = {
  readonly item: Omit<SampleArtifact["item"], "id">
  readonly content: SampleArtifact["content"]
}

// The artifact for a file the person attached by its absolute path.
export const attachedArtifact = (path: string, directory?: string): AttachedArtifact => {
  const relative = relativeTo(path, directory)
  const name = relative.split("/").at(-1) ?? relative
  const held = looksSecret(path)
  if (imageTypes.test(name))
    return {
      item: { kind: "image", name, detail: relative, path, url: null, lines: null, held },
      content: ready({
        kind: "image",
        src: svg(
          800,
          450,
          `<rect width="800" height="450" fill="#f4f1ea"/>` +
            `<text x="400" y="235" font-family="Helvetica, Arial, sans-serif" font-size="28" fill="#2d2a24" text-anchor="middle">${name.replace(/[<&]/g, "")}</text>`,
        ),
      }),
    }
  const lines = stand(relative)
  return {
    item: { kind: "file", name, detail: relative, path, url: null, lines: null, held },
    content: ready(fileLines(relative, lines, { from: 1, to: lines.length })),
  }
}
