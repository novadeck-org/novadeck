import { playwright } from "@vitest/browser-playwright"
import { mergeConfig } from "vite"
import { defineConfig } from "vitest/config"

import viteConfig from "./vite.config"

// On CI a failed behaviour spec leaves a screenshot in .vitest/attachments/, which the
// workflow uploads. Tracing slows every spec, so it records only when asked for, as a
// CI re-run with debug logging does; a failed spec's trace then joins its screenshot.
const ci = Boolean(process.env.CI)
const trace = Boolean(process.env.NOVADECK_UI_TRACE)

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
            // A file's first render or terminal open in jsdom is CPU-bound cold-start work:
            // on Windows CI it has taken 1.5-5.8s (WorkspaceOverlays, WorkspaceTerminal,
            // queries), against a fraction of that on Linux and macOS.
            testTimeout: 20_000,
            include: ["src/**/*.test.ts"],
            exclude: ["src/specs/**"],
          },
        },
        {
          extends: true,
          // Let concurrent runs pick free ports; the app dev server keeps its strict one.
          server: { strictPort: false },
          test: {
            name: "behaviour",
            include: ["src/specs/**/*.spec.tsx"],
            exclude: ["src/specs/motion.spec.tsx"],
            setupFiles: ["./src/specs/setup.ts"],
            // Whole-app renders under CI load can take longer than the 1s default.
            expect: { poll: { timeout: 5000 } },
            // A file's first spec opens the whole app cold: the first view switch and drag also
            // load and compile their code. In a full run on a loaded machine that first spec has
            // taken 13-18s (the Canvas one takes about 3s alone), against the 15s default. 30s
            // keeps about 1.7x headroom over the slowest seen. A failing element assertion or
            // action waits out what is left of it, so a failure now takes up to 30s to report.
            testTimeout: 30_000,
            browser: {
              enabled: true,
              headless: true,
              screenshotFailures: ci,
              ...(trace
                ? { trace: { mode: "retain-on-failure", tracesDir: "test-results/traces" } }
                : {}),
              // English dates, as the specs expect, whatever the machine's locale.
              provider: playwright({
                contextOptions: { reducedMotion: "reduce", locale: "en-US" },
              }),
              instances: [{ browser: "chromium" }],
              viewport: { width: 1440, height: 900 },
            },
          },
        },
        {
          extends: true,
          server: { strictPort: false },
          test: {
            name: "motion",
            include: ["src/specs/motion.spec.tsx"],
            setupFiles: ["./src/specs/setup.ts"],
            expect: { poll: { timeout: 5000 } },
            // Its first spec opens the app cold too, as the behaviour project's comment says.
            testTimeout: 30_000,
            browser: {
              enabled: true,
              headless: true,
              screenshotFailures: false,
              provider: playwright({
                contextOptions: { reducedMotion: "no-preference", locale: "en-US" },
              }),
              instances: [{ browser: "chromium" }],
              viewport: { width: 1440, height: 900 },
            },
          },
        },
      ],
    },
  }),
)
