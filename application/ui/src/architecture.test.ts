import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, posix, relative } from "node:path"

import { describe, expect, it } from "./test"

// Every source file belongs to a layer: a folder ("core/") or a single file
// ("deploy.ts"). Each layer lists what it may import from src. Every folder in
// backend/ is an adapter layer; see `adapterRule`. The core is imported as `#core/*`, the
// package's own `imports`, so that step 5 changes only configuration; inside the core its
// files import one another by relative path.
// theme/ (the theme file and how its scheme is applied) is open to every layer that
// composes the page; it imports nothing but itself and the core's types, for the scheme
// preference they hold. Backends never read it: what they paint outside CSS, such as the
// terminal emulator, takes the page's theme from the entry, as the port's `ThemeSource`.
const base = ["core/", "interaction/", "ui-toolkit/", "theme/"]
const features = ["sidebar/", "projects/", "preferences/", "search/"]
const rules: Record<string, readonly string[]> = {
  "core/": ["core/"],
  "theme/": ["theme/", "core/types.ts"],
  "backend/": ["backend/", "core/"],
  // The terminal views every backend draws its terminals with (see `terminalViews`): the
  // core, the port and libraries, never an adapter.
  "backend/terminal-views/": ["backend/terminal-views/", "backend/port.ts", "core/"],
  "ui-toolkit/": ["ui-toolkit/", "class-name.ts"],
  "interaction/": ["interaction/", "core/"],
  ...Object.fromEntries(features.map((layer) => [layer, [...base, layer]])),
  // Voice input: capture and the dictation state machine over the model's `Voice`, and the
  // one terminal contract it types into.
  "voice/": ["voice/", "core/", "ui-toolkit/"],
  "terminals/": [...base, "terminals/", "sidebar/"],
  "layouts/": [...base, "layouts/", "sidebar/", "terminals/"],
  // What asks for the person across the workspace: terminals' requests and unread finishes.
  "notifications/": [...base, "notifications/", "sidebar/", "terminals/unread-state.ts"],
  // The Inbox: what asks for the person, answered in place, beside the sidebar's rows, with
  // the chat's markdown reader and its answers' rules.
  "inbox/": [
    ...base,
    "inbox/",
    "sidebar/",
    "terminals/chat/Markdown.tsx",
    "terminals/chat/answers.ts",
  ],
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
    "backend/",
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
    "backend/port.ts",
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
    "terminals/chat/mode-state.ts",
    // The companion panes' store, which commands use by its type.
    "terminals/companion/state.ts",
    "layouts/canvas/types.ts",
    // The dictation contract's types, which keys call.
    "voice/dictation-control.ts",
  ],
  // Specs drive the whole UI over the demo: the layers they render, mock or read, the port,
  // and the page's styles. The demo is reached through the spec entry alone; see
  // `specBackend`.
  "specs/": [
    "specs/",
    "app/",
    "backend/port.ts",
    ...base,
    ...features,
    "terminals/",
    "layouts/",
    "shell/",
    "styles.css",
  ],
  // Entry point and support modules outside the feature layers.
  // Each app's entry: it renders the app with the backend it chose (see `entryAdapters`).
  // One entry never reaches another's, only how they all start.
  "entries/": ["entries/start.tsx", "app/", "backend/", "theme/", "styles.css"],
  "test/": [
    "test/",
    "test.ts",
    "core/",
    "backend/",
    // Command tests run the real stores, navigator and commands.
    "app/commands/",
    "app/routing.ts",
    "app/ui-store.ts",
    "layouts/canvas/types.ts",
  ],
  "test.ts": [],
  "class-name.ts": [],
  "bundle-boundary.ts": [],
  // How each build is deployed, which vite.config.ts hands the build kit.
  "deploy.ts": [],
}
const adapterRule = (layer: string): readonly string[] => [
  layer,
  "backend/",
  "core/",
  "ui-toolkit/",
]
// Not an adapter, though in backend/: both adapters draw their terminals with it.
const terminalViews = "backend/terminal-views/"
// The entries are the only files that import a backend adapter, each only its own: the
// runner for the desktop and web apps, the visitor demo for the try build, and the demo with
// its debug panel for the content preview.
const entryAdapters: Record<string, readonly string[]> = {
  "entries/desktop.tsx": ["backend/runner/"],
  "entries/web.tsx": ["backend/runner/"],
  "entries/try.tsx": ["backend/demo/visitor/"],
  "entries/previews.tsx": ["backend/demo/debug/"],
}
// The one other importer of the demo: the spec entry, which specs and the tests that render
// the whole workspace open the demo through, never another adapter module.
const demo = "backend/demo/"
// The demo's debug panel and its visitor build, which build on the demo's core.
const demoDebug = `${demo}debug/`
const demoVisitor = `${demo}visitor/`
const specBackend = "specs/support/backend.ts"
// The counter run drives the real UI over the runner adapter, scripted: the one spec
// that may reach core/store.ts, for its instrumentation hook. It and the spec below reach
// the runner adapter through its scripted server alone.
const counterRun = "specs/counters/"
const scriptedServer = "backend/runner/scripted-server.ts"
const counterRunReaches = [scriptedServer, "core/store.ts"]
// Canvas's out-of-sight spec opens the same scripted runner, to see which screens are open.
const canvasOffscreenSpec = "specs/canvas-offscreen.spec.tsx"
// The stores' instrumentation hook, which only the counter run installs; named here once,
// so this file is the one other place it appears.
const storeHook = "countListenersWoken"
const hookOwners = ["core/store.ts", counterRun, "architecture.test.ts"]
// Packages are denied unless listed here, owned through `vendors`, or used by an
// adapter or test code. theme/, interaction/ and app/commands/ use none; backend/ uses React
// types only. The core takes only the library entries `coreLibraryEntries` lists and the
// protocol's data entries
// that `protocolData` names, and no other package.
const everywherePackages = new Set(["react", "lucide-react"])
const typeOnlyPackages: Record<string, readonly string[]> = {
  "theme/": [],
  "backend/": ["react"],
  "app/commands/": [],
  "interaction/": [],
}
// The files in core/ that read the wire package, each through one data-only entry: its
// table of harnesses, the key that tells pages apart, and what draws as nothing in a command.
// An entry is added here when the core needs one; never `/client` or `/wire`.
const protocolData: Record<string, string> = {
  "core/harnesses.ts": "@novadeck/protocol/harnesses",
  "core/pages.ts": "@novadeck/protocol/pages",
  "core/command-text.ts": "@novadeck/protocol/text",
}
const testLayers = new Set(["specs/", "test/", "test.ts"])
const vendors: Record<string, readonly string[]> = {
  "@novadeck/build-kit": ["deploy.ts", "deploy.test.ts"],
  clsx: ["class-name.ts"],
  "tailwind-merge": ["class-name.ts"],
  "@ark-ui": ["ui-toolkit/"],
  "@xyflow/react": ["layouts/canvas/"],
  "@codemirror": ["terminals/companion/plan-editor/"],
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
  "react-router": ["app/", "shell/", "specs/"],
  "react-dom": ["layouts/transition.ts", "entries/start.tsx", "test/"],
  // One entry per workspace package, with the folders that own it. The runner client and its
  // test runner serve one adapter, the terminal emulator its screens, and the content viewers
  // the companion pane and chat.
  "@novadeck/viewers": ["terminals/companion/", "terminals/chat/"],
  "@novadeck/protocol": ["backend/runner/", ...Object.keys(protocolData)],
  "@novadeck/runner": ["backend/runner/"],
  "@novadeck/emulator": ["backend/runner/", "backend/demo/screen/", terminalViews],
  "@novadeck/terminal": ["backend/runner/", terminalViews],
  "@novadeck/wire": ["backend/runner/"],
  // The runner's server side, which only the counter run's scripted runner serves.
  "@orpc/server": [scriptedServer],
}

const src = join(process.cwd(), "src")
// The library entries the core may import, each one data only: no DOM, no framework, nothing
// only Node may load. None yet; add an entry when the core needs one, as `protocolData` does
// for the protocol. Everything else of a library is refused, whatever its subpath.
const coreLibraryEntries = new Set<string>([])
const coreLibrary = (specifier: string): boolean => coreLibraryEntries.has(specifier)
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
const coreSpecifier = "#core/"
const isCoreSpecifier = (specifier: string): boolean => specifier.startsWith(coreSpecifier)
const resolveFile = (file: string, specifier: string): string | undefined => {
  // Vite query suffixes such as `?worker` or `?raw` name the same file.
  const bare = specifier.replace(/\?.*$/, "")
  const isFile = (path: string): boolean =>
    existsSync(join(src, path)) && statSync(join(src, path)).isFile()
  // `#core/*` maps to `src/core/*.ts` (see the UI's package.json), and nothing else.
  if (isCoreSpecifier(bare)) {
    // As the mapping does: one .ts file, and never out of the core by `..`.
    const mapped = posix.normalize(`core/${bare.slice(coreSpecifier.length)}.ts`)
    return mapped.startsWith("core/") && isFile(mapped) ? mapped : undefined
  }
  const target = posix.normalize(posix.join(posix.dirname(file), bare))
  const candidates = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"].map(
    (suffix) => `${target}${suffix}`,
  )
  return candidates.find(isFile)
}
const isTest = (file: string): boolean => /\.test\.tsx?$/.test(file)
const rootTest = (file: string): boolean => isTest(file) && !file.includes("/")
const adapterOf = (file: string): string | undefined => {
  const folder = /^backend\/[^/]+\//.exec(file)?.[0]
  return folder === terminalViews ? undefined : folder
}
// The most specific layer wins, so backend/demo/ is not treated as backend/.
const layerOf = (file: string): string | undefined =>
  adapterOf(file) ??
  Object.keys(rules).reduce<string | undefined>(
    (found, layer) =>
      file.startsWith(layer) && layer.length > (found?.length ?? 0) ? layer : found,
    undefined,
  )
const allowedFor = (file: string, layer: string): readonly string[] => [
  ...(adapterOf(layer) ? adapterRule(layer) : rules[layer]!),
  ...(isTest(file) ? ["test/", "test.ts"] : []),
]
const packageName = (specifier: string): string =>
  specifier
    .split("/")
    .slice(0, specifier.startsWith("@") ? 2 : 1)
    .join("/")
const vendorOf = (specifier: string): string | undefined =>
  Object.keys(vendors).find((name) => specifier === name || specifier.startsWith(`${name}/`))

const importViolation = (file: string, layer: string | undefined) => {
  const allowed = layer ? allowedFor(file, layer) : []
  return ({ specifier, typeOnly }: { specifier: string; typeOnly: boolean }): string[] => {
    if (!specifier.startsWith(".") && !isCoreSpecifier(specifier)) {
      if (protocolData[file] === specifier) return []
      if (isTest(file) || (layer && (adapterOf(layer) || testLayers.has(layer)))) return []
      // The core takes the listed library entries and, through `protocolData`, the protocol's.
      if (layer === "core/") return coreLibrary(specifier) ? [] : [`${file} -> ${specifier}`]
      const limited = layer ? typeOnlyPackages[layer] : undefined
      const ok = limited
        ? limited.includes(packageName(specifier)) && typeOnly
        : everywherePackages.has(packageName(specifier)) || Boolean(vendorOf(specifier))
      return ok ? [] : [`${file} -> ${specifier}`]
    }
    const target = resolveFile(file, specifier)
    if (!target) return [`${file} -> ${specifier} (unresolved)`]
    if (file.startsWith(counterRun) && counterRunReaches.includes(target)) return []
    if (file === canvasOffscreenSpec && target === scriptedServer) return []
    const targetLayer = layerOf(target)
    if (targetLayer && adapterOf(targetLayer) && targetLayer !== layer)
      return entryAdapters[file]?.some((own) => target.startsWith(own)) ||
        (file === specBackend && targetLayer === demo)
        ? []
        : [
            `${file} -> ${target} (only its entry, or ${specBackend} for the demo, selects an adapter)`,
          ]
    // Root-level tests exercise the root modules beside them.
    if (!layer)
      return target.includes("/") && !target.startsWith("test/") ? [`${file} -> ${target}`] : []
    const ok = allowed.some(
      (entry) => target === entry || targetLayer === entry || target.startsWith(entry),
    )
    return ok ? [] : [`${file} -> ${target}`]
  }
}

describe("UI architecture", () => {
  it("places every source file in a layer", () => {
    expect(files.filter((file) => !layerOf(file) && !rootTest(file))).toEqual([])
  })

  it("keeps each layer to the layers it may import", () => {
    const found = files.flatMap((file) =>
      imports(file).flatMap(importViolation(file, layerOf(file))),
    )
    expect(found).toEqual([])
  })

  it("reaches the core as #core/* from outside it, and by relative path from inside", () => {
    const found = files.flatMap((file) =>
      imports(file).flatMap(({ specifier }) => {
        if (file.startsWith("core/"))
          return isCoreSpecifier(specifier) ? [`${file} -> ${specifier}`] : []
        const target = specifier.startsWith(".") ? resolveFile(file, specifier) : undefined
        return target?.startsWith("core/") ? [`${file} -> ${specifier} (use #core/*)`] : []
      }),
    )
    expect(found).toEqual([])
  })

  it("holds only .ts files in the core, which #core/* maps to", () => {
    // Every file, not only scripts: a .tsx, .js or stylesheet there is as much out of place.
    const core = readdirSync(join(src, "core"), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => relative(src, join(entry.parentPath, entry.name)).split("\\").join("/"))
    expect(core.filter((file) => !file.endsWith(".ts"))).toEqual([])
  })

  it("keeps the core to itself and to the library and protocol entries listed as data only", () => {
    const dataEntries = new Set(Object.values(protocolData))
    // The core's own tests may import what tests need, as every layer's tests may.
    const found = files
      .filter((file) => file.startsWith("core/") && !isTest(file))
      .flatMap((file) =>
        imports(file).flatMap(({ specifier }) => {
          // Only another .ts file of the core, with no query that makes it a worker or text.
          if (specifier.startsWith(".")) {
            const target = resolveFile(file, specifier)
            return !specifier.includes("?") && target?.startsWith("core/") && target.endsWith(".ts")
              ? []
              : [`${file} -> ${specifier}`]
          }
          if (dataEntries.has(specifier)) return []
          // The protocol isn't a library, so only its data entries pass; its `/client` and `/wire` don't.
          return coreLibrary(specifier) ? [] : [`${file} -> ${specifier}`]
        }),
      )
    expect(found).toEqual([])
  })

  it("keeps vendor libraries inside their adapters", () => {
    const found = files.flatMap((file) =>
      imports(file).flatMap(({ specifier }) => {
        const vendor = vendorOf(specifier)
        const library = file.startsWith("core/") && coreLibrary(specifier)
        return !vendor || library || vendors[vendor]!.some((owner) => file.startsWith(owner))
          ? []
          : [`${file} -> ${specifier}`]
      }),
    )
    expect(found).toEqual([])
  })

  it("lets only the backends and tests import the terminal views, which load with a connection", () => {
    const found = files
      .filter((file) => !file.startsWith(terminalViews) && !adapterOf(file) && !isTest(file))
      .flatMap((file) =>
        imports(file)
          .filter(({ specifier }) => specifier.startsWith("."))
          .filter(({ specifier }) => resolveFile(file, specifier)?.startsWith(terminalViews))
          .map(({ specifier }) => `${file} -> ${specifier}`),
      )
    expect(found).toEqual([])
  })

  // Packages other than the workspace's libraries: React among them, which the layer rule
  // alone would let through.
  it("keeps the terminal views to the workspace's libraries among packages, React not among them", () => {
    const found = files
      .filter((file) => file.startsWith(terminalViews) && !isTest(file))
      .flatMap((file) =>
        imports(file)
          .filter(({ specifier }) => !specifier.startsWith(".") && !isCoreSpecifier(specifier))
          .filter(({ specifier }) => !specifier.startsWith("@novadeck/"))
          .map(({ specifier }) => `${file} -> ${specifier}`),
      )
    expect(found).toEqual([])
  })

  it("imports no workspace package the table doesn't give an owner", () => {
    const found = files.flatMap((file) =>
      imports(file)
        .filter(({ specifier }) => specifier.startsWith("@novadeck/") && !vendorOf(specifier))
        // The core takes any library's entries for every environment, owner or not.
        .filter(({ specifier }) => !(file.startsWith("core/") && coreLibrary(specifier)))
        .map(({ specifier }) => `${file} -> ${specifier}`),
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
    const deadExceptions = counterRunReaches
      .filter(
        (reached) =>
          !files.some(
            (file) =>
              file.startsWith(counterRun) &&
              imports(file).some(({ specifier }) => resolveFile(file, specifier) === reached),
          ),
      )
      .map((reached) => `${counterRun} -> ${reached}`)
    const deadSpecBackend = imports(specBackend).some(({ specifier }) =>
      resolveFile(specBackend, specifier)?.startsWith(demo),
    )
      ? []
      : [`${specBackend} -> ${demo}`]
    const deadDemoLayers = [demoDebug, demoVisitor].filter(
      (layer) => !files.some((file) => file.startsWith(layer)),
    )
    expect([
      ...deadLayers,
      ...deadVendors,
      ...deadExceptions,
      ...deadSpecBackend,
      ...deadDemoLayers,
    ]).toEqual([])
  })

  it("keeps the stores' instrumentation hook to the counter run", () => {
    const named = new RegExp(`\\b${storeHook}\\b`)
    const found = files.filter(
      (file) => named.test(source(file)) && !hookOwners.some((owner) => file.startsWith(owner)),
    )
    expect(found).toEqual([])
  })

  it("keeps the runner's own code free of React and the UI toolkit", () => {
    // It draws terminals through the port's mount, into an element it is given; the chrome
    // around them is the app's. This holds until the adapter rule covers every adapter.
    const found = files
      .filter((file) => file.startsWith("backend/runner/") && !isTest(file))
      .flatMap((file) =>
        imports(file).flatMap(({ specifier }) => {
          const target = specifier.startsWith(".") ? resolveFile(file, specifier) : undefined
          const react = !specifier.startsWith(".") && /^react(-dom)?(\/|$)/.test(specifier)
          return react || target?.startsWith("ui-toolkit/") ? [`${file} -> ${specifier}`] : []
        }),
      )
    expect(found).toEqual([])
  })

  it("keeps the demo's debug panel and visitor build above its core", () => {
    // debug/ and visitor/ build on the demo's core; the core reaches neither, and the visitor
    // build never carries the debug panel. Tests too, as each folder becomes its own package.
    const found = files
      .filter((file) => file.startsWith(demo) && !file.startsWith(demoDebug))
      .flatMap((file) =>
        imports(file).flatMap(({ specifier }) => {
          const target = specifier.startsWith(".") ? resolveFile(file, specifier) : undefined
          const above = file.startsWith(demoVisitor) ? [demoDebug] : [demoDebug, demoVisitor]
          return target && above.some((layer) => target.startsWith(layer))
            ? [`${file} -> ${target}`]
            : []
        }),
      )
    expect(found).toEqual([])
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
    expect(Object.keys(entryAdapters).every((file) => files.includes(file))).toBe(true)
  })

  it("lets each page's script do nothing but start its entry", () => {
    // Outside src/, beside each page for its dev server: no rule above reaches them.
    const pages = join(process.cwd(), "entries")
    const scripts = readdirSync(pages).map((name) => [
      name,
      // Lines, whatever a checkout's line endings are (CRLF on Windows).
      readFileSync(join(pages, name, "main.tsx"), "utf8")
        .split(/\r?\n/)
        .filter((line) => line !== "" && !line.startsWith("//")),
    ])
    expect(scripts).toEqual(
      readdirSync(pages).map((name) => [name, [`import "../../src/entries/${name}"`]]),
    )
    expect(scripts.map(([name]) => `entries/${String(name)}.tsx`)).toEqual(
      expect.arrayContaining(
        Object.keys(entryAdapters).filter((file) => !file.endsWith("desktop.tsx")),
      ),
    )
  })

  it("names hook contracts instead of inferring them from the hook", () => {
    expect(files.filter((file) => /ReturnType<typeof use[A-Z]/.test(source(file)))).toEqual([])
  })
})
