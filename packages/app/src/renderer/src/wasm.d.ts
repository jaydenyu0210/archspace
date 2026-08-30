/**
 * Ambient module for the web-ifc wasm binary, served as a `data:` URI by the
 * `archspace:web-ifc-wasm-data-uri` plugin in electron.vite.config.ts — the
 * full why (file:// fetch, rejected `?inline` route) lives on that plugin.
 *
 * Declared here rather than via `vite/client` types because the renderer
 * imports exactly one non-code asset; a global declaration surface for every
 * Vite suffix would suggest a habit the codebase does not have.
 */
declare module 'virtual:web-ifc-wasm' {
  /** The binary as a `data:application/wasm;base64,` URI. */
  const dataUri: string;
  export default dataUri;
}
