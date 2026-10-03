// Modules wrangler bundles from files (wrangler.jsonc's rules): fonts as bytes, WebAssembly compiled.
declare module "*.ttf" {
  const bytes: ArrayBuffer;
  export default bytes;
}
declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
