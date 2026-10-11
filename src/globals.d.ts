/** Injected at build time from package.json (see tsup.config.ts / vitest.config.ts). */
declare const __VERSION__: string;

/** Prompt files in src/prompts are bundled as plain strings (see tsup.config.ts / vitest.config.ts). */
declare module '*.md' {
  const content: string;
  export default content;
}
