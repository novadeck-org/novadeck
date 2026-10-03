import { join, sep } from "node:path"

import { describe, expect, it } from "../test.js"
import { secret } from "./secrets.js"

const at = (...parts: string[]) => join(sep, "home", "u", ...parts)

describe("a file that may hold secrets", () => {
  it("is a key, credentials, an environment file, or anything in a folder of keys", () => {
    for (const path of [".env", ".env.local", join(".ssh", "config"), "server.pem", "id_ed25519"])
      expect(secret(at("project", path)), path).toBe(true)
    expect(secret(at(".npmrc"))).toBe(true)
    expect(secret(at(".ssh", "photo.png"))).toBe(true)
  })

  it("is an agent's or a tool's login, an environment, or a shell's history", () => {
    const logins = [
      join(".claude", ".credentials.json"),
      join(".codex", "auth.json"),
      join(".config", "gh", "hosts.yml"),
      join(".config", "gcloud", "application_default_credentials.json"),
      join(".cargo", "credentials.toml"),
      join(".gemini", "oauth_creds.json"),
      ".envrc",
      "prod.env",
      ".bash_history",
      ".zsh_history",
      ".vault-token",
      join(".terraform.d", "credentials.tfrc.json"),
      join(".local", "share", "fish", "fish_history"),
      ".yarnrc.yml",
      join(".config", "rclone", "rclone.conf"),
      ".s3cfg",
      join("AppData", "Roaming", "GitHub CLI", "hosts.yml"),
    ]
    for (const path of logins) expect(secret(at(path)), path).toBe(true)
  })

  it("is not a file a login is merely named like, elsewhere, nor code mentioning secrets", () => {
    for (const path of [
      join("src", "i18n", "en", "auth.json"),
      join("deploy", "gcloud", "README.md"),
      "secrets.ts",
    ])
      expect(secret(at("project", path)), path).toBe(false)
  })
})
