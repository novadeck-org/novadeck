import { unit } from "@novadeck/build-kit/vitest"
import { playwright } from "@vitest/browser-playwright"
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    restoreMocks: true,
    projects: [
      unit(),
      {
        extends: true,
        server: { strictPort: false },
        // Its spec reads the demo's screens back through the emulator.
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
          name: "screen",
          include: ["src/screen/screen.spec.ts"],
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
      },
    ],
  },
})
