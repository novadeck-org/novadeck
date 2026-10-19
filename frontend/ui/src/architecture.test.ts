import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, posix } from "node:path"

import { describe, expect, it } from "./test"

// Every source file belongs to a layer: a folder ("shell/") or a single file
// ("test.ts"). Each layer lists what it may import from src. What the package graph
// holds (which package may import which: the core, the runner adapter, the demo and the
// rest are packages of their own) is not repeated here. The model is `@novadeck/core`, and
// its files are named below as `core/<file>.ts`, so the layers that may reach only some of it
// still say so; inside the core its files import one another by relative path.
// theme/ (the theme file and how its scheme is applied) is open to every layer that
// composes the page; it imports nothing but itself and the core's types, for the scheme
// preference they hold. Backends never read it: what they paint outside CSS, such as the
// terminal emulator, takes the page's theme from the entry, as the port's `ThemeSource`.
// ui-toolkit/ is the package `@novadeck/toolkit` (see `modules`): the controls, `class-name` and
// the sidebar item. Its own rules are its package.json's.
// terminals/companion/ is the package `@novadeck/companion` (see `modules`): the companion pane
// and the bar drag, which `layouts/` and `app/` reach as part of `terminals/`.
const base = ["core/", "interaction/", "ui-toolkit/", "theme/"]
const features = ["sidebar/", "projects/", "preferences/", "search/"]
const rules: Record<string, readonly string[]> = {
  "theme/": ["theme/", "core/types.ts"],
  "interaction/": ["interaction/", "core/"],
  ...Object.fromEntries(features.map((layer) => [layer, [...base, layer]])),
  // Voice input: capture and the dictation state machine over the model's `Voice`, and the
  // one terminal contract it types into.
  "voice/": ["voice/", "core/", "ui-toolkit/"],
  "terminals/": [...base, "terminals/"],
  "layouts/": [...base, "layouts/", "terminals/"],
  // What asks for the person across the workspace: terminals' requests and unread finishes.
  "notifications/": [...base, "notifications/", "terminals/unread-state.ts"],
  // The Inbox: what asks for the person, answered in place, in the sidebar item's rows, with
  // the chat's markdown reader and its answers' rules.
  "inbox/": [...base, "inbox/", "terminals/chat/Markdown.tsx", "terminals/chat/answers.ts"],
  "shell/": [
    ...base,
    "shell/",
    "sidebar/",
    "terminals/",
    "layouts/",
    "projects/",
    "notifications/",
    "inbox/",
  ],
  "app/": [
    "app/",
    ...base,
    ...features,
    "terminals/",
    "layouts/",
    "shell/",
    "voice/",
    "notifications/",
    "inbox/",
  ],
  // Commands are plain functions over the stores: no React, no DOM libraries.
  "app/commands/": [
    "app/commands/",
    "app/routing.ts",
    "app/ui-store.ts",
    "app/selectors.ts",
    "core/",
    // The keymap's types only: commands never touch the DOM contracts in interaction/dom.ts.
    "interaction/keymap.ts",
    "shell/shell-state.ts",
    // Which panel a link to the sidebar shows.
    "shell/panels.ts",
    "terminals/rename-state.ts",
    // Unread finishes, which the notification center's dismissals clear.
    "terminals/unread-state.ts",
    // The switcher's arrangement, which commands change by its pure functions.
    "projects/project-arrangement.ts",
    "terminals/recent.ts",
    // The chat's store and commands, which the app composes; its pure helpers are theirs.
    "terminals/chat/state.ts",
    "terminals/chat/commands.ts",
    // The companion panes' store, which commands use by its type, and the actions they
    // implement, which they declare they satisfy.
    "terminals/companion/state.ts",
    "terminals/companion/actions.ts",
    "layouts/canvas/types.ts",
    // The dictation contract's types, which keys call.
    "voice/dictation-control.ts",
  ],
  // Each app's entry: it renders the app with the backend it chose, which is the app's own
  // package (the desktop and browser entries take the runner adapter, see `vendors`).
  // One entry never reaches another's, only how they all start.
  "entries/": ["entries/start.tsx", "app/", "core/port.ts", "theme/", "styles.css"],
  // The helper that builds the app's commands for tests: the real stores, navigator and commands.
  "test/": [
    "test/",
    "test.ts",
    "core/",
    "app/commands/",
    "app/routing.ts",
    "app/ui-store.ts",
    "layouts/canvas/types.ts",
    // The chat store that the helper puts in the command context.
    "terminals/chat/state.ts",
  ],
  "test.ts": [],
}
// Packages are denied unless listed here or owned through `vendors`; test code (the test
// layers and every layer's tests) may use any other package too. theme/, interaction/ and
// app/commands/ use none.
const everywherePackages = new Set(["react", "lucide-react"])
const typeOnlyPackages: Record<string, readonly string[]> = {
  "theme/": [],
  "app/commands/": [],
  "interaction/": [],
}
const testLayers = new Set(["test/", "test.ts"])
const vendors: Record<string, readonly string[]> = {
  "@xyflow/react": ["layouts/canvas/"],
  "react-grid-layout": ["layouts/grid/"],
  allotment: ["shell/"],
  // Terminals' tabs, windows and taskbars, the footer's subscriptions and the project
  // switcher's projects and its pins, which reorder as the taskbar's icons do, and the
  // drag the switcher hands to the pins bar.
  "@dnd-kit": [
    "terminals/",
    "shell/SubscriptionUsage.tsx",
    "projects/PinsBar.tsx",
    "projects/pin-handoff.ts",
    "projects/ProjectList.tsx",
    "projects/ProjectRow.tsx",
  ],
  "react-router": ["app/", "shell/"],
  "react-dom": ["layouts/transition.ts", "entries/start.tsx"],
  // One entry per workspace package, with the folders that own it. The content viewers serve
  // chat (the companion pane, which they served too, is a package of its own).
  "@novadeck/viewers": ["terminals/chat/"],
}

// The packages that hold what used to be folders of src, named as the layers above know them.
const modules: Record<string, string> = {
  "@novadeck/toolkit/": "ui-toolkit/",
  "@novadeck/companion/": "terminals/companion/",
  "@novadeck/core/testing": "test/fixtures.ts",
  "@novadeck/test-kit/": "test/",
}

const src = join(import.meta.dirname)
const files = (readdirSync(src, { recursive: true }) as string[])
  .map((file) => file.split("\\").join("/"))
  .filter((file) => /\.tsx?$/.test(file))
const source = (file: string): string => readFileSync(join(src, file), "utf8")
const importPattern =
  /(?:^(?:import|export)(\s+type)?\b[^"']*?\bfrom|^import|\bimport\()\s*(["'])([^"']+)\2/gm
const imports = (file: string) =>
  [...source(file).matchAll(importPattern)].map((match) => ({
    specifier: match[3]!,
    typeOnly: Boolean(match[1]),
  }))
const coreSpecifier = "@novadeck/core/"
const isCoreSpecifier = (specifier: string): boolean => specifier.startsWith(coreSpecifier)
// The layer file a specifier of another package names, among the layers above.
const moduleOf = (specifier: string): string | undefined => {
  const bare = specifier.replace(/\?.*$/, "")
  if (isCoreSpecifier(bare) && bare !== "@novadeck/core/testing")
    return `core/${bare.slice(coreSpecifier.length)}.ts`
  const owner = Object.keys(modules).find((name) => bare === name || bare.startsWith(name))
  if (!owner) return undefined
  return owner.endsWith("/") ? `${modules[owner]}${bare.slice(owner.length)}.ts` : modules[owner]
}
const resolveFile = (file: string, specifier: string): string | undefined => {
  // Vite query suffixes such as `?worker` or `?raw` name the same file.
  const bare = specifier.replace(/\?.*$/, "")
  const isFile = (path: string): boolean =>
    existsSync(join(src, path)) && statSync(join(src, path)).isFile()
  const target = posix.normalize(posix.join(posix.dirname(file), bare))
  const candidates = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"].map(
    (suffix) => `${target}${suffix}`,
  )
  return candidates.find(isFile)
}
const isTest = (file: string): boolean => /\.test\.tsx?$/.test(file)
const rootTest = (file: string): boolean => isTest(file) && !file.includes("/")
// The most specific layer wins.
const layerOf = (file: string): string | undefined =>
  Object.keys(rules).reduce<string | undefined>(
    (found, layer) =>
      file.startsWith(layer) && layer.length > (found?.length ?? 0) ? layer : found,
    undefined,
  )
const allowedFor = (file: string, layer: string): readonly string[] => [
  ...rules[layer]!,
  ...(isTest(file) ? ["test/", "test.ts"] : []),
]
const packageName = (specifier: string): string =>
  specifier
    .split("/")
    .slice(0, specifier.startsWith("@") ? 2 : 1)
    .join("/")
const vendorOf = (specifier: string): string | undefined =>
  Object.keys(vendors)
    .filter((name) => specifier === name || specifier.startsWith(`${name}/`))
    .reduce<string | undefined>(
      (found, name) => (name.length > (found?.length ?? 0) ? name : found),
      undefined,
    )

const importViolation = (file: string, layer: string | undefined) => {
  const allowed = layer ? allowedFor(file, layer) : []
  return ({ specifier, typeOnly }: { specifier: string; typeOnly: boolean }): string[] => {
    const named = moduleOf(specifier)
    if (!specifier.startsWith(".") && named === undefined) {
      if (isTest(file) || (layer && testLayers.has(layer))) return []
      const limited = layer ? typeOnlyPackages[layer] : undefined
      const ok = limited
        ? limited.includes(packageName(specifier)) && typeOnly
        : everywherePackages.has(packageName(specifier)) || Boolean(vendorOf(specifier))
      return ok ? [] : [`${file} -> ${specifier}`]
    }
    const target = named ?? resolveFile(file, specifier)
    if (!target) return [`${file} -> ${specifier} (unresolved)`]
    // Root-level tests exercise the root modules beside them.
    if (!layer)
      return target.includes("/") && !target.startsWith("test/") && !target.startsWith("core/")
        ? [`${file} -> ${target}`]
        : []
    const ok = allowed.some((entry) => target === entry || target.startsWith(entry))
    return ok ? [] : [`${file} -> ${target}`]
  }
}

describe("UI architecture", () => {
  it("reads the source of every folder", () => {
    expect(files).toEqual(
      expect.arrayContaining([
        "app/App.tsx",
        "entries/start.tsx",
        "theme/apply.ts",
        "terminals/TerminalTabs.tsx",
      ]),
    )
  })

  it("places every source file in a layer", () => {
    expect(files.filter((file) => !layerOf(file) && !rootTest(file))).toEqual([])
  })

  it("keeps each layer to the layers it may import", () => {
    const found = files.flatMap((file) =>
      imports(file).flatMap(importViolation(file, layerOf(file))),
    )
    expect(found).toEqual([])
  })

  it("keeps vendor libraries inside their layers", () => {
    const found = files.flatMap((file) =>
      imports(file).flatMap(({ specifier }) => {
        const vendor = vendorOf(specifier)
        return !vendor || vendors[vendor]!.some((owner) => file.startsWith(owner))
          ? []
          : [`${file} -> ${specifier}`]
      }),
    )
    expect(found).toEqual([])
  })

  it("has no rule that matches nothing", () => {
    const deadLayers = Object.keys(rules).filter(
      (layer) => !files.some((file) => file.startsWith(layer)),
    )
    const deadVendors = Object.entries(vendors).flatMap(([vendor, owners]) =>
      owners
        .filter(
          (owner) =>
            !files.some(
              (file) =>
                file.startsWith(owner) &&
                imports(file).some(({ specifier }) => vendorOf(specifier) === vendor),
            ),
        )
        .map((owner) => `${vendor} in ${owner}`),
    )
    expect([...deadLayers, ...deadVendors]).toEqual([])
  })

  it("keeps imports statically resolvable", () => {
    expect(files.filter((file) => /\bimport\(\s*[^"'\s]/.test(source(file)))).toEqual([])
  })

  it("lets the entries export nothing but how they start", () => {
    const exported = files.flatMap((file) =>
      !file.startsWith("entries/")
        ? []
        : [
            ...[
              ...source(file).matchAll(/^export\s+(?:const|let|function|class|type)\s+(\w+)/gm),
            ].map((match) => `${file} ${match[1]}`),
            ...(/^export\s*(?:\*|\{|default)/m.test(source(file)) ? [`${file} *`] : []),
          ],
    )
    expect(exported).toEqual(["entries/start.tsx start"])
    expect(files).toEqual(expect.arrayContaining(["entries/start.tsx"]))
  })

  it("names hook contracts instead of inferring them from the hook", () => {
    expect(files.filter((file) => /ReturnType<typeof use[A-Z]/.test(source(file)))).toEqual([])
  })
})

// What the UI package exports: the few modules the apps start from, and for the specs those
// they drive the whole UI through. Anything else is internal, and only the specs may reach a
// module that isn't public, besides the one the chat contract renders.
describe("the UI's exports", () => {
  const publicSubpaths = [
    "./app/App",
    "./styles.css",
    "./theme/source",
    "./entries/start",
    // The host finds the UI's folder through its manifest.
    "./package.json",
  ]
  const root = join(src, "..", "..", "..")
  const packagesOf = (folder: string): string[] =>
    readdirSync(join(root, folder)).map((name) => `${folder}/${name}`)
  const sourcesOf = (dir: string): { file: string; text: string }[] =>
    !existsSync(join(root, dir, "src"))
      ? []
      : (readdirSync(join(root, dir, "src"), { recursive: true }) as string[])
          .map((file) => file.split("\\").join("/"))
          .filter((file) => /\.(?:tsx?|css)$/.test(file))
          .map((file) => ({
            file: `${dir}/src/${file}`,
            text: readFileSync(join(root, dir, "src", file), "utf8"),
          }))
  const reach = [...packagesOf("frontend"), ...packagesOf("apps")]
    .filter((dir) => dir !== "frontend/ui")
    .flatMap((dir) =>
      sourcesOf(dir).flatMap(({ file, text }) =>
        [...text.matchAll(/(["'])@novadeck\/ui(\/[^"'?]+)(?:\?[^"']*)?\1/g)].map((match) => ({
          dir,
          file,
          subpath: `.${match[2]!}`,
        })),
      ),
    )
  const manifest = JSON.parse(readFileSync(join(src, "..", "package.json"), "utf8")) as {
    exports: Record<string, string>
  }

  it("reads the other packages' sources, the specs' among them", () => {
    expect(reach.some(({ dir }) => dir === "frontend/specs")).toBe(true)
    expect(reach.some(({ dir }) => dir === "apps/try")).toBe(true)
  })

  it("lets only the specs import what isn't public", () => {
    // The chat contract renders the chat's transcript from recorded harness records, and
    // reaches nothing else.
    const contractSubpaths = new Set(["./terminals/chat/Transcript"])
    expect(reach.some(({ dir }) => dir === "frontend/chat-contract")).toBe(true)
    expect(
      reach
        .filter(
          ({ dir, subpath }) =>
            dir !== "frontend/specs" &&
            !publicSubpaths.includes(subpath) &&
            !(dir === "frontend/chat-contract" && contractSubpaths.has(subpath)),
        )
        .map(({ file, subpath }) => `${file} -> ${subpath}`),
    ).toEqual([])
  })

  it("exports what is imported, and nothing else", () => {
    const used = new Set([...publicSubpaths, ...reach.map(({ subpath }) => subpath)])
    expect(Object.keys(manifest.exports).toSorted()).toEqual([...used].toSorted())
  })
})
