// `git check-ref-format --branch`, written out so no process runs for it.

/** Whether git would accept `name` as a branch name (not an `@{-N}` shorthand). */
export const isBranchName = (name: string): boolean => {
  if (name === "" || name === "@" || name.startsWith("-")) return false
  if (name.endsWith("/") || name.endsWith(".")) return false
  if (name.includes("..") || name.includes("@{")) return false
  for (const ch of name) {
    const code = ch.charCodeAt(0)
    if (code < 0x20 || code === 0x7f || " ~^:?*[\\".includes(ch)) return false
  }
  return name
    .split("/")
    .every((part) => part !== "" && !part.startsWith(".") && !part.endsWith(".lock"))
}
