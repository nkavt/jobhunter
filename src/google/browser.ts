import { spawn } from 'node:child_process';

/** Open a URL in the default browser. Best effort: callers always print the URL too. */
export function openInBrowser(url: string): void {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // No browser available (e.g. over SSH); the printed URL is the fallback.
  }
}
