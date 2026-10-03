import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, posix } from "node:path"

import { describe, expect, it } from "./test"

// Every source file belongs to a layer: a folder ("model/") or a single file
// ("main.tsx"). Each layer lists what it may import from src. Every folder in
// backend/ is an adapter layer; see `adapterRule`.
// theme/ (the theme list and how a theme is applied) is open to every layer that
// composes the page; it imports nothing but itself. model/ takes only the theme list's
// types, for the appearance preferences hold, and adapters resolve colour tokens with
// it for what they paint outside CSS, such as the terminal emulator.
const base = ["model/", "interaction/", "ui-toolkit/", "theme/"]
const features = ["sidebar/", "projects/", "preferences/", "search/"]
const rules: Record<string, readonly string[]> = {
  "model/": ["model/", "theme/themes.ts"],
  "theme/": ["theme/"],
  "backend/": ["backend/", "model/"],
  "ui-toolkit/": ["ui-toolkit/", "class-name.ts"],
  "interaction/": ["interaction/", "model/"],
  ...Object.fromEntries(features.map((layer) => [layer, [...base, layer]])),
  "terminals/": [...base, "terminals/", "sidebar/"],
  "layouts/": [...base, "layouts/", "sidebar/", "terminals/"],
  "shell/": [...base, "shell/", "sidebar/", "terminals/", "layouts/", "projects/"],
  "app/": ["app/", "backend/", ...base, ...features, "terminals/", "layouts/", "shell/"],
  // Commands are plain functions over the stores: no React, no DOM libraries.
  "app/commands/": [
    "app/commands/",
    "app/routing.ts",
    "app/ui-store.ts",
    "app/selectors.ts",
    "backend/port.ts",
    "model/",
    // The keymap's types only: commands never touch the DOM contracts in interaction/dom.ts.
    "interaction/keymap.ts",
    "shell/shell-state.ts",
    "terminals/rename-state.ts",
    "terminals/recent.ts",
    // The companion panes' store, which commands use by its type.
    "terminals/companion/state.ts",
    "layouts/canvas/types.ts",
  ],
  "specs/": ["specs/", "app/App.tsx", "theme/", "styles.css"],
  // Entry point and support modules outside the feature layers.
  "main.tsx": ["app/", "theme/", "styles.css"],
  "test/": [
    "test/",
    "test.ts",
    "model/",
    "backend/",
    // Command tests run the real stores, navigator and commands.
    "app/commands/",
    "app/routing.ts",
    "app/ui-store.ts",
    "layouts/canvas/types.ts",
  ],
  "test.ts": [],
  "class-name.ts": [],
  "content-security-policy.ts": [],
}
const adapterRule = (layer: string): readonly string[] => [
  layer,
  "backend/",
  "model/",
  "ui-toolkit/",
  "theme/",
]
// The only file that may import a backend adapter; it exports nothing else.
const adapterSelection = "app/backend.ts"
const adapterSelectionExports = ["selectBackend"]
// Packages are denied unless listed here, owned through `vendors`, or used by an
// adapter or test code. model/, theme/, interaction/ and app/commands/ use none; core
// backend/ uses React types only.
const everywherePackages = new Set(["react", "lucide-react"])
const typeOnlyPackages: Record<string, readonly string[]> = {
  "model/": [],
  "theme/": [],
  "backend/": ["react"],
  "app/commands/": [],
  "interaction/": [],
}
const testLayers = new Set(["specs/", "test/", "test.ts"])
const vendors: Record<string, readonly string[]> = {
  clsx: ["class-name.ts"],
  "tailwind-merge": ["class-name.ts"],
  "@ark-ui": ["ui-toolkit/"],
  "@xyflow/react": ["layouts/canvas/"],
  "@codemirror": ["terminals/companion/plan-editor/"],
  "@lezer": ["terminals/companion/plan-editor/", "terminals/companion/highlight.ts"],
  "react-grid-layout": ["layouts/grid/"],
  allotment: ["shell/"],
  "@dnd-kit": ["terminals/"],
  "react-router": ["app/", "shell/"],
  "react-dom": ["layouts/transition.ts", "main.tsx", "test/"],
  // The runner client, its test runner, and the terminal emulator serve one adapter.
  "@novadeck": ["backend/runner/"],
  "@xterm": ["backend/runner/"],
}

const src = join(process.cwd(), "src")
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
const resolveFile = (file: string, specifier: string): string | undefined => {
  // Vite query suffixes such as `?worker` or `?raw` name the same file.
  const bare = specifier.replace(/\?.*$/, "")
  const target = posix.normalize(posix.join(posix.dirname(file), bare))
  const candidates = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"].map(
    (suffix) => `${target}${suffix}`,
  )
  const isFile = (path: string): boolean =>
    existsSync(join(src, path)) && statSync(join(src, path)).isFile()
  return candidates.find(isFile)
}
const isTest = (file: string): boolean => /\.test\.tsx?$/.test(file)
const rootTest = (file: string): boolean => isTest(file) && !file.includes("/")
const adapterOf = (file: string): string | undefined => /^backend\/[^/]+\//.exec(file)?.[0]
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
    if (!specifier.startsWith(".")) {
      if (isTest(file) || (layer && (adapterOf(layer) || testLayers.has(layer)))) return []
      const limited = layer ? typeOnlyPackages[layer] : undefined
      const ok = limited
        ? limited.includes(packageName(specifier)) && typeOnly
        : everywherePackages.has(packageName(specifier)) || Boolean(vendorOf(specifier))
      return ok ? [] : [`${file} -> ${specifier}`]
    }
    const target = resolveFile(file, specifier)
    if (!target) return [`${file} -> ${specifier} (unresolved)`]
    const targetLayer = layerOf(target)
    if (targetLayer && adapterOf(targetLayer) && targetLayer !== layer)
      return file === adapterSelection
        ? []
        : [`${file} -> ${target} (only ${adapterSelection} selects an adapter)`]
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

  it("keeps vendor libraries inside their adapters", () => {
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

  it("lets the adapter selection export only its choice", () => {
    const text = source(adapterSelection)
    const exported = [...text.matchAll(/^export\s+(?:const|let|function|class|type)\s+(\w+)/gm)]
    expect(/^export\s*(?:\*|\{|default)/m.test(text)).toBe(false)
    expect(exported.map((match) => match[1])).toEqual(adapterSelectionExports)
  })

  it("names hook contracts instead of inferring them from the hook", () => {
    expect(files.filter((file) => /ReturnType<typeof use[A-Z]/.test(source(file)))).toEqual([])
  })
})
