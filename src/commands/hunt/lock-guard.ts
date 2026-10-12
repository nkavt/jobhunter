import { stat } from 'node:fs/promises';
import { describeLock, findOpenLock, type OpenLock } from '../../tracker/index.js';
import { CancelledError, dim, type Ui } from '../../ui/index.js';
import { HuntSetupError } from './errors.js';

export interface LockGuardDeps {
  ui: Ui;
  /** Finds a spreadsheet app's lock on the local tracking sheet. */
  findLock?: (path: string) => Promise<OpenLock | undefined>;
  /** Whether the user can answer prompts; without a terminal, a run never waits. */
  interactive?: boolean;
}

/**
 * Keeps Jobhunter from writing to a local sheet while a spreadsheet app has it open: the app
 * would overwrite the new rows the next time the user saves (or, on Windows, block the write).
 */
export class LockGuard {
  /** A lock the user said is left over; ignored as long as it doesn't change. */
  private ignored?: string;
  /** The user chose to keep this run's jobs for later; don't ask again. */
  private deferred = false;
  private readonly findLock: (path: string) => Promise<OpenLock | undefined>;
  private readonly interactive: boolean;

  constructor(
    private readonly deps: LockGuardDeps,
    private readonly path: string,
  ) {
    this.findLock = deps.findLock ?? findOpenLock;
    this.interactive = deps.interactive ?? (process.stdin.isTTY && process.stdout.isTTY);
  }

  /** Before fetching: wait for the user to close the file, or stop. */
  async beforeStart(): Promise<void> {
    for (;;) {
      const lock = await this.currentLock();
      if (!lock) return;
      const message = describeLock(this.path, lock);
      if (!this.interactive) throw new HuntSetupError(message);
      this.deps.ui.warn(message);
      if (lock.stale) this.deps.ui.info(dim(staleHint(lock)));
      const choice = await this.deps.ui.select<'retry' | 'ignore' | 'cancel'>({
        message: 'What would you like to do?',
        choices: [
          { name: "It's closed now, continue", value: 'retry' },
          { name: "Continue anyway: it isn't open", value: 'ignore' },
          { name: 'Cancel', value: 'cancel' },
        ],
        default: lock.stale ? 'ignore' : 'retry',
      });
      if (choice === 'cancel') throw new CancelledError();
      if (choice === 'ignore') this.ignored = await lockId(lock);
    }
  }

  /** Before each write. `false` = keep the rows for the next run instead. */
  async readyToWrite(): Promise<boolean> {
    if (this.deferred) return false;
    for (;;) {
      const lock = await this.currentLock();
      if (!lock) return true;
      if (!this.interactive) {
        this.deferred = true;
        return false;
      }
      this.deps.ui.warn(describeLock(this.path, lock));
      const choice = await this.deps.ui.select<'retry' | 'later' | 'ignore'>({
        message: 'What would you like to do?',
        choices: [
          { name: "It's closed now, add the jobs", value: 'retry' },
          { name: 'Keep the jobs and add them on the next run', value: 'later' },
          { name: "Add them anyway: it isn't open", value: 'ignore' },
        ],
        default: 'retry',
      });
      if (choice === 'later') {
        this.deferred = true;
        return false;
      }
      if (choice === 'ignore') this.ignored = await lockId(lock);
    }
  }

  private async currentLock(): Promise<OpenLock | undefined> {
    const lock = await this.findLock(this.path);
    if (!lock) return undefined;
    return this.ignored !== undefined && this.ignored === (await lockId(lock)) ? undefined : lock;
  }
}

const staleHint = (lock: OpenLock) =>
  `${lock.lockFile} is from before your computer last started, so it's probably left over from a crash.`;

/** Same file and modification time = the same lock. */
async function lockId(lock: OpenLock): Promise<string> {
  const info = await stat(lock.lockFile).catch(() => undefined);
  return `${lock.lockFile}:${String(info?.mtimeMs ?? 0)}`;
}
