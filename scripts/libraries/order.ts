import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

// The order between libraries, from each library design's `depends_on`: what the import
// fence (.oxlintrc.json) and the package graph each enforce, checked by fence.test.ts and
// graph.test.ts.

/** Each library, and the libraries its design lets it import. */
export const order: Readonly<Record<string, readonly string[]>> = {
  emulator: [],
  sandbox: [],
  terminal: ["emulator"],
  "tui-input": ["emulator"],
  viewers: [],
  wire: [],
}

/**
 * The app's own packages, by name: everything in application/, apps/, backend/, contract/,
 * frontend/ and harnesses/, and the atlas.
 */
export const appPackages = (root: string): readonly string[] =>
  [
    ...["application", "apps", "backend", "contract", "frontend", "harnesses"]
      .filter((folder) => existsSync(join(root, folder)))
      .flatMap((folder) =>
        readdirSync(join(root, folder)).map((name) => join(root, folder, name, "package.json")),
      ),
    // One path, as step 5's move script rewrites it.
    join(root, "tools/atlas/package.json"),
  ]
    .filter((file) => existsSync(file))
    .map((file) => (JSON.parse(readFileSync(file, "utf8")) as { name: string }).name)
