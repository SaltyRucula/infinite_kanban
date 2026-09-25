import { spawn, type ChildProcess } from 'node:child_process';

/**
 * Holds a macOS `caffeinate -i` power assertion while at least one agent
 * session is active, so system idle sleep does not suspend the board
 * mid-task. Released automatically once no sessions remain. This does NOT
 * override lid-closed sleep, which macOS enforces regardless of any
 * software assertion outside of clamshell mode (external display + power).
 * On other platforms there is no `caffeinate`, so by default nothing is held.
 */
export class PowerAssertion {
  private child: ChildProcess | null = null;

  private readonly spawnCaffeinate: (() => ChildProcess) | null;

  constructor(
    spawnCaffeinate?: () => ChildProcess,
    platform: NodeJS.Platform = process.platform,
  ) {
    this.spawnCaffeinate = spawnCaffeinate
      ?? (platform === 'darwin' ? () => spawn('caffeinate', ['-i', '-m'], { stdio: 'ignore' }) : null);
  }

  sync(activeSessionCount: number): void {
    if (activeSessionCount > 0 && !this.child) {
      if (!this.spawnCaffeinate) return;
      try {
        const child = this.spawnCaffeinate();
        this.child = child;
        child.once('exit', () => {
          if (this.child === child) this.child = null;
        });
        // spawn() reports failures such as ENOENT asynchronously; an unhandled
        // 'error' event would crash the process.
        child.on('error', (err) => {
          if (this.child === child) this.child = null;
          console.warn('[power-assertion] caffeinate failed:', err.message);
        });
        child.unref();
      } catch (err) {
        console.warn('[power-assertion] failed to start caffeinate:', err instanceof Error ? err.message : String(err));
      }
      return;
    }
    if (activeSessionCount === 0 && this.child) {
      this.child.kill();
      this.child = null;
    }
  }

  isHeld(): boolean {
    return this.child !== null;
  }
}
