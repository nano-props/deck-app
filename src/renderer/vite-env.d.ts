/// <reference types="vite/client" />

// Side-effect-only CSS imports (e.g. `import './styles.css'`).
declare module '*.css' {
  const _: void
  export default _
}
