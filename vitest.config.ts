import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

const pkg = JSON.parse(readFileSync('./package.json', 'utf8')) as { version: string };

export default defineConfig({
  define: { __VERSION__: JSON.stringify(pkg.version) },
  plugins: [
    {
      // Same as tsup's `.md: 'text'` loader: prompt files import as plain strings.
      name: 'markdown-as-text',
      transform(code, id) {
        return id.endsWith('.md')
          ? { code: `export default ${JSON.stringify(code)};`, map: null }
          : null;
      },
    },
  ],
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/cli.ts'],
    },
  },
});
