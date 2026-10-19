// The folder under the platform's app data folder where a launch keeps its data: the
// workspace database, the shell files agents run, the appearance and Chromium's own.
// Named alike on every platform, and apart from the product's name, "Novadeck", which
// Electron would use: a change of branding then never moves anyone's data. A
// development launch keeps its own, so it never rewrites an installed Novadeck's agent
// launchers or opens its database.
export const dataFolderName = ({ packaged }: { readonly packaged: boolean }): string =>
  packaged ? "novadeck" : "novadeck-dev"
