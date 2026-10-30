// The languages the code viewer highlights, and which one a file is in by its name. Kept
// apart from the parsers, so knowing a file's language loads none of them.

export type Language =
  | "cpp"
  | "css"
  | "go"
  | "html"
  | "java"
  | "javascript"
  | "json"
  | "markdown"
  | "python"
  | "rust"
  | "typescript"
  | "tsx"
  | "xml"
  | "yaml"

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

const languages = new Set<string>(Object.values(extensions))

export const isLanguage = (language: string): language is Language => languages.has(language)

// The language of a file by its name, if it's one the viewer highlights. Only the table's own
// keys: `x.constructor` names no language.
export const languageOf = (path: string): Language | undefined => {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase()
  const dot = name.lastIndexOf(".")
  const extension = name.slice(dot + 1)
  return dot > 0 && Object.hasOwn(extensions, extension) ? extensions[extension] : undefined
}
