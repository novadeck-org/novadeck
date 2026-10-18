import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

// `node scripts/protocol/move-client.ts`: moves the runner client out of the protocol, into its
// own package `@novadeck/runner-client` (`application/runner-client`), and points every importer
// at it. It works out what to do from the tree it finds, so it runs again after other pull
// requests change the client or its importers. See scripts/protocol/README.md.

const root = join(import.meta.dirname, "..", "..")
const protocol = "application/protocol"
const client = "application/runner-client"
const name = "@novadeck/runner-client"
const oldSpecifier = "@novadeck/protocol/client"

// The client's files, and where each goes; `client.ts` is the package's entry.
const moved: Record<string, string> = {
  "client.ts": "index.ts",
  "runner.ts": "runner.ts",
  "desktop.ts": "desktop.ts",
  "errors.ts": "errors.ts",
}

// Who imports the client, and how: the UI ships it; the host bundles everything it uses, and the
// runner uses it only in its tests.
const consumers: Record<string, "dependencies" | "devDependencies"> = {
  "application/ui": "dependencies",
  "application/host": "devDependencies",
  "application/runner": "devDependencies",
}

const git = (...args: string[]): string =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 })
const read = (file: string): string => readFileSync(join(root, file), "utf8")
const write = (file: string, text: string): void => writeFileSync(join(root, file), text)
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

if (git("status", "--porcelain").trim() !== "") {
  console.error("The working tree isn't clean: commit or discard its changes first.")
  process.exit(1)
}
// Tracked files, not the folder: a reset leaves its ignored `node_modules/` and `dist/` behind.
if (git("ls-files", client).trim() !== "") {
  console.error(
    `${client} already exists: the move is done. Reset to the branch's base to run it again.`,
  )
  process.exit(1)
}
for (const file of Object.keys(moved))
  if (!existsSync(join(root, protocol, "src", file))) {
    console.error(`There is no ${protocol}/src/${file} to move.`)
    process.exit(1)
  }
// oxfmt from the workspace's own install: `pnpm exec` refuses once the manifests change.
const oxfmt = join(root, "node_modules", ".bin", "oxfmt")
try {
  execFileSync(oxfmt, ["--version"], { cwd: root, stdio: "ignore" })
} catch {
  console.error("oxfmt can't run here (pnpm install?), and the move formats what it changes.")
  process.exit(1)
}

// Where a protocol file that stays is imported from once the client is outside the protocol:
// its index, where the index re-exports it, or its own entry.
const fromIndex = new Set(
  [...read(`${protocol}/src/index.ts`).matchAll(/from\s+"\.\/([^"]+)\.js"/g)].map(
    ([, file]) => file!,
  ),
)
const protocolPackage = JSON.parse(read(`${protocol}/package.json`)) as {
  description: string
  exports: Record<string, unknown>
  dependencies: Record<string, string>
}
const entryOf = (file: string): string | undefined =>
  fromIndex.has(file)
    ? "@novadeck/protocol"
    : `./${file}` in protocolPackage.exports
      ? `@novadeck/protocol/${file}`
      : undefined

// The protocol's names a moved file took from several of its files, as one import of its index.
// A type-only import's names keep `type` inside the braces.
const oneImportOfTheProtocol = (text: string): string => {
  const each = /^import\s+(type\s+)?\{([^}]*)\}\s+from\s+"@novadeck\/protocol"\n/gm
  const found = [...text.matchAll(each)]
  if (found.length < 2) return text
  const names = found.flatMap(([, onlyTypes, list]) =>
    list!
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => (onlyTypes && !entry.startsWith("type ") ? `type ${entry}` : entry)),
  )
  let first = true
  return text.replace(each, () => {
    if (!first) return ""
    first = false
    return `import { ${names.join(", ")} } from "@novadeck/protocol"\n`
  })
}

// What the script can't write goes here and stops the run before it changes anything.
const problems: string[] = []
const dropped: string[] = []
const movedText = new Map<string, string>()

for (const [file, to] of Object.entries(moved)) {
  const text = read(`${protocol}/src/${file}`)
  const next = text
    // A re-export of a file that stays would be another package's API passed on; importers
    // take it from the protocol themselves.
    .replace(
      /^export\s*(?:type\s*)?(?:\{[^}]*\}|\*(?:\s*as\s+\w+)?)\s*from\s*"\.\/([^"]+)\.js";?\n?/gm,
      (whole, of: string) => {
        if (`${of}.ts` in moved) return whole
        dropped.push(`${file}: ${whole.trim().replace(/\s+/g, " ")}`)
        return ""
      },
    )
    .replace(/(\bfrom\s*|\bimport\(\s*)"\.\/([^"]+)\.js"/g, (whole, lead: string, of: string) => {
      const sibling = moved[`${of}.ts`]
      if (sibling) return `${lead}"./${sibling.replace(/\.ts$/, ".js")}"`
      const entry = entryOf(of)
      if (entry) return `${lead}"${entry}"`
      problems.push(`${file}: ./${of}.js is neither moved nor one of the protocol's entries`)
      return whole
    })
  if (/["']\.\.\//.test(next)) problems.push(`${file} imports something outside src/`)
  movedText.set(to, oneImportOfTheProtocol(next))
}

// A file that stays can't import one that moves: the protocol doesn't depend on the client.
for (const file of git("ls-files", `${protocol}/src`).split("\n").filter(Boolean)) {
  if (Object.keys(moved).some((each) => file === `${protocol}/src/${each}`)) continue
  for (const [, of] of read(file).matchAll(/(?:\bfrom\s*|\bimport\(\s*)"\.\/([^"]+)\.js"/g))
    if (`${of}.ts` in moved) problems.push(`${file} imports ./${of}.js, which moves to the client`)
}

// Every mention of the old entry or the moved files' paths, as text: imports, docs, comments,
// the atlas's anchors and the tests that name a path.
const paths = Object.entries(moved).map(
  ([file, to]) => [`${protocol}/src/${file}`, `${client}/src/${to}`] as const,
)
const rewrites = new Map<string, string>()
for (const file of git("ls-files", "-z").split("\0").filter(Boolean)) {
  if (!/\.(?:ts|tsx|mts|md|yml|json)$/.test(file) || file === "pnpm-lock.yaml") continue
  // The moved files are rewritten above, and this script and its README name the old paths.
  if (Object.keys(moved).some((each) => file === `${protocol}/src/${each}`)) continue
  if (file.startsWith("scripts/protocol/")) continue
  const text = read(file)
  if (!text.includes(oldSpecifier) && !paths.some(([from]) => text.includes(from))) continue
  let next = text.split(oldSpecifier).join(name)
  for (const [from, to] of paths) next = next.split(from).join(to)
  if (next !== text) rewrites.set(file, next)
}

// The client depends on the wire as the protocol does.
if (protocolPackage.dependencies["@novadeck/wire"] === undefined)
  problems.push(`${protocol} no longer depends on @novadeck/wire, which the client needs`)
// Every package whose code imports the client must be one the script gives it to: a new
// importer elsewhere would lose its dependency, and only a person knows whether it ships it.
const packageOf = (file: string): string | undefined => {
  for (let folder = dirname(file); folder !== "."; folder = dirname(folder))
    if (existsSync(join(root, folder, "package.json"))) return folder
  return undefined
}
const importsClient =
  /(?:\bfrom\s*|^\s*import\s*|\bimport\(\s*|\bvi\.\w+\(\s*)["']@novadeck\/protocol\/client["']/m
for (const file of rewrites.keys()) {
  if (!/\.(?:ts|tsx|mts)$/.test(file) || !importsClient.test(read(file))) continue
  const owner = packageOf(file)
  if (owner === undefined || !(owner in consumers))
    problems.push(
      `${file} imports the client, but ${owner ?? "no package"} isn't among the consumers ` +
        `(${Object.keys(consumers).join(", ")}): add it to \`consumers\` with the field it needs`,
    )
}

if (problems.length > 0) {
  console.error(`Stopped, nothing changed. Decide these first:\n${problems.join("\n")}`)
  process.exit(1)
}

// The move, then the moved files as rewritten.
mkdirSync(join(root, client, "src"), { recursive: true })
for (const [file, to] of Object.entries(moved))
  git("mv", `${protocol}/src/${file}`, `${client}/src/${to}`)
for (const [to, text] of movedText) write(`${client}/src/${to}`, text)
for (const [file, text] of rewrites) write(file, text)

// The package, shaped like the protocol: source under `development`, built types and code
// otherwise, and the protocol's own tsconfigs.
const wire = protocolPackage.dependencies["@novadeck/wire"]!
write(
  `${client}/package.json`,
  json({
    name,
    version: "0.0.0",
    private: true,
    description: "The client UIs connect to a Novadeck runner with.",
    type: "module",
    exports: {
      ".": {
        development: "./src/index.ts",
        types: "./dist/index.d.ts",
        default: "./dist/index.js",
      },
    },
    scripts: {
      build: "tsc -p tsconfig.build.json",
      typecheck: "tsc --noEmit -p tsconfig.json",
    },
    dependencies: { "@novadeck/protocol": "workspace:*", "@novadeck/wire": wire },
    devDependencies: JSON.parse(read(`${protocol}/package.json`)).devDependencies,
  }),
)
for (const config of ["tsconfig.json", "tsconfig.build.json"])
  write(`${client}/${config}`, read(`${protocol}/${config}`))

// The protocol keeps its contract and loses the client's entry.
const { "./client": _client, ...exports } = protocolPackage.exports
write(
  `${protocol}/package.json`,
  json({
    ...protocolPackage,
    description: protocolPackage.description.replace(/ and client\.$/, "."),
    exports,
  }),
)

// Each consumer depends on the client where it depended on the protocol's entry.
for (const [folder, field] of Object.entries(consumers)) {
  const manifest = JSON.parse(read(`${folder}/package.json`)) as Record<string, unknown>
  const deps = { ...(manifest[field] as Record<string, string>), [name]: "workspace:*" }
  manifest[field] = Object.fromEntries(
    Object.entries(deps).toSorted(([a], [b]) => a.localeCompare(b)),
  )
  write(`${folder}/package.json`, json(manifest))
}

const touched = [
  ...[...movedText.keys()].map((to) => `${client}/src/${to}`),
  ...rewrites.keys(),
  `${client}/package.json`,
  `${protocol}/package.json`,
  ...Object.keys(consumers).map((folder) => `${folder}/package.json`),
]
execFileSync(oxfmt, touched, { cwd: root, stdio: "inherit" })
execFileSync("pnpm", ["install", "--no-frozen-lockfile"], { cwd: root, stdio: "inherit" })

// What the script leaves to a person: patterns that name the protocol's client files without
// spelling a path out (the bench's attribution, the CI's paths).
let left = ""
try {
  left = git(
    "grep",
    "-n",
    "-E",
    "protocol/.*(client|runner|desktop|errors)",
    "--",
    ".",
    ":!pnpm-lock.yaml",
  )
    .split("\n")
    .filter(
      (line) => line && !line.startsWith(`${client}/`) && !line.startsWith("scripts/protocol/"),
    )
    .join("\n")
} catch {
  // git grep finds nothing: no mention left.
}
console.log(
  `Moved the client to ${client} and rewrote ${rewrites.size} files that named it.` +
    (dropped.length ? `\nDropped re-exports of files that stay:\n${dropped.join("\n")}` : ""),
)
if (left) console.log(`Mentions left for a person to check:\n${left}`)
