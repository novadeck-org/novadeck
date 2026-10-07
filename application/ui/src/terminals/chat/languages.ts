// What a fenced block's info string names, as the file name the highlighter knows its
// language by; undefined for a language it doesn't highlight.
const aliases: Readonly<Record<string, string>> = {
  js: "js",
  javascript: "js",
  jsx: "jsx",
  node: "js",
  ts: "ts",
  typescript: "ts",
  tsx: "tsx",
  json: "json",
  jsonc: "json",
  json5: "json",
  css: "css",
  html: "html",
  xml: "xml",
  svg: "xml",
  md: "md",
  markdown: "md",
  py: "py",
  python: "py",
  rs: "rs",
  rust: "rs",
  go: "go",
  golang: "go",
  java: "java",
  c: "c",
  h: "h",
  cpp: "cpp",
  "c++": "cpp",
  yaml: "yaml",
  yml: "yaml",
}

export const fenceFile = (info: string): string | undefined => {
  const extension = aliases[info.toLowerCase()]
  return extension ? `code.${extension}` : undefined
}
