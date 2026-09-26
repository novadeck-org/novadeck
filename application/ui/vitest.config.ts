import { playwright } from "@vitest/browser-playwright"
import { mergeConfig } from "vite"
import { defineConfig } from "vitest/config"

import viteConfig from "./vite.config"

// The CSP plugin guards the app's index.html; the browser runner serves its own tester page.
const plugins = viteConfig.plugins?.filter(
  (plugin) => !(plugin && "name" in plugin && plugin.name === "novadeck-content-security-policy"),
)

export default mergeConfig(
  { ...viteConfig, plugins },
  defineConfig({
    test: {
      restoreMocks: true,
      projects: [
        {
          extends: true,
          test: {
            name: "unit",
            environment: "jsdom",
            include: ["src/**/*.spec.ts"],
            exclude: ["src/specs/**"],
            setupFiles: ["./src/test/setup.ts"],
          },
        },
        {
          extends: true,
          // Let concurrent runs pick free ports; the app dev server keeps its strict one.
          server: { strictPort: false },
          test: {
            name: "behaviour",
            include: ["src/specs/**/*.spec.tsx"],
            setupFiles: ["./src/specs/setup.ts"],
            // Whole-app renders under CI load can take longer than the 1s default.
            expect: { poll: { timeout: 5000 } },
            browser: {
              enabled: true,
              headless: true,
              screenshotFailures: false,
              provider: playwright({ contextOptions: { reducedMotion: "reduce" } }),
              instances: [{ browser: "chromium" }],
              viewport: { width: 1440, height: 900 },
            },
          },
        },
      ],
    },
  }),
)
