import { resolve } from "node:path"

import { defineConfig } from "electron-vite"

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
          murmurWorker: resolve("../runner/src/murmur/worker.ts"),
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
