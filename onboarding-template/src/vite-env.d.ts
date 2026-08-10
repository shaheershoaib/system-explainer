/// <reference types="vite/client" />

// CSS / asset side-effect imports (TS 6 requires explicit ambient declarations).
declare module '*.css';
declare module '*.svg' {
  const src: string
  export default src
}
