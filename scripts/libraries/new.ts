import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { isLibraryName, template, type Versions } from "./template.ts"

// `pnpm new:library <name> <description>`: writes a new library into libraries/<name> from
// the template. The import fence doesn't know it yet: add it to the order in
// scripts/libraries/order.ts and give it its override in .oxlintrc.json.

const root = join(import.meta.dirname, "..", "..")
const [name, ...words] = process.argv.slice(2)
const description = words.join(" ")

// The workspace's package names, without their scope: a library may not take one.
const taken = [
  "application",
  "apps",
  "backend",
  "contract",
  "engines",
  "frontend",
  "harnesses",
  "libraries",
  "tools",
]
  .flatMap((folder) =>
    existsSync(join(root, folder))
      ? readdirSync(join(root, folder)).map((each) => join(root, folder, each, "package.json"))
      : [],
  )
  .concat(join(root, "atlas/package.json"))
  .filter((file) => existsSync(file))
  .map((file) =>
    (JSON.parse(readFileSync(file, "utf8")) as { name: string }).name.split("/").at(-1)!,
  )

// One there already is the name's first, before it counts as taken.
if (name && existsSync(join(root, "libraries", name))) {
  console.error(`libraries/${name} already exists.`)
  process.exit(1)
}

if (!name || !isLibraryName(name, taken) || !description) {
  console.error(
    "usage: pnpm new:library <name> <description>, the name in lower-case-words, neither a workspace package's nor harness-*",
  )
  process.exit(1)
}

const folder = join(root, "libraries", name)

const { devDependencies } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  devDependencies: Versions
}
for (const [path, content] of Object.entries(template(name, description, devDependencies))) {
  mkdirSync(dirname(join(folder, path)), { recursive: true })
  writeFileSync(join(folder, path), content)
}
// In the repository's own style, as the template's JSON is written plainly.
execFileSync(process.execPath, [join(root, "node_modules", "oxfmt", "bin", "oxfmt"), folder], {
  cwd: root,
  stdio: ["ignore", "ignore", "inherit"],
})
console.log(
  `Wrote libraries/${name}. Next: pnpm install, fence it in and give it its first test (see libraries/README.md).`,
)
