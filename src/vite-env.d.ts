/// <reference types="vite/client" />

declare module "*.vert.glsl?raw" {
  const source: string;
  export default source;
}
declare module "*.frag.glsl?raw" {
  const source: string;
  export default source;
}
