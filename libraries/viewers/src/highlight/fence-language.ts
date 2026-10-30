import type { Language } from "./languages.js"

// The language a fenced block's info string names, by the names people write it with;
// undefined for one the highlighter doesn't know.
const aliases: Readonly<Record<string, Language>> = {
  js: "javascript",
  javascript: "javascript",
  jsx: "javascript",
  node: "javascript",
  ts: "typescript",
  typescript: "typescript",
  tsx: "tsx",
  json: "json",
  jsonc: "json",
  json5: "json",
  css: "css",
  html: "html",
  xml: "xml",
  svg: "xml",
  md: "markdown",
  markdown: "markdown",
  py: "python",
  python: "python",
  rs: "rust",
  rust: "rust",
  go: "go",
  golang: "go",
  java: "java",
  c: "cpp",
  h: "cpp",
  cpp: "cpp",
  "c++": "cpp",
  yaml: "yaml",
  yml: "yaml",
}

export const fenceLanguage = (info: string): Language | undefined => {
  const name = info.toLowerCase()
  return Object.hasOwn(aliases, name) ? aliases[name] : undefined
}
