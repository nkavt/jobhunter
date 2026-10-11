import { homedir } from 'node:os';
import { resolve } from 'node:path';

/**
 * Turn what the user typed or dragged into the terminal into an absolute path:
 * trims, strips surrounding quotes, unescapes `\ `, expands `~`.
 */
export function resolveUserPath(input: string, cwd = process.cwd()): string {
  let path = input.trim();
  if (/^(['"]).*\1$/.test(path)) path = path.slice(1, -1);
  path = path.replace(/\\ /g, ' ');
  if (path === '~' || path.startsWith('~/')) path = homedir() + path.slice(1);
  return resolve(cwd, path);
}
