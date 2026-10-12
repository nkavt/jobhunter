import { readFile, stat } from 'node:fs/promises';
import { hostname, uptime } from 'node:os';
import { basename, dirname, join } from 'node:path';

/** A spreadsheet app has the file open: it left a lock file next to it. */
export interface OpenLock {
  app: string;
  /** Who opened it, when the lock file says ("Alex on alex-laptop"). */
  by?: string;
  lockFile: string;
  /** Left behind by a crash: written by this computer before it last started. */
  stale: boolean;
}

/**
 * Looks for the lock files spreadsheet apps keep next to an open file: LibreOffice and
 * Collabora write `.~lock.<name>#`; Excel writes `~$<name>`, which it shortens
 * to `~$` + the name without its first two letters for longer names.
 * Only shows the file is open on this computer (or another one sharing the folder), never
 * on a device it's synced to.
 */
export async function findOpenLock(path: string): Promise<OpenLock | undefined> {
  const dir = dirname(path);
  const name = basename(path);
  const candidates = [
    { file: join(dir, `.~lock.${name}#`), app: 'LibreOffice' },
    { file: join(dir, `~$${name}`), app: 'Excel' },
    ...(name.length > 2 ? [{ file: join(dir, `~$${name.slice(2)}`), app: 'Excel' }] : []),
  ];
  for (const candidate of candidates) {
    const info = await stat(candidate.file).catch(() => undefined);
    if (!info?.isFile()) continue;
    const content = await readFile(candidate.file).catch(() => Buffer.alloc(0));
    const owner = candidate.app === 'LibreOffice' ? libreOfficeOwner(content) : excelOwner(content);
    const bootedAt = Date.now() - uptime() * 1000;
    const thisComputer = !owner.host || owner.host === hostname();
    return {
      app: candidate.app,
      ...(owner.user
        ? { by: owner.host && !thisComputer ? `${owner.user} on ${owner.host}` : owner.user }
        : {}),
      lockFile: candidate.file,
      stale: thisComputer && info.mtimeMs < bootedAt,
    };
  }
  return undefined;
}

/** `Alex Example,alex-laptop,alex,12.10.2026 14:03,file:///…;` */
function libreOfficeOwner(content: Buffer): { user?: string; host?: string } {
  const [display = '', host = '', user = ''] = content.toString('utf8').split(',');
  const who = display.trim() || user.trim();
  return { ...(who ? { user: who } : {}), ...(host.trim() ? { host: host.trim() } : {}) };
}

/** Excel's owner file starts with the user name's length, then the name. */
function excelOwner(content: Buffer): { user?: string; host?: string } {
  const length = content[0] ?? 0;
  if (length < 1 || length > 53 || content.length < length + 1) return {};
  const user = content.toString('latin1', 1, 1 + length).trim();
  return /^[\p{L}\p{N} ._'-]+$/u.test(user) ? { user } : {};
}

export function describeLock(path: string, lock: OpenLock): string {
  const by = lock.by ? ` by ${lock.by}` : '';
  return `${basename(path)} is open in ${lock.app}${by}. Close it so Jobhunter can add the new jobs.`;
}
