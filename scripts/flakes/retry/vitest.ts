// What every package's Vitest config is wrapped in: on CI, a failed test whose outcome the
// runner's load can decide runs again (policy.ts), and every test that passed only on a retry
// is recorded (reporter.ts). Off CI it changes nothing.
//
//   export default defineConfig(retryOnCi({ test: { ... } }))
//
// The reporter joins through a plugin, not the config's `reporters`, which the CI scripts'
// `--reporter` flags replace; and the plugin joins each project, as a project that doesn't
// extend the root config doesn't take its plugins.

import { readFileSync } from "node:fs"
import { join } from "node:path"

import type { Plugin, ViteUserConfig } from "vitest/config"

import { type Declared, platformOf } from "../../workspace/platform.js"
import { onCi, retriesFor, type Suite } from "./policy.js"
import { marker, RetryRecord } from "./reporter.js"

// A package.json that can't be read declares nothing, so its package reads as `system`.
const manifestAt = (folder: string): Declared => {
  try {
    const manifest: unknown = JSON.parse(readFileSync(join(folder, "package.json"), "utf8"))
    return typeof manifest === "object" && manifest !== null ? manifest : {}
  } catch {
    return {}
  }
}

/** Whether a project is one of those named, as Vitest names a browser instance's after it. */
const named = (project: string, names: readonly string[]): boolean =>
  names.some((name) => project === name || project.startsWith(`${name} (`))

/** The plugin that sets a project's retries and adds the record's reporter to the run once. */
export const retryPlugin = (
  suite: Suite,
  exempt: readonly string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): Plugin => ({
  name: "novadeck:retry-on-ci",
  configureVitest({ vitest, project }) {
    const ci = onCi(env)
    const wanted = named(project.name, exempt)
      ? 0
      : retriesFor({
          ci,
          suite,
          platform: platformOf(manifestAt(project.config.root)),
          browser: Boolean(project.config.browser?.enabled),
        })
    if (wanted > (typeof project.config.retry === "number" ? project.config.retry : 0))
      project.config.retry = wanted
    if (!ci) return
    // A resolved config's reporters are instances or [name, options] pairs; an instance joins
    // as it is, before Vitest builds the run's reporters.
    const reporters = vitest.config.reporters as unknown[]
    if (
      !reporters.some(
        (reporter) => typeof reporter === "object" && reporter !== null && marker in reporter,
      )
    )
      reporters.push(new RetryRecord())
  },
})

type Project = NonNullable<NonNullable<ViteUserConfig["test"]>["projects"]>[number]

const withPlugin = (project: Project, plugin: Plugin): Project => {
  // A project given by a path or a function would run without retries or their record.
  if (typeof project !== "object" || project === null || project instanceof Promise)
    throw new Error("retryOnCi takes a config's projects written inline.")
  // A project that extends the root config takes the root's plugins, this one among them.
  if (project.extends === true) return project
  return { ...project, plugins: [...(project.plugins ?? []), plugin] }
}

/**
 * A package's Vitest config with CI's retries and their record (see above). `exempt` names
 * projects that never retry, as a benchmark whose run is its measure.
 */
export const retryOnCi = (
  config: ViteUserConfig,
  {
    suite = "tests",
    exempt = [],
  }: { readonly suite?: Suite; readonly exempt?: readonly string[] } = {},
): ViteUserConfig => {
  const plugin = retryPlugin(suite, exempt)
  const projects = config.test?.projects
  return {
    ...config,
    plugins: [...(config.plugins ?? []), plugin],
    ...(projects && config.test
      ? { test: { ...config.test, projects: projects.map((each) => withPlugin(each, plugin)) } }
      : {}),
  }
}
