import type { Parser } from "@lezer/common"
import { classHighlighter, highlightCode } from "@lezer/highlight"

// Syntax highlighting for the files an agent shows, with CodeMirror's parsers but no
// editor. The language comes from the file's name, and its parser loads the first time
// a file of that language is shown. Each token gets `tok-*` classes, which
// the syntax recipe (syntax.css) colours.

// A run of text, where it starts in its line, and the classes for its kind of token,
// none for plain text.
export type Run = { readonly text: string; readonly from: number; readonly classes: string }
export type HighlightedLine = readonly Run[]

const loaders = {
  cpp: async () => (await import("@lezer/cpp")).parser,
  css: async () => (await import("@lezer/css")).parser,
  go: async () => (await import("@lezer/go")).parser,
  html: async () => (await import("@lezer/html")).parser,
  java: async () => (await import("@lezer/java")).parser,
  javascript: async () => (await import("@lezer/javascript")).parser.configure({ dialect: "jsx" }),
  json: async () => (await import("@lezer/json")).parser,
  markdown: async () => (await import("@lezer/markdown")).parser,
  python: async () => (await import("@lezer/python")).parser,
  rust: async () => (await import("@lezer/rust")).parser,
  typescript: async () => (await import("@lezer/javascript")).parser.configure({ dialect: "ts" }),
  tsx: async () => (await import("@lezer/javascript")).parser.configure({ dialect: "ts jsx" }),
  xml: async () => (await import("@lezer/xml")).parser,
  yaml: async () => (await import("@lezer/yaml")).parser,
} satisfies Record<string, () => Promise<Parser>>

export type Language = keyof typeof loaders

const extensions: Record<string, Language> = {
  c: "cpp",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  h: "cpp",
  hh: "cpp",
  hpp: "cpp",
  css: "css",
  go: "go",
  htm: "html",
  html: "html",
  java: "java",
  cjs: "javascript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  json: "json",
  jsonc: "json",
  markdown: "markdown",
  md: "markdown",
  py: "python",
  pyi: "python",
  rs: "rust",
  cts: "typescript",
  mts: "typescript",
  ts: "typescript",
  tsx: "tsx",
  svg: "xml",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
}

// The language of a file by its name, if it's one Novadeck highlights.
export const languageOf = (path: string): Language | undefined => {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase()
  const dot = name.lastIndexOf(".")
  return dot > 0 ? extensions[name.slice(dot + 1)] : undefined
}

const parsers = new Map<Language, Promise<Parser>>()

const parserFor = (language: Language): Promise<Parser> => {
  const known = parsers.get(language)
  if (known) return known
  const loading = loaders[language]()
  // A parser that failed to load is tried again the next time.
  loading.catch(() => parsers.delete(language))
  parsers.set(language, loading)
  return loading
}

// The lines split into runs by kind of token, or null when the file's language isn't
// one Novadeck highlights. The lines are parsed together, so a construct spanning lines,
// such as a block comment, colours them all.
export const highlightLines = async (
  path: string,
  lines: readonly string[],
): Promise<readonly HighlightedLine[] | null> => {
  const language = languageOf(path)
  if (!language) return null
  const parser = await parserFor(language)
  const code = lines.join("\n")
  const highlighted: Run[][] = [[]]
  let from = 0
  highlightCode(
    code,
    parser.parse(code),
    classHighlighter,
    (text, classes) => {
      highlighted.at(-1)!.push({ text, from, classes })
      from += text.length
    },
    () => {
      highlighted.push([])
      from = 0
    },
  )
  return highlighted
}
