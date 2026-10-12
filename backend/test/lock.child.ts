/**
 * One contestant in lock.test.ts's race. QUIETPURSE_HOME and DATABASE_URL arrive in the
 * environment from the parent, and config reads them once at load, so this file
 * imports the module under test and nothing else from src.
 *
 * It prints `ready` on stdout, and the first byte on stdin is the barrier: every child
 * claims at the same instant rather than whenever its imports finished. Then it prints
 * one JSON line with the outcome. A winner holds until stdin ends, because a winner
 * that exited at once would leave a dead pid for the next child to take over
 * legitimately, and two winners would then be the correct answer. A stdin that ends
 * before the claim settles means the parent is gone, so the child goes with it.
 */
import { acquireLock, releaseLock } from '../src/lock';

let ended = false;
let holding = false;
let started = false;

const stop = (): void => {
  void releaseLock().then(() => process.exit(0));
};

process.stdin.setEncoding('utf8');
process.stdin.on('end', () => {
  ended = true;
  if (holding) stop();
});
process.stdin.on('data', () => {
  if (started) return;
  started = true;
  acquireLock().then(
    () => {
      holding = true;
      process.stdout.write(`${JSON.stringify({ won: true, pid: process.pid })}\n`);
      if (ended) stop();
    },
    (e: Error) => {
      process.stdout.write(
        `${JSON.stringify({ won: false, pid: process.pid, message: e.message })}\n`,
      );
      process.exit(0);
    },
  );
});
process.stdout.write('ready\n');
