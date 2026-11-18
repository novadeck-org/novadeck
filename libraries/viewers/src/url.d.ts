// Files a bundler serves beside the page, imported as their address.
declare module "*?url" {
  const url: string
  export default url
}
