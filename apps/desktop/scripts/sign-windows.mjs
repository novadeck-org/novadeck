// electron-builder's hook for signing one Windows file (`win.signtoolOptions.sign`), which
// the Package workflow names when a release signs: the app's executables, libraries and
// native modules, the installer and its uninstaller. It signs as the engines' build does,
// through Azure Artifact Signing with SignTool and the signing library pinned by checksum
// in engines/ggml-build/src/signtool.ts, so packaging installs no signing tool of its own
// choosing. See docs/release-signing.md.
import { signWindowsFiles, windowsSigning } from "@novadeck/ggml-build/signtool"

export const sign = async ({ path }) => {
  const signing = windowsSigning(process.env)
  // Named as the hook, the release means to sign: an unsigned file must stop it.
  if (!signing) {
    throw new Error(
      "Signing the app needs AZURE_SIGNING_ENDPOINT, AZURE_SIGNING_ACCOUNT and AZURE_SIGNING_PROFILE.",
    )
  }
  await signWindowsFiles([path], signing)
}
