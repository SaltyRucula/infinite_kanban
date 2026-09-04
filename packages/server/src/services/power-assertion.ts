import { spawn, type ChildProcess } from 'node:child_process';

/**
 * Holds a macOS `caffeinate -i` power assertion while at least one agent
 * session is active, so system idle sleep does not suspend the board
 * mid-task. Released automatically once no sessions remain. This does NOT
 * override lid-closed sleep, which macOS enforces regardless of any
 * software assertion outside of clamshell mode (external display + power).
 */
export class PowerAssertion {
  private child: ChildProcess | null = null;

  private readonly spawnCaffeinate: () => ChildProcess;

  constructor(spawnCaffeinate: () => ChildProcess = () => spawn('caffeinate', ['-i', '-m'], { stdio: 'ignore' })) {
    this.spawnCaffeinate = spawnCaffeinate;
  }

  sync(activeSessionCount: number): void {
    if (activeSessionCount > 0 && !this.child) {
      try {
        this.child = this.spawnCaffeinate();
        this.child.once('exit', () => {
          this.child = null;
        });
        this.child.unref();
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
