import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { anthropic } from "../model/anthropic.js"
import type { AgentSetup } from "./agent.js"

/**
 * Claude Code against the fake model: its own config folder in the sandbox, seeded past
 * onboarding, the theme picker, folder trust and the custom API key's approval, with
 * NovaDeck's MCP tools allowed so a `send` asks nothing.
 */
export const claude: AgentSetup = {
  agent: "claude",
  name: "Claude Code",
  dialect: anthropic,
  // The name its first screen's header gives, beside its version.
  banner: "Claude Code",
  bindsAtReady: true,
  refused: [],
  watch: {
    searched: [
      ".claude/settings.json",
      ".claude/plugins/installed_plugins.json",
      ".claude/plugins/known_marketplaces.json",
    ],
    // Its projects, each named after its path with every other character a dash, which
    // keeps the sandbox's name whole: that holds only letters, digits and dashes.
    listed: [".claude/projects"],
    stamped: [],
  },
  hosts: ["api.anthropic.com", "claude.ai", "console.anthropic.com", "statsig.anthropic.com"],
  prepare: async (sandbox, model, installed) => {
    const config = join(sandbox.home, ".claude")
    await mkdir(config, { recursive: true, mode: 0o700 })
    // With CLAUDE_CONFIG_DIR set, Claude Code keeps its global state in the folder too.
    await writeFile(
      join(config, ".claude.json"),
      JSON.stringify({
        hasCompletedOnboarding: true,
        lastOnboardingVersion: installed.version,
        lastReleaseNotesSeen: installed.version,
        theme: "dark",
        autoUpdates: false,
        officialMarketplaceAutoInstall: false,
        // It asks once about a key from the environment, by the key's last 20 characters.
        customApiKeyResponses: { approved: [model.credential.slice(-20)], rejected: [] },
        projects: {
          [sandbox.project]: {
            hasTrustDialogAccepted: true,
            hasCompletedProjectOnboarding: true,
            projectOnboardingSeenCount: 1,
            allowedTools: [],
          },
        },
      }),
    )
    await writeFile(
      join(config, "settings.json"),
      JSON.stringify({ permissions: { allow: ["mcp__plugin_novadeck_novadeck"] } }),
    )
    return {
      CLAUDE_CONFIG_DIR: config,
      ANTHROPIC_BASE_URL: model.url,
      ANTHROPIC_API_KEY: model.credential,
      DISABLE_AUTOUPDATER: "1",
      DISABLE_UPDATES: "1",
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "1",
      CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "1",
    }
  },
}
