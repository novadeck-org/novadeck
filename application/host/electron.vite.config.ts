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
        },
        // Native PTYs load through Node's own resolver, from the unpacked package.
        external: ["node-pty"],
      },
    },
  },
  preload: {
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
