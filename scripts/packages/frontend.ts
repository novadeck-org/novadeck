// What step 5's 5.3b moves, and how each import and path that names it is rewritten: pure, so
// move-frontend.ts runs it over the tree and its tests run it over text. See README.md.

import { createHash } from "node:crypto"
import { builtinModules } from "node:module"
import { posix } from "node:path"

import { applyEdit, keeps, type Edit, type Kept } from "./move.ts"

export { applyEdit, type Edit }

// ---------------------------------------------------------------------------------------
// The packages
// ---------------------------------------------------------------------------------------

export type Pkg = {
  readonly id: string
  /** The package's folder from the repository's root. */
  readonly dir: string
  readonly name: string
  readonly description: string
  /** An app: its dependencies are what it ships, and no package imports it. */
  readonly app?: true
  /** Every file of the package is test code, so everything it imports is a dev dependency. */
  readonly allDev?: true
  /** The package.json "exports" the package defines itself; imports add the rest (below). */
  readonly exports?: Readonly<Record<string, unknown>>
  readonly scripts: Readonly<Record<string, string>>
  /** The Vitest projects the package's own config has: see `vitestConfig`. */
  readonly vitest?: "unit" | "unit+browser" | "template"
  /** Packages its tooling needs beyond what its files import. */
  readonly tooling?: readonly string[]
  /** The `include` of its tsconfig besides src. */
  readonly include?: readonly string[]
  readonly author?: string
}

const unitScripts = {
  test: "vitest run",
  "test:watch": "vitest",
  typecheck: "tsc --noEmit -p tsconfig.json",
} as const

export const packages: readonly Pkg[] = [
  {
    id: "core",
    dir: "frontend/core",
    name: "@novadeck/core",
    description:
      "The Novadeck UI's model: its state, stores and the port it talks to a backend through.",
    // Core's deep paths are its API, as `#core/*` was.
    exports: { "./*": "./src/*.ts" },
    scripts: unitScripts,
    vitest: "unit",
  },
  {
    id: "test-kit",
    dir: "frontend/test-kit",
    name: "@novadeck/test-kit",
    description: "What the UI's tests render and drive the app with.",
    exports: {
      "./render": "./src/render.ts",
      "./phases": "./src/phases.ts",
      "./backend-contract": "./src/backend-contract.tsx",
    },
    scripts: { typecheck: "tsc --noEmit -p tsconfig.json" },
  },
  {
    id: "terminal-views",
    dir: "frontend/terminal-views",
    name: "@novadeck/terminal-views",
    description: "The terminal views every backend draws its terminals with.",
    scripts: unitScripts,
    vitest: "unit+browser",
  },
  {
    id: "runner-adapter",
    dir: "frontend/runner-adapter",
    name: "@novadeck/runner-adapter",
    description: "The UI's backend for a Novadeck runner, over a WebSocket or the desktop host.",
    // `testing`, `scripted` and `scripted-server` are dev subpaths: they stay out of the build,
    // so the runner's and the oRPC server's edges stay dev-only.
    exports: {
      ".": "./src/index.ts",
      "./testing": { node: "./src/testing.ts" },
      "./scripted": "./src/scripted.ts",
      "./scripted-server": "./src/scripted-server.ts",
    },
    scripts: unitScripts,
    vitest: "unit",
  },
  {
    id: "demo",
    dir: "frontend/demo",
    name: "@novadeck/demo",
    description: "The UI's demo backend: a scripted workspace, for the website and the previews.",
    scripts: unitScripts,
    vitest: "unit+browser",
  },
  {
    id: "demo-debug",
    dir: "frontend/demo-debug",
    name: "@novadeck/demo-debug",
    description: "The demo's debug panel and rehearsals, for the content preview and the specs.",
    scripts: unitScripts,
    vitest: "unit",
  },
  {
    id: "specs",
    dir: "frontend/specs",
    name: "@novadeck/specs",
    description:
      "The UI's behaviour specs: the whole app in a real browser, over the demo backend.",
    allDev: true,
    scripts: unitScripts,
    vitest: "template",
    // `playwright` itself, which CI installs the browser with, and the packages its browser
    // projects optimize up front (`optimizeDeps.include` in its vitest.config.ts resolves each
    // from the specs' own folder, so each must be one of its dependencies).
    tooling: [
      "playwright",
      "@ark-ui/react",
      "@novadeck/emulator",
      "@novadeck/protocol",
      "@novadeck/wire",
      "@xyflow/react",
      "react-dom",
      "react-grid-layout",
    ],
  },
  {
    id: "ui",
    dir: "frontend/ui",
    name: "@novadeck/ui",
    description: "The Novadeck React frontend.",
    author: "mzpkdev",
    // What the apps start from; the specs' reach is added from their imports.
    exports: {
      "./app/App": "./src/app/App.tsx",
      "./styles.css": "./src/styles.css",
      "./theme/source": "./src/theme/source.ts",
      "./entries/start": "./src/entries/start.tsx",
      // The host finds the UI's folder through its manifest.
      "./package.json": "./package.json",
    },
    scripts: {
      dev: "vite --host 127.0.0.1",
      build: "vite build",
      preview: "vite preview --host 127.0.0.1",
      test: "vitest run",
      "test:watch": "vitest",
      typecheck: "tsc --noEmit -p tsconfig.json",
    },
    vitest: "unit",
    include: ["entries/**/*.tsx"],
  },
  {
    id: "try",
    dir: "apps/try",
    name: "@novadeck/try",
    description: "The visitor build of the demo, which the website embeds.",
    app: true,
    scripts: {
      dev: "vite --host 127.0.0.1 --mode try",
      build: "vite build --mode try",
      preview: "vite preview --host 127.0.0.1",
      "poster:try": "node scripts/poster.ts",
      test: "vitest run",
      typecheck: "tsc --noEmit -p tsconfig.json",
    },
    vitest: "unit",
    include: ["scripts/**/*.ts"],
  },
  {
    id: "previews",
    dir: "apps/previews",
    name: "@novadeck/previews",
    description: "The content preview: the demo with its debug panel.",
    app: true,
    scripts: {
      dev: "vite --host 127.0.0.1 --mode content-preview",
      build: "vite build --mode content-preview",
      preview: "vite preview --host 127.0.0.1",
      typecheck: "tsc --noEmit -p tsconfig.json",
    },
  },
]

export const packageOf = (file: string): Pkg | undefined =>
  packages.find(({ dir }) => file.startsWith(`${dir}/`))

const byName = new Map(packages.map((pkg) => [pkg.name, pkg]))

// ---------------------------------------------------------------------------------------
// Where a file goes
// ---------------------------------------------------------------------------------------

const ui = "application/ui"

/** Where a tracked file of the old UI goes: a file, or a folder (ending in a slash). */
export type Rule = { readonly from: string; readonly to: string | null }

// The most specific first: single files, then folders, longest first. A file no rule names
// stays in the UI, at the same place below `frontend/ui`; `null` deletes it.
export const rules: readonly Rule[] = [
  { from: `${ui}/src/test/fixtures.ts`, to: "frontend/core/src/testing.ts" },
  { from: `${ui}/src/test/render.ts`, to: "frontend/test-kit/src/render.ts" },
  { from: `${ui}/src/test/phases.ts`, to: "frontend/test-kit/src/phases.ts" },
  { from: `${ui}/src/test/backend-contract.tsx`, to: "frontend/test-kit/src/backend-contract.tsx" },
  { from: `${ui}/src/bundle-boundary.ts`, to: "tools/build-kit/src/bundle-checks.ts" },
  { from: `${ui}/src/bundle-boundary.test.ts`, to: "tools/build-kit/src/bundle-checks.test.ts" },
  { from: `${ui}/src/deploy.ts`, to: "apps/try/src/deploy.ts" },
  { from: `${ui}/src/deploy.test.ts`, to: "apps/try/src/deploy.test.ts" },
  { from: `${ui}/src/entries/try.tsx`, to: "apps/try/src/main.tsx" },
  { from: `${ui}/src/entries/previews.tsx`, to: "apps/previews/src/main.tsx" },
  { from: `${ui}/entries/try/index.html`, to: "apps/try/index.html" },
  { from: `${ui}/entries/previews/index.html`, to: "apps/previews/index.html" },
  // The pages' scripts: each app's src/main.tsx is the entry itself.
  { from: `${ui}/entries/try/main.tsx`, to: null },
  { from: `${ui}/entries/previews/main.tsx`, to: null },
  { from: `${ui}/scripts/poster.ts`, to: "apps/try/scripts/poster.ts" },
  { from: `${ui}/src/backend/demo/debug/`, to: "frontend/demo-debug/src/" },
  { from: `${ui}/src/backend/demo/`, to: "frontend/demo/src/" },
  { from: `${ui}/src/backend/runner/`, to: "frontend/runner-adapter/src/" },
  { from: `${ui}/src/backend/terminal-views/`, to: "frontend/terminal-views/src/" },
  { from: `${ui}/src/specs/`, to: "frontend/specs/src/" },
  { from: `${ui}/src/core/`, to: "frontend/core/src/" },
  // The apps' own folders: their pages, and where they build.
  { from: `${ui}/entries/try/`, to: "apps/try/" },
  { from: `${ui}/entries/previews/`, to: "apps/previews/" },
  { from: `${ui}/dist-try/`, to: "apps/try/dist/" },
  { from: `${ui}/dist-previews/`, to: "apps/previews/dist/" },
]

// What the specs write to: the counter run's reading and a failed spec's screenshots.
const specsOutputs: readonly Rule[] = [
  { from: `${ui}/test-results/`, to: "frontend/specs/test-results/" },
  { from: `${ui}/.vitest/`, to: "frontend/specs/.vitest/" },
]

const ruleFor = (path: string): Rule | undefined =>
  [...rules, ...specsOutputs].find(({ from }) =>
    from.endsWith("/") ? path.startsWith(from) : path === from,
  )

/** Where a tracked file goes: undefined when it stays, null when the move deletes it. */
export const destinationOf = (file: string): string | null | undefined => {
  if (!file.startsWith(`${ui}/`)) return undefined
  const rule = ruleFor(file)
  if (rule)
    return rule.to === null
      ? null
      : rule.to.endsWith("/")
        ? rule.to + file.slice(rule.from.length)
        : rule.to
  // Nothing of src/backend/ and src/test/ is left to stay without a rule above.
  if (file.startsWith("application/ui/src/backend/")) return undefined
  return `frontend/ui/${file.slice(ui.length + 1)}`
}

/** The files `destinationOf` has no place for: a new folder in src/backend/ needs a package. */
export const unplaced = (file: string): boolean =>
  file.startsWith(`${ui}/src/backend/`) && ruleFor(file) === undefined

/**
 * Each package's own copy of the one-line Vitest re-export (decision 1): a copy in the test
 * kit would close a cycle, core's tests importing a package that imports core.
 */
export const ownCopies: readonly string[] = [`${ui}/src/test.ts`]

export type Policy = {
  readonly place: (file: string) => string | null | undefined
  readonly ownCopies: readonly string[]
}
export const policy: Policy = { place: destinationOf, ownCopies }

// ---------------------------------------------------------------------------------------
// Imports: where each specifier points, and what it becomes
// ---------------------------------------------------------------------------------------

export type Found = { readonly specifier: string; readonly line: number }

// The ways a module is named in code: static imports and re-exports, dynamic imports, bare
// imports, Vitest's mocks, and triple-slash type references.
const codeForms: readonly RegExp[] = [
  /(\bfrom\s*)(["'])([^"'\n]+)\2/g,
  /(\bimport\s*\(\s*)(["'])([^"'\n]+)\2/g,
  /(^\s*import\s*)(["'])([^"'\n]+)\2/gm,
  /(\bvi\.(?:mock|doMock|unmock|doUnmock|importActual|importMock)\s*\(\s*)(["'])([^"'\n]+)\2/g,
  /(\/\/\/\s*<reference\s+types=)(["'])([^"'\n]+)\2/g,
]
const styleForms: readonly RegExp[] = [/(@import\s+)(["'])([^"'\n]+)\2/g]

const isCode = (file: string): boolean => /\.(?:[cm]?[jt]sx?)$/.test(file)
const isStyle = (file: string): boolean => file.endsWith(".css")

/**
 * Files with sample code in strings (the demo shows a visitor projects to read), whose import
 * lines may name files of a project that isn't ours: those are left as they are, not a problem.
 */
export const samples: Kept = [
  { path: "application/ui/src/backend/demo/showcase/artifacts.ts", why: "code the demo shows" },
  { path: "application/ui/src/backend/demo/showcase/storefront.ts", why: "code the demo shows" },
  { path: "application/ui/src/backend/demo/transcripts.ts", why: "code the demo shows" },
  { path: "frontend/demo/src/launch.ts", why: "code the demo shows" },
  { path: "frontend/demo/src/showcase/artifacts.ts", why: "code the demo shows" },
  { path: "frontend/demo/src/showcase/storefront.ts", why: "code the demo shows" },
  { path: "frontend/demo/src/transcripts.ts", why: "code the demo shows" },
]

const formsOf = (file: string): readonly RegExp[] =>
  isCode(file) ? codeForms : isStyle(file) ? styleForms : []

// What a module specifier looks like: text between quotes after `from` that isn't one (a
// sentence in a comment) is no import.
const specifierLike = /^[\w@./#~-][\w@./#~?=&:%+-]*$/

/** Replaces each specifier of a file's text by what `next` gives for it. */
export const mapSpecifiers = (
  file: string,
  text: string,
  next: (specifier: string, line: number) => string,
): string =>
  formsOf(file).reduce(
    (current, form) =>
      current.replace(new RegExp(form.source, form.flags), (whole, lead, quote, specifier, at) => {
        if (!specifierLike.test(specifier as string)) return whole
        const line = current.slice(0, at as number).split("\n").length
        return `${lead}${quote}${next(specifier as string, line)}${quote}`
      }),
    text,
  )

/** The specifiers a file's text names. */
export const specifiersOf = (file: string, text: string): Found[] => {
  const found: Found[] = []
  mapSpecifiers(file, text, (specifier, line) => {
    found.push({ specifier, line })
    return specifier
  })
  return found
}

const withoutQuery = (specifier: string): string => specifier.replace(/\?.*$/, "")
const queryOf = (specifier: string): string => specifier.slice(withoutQuery(specifier).length)

const suffixes = ["", ".ts", ".tsx", ".js", ".mjs", "/index.ts", "/index.tsx"] as const

/** What a relative specifier of `file` names among `tracked`, with the suffix it left off. */
export const resolveRelative = (
  file: string,
  specifier: string,
  tracked: ReadonlySet<string>,
): { readonly target: string; readonly suffix: string } | undefined => {
  const stem = posix.normalize(posix.join(posix.dirname(file), withoutQuery(specifier)))
  for (const suffix of suffixes)
    if (tracked.has(stem + suffix)) return { target: stem + suffix, suffix }
  return undefined
}

const isRelative = (specifier: string): boolean => /^\.\.?(?:\/|$)/.test(specifier)
const isBare = (specifier: string): boolean => !isRelative(specifier) && !/^[#/]/.test(specifier)

/** `react-dom/client` is `react-dom`; `@ark-ui/react/select` is `@ark-ui/react`. */
export const packageName = (specifier: string): string =>
  specifier
    .replace(/\?.*$/, "")
    .split("/")
    .slice(0, specifier.startsWith("@") ? 2 : 1)
    .join("/")

const builtins = new Set(builtinModules)
const isBuiltin = (specifier: string): boolean =>
  specifier.startsWith("node:") || builtins.has(packageName(specifier))

const trimmed = (path: string): string => path.replace(/\.(?:tsx?)$/, "")

/** The specifier that names `file` of another package: `@novadeck/<package>/<subpath>`. */
export const crossSpecifier = (target: string, pkg: Pkg): string => {
  const inside = target.slice(`${pkg.dir}/src/`.length)
  const sub = trimmed(inside)
  return sub === "index" ? pkg.name : `${pkg.name}/${sub}`
}

/** How a relative specifier reads from `file` to `target`, as `stem` (no suffix) of it. */
const relativeTo = (file: string, target: string): string => {
  const path = posix.relative(posix.dirname(file), target)
  return path.startsWith(".") ? path : `./${path}`
}

export type Edge = {
  readonly from: string
  readonly to: string
  readonly file: string
  readonly specifier: string
}

export type Rewritten = {
  readonly text: string
  readonly problems: string[]
  /** The own `test.ts` the file now imports, which its package needs a copy of. */
  readonly copies: Set<string>
}

// The other ways a file names a path, which the rewrite doesn't follow: a glob, a URL made
// from the module's own, a stylesheet's `url()`. Where one reaches another package it can't be
// pointed anywhere without a person choosing how, so the plan stops.
const pathForms = (file: string, text: string): { path: string; line: number; form: string }[] => {
  const found: { path: string; line: number; form: string }[] = []
  const at = (index: number): number => text.slice(0, index).split("\n").length
  if (isCode(file)) {
    for (const match of text.matchAll(/import\.meta\.glob\(([^)]*)\)/g))
      for (const literal of match[1]!.matchAll(/(["'`])((?:\.{1,2})?\/[^"'`]*)\1/g))
        found.push({ path: literal[2]!, line: at(match.index), form: "import.meta.glob" })
    for (const match of text.matchAll(
      /new\s+URL\(\s*(["'`])(\.{1,2}\/[^"'`]+)\1\s*,\s*import\.meta\.url/g,
    ))
      found.push({ path: match[2]!, line: at(match.index), form: "new URL(…, import.meta.url)" })
  }
  if (isStyle(file))
    for (const match of text.matchAll(/url\(\s*(["']?)(\.{1,2}\/[^"')\s]+)\1\s*\)/g))
      found.push({ path: match[2]!, line: at(match.index), form: "url()" })
  return found
}

/** The problems of the path forms in a file that reach another package than its own. */
export const crossPathProblems = (
  file: string,
  text: string,
  own: Pkg,
  rule: Policy = policy,
): string[] =>
  pathForms(file, text).flatMap(({ path, line, form }) => {
    // A root-absolute glob is from the Vite root: the old UI's package, so the new one's root.
    if (path.startsWith("/") && !file.startsWith(`${ui}/`)) return []
    const from = path.startsWith("/") ? ui : posix.dirname(file)
    const target = posix.normalize(posix.join(from, path.replace(/[*{].*$/, "")))
    const places = [rule.place(target), rule.place(`${target.replace(/\/$/, "")}/_`)]
    const packagesOf = places.flatMap((place) => {
      const there = typeof place === "string" ? packageOf(place) : undefined
      return there ? [there] : []
    })
    return packagesOf.some((there) => there !== own)
      ? [
          `${file}:${line}: ${form} names ${JSON.stringify(path)}, which is in another package after the move: point it at the package by hand, then run again`,
        ]
      : []
  })

/**
 * The text of `file` (at the path it has now) with each specifier pointed where it goes after
 * the move: `#core/x` and every relative import that crosses into another package become
 * `@novadeck/<package>/<subpath>`, an import of the Vitest re-export or of a moved file stays
 * relative to the file's new place, and an import it can't place is a problem, not a guess.
 */
export const rewriteImports = (
  file: string,
  text: string,
  tracked: ReadonlySet<string>,
  rule: Policy = policy,
): Rewritten => {
  const problems: string[] = []
  const copies = new Set<string>()
  const place = (path: string): string => {
    const to = rule.place(path)
    return typeof to === "string" ? to : path
  }
  const newFile = place(file)
  const own = packageOf(newFile)
  if (!own) return { text, problems, copies }
  const fail = (specifier: string, line: number, why: string): string => {
    if (!keeps(samples, file)) problems.push(`${file}:${line}: ${JSON.stringify(specifier)} ${why}`)
    return specifier
  }
  const next = (specifier: string, line: number): string => {
    if (isBare(specifier)) return specifier
    const core = /^#core\/(.+)$/.exec(withoutQuery(specifier))
    const resolved = core
      ? [`frontend/core/src/${core[1]}.ts`, `${ui}/src/core/${core[1]}.ts`]
          .filter((path) => tracked.has(path))
          .map((target) => ({ target, suffix: ".ts" }))[0]
      : isRelative(specifier)
        ? resolveRelative(file, specifier, tracked)
        : undefined
    if (!resolved) return fail(specifier, line, "names no file here: it can't be placed")
    const { target, suffix } = resolved
    if (rule.place(target) === null)
      return fail(specifier, line, `names ${target}, which the move deletes`)
    // The Vitest re-export is each package's own.
    const newTarget = rule.ownCopies.includes(target) ? `${own.dir}/src/test.ts` : place(target)
    if (newTarget !== place(target)) copies.add(own.dir)
    const there = packageOf(newTarget)
    if (!there) return fail(specifier, line, `names ${newTarget}, which no package holds`)
    if (there !== own) {
      if (!newTarget.startsWith(`${there.dir}/src/`))
        return fail(specifier, line, `names ${newTarget}, outside ${there.name}'s src`)
      return crossSpecifier(newTarget, there) + queryOf(specifier)
    }
    // The same package: unchanged where both ends moved together, else from the new places.
    const before = posix.relative(posix.dirname(file), target)
    const after = posix.relative(posix.dirname(newFile), newTarget)
    if (!core && before === after) return specifier
    const stem = newTarget.endsWith(suffix)
      ? newTarget.slice(0, newTarget.length - suffix.length)
      : newTarget
    return relativeTo(newFile, stem) + queryOf(specifier)
  }
  problems.push(...crossPathProblems(file, text, own, rule))
  return { text: mapSpecifiers(file, text, next), problems, copies }
}

// ---------------------------------------------------------------------------------------
// The graph, the dependencies and the export maps, read off the rewritten imports
// ---------------------------------------------------------------------------------------

/** The edges between packages that a file's rewritten imports make. */
export const edgesOf = (file: string, text: string): Edge[] => {
  const own = packageOf(file)
  if (!own) return []
  return specifiersOf(file, text).flatMap(({ specifier }) => {
    const to = isBare(specifier) ? byName.get(packageName(specifier)) : undefined
    return to && to !== own ? [{ from: own.id, to: to.id, file, specifier }] : []
  })
}

/** A cycle among the packages, as the ids around it, or undefined. */
export const cycleOf = (edges: readonly Edge[]): string[] | undefined => {
  const next = new Map<string, Set<string>>()
  for (const { from, to } of edges) next.set(from, (next.get(from) ?? new Set()).add(to))
  const done = new Set<string>()
  const walk = (id: string, path: string[]): string[] | undefined => {
    if (path.includes(id)) return [...path.slice(path.indexOf(id)), id]
    if (done.has(id)) return undefined
    for (const to of next.get(id) ?? []) {
      const found = walk(to, [...path, id])
      if (found) return found
    }
    done.add(id)
    return undefined
  }
  for (const id of next.keys()) {
    const found = walk(id, [])
    if (found) return found
  }
  return undefined
}

/** The problem a cycle among the packages is, with a file that closes it. */
export const cycleProblem = (edges: readonly Edge[]): string[] => {
  const cycle = cycleOf(edges)
  if (!cycle) return []
  const closing = edges.find(({ from, to }) => from === cycle.at(-2) && to === cycle.at(-1))
  return [
    `The packages import one another in a circle: ${cycle.join(" -> ")}` +
      (closing ? ` (${closing.file} imports ${closing.specifier})` : "") +
      ". turbo counts dev dependencies too; keep the Vitest re-export in each package.",
  ]
}

const testFile =
  /\.(?:test|spec)\.[cm]?[jt]sx?$|\/src\/(?:test|testing|scripted|scripted-server)\.ts$|\/src\/test\/|\/setup\.ts$/
const configFile = /\/(?:vite|vitest)\.config\.[cm]?ts$|\/scripts\//

/** Whether the file is test, config or tooling: what it imports is a dev dependency. */
export const isDevFile = (file: string): boolean => {
  const pkg = packageOf(file)
  return Boolean(pkg?.allDev) || testFile.test(file) || configFile.test(file)
}

// Build tools: dev dependencies wherever a package imports them.
const toolPackages =
  /^(?:@novadeck\/build-kit|@tailwindcss\/vite|@vitejs\/plugin-react|@vitest\/browser-playwright|@types\/.+|tailwindcss|vite|vitest|vitest-browser-react|typescript|jsdom|playwright)$/

export type Dependencies = {
  readonly dependencies: Record<string, string>
  readonly devDependencies: Record<string, string>
  readonly problems: string[]
}

const sorted = (record: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(record).toSorted(([a], [b]) => a.localeCompare(b)))

/**
 * The dependencies of a package, from what its files import (F8): workspace packages as
 * `workspace:*`, npm packages at the version `versions` gives; one it gives none for is a
 * problem, as it is an import nothing in the repository declares.
 */
export const dependenciesOf = (
  pkg: Pkg,
  files: ReadonlyMap<string, string>,
  versions: Readonly<Record<string, string>>,
): Dependencies => {
  const prod = new Set<string>()
  const dev = new Set<string>()
  const problems: string[] = []
  const add = (name: string, isDev: boolean, where: string): void => {
    if (name === pkg.name || isBuiltin(name)) return
    const target = byName.has(name) || name in versions
    // A sample's imports are the visitor's to read, not ours: only the ones we know count.
    if (!target && keeps(samples, where.split(":")[0]!)) return
    if (!target) {
      problems.push(
        `${where}: imports ${name}, which no dependency list or workspace package gives a version`,
      )
      return
    }
    if (isDev || toolPackages.test(name)) dev.add(name)
    else prod.add(name)
  }
  let react = false
  for (const [file, text] of files) {
    if (!file.startsWith(`${pkg.dir}/`)) continue
    const isDev = isDevFile(file)
    if (file.endsWith(".tsx")) react = true
    for (const { specifier, line } of specifiersOf(file, text)) {
      if (isBare(specifier)) add(packageName(specifier), isDev, `${file}:${line}`)
    }
  }
  if (react) add("react", Boolean(pkg.allDev), `${pkg.dir} (its .tsx files)`)
  for (const name of pkg.tooling ?? []) add(name, true, pkg.dir)
  const all = new Set([...prod, ...dev])
  const has = (name: string): boolean => all.has(name)
  const nodeTypes = [...files].some(
    ([file, text]) =>
      file.startsWith(`${pkg.dir}/`) &&
      specifiersOf(file, text).some(({ specifier }) => isBare(specifier) && isBuiltin(specifier)),
  )
  const tool = (name: string, wanted: boolean): void => {
    if (wanted) add(name, true, pkg.dir)
  }
  tool("typescript", true)
  tool(
    "vitest",
    Boolean(pkg.vitest) ||
      has("vitest") ||
      [...files.keys()].some((f) => f === `${pkg.dir}/src/test.ts`),
  )
  tool("jsdom", pkg.vitest === "unit" || pkg.vitest === "unit+browser" || pkg.vitest === "template")
  tool("@types/node", nodeTypes)
  tool("@types/react", has("react"))
  tool("@types/react-dom", has("react-dom"))
  tool(
    "vite",
    [...files.keys()].some((f) => f === `${pkg.dir}/vite.config.ts`) || usesViteTypes(pkg, files),
  )
  const record = (names: Set<string>): Record<string, string> =>
    sorted(
      Object.fromEntries(
        [...names].map((name) => [name, byName.has(name) ? "workspace:*" : (versions[name] ?? "")]),
      ),
    )
  const devNames = new Set([...dev].filter((name) => !prod.has(name)))
  return { dependencies: record(prod), devDependencies: record(devNames), problems }
}

/** Whether a package's files use what `vite/client` declares: CSS and `?raw` imports, `import.meta.env`. */
export const usesViteTypes = (pkg: Pkg, files: ReadonlyMap<string, string>): boolean =>
  [...files].some(
    ([file, text]) =>
      file.startsWith(`${pkg.dir}/`) &&
      isCode(file) &&
      (/import\.meta\.(?:env|glob)\b/.test(text) ||
        specifiersOf(file, text).some(({ specifier }) =>
          /\.css$|\?(?:raw|url|worker|inline)/.test(specifier),
        )),
  ) || [...files.keys()].some((file) => file.startsWith(`${pkg.dir}/`) && file.endsWith(".d.ts"))

/** The export keys and files that other packages' imports of `pkg` need, beyond its own. */
export const exportsFor = (
  pkg: Pkg,
  files: ReadonlyMap<string, string>,
  tracked: ReadonlySet<string>,
): { readonly exports: Record<string, unknown>; readonly problems: string[] } => {
  const exports: Record<string, unknown> = { ...pkg.exports }
  const problems: string[] = []
  const wildcard = Object.keys(exports).includes("./*")
  for (const [file, text] of files) {
    if (packageOf(file) === pkg) continue
    for (const { specifier, line } of specifiersOf(file, text)) {
      if (specifier !== pkg.name && !specifier.startsWith(`${pkg.name}/`)) continue
      const sub = specifier.slice(pkg.name.length)
      const key = sub === "" ? "." : `.${withoutQuery(sub)}`
      if (key in exports || wildcard) continue
      const stem = `${pkg.dir}/src${sub === "" ? "/index" : withoutQuery(sub)}`
      const target = ["", ".ts", ".tsx"]
        .map((suffix) => stem + suffix)
        .find((path) => tracked.has(path))
      if (target) exports[key] = `./${target.slice(pkg.dir.length + 1)}`
      else problems.push(`${file}:${line}: ${specifier} names no file of ${pkg.name} (${stem})`)
    }
  }
  return {
    exports: Object.fromEntries(Object.entries(exports).toSorted(([a], [b]) => a.localeCompare(b))),
    problems,
  }
}

// ---------------------------------------------------------------------------------------
// The files the packages are made of
// ---------------------------------------------------------------------------------------

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

/** A package's package.json. */
export const manifestOf = (
  pkg: Pkg,
  deps: Dependencies,
  exports: Readonly<Record<string, unknown>>,
): string =>
  json({
    name: pkg.name,
    version: "0.0.0",
    private: true,
    description: pkg.description,
    ...(pkg.author ? { author: pkg.author } : {}),
    type: "module",
    ...(Object.keys(exports).length > 0 ? { exports } : {}),
    scripts: pkg.scripts,
    ...(Object.keys(deps.dependencies).length > 0 ? { dependencies: deps.dependencies } : {}),
    devDependencies: deps.devDependencies,
  })

/** A package's tsconfig.json. */
export const tsconfigOf = (pkg: Pkg, types: readonly string[]): string => {
  const include = [
    "src/**/*.ts",
    "src/**/*.tsx",
    ...(pkg.include ?? []),
    ...(pkg.app || pkg.id === "ui" ? ["vite.config.ts"] : []),
    ...(pkg.vitest ? ["vitest.config.ts"] : []),
  ]
  return `{
  "compilerOptions": {
    // Workspace packages' source, as Vitest reads it: no build first (see docs/build-graph.md).
    // \`node\` too, which \`Bundler\` resolution leaves out: the runner's and the harnesses' source,
    // which the adapter's test runner reaches, imports Node-only subpaths. The lint keeps the
    // UI's own code off them.
    "customConditions": ["node", "development"],
    "target": "ES2022",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ${JSON.stringify(types)}
  },
  "include": ${JSON.stringify(include)}
}
`
}

const emulatorEntries = [
  "@novadeck/emulator > @xterm/addon-fit",
  "@novadeck/emulator > @xterm/addon-unicode-graphemes",
  "@novadeck/emulator > @xterm/addon-web-links",
  "@novadeck/emulator > @xterm/addon-webgl",
  "@novadeck/emulator > @xterm/xterm",
]

// The small browser project of a package that has one spec which needs a real browser.
const browserProject = (name: string, spec: string, why: string): string => `
    {
      extends: true,
      server: { strictPort: false },
      // ${why}
      optimizeDeps: {
        include: [
${emulatorEntries.map((entry) => `          "${entry}",`).join("\n")}
        ],
      },
      test: {
        name: "${name}",
        include: ["${spec}"],
        testTimeout: 30_000,
        browser: {
          enabled: true,
          headless: true,
          screenshotFailures: false,
          provider: playwright({ contextOptions: { reducedMotion: "reduce", locale: "en-US" } }),
          instances: [{ browser: "chromium" }],
          viewport: { width: 1440, height: 900 },
        },
      },
    },`

/** A package's vitest.config.ts, for the packages whose config is only their unit tests. */
export const vitestConfig = (pkg: Pkg): string | undefined => {
  if (pkg.vitest === "unit")
    return `import { unit } from "@novadeck/build-kit/vitest"
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: { restoreMocks: true, projects: [unit()] },
})
`
  if (pkg.vitest === "unit+browser") {
    const [name, spec, why] =
      pkg.id === "terminal-views"
        ? [
            "renderers",
            "src/renderers.spec.ts",
            "Its spec swaps the WebGL renderer in a real browser.",
          ]
        : [
            "screen",
            "src/screen/screen.spec.ts",
            "Its spec reads the demo's screens back through the emulator.",
          ]
    return `import { unit } from "@novadeck/build-kit/vitest"
import { playwright } from "@vitest/browser-playwright"
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    restoreMocks: true,
    projects: [
      unit(),${browserProject(name!, spec!, why!)}
    ],
  },
})
`
  }
  return undefined
}

// ---------------------------------------------------------------------------------------
// Handwritten files, made whole
// ---------------------------------------------------------------------------------------

/**
 * A file the move writes whole, from a template beside this one (under
 * scripts/packages/frontend/, with `.tmpl` added): the configs and tests that can't be
 * moved with their imports pointed elsewhere. `was` is the hash of the text it replaces: the
 * file is replaced while its text is that one, so a branch that changed it stops the run for
 * the template to be redone. Without `was` the file is new, and made only if it isn't there.
 * `until` is a later step's file that took its place: once that is there, it isn't made.
 */
export type Made = {
  readonly file: string
  readonly why: string
  readonly was?: string
  readonly until?: string
}

export const made: readonly Made[] = [
  {
    file: "frontend/ui/vite.config.ts",
    why: "the desktop and browser builds only: the visitor build and the preview are the apps'",
    was: "6916ada77eff3e38bf274bc41bf6336cc4e79d8f8e8f96d6ff625ed914751b31",
    // 5.3c moved those builds to the desktop app, and deleted this file.
    until: "apps/desktop/vite.config.ts",
  },
  {
    file: "frontend/ui/src/architecture.test.ts",
    why: "the layers of the UI alone: the packages' rules are the package graph's",
    was: "b12cba9bca5bd3368eae2cf76ad5d2f1819440922373a4ee1e164175bd674b9c",
  },
  {
    file: "frontend/core/src/architecture.test.ts",
    why: "the core's rules, which were a layer of the UI's test",
  },
  {
    file: "frontend/specs/src/hook-owners.test.ts",
    why: "the instrumentation hook's owners span the core and the counter run",
  },
  { file: "frontend/specs/vitest.config.ts", why: "the specs' four browser and jsdom projects" },
  { file: "apps/try/vite.config.ts", why: "the visitor build's own config" },
  { file: "apps/previews/vite.config.ts", why: "the preview's own config" },
  {
    file: "apps/try/src/deploy.test.ts",
    why: "the pages of all four entries are read from their packages",
    was: "9cea4b2e7fca7a380640c93ab3269ee9fa0510ade5d026b08cbcac38d44e4918",
  },
  {
    file: "tools/build-kit/src/bundle-checks.ts",
    why: "the build checks the apps share, without the forbidden folders",
    was: "80c1d45268be41ce9e88f99a5e28f45c4870f5961600ec68d54e0280583d0127",
  },
  {
    file: "tools/build-kit/src/bundle-checks.test.ts",
    why: "as above",
    was: "1ceaf95cc43522208f58f6e87a3d32a066f85f4ffd602dac02167d7f28434faf",
  },
  { file: "tools/build-kit/src/vitest.ts", why: "the unit project every package's config lists" },
  {
    file: "tools/build-kit/src/tailwind-guards.test.ts",
    why: "no file Tailwind scans holds a guard's utility outside the folder it guards",
  },
  {
    file: "scripts/flakes/specs-path.test.ts",
    why: "a flake registered by either form of a spec's id is known",
  },
]

// Files the move generates whole, replacing what the old UI had: by the hash of the text.
export const generatedWas: Readonly<Record<string, string>> = {
  "frontend/ui/tsconfig.json": "639c4b652cb46176e7384bb624f5e65ed421045d5c43083c5c18881580a4dcc1",
  "frontend/ui/vitest.config.ts":
    "15c2b41036b933cc270e33f219a952502ca148f24c9404f209ac6d92881c428d",
}

/** The hash a `was` holds. */
export const hashOf = (text: string): string => createHash("sha256").update(text).digest("hex")

// ---------------------------------------------------------------------------------------
// Handwritten edits
// ---------------------------------------------------------------------------------------

const playwrightFilter = (file: string): Edit => ({
  file,
  before: "pnpm --filter @novadeck/ui exec playwright",
  after: "pnpm --filter @novadeck/specs exec playwright",
  why: "the specs own Playwright: they run the browser projects (decision 5)",
  all: true,
})

// The names a library fence keeps app code out with: every package that came out of the UI.
const appPackages = [
  "@novadeck/core",
  "@novadeck/demo",
  "@novadeck/demo-debug",
  "@novadeck/previews",
  "@novadeck/runner-adapter",
  "@novadeck/specs",
  "@novadeck/terminal-views",
  "@novadeck/test-kit",
  "@novadeck/try",
]
const fenceIndent = " ".repeat(18)
const fenceNames = (names: readonly string[]): string =>
  names.map((name) => `${fenceIndent}"${name}",\n${fenceIndent}"${name}/**",\n`).join("")

// What marks each of the root's test lines as split by package since #315, whatever main adds
// to them later (#317's `--output-logs`): a run on main finds its three edits there.
const testLine =
  "--filter=./frontend/* --filter=./apps/* --filter=@novadeck/runner --filter=@novadeck/host"
const shard1Line = "--filter=@novadeck/demo-debug --concurrency=1 -- --shard=1/2"
const shard2Line = "--filter=@novadeck/demo-debug --concurrency=1 -- --shard=2/2"

export const edits: readonly Edit[] = [
  {
    file: "application/host/electron-builder.yml",
    before: "  - from: ../ui/dist\n",
    after: "  - from: ../../frontend/ui/dist\n",
    why: "a path from the host, one folder deeper",
    // 5.3c moved the host into apps/desktop, which copies its own build.
    later: "apps/desktop/electron-builder.yml",
    settled: ["  - from: dist\n"],
  },
  {
    file: "package.json",
    before:
      '"dev:previews": "pnpm --filter @novadeck/protocol... build && pnpm --filter @novadeck/ui dev --mode content-preview --port 5181",',
    after:
      '"dev:previews": "pnpm --filter @novadeck/protocol... build && pnpm --filter @novadeck/previews dev --port 5181",',
    why: "the preview is an app of its own, whose script sets its mode",
  },
  {
    file: "package.json",
    before:
      '"dev:try": "pnpm --filter @novadeck/protocol... build && pnpm --filter @novadeck/ui dev --mode try --port 5190",',
    after:
      '"dev:try": "pnpm --filter @novadeck/protocol... build && pnpm --filter @novadeck/try dev --port 5190",',
    why: "the visitor build is an app of its own, whose script sets its mode",
  },
  {
    file: "package.json",
    before:
      '"build:try": "pnpm --filter-prod \\"@novadeck/ui^...\\" build && pnpm --filter @novadeck/ui build --mode try --outDir dist-try",',
    after:
      '"build:try": "pnpm --filter-prod \\"@novadeck/try^...\\" --filter-prod \\"!@novadeck/ui\\" build && pnpm --filter @novadeck/try build",',
    why: "the libraries it needs, but not the desktop build of the UI, then the app into its own dist",
  },
  {
    file: "package.json",
    before:
      '"preview:try": "pnpm --filter @novadeck/ui preview --outDir dist-try --port 5191 --strictPort",',
    after: '"preview:try": "pnpm --filter @novadeck/try preview --port 5191 --strictPort",',
    why: "the app previews its own dist",
  },
  {
    file: "package.json",
    before: '"poster:try": "pnpm --filter @novadeck/ui poster:try",',
    after: '"poster:try": "pnpm --filter @novadeck/try poster:try",',
    why: "the posters are the visitor build's",
  },
  {
    file: "package.json",
    before:
      '"test": "pnpm run test:repository && turbo run test --filter=!@novadeck/ui --filter=!@novadeck/runner --filter=!@novadeck/host && turbo run test --filter=@novadeck/ui --filter=@novadeck/runner --filter=@novadeck/host --concurrency=1",',
    after:
      '"test": "pnpm run test:repository && turbo run test --filter=!@novadeck/ui --filter=!@novadeck/specs --filter=!@novadeck/terminal-views --filter=!@novadeck/demo --filter=!@novadeck/runner --filter=!@novadeck/host && turbo run test --filter=@novadeck/ui --filter=@novadeck/specs --filter=@novadeck/terminal-views --filter=@novadeck/demo --filter=@novadeck/runner --filter=@novadeck/host --concurrency=1",',
    why: "every package with browser tests joins the serial list",
    settled: [testLine],
  },
  {
    file: "apps/try/scripts/poster.ts",
    before: "(`dist-try` unless a directory is given)",
    after: "(`dist` unless a directory is given)",
    why: "the app builds into its own dist",
  },
  {
    file: "apps/try/scripts/poster.ts",
    before: 'directory = "dist-try"',
    after: 'directory = "dist"',
    why: "as above",
  },
  {
    file: "apps/try/index.html",
    before: '<script type="module" src="./main.tsx"></script>',
    after: '<script type="module" src="./src/main.tsx"></script>',
    why: "the page is the package's root, and its script the app's main",
  },
  {
    file: "apps/previews/index.html",
    before: '<script type="module" src="./main.tsx"></script>',
    after: '<script type="module" src="./src/main.tsx"></script>',
    why: "as above",
  },
  {
    file: "tools/build-kit/package.json",
    before: '  "exports": {\n    "./connect-sources": "./src/connect-sources.ts",\n',
    after:
      '  "exports": {\n    "./bundle-checks": "./src/bundle-checks.ts",\n    "./connect-sources": "./src/connect-sources.ts",\n',
    why: "the build checks the apps share",
  },
  {
    file: "tools/build-kit/package.json",
    before: '    "./search-visibility": "./src/search-visibility.ts"\n',
    after:
      '    "./search-visibility": "./src/search-visibility.ts",\n    "./vitest": "./src/vitest.ts"\n',
    why: "the unit project every frontend package's config lists",
  },
  {
    file: ".oxlintrc.json",
    before: '"files": ["frontend/ui/src/**"],',
    after: '"files": ["frontend/*/src/**", "apps/*/src/**"],',
    why: "the UI's browser-code rule applies to every package that came out of it",
    // 5.3c's form of the line.
    settled: ['"apps/*/src/**", "apps/desktop/renderer/**"'],
  },
  {
    file: ".oxlintrc.json",
    before: `${fenceIndent}"@novadeck/runner-client/**",\n${fenceIndent}"@novadeck/ui",\n`,
    after: `${fenceIndent}"@novadeck/runner-client/**",\n${fenceNames(appPackages)}${fenceIndent}"@novadeck/ui",\n`,
    why: "a library never imports app code: the packages of the old UI are app code",
    all: true,
  },
  {
    file: ".github/workflows/benchmark.yml",
    before: "'^(frontend/ui/|backend/runner/|",
    after: "'^(frontend/|apps/|backend/runner/|",
    why: "the counter run reads the UI wherever its packages are",
  },
  {
    file: ".github/workflows/benchmark.yml",
    before: "pnpm --filter @novadeck/ui exec vitest run --project counters",
    after: "pnpm --filter @novadeck/specs exec vitest run --project counters",
    why: "the counters project is the specs'",
  },
  ...[
    ".github/workflows/benchmark.yml",
    ".github/workflows/flaky-capture.yml",
    ".github/workflows/quality.yml",
    ".github/workflows/timing.yml",
    ".github/workflows/warm.yml",
  ].map(playwrightFilter),
  {
    file: ".github/workflows/try.yml",
    before: "          for dist in application/ui/dist-try; do\n",
    after:
      '          for layout in apps/try/dist:@novadeck/try application/ui/dist-try:@novadeck/ui; do\n            dist="${layout%%:*}"\n',
    why: "the app's own dist, ahead of the layout older tags build; each with the package whose Playwright makes the posters",
  },
  {
    file: ".github/workflows/try.yml",
    before: '              echo "TRY_DIST=$dist" >> "$GITHUB_ENV"\n              exit 0\n',
    after:
      '              echo "TRY_DIST=$dist" >> "$GITHUB_ENV"\n              echo "TRY_PACKAGE=${layout#*:}" >> "$GITHUB_ENV"\n              exit 0\n',
    why: "as above",
  },
  {
    file: ".github/workflows/try.yml",
    before: "pnpm --filter @novadeck/ui exec playwright",
    after: 'pnpm --filter "$TRY_PACKAGE" exec playwright',
    why: "a tag from before the move has Playwright in the UI, a later one in the app",
    all: true,
  },
  {
    file: "scripts/bench/profile/attribute.ts",
    before: String.raw`/\/application\/ui\/src\/core\/store\.ts$/`,
    after: String.raw`/\/frontend\/core\/src\/store\.ts$/`,
    why: "the core's store, in a regular expression over stack paths",
  },
  ...["attribute", "patches"].flatMap((name): Edit[] => [
    {
      file: `scripts/bench/profile/${name}.test.ts`,
      before: "/r/application/ui/src/core/",
      after: "/r/frontend/core/src/",
      why: "sample stack paths, which the attribution's patterns read",
      all: true,
    },
    {
      file: `scripts/bench/profile/${name}.test.ts`,
      before: "/r/application/ui/src/App.tsx",
      after: "/r/frontend/ui/src/App.tsx",
      why: "as above",
      all: true,
    },
  ]),
  {
    file: "scripts/flaky-capture/grid.config.mts",
    before: 'import base from "../../frontend/ui/vitest.config.ts"',
    after: 'import base from "../../frontend/specs/vitest.config.ts"',
    why: "the behaviour project is the specs'",
  },
  {
    file: "scripts/flaky-capture/grid.config.mts",
    before: 'new URL("../../frontend/ui/", import.meta.url)',
    after: 'new URL("../../frontend/specs/", import.meta.url)',
    why: "the Vitest root of the project it runs",
  },
  {
    file: "scripts/flaky-capture/grid.config.mts",
    before: 'include: ["src/specs/companions.spec.tsx"]',
    after: 'include: ["src/companions.spec.tsx"]',
    why: "a path from the specs' root",
  },
  {
    file: "scripts/flaky-capture/grid.ts",
    before: 'const ui = join(repo, "frontend/ui")',
    after: 'const ui = join(repo, "frontend/specs")',
    why: "where the capture runs Vitest from",
  },
  {
    file: "frontend/ui/src/theme/contract.test.ts",
    before: String.raw`const all = (readdirSync(src, { recursive: true }) as string[]).map((file) =>
  file.split("\\").join("/"),
)
const read = (file: string): string => readFileSync(join(src, file), "utf8")`,
    after: String.raw`// The UI's source is in several packages now: a file is named as it was below the old src/.
const places = [
  ["backend/demo/debug/", "demo-debug"],
  ["backend/demo/", "demo"],
  ["backend/terminal-views/", "terminal-views"],
  ["backend/runner/", "runner-adapter"],
  ["core/", "core"],
].map(([prefix, name]) => ({ prefix: prefix!, dir: join(src, "..", "..", name!, "src") }))
const all = [
  ...(readdirSync(src, { recursive: true }) as string[]),
  ...places.flatMap(({ prefix, dir }) =>
    (readdirSync(dir, { recursive: true }) as string[]).map((file) => prefix + file),
  ),
].map((file) => file.split("\\").join("/"))
const read = (file: string): string => {
  const place = places.find(({ prefix }) => file.startsWith(prefix))
  return readFileSync(
    place ? join(place.dir, file.slice(place.prefix.length)) : join(src, file),
    "utf8",
  )
}`,
    why: "the scan covers every package the UI's folders went to (F3: it must not run on less)",
  },
  {
    file: "frontend/ui/src/theme/motion.test.ts",
    before: String.raw`const stylesheets = (readdirSync(src, { recursive: true }) as string[])
  .map((file) => file.split("\\").join("/"))
  .filter((file) => file.endsWith(".css"))
const read = (file: string): string =>
  readFileSync(join(src, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "")`,
    after: String.raw`// The UI's source is in several packages now: a file is named as it was below the old src/.
const places = [
  ["backend/demo/debug/", "demo-debug"],
  ["backend/demo/", "demo"],
  ["backend/terminal-views/", "terminal-views"],
  ["backend/runner/", "runner-adapter"],
  ["core/", "core"],
].map(([prefix, name]) => ({ prefix: prefix!, dir: join(src, "..", "..", name!, "src") }))
const stylesheets = [
  ...(readdirSync(src, { recursive: true }) as string[]),
  ...places.flatMap(({ prefix, dir }) =>
    (readdirSync(dir, { recursive: true }) as string[]).map((file) => prefix + file),
  ),
]
  .map((file) => file.split("\\").join("/"))
  .filter((file) => file.endsWith(".css"))
const read = (file: string): string => {
  const place = places.find(({ prefix }) => file.startsWith(prefix))
  return readFileSync(
    place ? join(place.dir, file.slice(place.prefix.length)) : join(src, file),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "")
}`,
    why: "as above",
  },
  // The atlas: the UI's one area becomes one area for each package, under the tokens it had.
  {
    file: "tools/atlas/content/areas.ts",
    before: `  { token: "ui", dir: "frontend/ui", src: "src", node: "renderer", split: ["backend"] },\n`,
    after: [
      `  { token: "ui", dir: "frontend/ui", src: "src", node: "renderer" },`,
      `  { token: "ui/core", dir: "frontend/core", node: "renderer" },`,
      `  { token: "ui/test", dir: "frontend/test-kit", node: "renderer" },`,
      `  { token: "ui/backend/runner", dir: "frontend/runner-adapter", node: "renderer" },`,
      `  { token: "ui/backend/terminal-views", dir: "frontend/terminal-views", node: "renderer" },`,
      `  { token: "ui/backend/demo", dir: "frontend/demo", node: "renderer" },`,
      `  { token: "ui/backend/demo/debug", dir: "frontend/demo-debug", node: "renderer" },`,
      `  { token: "ui/specs", dir: "frontend/specs", node: "renderer" },`,
      `  { token: "app/try", dir: "apps/try", node: "renderer" },`,
      `  { token: "app/previews", dir: "apps/previews", node: "renderer" },`,
      "",
    ].join("\n"),
    why: "each package of the old UI is a root, under the token its folder had",
  },
  {
    file: "tools/atlas/content/areas.ts",
    before: `const ui = "application/ui/src"\n`,
    after: [
      `const ui = "frontend/ui/src"`,
      `const core = "frontend/core/src"`,
      `const adapter = "frontend/runner-adapter/src"`,
      `const views = "frontend/terminal-views/src"`,
      `const demo = "frontend/demo/src"`,
      "",
    ].join("\n"),
    why: "the UI's folders are packages",
  },
  ...(
    [
      ["core", "core"],
      ["backend/runner", "adapter"],
      ["backend/terminal-views", "views"],
      ["backend/demo", "demo"],
    ] as const
  ).map(([folder, name]): Edit => ({
    file: "tools/atlas/content/areas.ts",
    before: "`${ui}/" + folder + "/",
    after: "`${" + name + "}/",
    why: "an anchor in the package that holds the folder",
    all: true,
  })),
  {
    file: "tools/atlas/content/areas.ts",
    before: `  "ui/test": { purpose: "Fixtures and render helpers the UI's tests share." },\n  "engine/whisper": {`,
    after: [
      `  "ui/test": { purpose: "Fixtures and render helpers the UI's tests share." },`,
      `  "ui/backend/demo/debug": {`,
      `    purpose: "The demo's debug panel and rehearsals, for the content preview and the specs.",`,
      `  },`,
      `  "app/try": { purpose: "The visitor build of the demo, which the website embeds." },`,
      `  "app/previews": { purpose: "The content preview: the demo with its debug panel." },`,
      `  "engine/whisper": {`,
    ].join("\n"),
    why: "the notes of the areas that are new",
  },
  {
    file: "tools/atlas/content/flows.ts",
    before: `const ui = "application/ui/src"\n`,
    after: `const adapter = "frontend/runner-adapter/src"\n`,
    why: "the flows' anchors are in the runner adapter",
  },
  {
    file: "tools/atlas/content/flows.ts",
    before: "`${ui}/backend/runner/",
    after: "`${adapter}/",
    why: "as above",
    all: true,
  },
  {
    file: "tools/atlas/extract/ui-lens.ts",
    before: [
      `const ui = "application/ui/src"`,
      "const stateFile = `${ui}/core/state.ts`",
      "const portFile = `${ui}/core/port.ts`",
      "const adapterDir = `${ui}/backend/runner/`",
      "",
    ].join("\n"),
    after: [
      `const ui = "frontend/ui/src"`,
      `const core = "frontend/core/src"`,
      `const adapterSrc = "frontend/runner-adapter/src"`,
      `const views = "frontend/terminal-views/src"`,
      "const stateFile = `${core}/state.ts`",
      "const portFile = `${core}/port.ts`",
      "const adapterDir = `${adapterSrc}/`",
      "// The backends: the adapters the UI is drawn over, apart from the app.",
      "const isBackend = (file: string) => file.startsWith(adapterDir) || file.startsWith(`${views}/`)",
      "",
    ].join("\n"),
    why: "the UI's source is in several packages",
  },
  {
    file: "tools/atlas/extract/ui-lens.ts",
    before: "sourceFiles(repo, ui).filter(",
    after:
      "[ui, core, adapterSrc, views]\n    .flatMap((dir) => sourceFiles(repo, dir))\n    .filter(",
    why: "as above",
  },
  {
    file: "tools/atlas/extract/ui-lens.ts",
    before: "`${ui}/core/store.ts`",
    after: "`${core}/store.ts`",
    why: "the store is the core's",
    all: true,
  },
  {
    file: "tools/atlas/extract/ui-lens.ts",
    before: "!f.startsWith(`${ui}/backend/`)",
    after: "!isBackend(f)",
    why: "the backends are packages",
    all: true,
  },
  {
    file: "tools/atlas/extract/files.ts",
    before: "// Repository-relative paths of the non-test source files under `dir`.\n",
    after:
      '// Where the frontend\'s source is: each package of the old UI, and the apps.\nexport const frontendSources = (repo: string): string[] =>\n  ["frontend", "apps"].flatMap((folder) =>\n    readdirSync(join(repo, folder)).flatMap((name) => sourceFiles(repo, `${folder}/${name}/src`)),\n  )\n\n// Repository-relative paths of the non-test source files under `dir`, sorted.\n',
    why: "the UI's callers and local state are read in every package of it",
  },
  {
    file: "tools/atlas/extract/api.ts",
    before: '...sourceFiles(repo, "application/ui/src"),',
    after: "...frontendSources(repo),",
    why: "as above",
  },
  {
    file: "tools/atlas/extract/api.ts",
    before: 'import { sourceFiles } from "./files.ts"',
    after: 'import { frontendSources, sourceFiles } from "./files.ts"',
    why: "as above",
  },
  {
    file: "tools/atlas/extract/data.ts",
    before: 'sourceFiles(repo, "application/ui/src")',
    after: "frontendSources(repo)",
    why: "as above",
  },
  {
    file: "tools/atlas/extract/data.ts",
    before: 'import { sourceFiles } from "./files.ts"',
    after: 'import { frontendSources, sourceFiles } from "./files.ts"',
    why: "as above",
  },
  // The known flakes: Vitest reports a spec from its package's root, so `src/specs/x.spec.tsx`
  // is `src/x.spec.tsx`; the register has the new form and the matcher knows both.
  {
    file: "scripts/flakes/register.json",
    before: '"test": "src/specs/',
    after: '"test": "src/',
    why: "Vitest reports a spec's path from its package's root",
    all: true,
  },
  {
    file: "scripts/flakes/match.ts",
    before: "failure.test.startsWith(each.test) &&",
    after:
      'failure.test\n          .replace(/^src\\/specs\\//, "src/")\n          .startsWith(each.test.replace(/^src\\/specs\\//, "src/")) &&',
    why: "a spec's id was `src/specs/x.spec.tsx` before the specs had a package: either form matches",
  },
  {
    file: "tools/atlas/extract/links.ts",
    before: '("#core/*")',
    after: '("#name/*")',
    why: "the core is a package, not the UI's `imports`",
  },
  // Tailwind scans from the stylesheet: every package whose markup the UI renders, as the whole
  // old UI package was scanned before. A package's tests are left out, as the sheet's own
  // `@source not` leaves out the UI's.
  {
    file: "frontend/ui/src/styles.css",
    before:
      '/* The package, whichever entry\'s page Vite serves from: Tailwind looks for classes from here. */\n@import "tailwindcss" source("..");\n',
    after: [
      "/* Where Tailwind looks for classes, whichever entry's page Vite serves from: the UI's package",
      "   and each package whose markup it renders. A package that gains utilities of its own is",
      "   added here, and to the guards of the build kit's bundle-checks. */",
      '@import "tailwindcss" source(none);',
      '@source "..";',
      '@source "../../terminal-views/src";',
      '@source "../../demo/src";',
      '@source "../../demo-debug/src";',
      '@source not "../../terminal-views/src/**/*.test.ts";',
      '@source not "../../demo/src/**/*.test.ts";',
      '@source not "../../demo-debug/src/**/*.test.ts";',
      "",
    ].join("\n"),
    why: "the demo's, the debug panel's and the terminal views' utilities reach every build, as they did when they were folders of the UI",
  },
  {
    file: "package.json",
    before:
      "--filter=!@novadeck/ui --filter=!@novadeck/runner --filter=!@novadeck/host && turbo run test --filter=@novadeck/ui --filter=@novadeck/runner --filter=@novadeck/host --concurrency=1 -- --shard=1/2",
    after:
      "--filter=!@novadeck/ui --filter=!@novadeck/specs --filter=!@novadeck/terminal-views --filter=!@novadeck/demo --filter=!@novadeck/runner --filter=!@novadeck/host && turbo run test --filter=@novadeck/ui --filter=@novadeck/specs --filter=@novadeck/terminal-views --filter=@novadeck/demo --filter=@novadeck/runner --filter=@novadeck/host --concurrency=1 -- --shard=1/2",
    why: "the shards serialise every package with browser projects, as the whole run does",
    settled: [shard1Line],
  },
  {
    file: "package.json",
    before:
      '"test:shard2": "turbo run test --filter=@novadeck/ui --filter=@novadeck/runner --filter=@novadeck/host --concurrency=1 -- --shard=2/2"',
    after:
      '"test:shard2": "turbo run test --filter=@novadeck/ui --filter=@novadeck/specs --filter=@novadeck/terminal-views --filter=@novadeck/demo --filter=@novadeck/runner --filter=@novadeck/host --concurrency=1 -- --shard=2/2"',
    why: "as above",
    settled: [shard2Line],
  },
  {
    file: "README.md",
    before: "(beside `dist/`, which the desktop app packages)",
    after: "(the desktop app's `frontend/ui/dist/` is what the host packages)",
    why: "the visitor build has a folder of its own",
    // 5.3c's form of the line.
    settled: ["`apps/desktop/dist/` is what it packages"],
  },
  {
    file: "README.md",
    before:
      "Each app is an entry of its own, named by its Vite mode, so a deploy carries only its own\nchunks. The desktop app's page is the package's `index.html` (built to `dist/`, which the host\npackages and loads, and the dev server's root page in development), and the others' are\n`entries/web/`, `entries/try/` and `entries/previews/` (mode `web` for `pnpm dev:web`, `try`,\nand `content-preview`), each served at its own server's root and built to `dist-web/`,\n`dist-try/` or `dist-previews/`. Every page is the same document but for the script it starts,\nwhich `src/deploy.test.ts` checks; a page beside `entries/<name>/` starts\n`src/entries/<name>.tsx` through a one-line `main.tsx`, as a dev server serves only what's under\nits root. A backend that must connect first supplies a\n",
    after:
      "Each app is an entry of its own, named by its Vite mode, so a deploy carries only its own\nchunks. The desktop and browser apps are in `frontend/ui`: the desktop page is the package's\n`index.html` (built to `dist/`, which the host packages and loads, and the dev server's root\npage in development), and the browser page is `entries/web/` (mode `web` for `pnpm dev:web`,\nbuilt to `dist-web/`). The visitor build and the content preview are apps of their own,\n`apps/try` and `apps/previews` (modes `try` and `content-preview`), each with its page at the\npackage's root and built to its `dist/`. Every page is the same document but for the script it\nstarts, which `apps/try/src/deploy.test.ts` checks; an app's page starts its entry through\n`src/main.tsx` (the browser app's through a one-line `main.tsx` beside its page), as a dev\nserver serves only what's under its root. A backend that must connect first supplies a\n",
    why: "the visitor build and the preview are apps of their own",
    // 5.3c's form of the line.
    settled: ["The desktop and browser apps are in `apps/desktop`"],
  },
  {
    file: "README.md",
    before: "@novadeck/ui exec playwright install chromium`). novadeck.dev's hero",
    after: "@novadeck/try exec playwright install chromium`). novadeck.dev's hero",
    why: "the posters' browser is the visitor build's",
  },
  {
    file: "README.md",
    before:
      "Install the browser once with `pnpm --filter @novadeck/ui exec playwright install chromium`.\nRun a single spec with `pnpm --filter @novadeck/ui exec vitest run --project behaviour src/specs/canvas.spec.tsx`,",
    after:
      "Install the browser once with `pnpm --filter @novadeck/specs exec playwright install chromium`.\nRun a single spec with `pnpm --filter @novadeck/specs exec vitest run --project behaviour src/canvas.spec.tsx`,",
    why: "the specs run the browser projects",
  },
  {
    file: "README.md",
    before: "@novadeck/ui exec vitest run --project counters`; it leaves its reading in",
    after: "@novadeck/specs exec vitest run --project counters`; it leaves its reading in",
    why: "the counters project is the specs'",
  },
  {
    file: "scripts/flaky-capture/README.md",
    before: "pnpm --filter @novadeck/ui exec playwright install --with-deps chromium",
    after: "pnpm --filter @novadeck/specs exec playwright install --with-deps chromium",
    why: "the specs own Playwright",
  },
  {
    file: "scripts/bench/profile/patches.ts",
    before: 'id.endsWith("/src/core/store.ts")',
    after: 'id.endsWith("/frontend/core/src/store.ts")',
    why: "the core's store, among the ids the build bundles",
  },
  {
    file: "scripts/libraries/fence.test.ts",
    before: 'file.startsWith("application/")',
    after: 'file.startsWith("frontend/")',
    why: "the browser-code probes' folder",
  },
  ...["probe.ts", "types.ts", "deep/probe.test.tsx", "deep/named.ts", "deep/dynamic.ts"].map(
    (probe): Edit => ({
      file: "scripts/libraries/fence.test.ts",
      before: `"application/ui/src/${probe}"`,
      after: `"frontend/ui/src/${probe}"`,
      why: "the browser-code fence's probes, where the rule now applies",
    }),
  ),
  {
    file: "README.md",
    before: "Source lives in `application/ui/src/`, grouped in layers:",
    after:
      "The UI is split into packages: `frontend/core`, `frontend/ui`, `frontend/runner-adapter`,\n`frontend/terminal-views`, `frontend/demo`, `frontend/demo-debug`, `frontend/test-kit` and\n`frontend/specs`, and the apps `apps/try` and `apps/previews`. Their source is grouped in layers,\neach a folder of a package's `src/` (`backend/runner/` is `frontend/runner-adapter/src/`, and so\non):",
    why: "the map of the UI's layers",
  },
  {
    file: "README.md",
    before: "Everything outside it reaches it as `#core/*`, the UI package's\nown `imports`;",
    after: "Everything outside it reaches it as `@novadeck/core/*`, the core package's\nexports;",
    why: "the core is a package",
  },
  {
    file: "libraries/README.md",
    before: "one on\n  `application/ui/src` refuses",
    after: "one on\n  `frontend/*/src` and `apps/*/src` refuse",
    why: "the browser-code rule's files",
    // 5.3c's form of the line.
    settled: ["`apps/*/src` and `apps/desktop/renderer`"],
  },
]

// ---------------------------------------------------------------------------------------
// What a branch changed in the old UI's manifest
// ---------------------------------------------------------------------------------------

// The old UI's manifest as main had it when this was written, which the split regenerates: what
// it lists is not a branch's addition, and a value that differs from it is a branch's change.
const baseline = {
  imports: { "#core/*": "./src/core/*.ts" } as Record<string, string>,
  scripts: {
    dev: "vite --host 127.0.0.1",
    build: "vite build",
    preview: "vite preview --host 127.0.0.1",
    test: "vitest run",
    "test:watch": "vitest",
    "poster:try": "node scripts/poster.ts",
    typecheck: "tsc --noEmit -p tsconfig.json",
  } as Record<string, string>,
  versions: {
    "@ark-ui/react": "^5.39.3",
    "@codemirror/state": "^6.7.6",
    "@codemirror/view": "^6.43.14",
    "@dnd-kit/dom": "^0.5.0",
    "@dnd-kit/react": "^0.5.0",
    "@fontsource-variable/archivo": "5.3.0",
    "@fontsource-variable/jetbrains-mono": "^5.3.0",
    "@fontsource/share-tech-mono": "5.3.0",
    "@novadeck/emulator": "workspace:*",
    "@novadeck/protocol": "workspace:*",
    "@novadeck/runner-client": "workspace:*",
    "@novadeck/terminal": "workspace:*",
    "@novadeck/viewers": "workspace:*",
    "@novadeck/wire": "workspace:*",
    "@xyflow/react": "^12.12.0",
    allotment: "^1.20.5",
    clsx: "^2.1.1",
    "lucide-react": "^1.55.0",
    react: "^19.3.0",
    "react-dom": "^19.3.0",
    "react-grid-layout": "^2.3.0",
    "react-router": "^8.4.0",
    "tailwind-merge": "^3.3.1",
    "@novadeck/build-kit": "workspace:*",
    "@novadeck/runner": "workspace:*",
    "@orpc/server": "catalog:",
    "@tailwindcss/vite": "^4.3.3",
    "@types/react": "^19.3.0",
    "@types/react-dom": "^19.3.0",
    "@vitejs/plugin-react": "^5.2.0",
    "@vitest/browser-playwright": "5.0.3",
    jsdom: "^30.1.2",
    playwright: "^1.64.0",
    tailwindcss: "^4.3.3",
    typescript: "^7.0.2",
    vite: "^7.3.6",
    vitest: "^5.0.3",
    "vitest-browser-react": "^2.3.0",
  } as Record<string, string>,
}
const oldFields = new Set([
  "name",
  "version",
  "private",
  "description",
  "author",
  "type",
  "imports",
  "scripts",
  "dependencies",
  "devDependencies",
])

type Section = Record<string, string>
const sectionOf = (value: unknown): Section => (value ?? {}) as Section

/**
 * The generated manifest of the UI with what a branch changed in the old one, against the
 * manifest main had (`baseline`): a script or dependency it added, a script whose command it
 * changed, a dependency whose version it bumped, an `imports` entry it added. A field the
 * generated one has no place for stops the run, rather than being dropped without a word.
 */
export const withBranchAdditions = (
  generated: string,
  old: string,
  file: string,
): { text: string; problems: string[] } => {
  const before = JSON.parse(old) as Record<string, unknown>
  const next = JSON.parse(generated) as Record<string, unknown>
  const problems: string[] = []
  for (const field of Object.keys(before))
    if (!oldFields.has(field))
      problems.push(
        `${file}: the branch added the field "${field}" to the old manifest, which the split regenerates: put it in the UI's package.json by hand after the move, then run again`,
      )
  // Scripts: a script main had is the branch's where its command differs.
  const scripts = { ...sectionOf(next.scripts) }
  for (const [name, command] of Object.entries(sectionOf(before.scripts)))
    if (!(name in baseline.scripts) || (name in scripts && command !== baseline.scripts[name]))
      scripts[name] = command
  next.scripts = scripts
  // Dependencies: the branch's additions, and its version of one main had.
  for (const section of ["dependencies", "devDependencies"] as const) {
    const now = { ...sectionOf(next[section]) }
    const other = sectionOf(next[section === "dependencies" ? "devDependencies" : "dependencies"])
    for (const [name, version] of Object.entries(sectionOf(before[section]))) {
      if (!(name in baseline.versions)) {
        if (!(name in other)) now[name] = version
      } else if (name in now && version !== baseline.versions[name]) now[name] = version
    }
    next[section] = Object.fromEntries(
      Object.entries(now).toSorted(([a], [b]) => a.localeCompare(b)),
    )
  }
  const imports = Object.entries(sectionOf(before.imports)).filter(
    ([name, target]) => baseline.imports[name] !== target,
  )
  const ordered = Object.entries(next)
  if (imports.length > 0) {
    const at = ordered.findIndex(([key]) => key === "type") + 1
    ordered.splice(at, 0, ["imports", Object.fromEntries(imports)])
  }
  return { text: `${JSON.stringify(Object.fromEntries(ordered), null, 2)}\n`, problems }
}

const same = (x: unknown, y: unknown): boolean => JSON.stringify(x) === JSON.stringify(y)
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * A 3-way merge of two manifests of a package against their common base, key by key and one
 * level into objects: a key only one side changed takes that side's value, and a key both
 * changed differently is a conflict (named, and `theirs` kept in the text). Dependency lists
 * come out sorted.
 */
export const mergeManifests = (
  ours: unknown,
  base: unknown,
  theirs: unknown,
): { text: string; conflicts: string[] } => {
  const conflicts: string[] = []
  const merge = (a: unknown, b: unknown, c: unknown, path: string, depth: number): unknown => {
    if (same(a, b)) return c
    if (same(c, b) || same(a, c)) return a
    if (depth < 2 && isObject(a) && isObject(c) && (b === undefined || isObject(b))) {
      const out: Record<string, unknown> = { ...c }
      const known = (b ?? {}) as Record<string, unknown>
      for (const key of new Set([...Object.keys(known), ...Object.keys(a)])) {
        const value = merge(a[key], known[key], c[key], `${path}.${key}`, depth + 1)
        if (value === undefined) delete out[key]
        else out[key] = value
      }
      return path.endsWith("ependencies")
        ? Object.fromEntries(Object.entries(out).toSorted(([x], [y]) => x.localeCompare(y)))
        : out
    }
    conflicts.push(path.replace(/^\./, ""))
    return c
  }
  return { text: `${JSON.stringify(merge(ours, base, theirs, "", 0), null, 2)}\n`, conflicts }
}

// Whether a manifest is the UI's own: its versions come first.
const ownFirst = (file: string): number =>
  /^(?:frontend|apps|application\/ui)\//.test(file) ? 0 : 1

/** The lines of a text that start a conflict marker: `<<<<<<< ` or `>>>>>>> `. */
export const conflictMarkers = (text: string): number[] =>
  text.split(/\r?\n/).flatMap((line, index) => (/^(?:<{7}|>{7}) /.test(line) ? [index + 1] : []))

/**
 * The paths a failed run leaves for `git clean -fd` to take: the folders of the packages and
 * apps, and each file written elsewhere, from the plan's own list so it can't drift.
 */
export const cleanPaths = (written: readonly string[]): string[] => [
  ...new Set(
    written.map((file) => (/^(?:frontend|apps)\//.test(file) ? file.split("/")[0]! : file)),
  ),
]

// ---------------------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------------------

export type Planned = {
  /** Tracked files to move, and to delete. */
  readonly moves: readonly { readonly from: string; readonly to: string }[]
  readonly removes: readonly string[]
  /** The text of every file the plan changes, at its path after the move. */
  readonly writes: ReadonlyMap<string, string>
  readonly problems: readonly string[]
  /** Handwritten edits whose line a person changed: nothing to do, for a person to check. */
  readonly skipped: readonly string[]
}

export type PlanInput = {
  /** Every tracked file. */
  readonly tracked: readonly string[]
  readonly read: (file: string) => string
  /** A template's text by the file it makes. */
  readonly template: (file: string) => string
  readonly isTextual: (file: string) => boolean
  readonly policy?: Policy
  /** The handwritten edits; the real ones unless a test gives its own. */
  readonly edits?: readonly Edit[]
}

const TEST_LINE = `export { describe as context, describe, expect, it } from "vitest"\n`

/** Everything the move does, worked out before anything is written. */
export const plan = (input: PlanInput): Planned => {
  const rule = input.policy ?? policy
  const problems: string[] = []
  const present = new Set(input.tracked)
  const moves: { from: string; to: string }[] = []
  const removes: string[] = []
  const after = new Map<string, string>()
  for (const file of input.tracked) {
    if (unplaced(file)) {
      problems.push(`${file} is in a folder of src/backend/ that no package takes: give it one`)
      continue
    }
    const to = rule.place(file)
    if (to === undefined) continue
    if (to === null) removes.push(file)
    else if (present.has(to))
      problems.push(`${file} and ${to} are both tracked: keep one, at ${to}`)
    else {
      moves.push({ from: file, to })
      after.set(file, to)
    }
  }
  const removed = new Set(removes)
  const originOf = new Map([...after].map(([from, to]) => [to, from]))
  const pathAfter = (file: string): string => after.get(file) ?? file

  // The text of every file at its path after the move, imports and paths rewritten.
  const replaced = new Set([
    ...made.filter(({ was }) => was).map(({ file }) => file),
    ...Object.keys(generatedWas),
  ])
  const originals = new Map<string, string>()
  const outputs = new Map<string, string>()
  const copied = new Set<string>()
  for (const file of input.tracked) {
    if (removed.has(file) || !input.isTextual(file)) continue
    const place = pathAfter(file)
    const original = input.read(file)
    originals.set(place, original)
    let text = original
    // A file the move writes whole needs no rewriting of what it replaces.
    if (replaced.has(place)) {
      outputs.set(place, text)
      continue
    }
    const rewritten = rewriteImports(file, text, present, rule)
    problems.push(...rewritten.problems)
    rewritten.copies.forEach((dir) => copied.add(dir))
    text = rewritten.text
    if (!keptFile(place)) text = rewritePaths(text)
    outputs.set(place, text)
  }

  // Handwritten files and generated ones: new, or replacing the text the old UI had.
  const fresh = new Map<string, string>()
  const make = (
    file: string,
    content: string,
    was: string | undefined,
    why: string,
    generated = false,
  ): void => {
    const origin = originOf.get(file)
    if (origin !== undefined) {
      // Still at the old place: it is replaced if it is the text the script was written for.
      if (hashOf(originals.get(file) ?? "") === was) fresh.set(file, content)
      else
        problems.push(
          generated
            ? `${origin} isn't the text ${file} was generated over (${why}): make the branch's change in ${file} after the move, or in the generator (frontend.ts) and its hash`
            : `${origin} isn't the text ${file} was written for (${why}): redo its template in scripts/packages/frontend/ and its hash`,
        )
    } else if (!present.has(file)) fresh.set(file, content)
  }
  for (const { file, why, was, until } of made)
    if (until === undefined || !present.has(until)) make(file, input.template(file), was, why)

  for (const dir of copied) {
    const file = `${dir}/src/test.ts`
    if (!present.has(file) && !fresh.has(file)) {
      const old = `${ui}/src/test.ts`
      fresh.set(file, present.has(old) ? input.read(old) : TEST_LINE)
    }
  }
  // The packages' manifests, configs and tsconfigs, from what their files now import.
  const versions: Record<string, string> = {}
  // The UI's own manifests first: their versions are the ones its packages take, whatever
  // other package (the host lists playwright, typescript, vite and vitest) came before.
  for (const file of input.tracked
    .filter((f) => f.endsWith("package.json"))
    .toSorted((a, b) => ownFirst(a) - ownFirst(b))) {
    if (removed.has(file) || file.includes("/fixtures/")) continue
    try {
      const manifest = JSON.parse(input.read(file)) as Record<
        string,
        Record<string, string> | undefined
      >
      const own = (manifest as { name?: unknown }).name
      if (typeof own === "string") versions[own] = "workspace:*"
      for (const section of ["dependencies", "devDependencies"]) {
        for (const [name, version] of Object.entries(manifest[section] ?? {})) {
          if (!version.startsWith("workspace:")) versions[name] ??= version
        }
      }
    } catch {
      problems.push(`${file} isn't JSON`)
    }
  }
  for (const pkg of packages) {
    const config = vitestConfig(pkg)
    const file = `${pkg.dir}/vitest.config.ts`
    if (config !== undefined)
      make(file, config, generatedWas[file], "the package's Vitest projects", true)
  }
  const view = (): Map<string, string> => new Map([...outputs, ...fresh])
  const all = view()
  const finalPaths = new Set(all.keys())
  for (const pkg of packages) {
    const deps = dependenciesOf(pkg, all, versions)
    problems.push(...deps.problems)
    const mine = exportsFor(pkg, all, finalPaths)
    problems.push(...mine.problems)
    const types = [
      ...(usesViteTypes(pkg, all) ? ["vite/client"] : []),
      ...(deps.devDependencies["@types/node"] ? ["node"] : []),
    ]
    const file = `${pkg.dir}/tsconfig.json`
    make(file, tsconfigOf(pkg, types), generatedWas[file], "the package's compiler options", true)
    const manifest = `${pkg.dir}/package.json`
    const text = manifestOf(pkg, deps, mine.exports)
    const existing = originOf.has(manifest) ? undefined : originals.get(manifest)
    const notJson = [existing, originOf.has(manifest) ? originals.get(manifest) : undefined].some(
      (each) => {
        try {
          if (each !== undefined) JSON.parse(each)
          return false
        } catch {
          return true
        }
      },
    )
    if (notJson) {
      problems.push(
        `${originOf.get(manifest) ?? manifest} isn't JSON (a merge's conflict markers left in it?): make it a manifest again, then run again`,
      )
    } else if (existing === undefined) {
      const moved = originOf.has(manifest) ? originals.get(manifest) : undefined
      const kept =
        moved === undefined ? { text, problems: [] } : withBranchAdditions(text, moved, manifest)
      problems.push(...kept.problems)
      fresh.set(manifest, kept.text)
    } else {
      // Already made: only what the imports decide is brought up to date.
      const next = JSON.parse(text) as Record<string, Record<string, unknown> | undefined>
      const current = JSON.parse(existing) as Record<string, Record<string, unknown> | undefined>
      // What the imports give is added or brought up to date, and nothing a person or a branch
      // put there is taken out.
      const union = (section: string) =>
        next[section] === undefined && current[section] === undefined
          ? undefined
          : Object.fromEntries(
              Object.entries({ ...current[section], ...next[section] }).toSorted(([a], [b]) =>
                a.localeCompare(b),
              ),
            )
      const merged = Object.entries({
        ...current,
        exports: union("exports"),
        dependencies: union("dependencies"),
        devDependencies: union("devDependencies"),
      }).filter(([, value]) => value !== undefined)
      const updated = Object.fromEntries(merged)
      if (JSON.stringify(updated) !== JSON.stringify(JSON.parse(existing)))
        fresh.set(manifest, `${JSON.stringify(updated, null, 2)}\n`)
    }
  }

  // The edits, on the text as the rewrite leaves it.
  const final = view()
  const skipped: string[] = []
  for (const edit of input.edits ?? edits) {
    // A file a later step moved is read where that move took it.
    const file =
      !final.has(edit.file) && edit.later !== undefined && final.has(edit.later)
        ? edit.later
        : edit.file
    const text = final.get(file)
    if (text === undefined) {
      problems.push(`${edit.file} is gone (${edit.why}): the edit needs a new place`)
      continue
    }
    const result = applyEdit(text, edit)
    if ("problem" in result) problems.push(result.problem)
    else if (result.state === "made") final.set(file, result.text)
    else if (result.state === "gone") skipped.push(`${file}, whose line changed: ${edit.why}`)
  }

  // The packages' edges make no circle.
  problems.push(...cycleProblem([...final].flatMap(([file, text]) => edgesOf(file, text))))

  // Only what differs from the tree.
  const writes = new Map<string, string>()
  for (const [file, text] of final) if (originals.get(file) !== text) writes.set(file, text)
  return { moves, removes, writes, problems, skipped }
}

// ---------------------------------------------------------------------------------------
// Paths named in text
// ---------------------------------------------------------------------------------------

/**
 * What the rewrite leaves as it is, and the leftover check doesn't count: by path, as each
 * stands after the move. Each names an old folder on purpose.
 */
export const kept: Kept = [
  { path: "pnpm-lock.yaml", why: "pnpm install writes it again" },
  { path: "scripts/flakes/fixtures/", why: "logs captured from CI as they were" },
  { path: "FLAKY_RAPORT", why: "reports of what was" },
  { path: "scripts/packages/", why: "this script and its README name the old folders" },
  { path: "scripts/protocol/", why: "3.3r's move, which names the folders it moved" },
  { path: "scripts/core/", why: "3.1's and 3.2c's moves, as they ran" },
  {
    path: ".github/workflows/try.yml",
    why: "its layouts are those of tags it deploys, the old one among them",
  },
  { path: "backend/runner/src/terminals/peers.test.ts", why: "sample paths" },
  { path: "scripts/flaky-capture/grid-results.test.ts", why: "a sample result's checkout path" },
  { path: "scripts/libraries/graph.test.ts", why: "sample specs the package graph refuses" },
  { path: "scripts/libraries/fence.test.ts", why: "sample paths the fence refuses" },
]

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const before = String.raw`(^|[\s"'\x60(\[=:,]|(?:\.\.?\/)+)`
// What may follow a path's last segment.
const stop = String.raw`(?=[/"'\x60\s)\],:;]|$)`

const pathChars = String.raw`[\w@.*{}\-/]*`

/** Where a path below the old UI goes, in text: a file, a folder, or the package itself. */
export const pathBelowUi = (rest: string): string | undefined => {
  if (rest === "") return "frontend/ui"
  const path = `${ui}/${rest}`
  // A folder named without its last slash is still the folder.
  const spelled = path.endsWith("/") ? path : `${path}/`
  const rule = ruleFor(path) ?? ruleFor(spelled)
  if (rule && rule.to !== null) {
    if (!rule.from.endsWith("/")) return rule.to
    const to = rule.to + spelled.slice(rule.from.length)
    return path.endsWith("/") ? to : to.replace(/\/$/, "")
  }
  // A folder that several packages now share (src, src/backend, src/test, entries) names
  // none of them.
  if (/^src\/?$|^src\/(?:backend|test|entries)\/?$/.test(rest)) return undefined
  if (rest.startsWith("src/backend/")) return undefined
  return `frontend/ui/${rest}`
}

const uiPath = new RegExp(`${before}application\\/ui(?:\\/(${pathChars}))?${stop}`, "gm")
const uiPathEscaped =
  /(\\\/|[\s"'`([=:,]|^)application\\\/ui((?:\\\/[\w@.*{}-]+)*)(?=\\\/|["'`\s)\],:;]|$)/gm

// `ui/src/core/x.ts`, as the docs write it from application/.
const shortPath = new RegExp(`${before}ui\\/(src\\/${pathChars})${stop}`, "gm")

/** The text with every path below the old UI pointed at the package that now holds it. */
export const rewritePaths = (text: string): string =>
  text
    .replace(shortPath, (whole, lead: string, rest: string) => {
      const to = pathBelowUi(rest)
      return to === undefined ? whole : lead + to
    })
    .replace(uiPath, (whole, lead: string, rest: string | undefined) => {
      const to = pathBelowUi(rest ?? "")
      // `application/ui/` is the folder, with its slash.
      return to === undefined ? whole : lead + to + (rest === "" ? "/" : "")
    })
    .replace(uiPathEscaped, (whole, lead: string, rest: string) => {
      const to = pathBelowUi(rest.replaceAll("\\/", "/").replace(/^\//, ""))
      return to === undefined ? whole : lead + to.replaceAll("/", "\\/")
    })

// Any mention of the old UI's folders, however it is written: wider than the rewrite, so what
// the rewrite misses shows.
export const leftover = new RegExp(
  [
    String.raw`application[\\/]+ui\b`,
    String.raw`"application",\s*"ui"`,
    String.raw`(?:^|[\s"'\x60(\[=:,])ui\/src\/`,
    String.raw`#core\/`,
    // The apps' pages and builds are the apps', not the UI's.
    String.raw`frontend\/ui\/(?:entries\/(?:try|previews)|dist-(?:try|previews))\b`,
  ].join("|"),
  "m",
)

export const keptFile = (file: string): boolean => keeps(kept, file)

/** The lines of a file that still name the old UI. */
export const leftovers = (file: string, text: string): string[] =>
  keptFile(file)
    ? []
    : text
        .split(/\r?\n/)
        .flatMap((line, index) =>
          leftover.test(line) ? [`${file}:${index + 1}: ${line.trim()}`] : [],
        )

export { escape as escapeRegExp }
