// Whether a field's name sounds secret, by its words.

// Words that make a name a secret's wherever it is, and ones that do so only whole.
const secretInside = /(secret|passw|passphrase|apikey|privatekey|credential|has[lł][oa])/
const secretWords = new Set(["token", "pass", "pwd", "cookie", "bearer", "signature", "sig"])
// Words before `key`, which says what it opens: `api key`, but not `primary key` or `sort key`.
const keyOf = new Set([
  "api",
  "secret",
  "private",
  "access",
  "auth",
  "encryption",
  "signing",
  "license",
  "ssh",
  "account",
  "master",
  "client",
  "session",
])
// Words that end a name which only counts or points at a secret.
const notSecret = new Set([
  "count",
  "size",
  "budget",
  "limit",
  "length",
  "max",
  "min",
  "type",
  "name",
  "file",
  "path",
  "dir",
  "id",
  "ttl",
  "expiry",
  "expires",
  "url",
  "uri",
  "header",
  "field",
  "prefix",
])

export const soundsSecret = (name: string): boolean => {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
  const last = words.at(-1)
  // npm's `_auth` is a credential; a plain `auth` or `SSH_AUTH_SOCK` is not.
  if (/(^|_)_auth$/i.test(name) || /^_auth$/i.test(name)) return true
  if (last !== undefined && notSecret.has(last)) return last === "id" && words.includes("private")
  if (words.some((word) => secretInside.test(word))) return true
  if (words.some((word) => secretWords.has(word))) return true
  return words.some((word, index) => word === "key" && keyOf.has(words[index - 1] ?? ""))
}
