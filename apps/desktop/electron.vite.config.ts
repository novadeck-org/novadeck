import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"

import { defineConfig } from "electron-vite"

// The runner's source, which the host's dependency on it finds wherever its folder is.
const runnerSource = dirname(createRequire(import.meta.url).resolve("@novadeck/runner"))

export default defineConfig({
  main: {
    ssr: {
      resolve: {
        // @xterm/headless's module field points at a browser entry it does not ship.
        mainFields: ["main", "module"],
      },
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/main/index.ts"),
          // The runner runs in its own utility process.
          runner: resolve("src/runner/index.ts"),
          // The thread murmur redacts digests in, which the runner starts from a file beside it.
          murmurWorker: resolve(runnerSource, "murmur/worker.ts"),
          // The thread that masks secrets in saved transcripts, started the same way.
          redactionWorker: resolve(runnerSource, "terminals/redactionWorker.ts"),
        },
        // Native PTYs load through Node's own resolver, from the unpacked package.
        external: ["node-pty"],
      },
    },
  },
  preload: {
    // The preload runs in Electron, not a page: it also takes a library's Node-only
    // subpath for it, as wire's `/electron`, which names only the `node` condition. That
    // condition is added to the preset's, so a package's Node build could win where it lists
    // `node` first: the bundle is checked to need nothing but electron.
    ssr: { resolve: { conditions: ["node"] } },
    build: {
      rollupOptions: {
        input: resolve("src/preload/index.ts"),
        output: {
          entryFileNames: "index.cjs",
          format: "cjs",
        },
      },
    },
  },
})
