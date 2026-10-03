import { basename, sep } from "node:path"

// Files that often hold secrets: a key, credentials, an environment file, an agent's or a
// tool's login, a shell's history. NovaDeck shows them, as any file the person can
// read, but never puts one on screen by itself, as while the person shares it.
const secretFolders = new Set([".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker"])
const secretNames = [
  /^\.env(\..*)?$/i,
  /\.env$/i,
  /^\.envrc$/i,
  /^\.?credentials(\.[\w.]+)?$/i,
  /^oauth_creds\.json$/i,
  /^\.yarnrc\.yml$/i,
  /^\.s3cfg$/i,
  /^rclone\.conf$/i,
  /^fish_history$/i,
  /^\.vault-token$/i,
  /^\.dockercfg$/i,
  /^kubeconfig$/i,
  /^\.[\w-]*_history$/i,
  /^\.netrc$/i,
  /^\.git-credentials$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^\.pgpass$/i,
  /^secrets?\.(json|ya?ml|toml|ini|env|txt|properties)$/i,
  /^service-account.*\.json$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(_[^.]*)?$/i,
  /\.(pem|key|p12|pfx|keystore|jks|tfstate)$/i,
]
// Where tools keep their logins under names too plain to hold everywhere: the GitHub
// CLI's hosts.yml (in "GitHub CLI" on Windows), Codex's auth.json, and gcloud's folder.
const secretPaths = [
  /[\\/](gh|GitHub CLI)[\\/]hosts\.ya?ml$/i,
  /[\\/]\.codex[\\/]auth\.json$/i,
  /[\\/](\.config|AppData[\\/]Roaming)[\\/]gcloud[\\/]/i,
]

/** Whether a file, by its resolved path, may hold secrets: it opens only when the person picks it. */
export const secret = (path: string): boolean =>
  path.split(sep).some((part) => secretFolders.has(part)) ||
  secretNames.some((name) => name.test(basename(path))) ||
  secretPaths.some((pattern) => pattern.test(path))
