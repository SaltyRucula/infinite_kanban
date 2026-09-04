import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PowerAssertion } from '../src/services/power-assertion.js';

class FakeChild extends EventEmitter {
  killed = false;
  kill(): void {
    this.killed = true;
    this.emit('exit');
  }
  unref(): void {}
}

test('PowerAssertion spawns caffeinate only while sessions are active and releases at zero', () => {
  const spawned: FakeChild[] = [];
  const assertion = new PowerAssertion(() => {
    const child = new FakeChild();
    spawned.push(child);
    return child as unknown as import('node:child_process').ChildProcess;
  });

  assert.equal(assertion.isHeld(), false);

  assertion.sync(1);
  assert.equal(assertion.isHeld(), true);
  assert.equal(spawned.length, 1);

  // Given a second session starts while the first assertion is already held,
  // no additional caffeinate process should be spawned.
  assertion.sync(2);
  assert.equal(spawned.length, 1);

  assertion.sync(0);
  assert.equal(assertion.isHeld(), false);
  assert.equal(spawned[0]?.killed, true);
});

test('PowerAssertion re-acquires after the held process exits unexpectedly', () => {
  const spawned: FakeChild[] = [];
  const assertion = new PowerAssertion(() => {
    const child = new FakeChild();
    spawned.push(child);
    return child as unknown as import('node:child_process').ChildProcess;
  });

  assertion.sync(1);
  spawned[0]?.emit('exit');
  assert.equal(assertion.isHeld(), false);

  assertion.sync(1);
  assert.equal(assertion.isHeld(), true);
  assert.equal(spawned.length, 2);
});
