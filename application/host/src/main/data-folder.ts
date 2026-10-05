// The folder under the platform's app data folder where a launch keeps its data: the
// workspace database, the shell files agents run, the appearance and Chromium's own.
// Named alike on every platform: Electron would name it after the product, "novadeck.",
// whose trailing dot Windows drops from folder names, or keeps under some paths. A
// development launch keeps its own, so it never rewrites an installed NovaDeck's agent
// launchers or opens its database.
export const dataFolderName = ({ packaged }: { readonly packaged: boolean }): string =>
  packaged ? "NovaDeck" : "NovaDeck-dev"
