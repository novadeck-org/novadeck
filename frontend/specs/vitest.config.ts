import { resolve } from "node:path"

import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { playwright } from "@vitest/browser-playwright"
import { defineConfig } from "vitest/config"

// On CI a failed behaviour spec leaves a screenshot in .vitest/attachments/, which the
// workflow uploads. Tracing slows every spec, so it records only when asked for, as a
// CI re-run with debug logging does; a failed spec's trace then joins its screenshot.
const ci = Boolean(process.env.CI)
const trace = Boolean(process.env.NOVADECK_UI_TRACE)

// The dependencies a browser project loads only once its views or terminals open, optimized
// before it starts, as a reload partway through fails the specs it reaches.
const optimizedUpFront = [
  "@ark-ui/react/select",
  "@ark-ui/react/tabs",
  "@novadeck/protocol > @orpc/contract",
  "@novadeck/protocol > zod",
  "@novadeck/emulator > @xterm/addon-fit",
  "@novadeck/emulator > @xterm/addon-unicode-graphemes",
  "@novadeck/emulator > @xterm/addon-web-links",
  "@novadeck/emulator > @xterm/addon-webgl",
  "@novadeck/emulator > @xterm/xterm",
  "@novadeck/wire > @orpc/client",
  "@novadeck/wire > @orpc/client/standard",
  "@novadeck/wire > @orpc/standard-server-peer",
  "@xyflow/react",
  "react-grid-layout",
]

export default defineConfig({
  // The specs render the whole app with its stylesheet, so they build it as the apps do.
  plugins: [tailwindcss(), react()],
  // The UI's public files are the page's: the voice worklet is loaded from the document's base.
  publicDir: resolve(import.meta.dirname, "../ui/public"),
  test: {
    restoreMocks: true,
    projects: [
      {
        extends: true,
        test: {
          name: "integration",
          // The tests that render the whole workspace over the spec backend, in jsdom as the
          // unit project runs them, with the same budget for a cold first render.
          environment: "jsdom",
          testTimeout: 20_000,
          include: ["src/**/*.test.ts"],
        },
      },
      {
        extends: true,
        // Let concurrent runs pick free ports; the app dev server keeps its strict one.
        server: { strictPort: false },
        // Nearly every spec opens the demo's terminals, the emulator among them.
        optimizeDeps: { include: optimizedUpFront },
        test: {
          name: "behaviour",
          include: ["src/**/*.spec.tsx"],
          exclude: ["src/workspace/motion.spec.tsx", "src/counters/**"],
          setupFiles: ["./src/setup.ts"],
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
            commands: {
              // Native held-pointer gestures let specs inspect a drag before release.
              pinPointer: async (
                { page, frame },
                action: "press" | "move" | "release",
                point?: { x: number; y: number },
              ) => {
                if (action === "release") return page.mouse.up()
                const bounds = await (
                  await frame()
                )
                  .frameElement()
                  .then((element) => element.boundingBox())
                if (!bounds || !point) throw new Error("Missing drag point or test frame")
                await page.mouse.move(bounds.x + point.x, bounds.y + point.y, {
                  steps: action === "move" ? 16 : 1,
                })
                if (action === "press") await page.mouse.down()
              },
            },
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
        // The counter run fails the build on its counts, so it must not meet a reload when
        // Vite finds a dependency to optimize partway through: they are optimized up front.
        optimizeDeps: { include: optimizedUpFront },
        test: {
          name: "counters",
          include: ["src/counters/**/*.spec.tsx"],
          setupFiles: ["./src/setup.ts"],
          // The warm-up loads the views' code in real time, cold and under load in a full run.
          expect: { poll: { timeout: 30_000 } },
          // One long run: 13 terminals through three phases, a real frame per scripted step.
          testTimeout: 180_000,
          browser: {
            enabled: true,
            headless: true,
            screenshotFailures: false,
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
        // Its specs open the demo's terminals, the emulator among them, as the behaviour specs do.
        optimizeDeps: { include: optimizedUpFront },
        test: {
          name: "motion",
          include: ["src/workspace/motion.spec.tsx"],
          setupFiles: ["./src/setup.ts"],
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
})
