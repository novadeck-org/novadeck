import { unit } from "@novadeck/build-kit/vitest"
import { playwright } from "@vitest/browser-playwright"
import { configDefaults, defineConfig, type TestProjectInlineConfiguration } from "vitest/config"

// A project of specs that run a terminal in a real browser.
const browserProject = (options: {
  readonly name: string
  readonly include?: string[]
  readonly exclude?: string[]
  readonly args?: string[]
}): TestProjectInlineConfiguration => ({
  extends: true,
  server: { strictPort: false },
  optimizeDeps: {
    include: [
      "@novadeck/emulator > @xterm/addon-fit",
      "@novadeck/emulator > @xterm/addon-unicode-graphemes",
      "@novadeck/emulator > @xterm/addon-web-links",
      "@novadeck/emulator > @xterm/addon-webgl",
      "@novadeck/emulator > @xterm/xterm",
    ],
  },
  test: {
    name: options.name,
    include: options.include ?? ["src/*.spec.ts"],
    exclude: [...configDefaults.exclude, ...(options.exclude ?? [])],
    testTimeout: 30_000,
    browser: {
      enabled: true,
      headless: true,
      screenshotFailures: false,
      provider: playwright({
        ...(options.args && { launchOptions: { args: options.args } }),
        contextOptions: {
          reducedMotion: "reduce",
          locale: "en-US",
        },
      }),
      instances: [{ browser: "chromium" }],
      viewport: { width: 1440, height: 900 },
    },
  },
})

export default defineConfig({
  test: {
    restoreMocks: true,
    projects: [
      unit(),
      browserProject({
        name: "renderers",
        // Its specs run a terminal in a real browser: swapping the WebGL renderer, and mouse at any zoom.
        exclude: ["src/ligatures.spec.ts"],
      }),
      browserProject({
        name: "ligatures",
        // Ligatures drawn on WebGL fit their cells only where the font's advance is fractional
        // (7.8 px for 13 px JetBrains Mono, against a 7 px cell), which the headless shell hints
        // away unless told not to, as the app's windows are not.
        include: ["src/ligatures.spec.ts"],
        args: ["--font-render-hinting=none"],
      }),
    ],
  },
})
