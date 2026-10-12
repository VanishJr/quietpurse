/**
 * The one-process-per-folder lock, off the process that boots the
 * app so a case can red it: what is claimed, what a file already there means, what is
 * removed and by whom. The takeover's reasoning is in backend/src/SPEC.md; a reason that
 * belongs to one line is beside that line in lock.ts.
 *
 * Every case points config.home at a folder of its own under the suite's per-run home
 * and restores it, and asserts the file at its own literal of the path, never through
 * the module: a path computed when the module loads would pass a case that used the
 * suite's home and fail the first one that set its own. DATABASE_URL is pinned
 * undefined for the same span, because test/setup.ts does not set it and a
 * developer's backend/.env can.
 *
 * The race runs real child processes on the same folder, released together by the
 * first data on each stdin (lock.child.ts). The winner holds until told to stop: a
 * winner that exited would leave a dead pid for the next child to take over by design.
 * The children are stopped by their recorded pids and each one is re-observed gone.
 *
 * The module's waits are raced here. "a claim whose write has not landed"
 * races the empty-file wait (EMPTY_WAIT_STEPS × EMPTY_WAIT_MS) and "a takeover another
 * start is inside" the wait on a held marker (MARKER_WAIT_STEPS × MARKER_WAIT_MS); the
 * delays injected sit well inside those bounds rather than beside them. A marker nobody
 * releases is never removed by a start that did not make it, so the cases that seed
 * one wait the whole bound out on both attempts and take as long as that is. A dead pid is
 * a process observed alive and then observed exited, asserted dead again immediately
 * before it is written: on Linux the number is not reissued within the case, on Windows
 * it can be, to the very next spawn.
 *
 * Not held: the second refusal of the two-attempt claim ("took it while this one was
 * starting") reached when the second attempt also finds a file, and that file then
 * vanishes or names a dead pid. A start that loses to a live claim reads the first
 * refusal, which the races with a winner assert of every loser; the second is held
 * through the other way it is reached, a marker nobody is inside.
 */
import { ChildProcess, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { acquireLock, pidAlive, releaseLock } from '../src/lock';

const BACKEND = path.join(__dirname, '..');
const SUITE_HOME = config.home;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const exists = (p: string): Promise<boolean> =>
  fs
    .access(p)
    .then(() => true)
    .catch(() => false);

async function inHome<T>(
  name: string,
  run: (home: string, lockFile: string) => Promise<T>,
): Promise<T> {
  const home = path.join(SUITE_HOME, 'lock', name);
  const before = { home: config.home, databaseUrl: config.databaseUrl };
  await fs.rm(home, { recursive: true, force: true });
  config.home = home;
  config.databaseUrl = undefined;
  try {
    return await run(home, path.join(home, 'quietpurse.lock'));
  } finally {
    config.home = before.home;
    config.databaseUrl = before.databaseUrl;
    await fs.rm(home, { recursive: true, force: true });
  }
}

const seed = async (lockFile: string, content: string): Promise<void> => {
  await fs.mkdir(path.dirname(lockFile), { recursive: true });
  await fs.writeFile(lockFile, content);
};

/** A pid whose process was alive and has exited, never a number guessed to be unused. */
const deadPid = (): number => {
  const pid = spawnSync(process.execPath, ['-e', '']).pid;
  expect(pidAlive(pid), `pid ${pid} was handed out again before the case could seed it`).toBe(
    false,
  );
  return pid;
};

const refusalNaming = (pid: number, home: string): RegExp =>
  new RegExp(`^another Quietpurse \\(pid ${pid}\\) is already running on ${home.replace(/[.\\]/g, '\\$&')}\\.`);

interface Outcome {
  won: boolean;
  pid: number;
  message?: string;
}

interface Contestant {
  proc: ChildProcess;
  pid: number;
  ready: Promise<void>;
  answer: Promise<Outcome>;
  exited: Promise<void>;
}

const contestant = (home: string): Contestant => {
  const proc = spawn(process.execPath, ['--import', 'tsx', 'test/lock.child.ts'], {
    cwd: BACKEND,
    env: { ...process.env, QUIETPURSE_HOME: home, DATABASE_URL: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  let buffered = '';
  let answered = false;
  let readyResolve: () => void = () => {};
  let readyReject: (e: Error) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const exited = new Promise<void>((resolve) => proc.on('exit', () => resolve()));
  const answer = new Promise<Outcome>((resolve, reject) => {
    proc.stderr!.setEncoding('utf8');
    proc.stderr!.on('data', (chunk: string) => (stderr += chunk));
    proc.stdout!.setEncoding('utf8');
    proc.stdout!.on('data', (chunk: string) => {
      buffered += chunk;
      let nl = buffered.indexOf('\n');
      while (nl >= 0) {
        const line = buffered.slice(0, nl);
        buffered = buffered.slice(nl + 1);
        if (line === 'ready') readyResolve();
        else {
          answered = true;
          resolve(JSON.parse(line) as Outcome);
        }
        nl = buffered.indexOf('\n');
      }
    });
    // a child that dies before answering fails the case now, with its stderr, rather
    // than as a timeout with nothing said. On close and not exit: at exit the child's
    // stdout may still hold its answer line
    proc.on('close', (code, signal) => {
      if (answered) return;
      const e = new Error(
        `child ${proc.pid} exited (${code ?? signal}) before answering:\n${stderr}`,
      );
      readyReject(e);
      reject(e);
    });
  });
  answer.catch(() => undefined);
  ready.catch(() => undefined);
  proc.stdin!.on('error', () => undefined);
  return { proc, pid: proc.pid!, ready, answer, exited };
};

/** Ends every child by its recorded pid and re-observes it gone. */
async function stopAll(children: Contestant[]): Promise<void> {
  for (const c of children) c.proc.stdin!.end();
  for (const c of children) {
    let done = false;
    await Promise.race([c.exited.then(() => (done = true)), sleep(5_000)]);
    if (!done) {
      c.proc.kill('SIGKILL');
      await c.exited;
    }
  }
  for (const c of children) expect(pidAlive(c.pid), `child ${c.pid} is still alive`).toBe(false);
}

/** N children released on one instant; the caller stops them once it has read the folder. */
async function race(home: string, n: number): Promise<{ outcomes: Outcome[]; stop: () => Promise<void> }> {
  const children = Array.from({ length: n }, () => contestant(home));
  const stop = () => stopAll(children);
  try {
    await Promise.all(children.map((c) => c.ready));
    for (const c of children) c.proc.stdin!.write('go');
    const outcomes = await Promise.all(children.map((c) => c.answer));
    return { outcomes, stop };
  } catch (e) {
    await stop();
    throw e;
  }
}

const assertOneWinner = async (outcomes: Outcome[], home: string, lockFile: string): Promise<void> => {
  const winners = outcomes.filter((o) => o.won).map((o) => o.pid);
  expect(winners, JSON.stringify(outcomes)).toHaveLength(1);
  for (const loser of outcomes.filter((o) => !o.won)) {
    expect(loser.message).toMatch(refusalNaming(winners[0], home));
  }
  expect(await fs.readFile(lockFile, 'utf8')).toBe(String(winners[0]));
};

describe('two starts on one folder', () => {
  it('lets exactly one of five simultaneous starts claim a clean folder', async () => {
    await inHome('race-clean', async (home, lockFile) => {
      const { outcomes, stop } = await race(home, 5);
      try {
        await assertOneWinner(outcomes, home, lockFile);
      } finally {
        await stop();
      }
      // the winner released on its way out
      expect(await exists(lockFile)).toBe(false);
    });
  }, 60_000);

  it('lets exactly one of five simultaneous starts take over a dead pid', async () => {
    await inHome('race-dead', async (home, lockFile) => {
      await seed(lockFile, String(deadPid()));
      const { outcomes, stop } = await race(home, 5);
      try {
        await assertOneWinner(outcomes, home, lockFile);
      } finally {
        await stop();
      }
      expect(await exists(lockFile)).toBe(false);
    });
  }, 60_000);

  it('lets none of five simultaneous starts past a marker nobody is inside, and every refusal names it', async () => {
    await inHome('race-stale-marker', async (home, lockFile) => {
      const dead = deadPid();
      await seed(lockFile, String(dead));
      const marker = `${lockFile}.takeover`;
      await fs.mkdir(marker);
      const { outcomes, stop } = await race(home, 5);
      try {
        expect(outcomes.filter((o) => o.won), JSON.stringify(outcomes)).toHaveLength(0);
        for (const o of outcomes) {
          expect(o.message).toContain('Start again');
          expect(o.message).toContain(marker);
        }
      } finally {
        await stop();
      }
      expect(await fs.readFile(lockFile, 'utf8')).toBe(String(dead));
      expect(await exists(marker)).toBe(true);
    });
  }, 60_000);
});

describe('a file already there', () => {
  it('refuses a live pid, names it and the way out, and leaves the file untouched', async () => {
    await inHome('live-pid', async (home, lockFile) => {
      await seed(lockFile, String(process.ppid));
      const e = await acquireLock().then(
        () => new Error('resolved'),
        (err: Error) => err,
      );
      expect(e.message).toMatch(refusalNaming(process.ppid, home));
      expect(e.message).toContain(`delete ${lockFile} if that process is gone`);
      expect(await fs.readFile(lockFile, 'utf8')).toBe(String(process.ppid));
    });
  });

  it('takes over a dead pid', async () => {
    await inHome('dead-pid', async (_home, lockFile) => {
      await seed(lockFile, String(deadPid()));
      await acquireLock();
      expect(await fs.readFile(lockFile, 'utf8')).toBe(String(process.pid));
      await releaseLock();
    });
  });

  it('takes over garbage', async () => {
    await inHome('garbage', async (_home, lockFile) => {
      await seed(lockFile, 'not a pid');
      await acquireLock();
      expect(await fs.readFile(lockFile, 'utf8')).toBe(String(process.pid));
      await releaseLock();
    });
  });

  it.each(['0', '-1'])('takes over a file holding %s, which is a process group and not a pid', async (held) => {
    await inHome(`group-${held}`, async (_home, lockFile) => {
      await seed(lockFile, held);
      // alive to pidAlive, so it is the guard and not the signal that takes the file over
      expect(pidAlive(Number(held))).toBe(true);
      await acquireLock();
      expect(await fs.readFile(lockFile, 'utf8')).toBe(String(process.pid));
      await releaseLock();
    });
  });

  it('takes over a file that stays empty', async () => {
    await inHome('empty', async (_home, lockFile) => {
      await seed(lockFile, '');
      await acquireLock();
      expect(await fs.readFile(lockFile, 'utf8')).toBe(String(process.pid));
      await releaseLock();
    });
  });

  it('reads an empty file as a claim whose write has not landed yet', async () => {
    await inHome('empty-then-live', async (home, lockFile) => {
      await seed(lockFile, '');
      const attempt = acquireLock().then(
        () => new Error('resolved'),
        (err: Error) => err,
      );
      await sleep(50);
      await fs.writeFile(lockFile, String(process.ppid));
      expect((await attempt).message).toMatch(refusalNaming(process.ppid, home));
      expect(await fs.readFile(lockFile, 'utf8')).toBe(String(process.ppid));
    });
  });

  it('waits for a takeover another start is inside, then looks again', async () => {
    await inHome('marker-held', async (home, lockFile) => {
      await seed(lockFile, String(deadPid()));
      await fs.mkdir(`${lockFile}.takeover`);
      const attempt = acquireLock().then(
        () => new Error('resolved'),
        (err: Error) => err,
      );
      await sleep(50);
      await fs.writeFile(lockFile, String(process.ppid));
      // tolerant, so a module that took the marker away itself reds on the sentence
      // below and not here
      await fs.rmdir(`${lockFile}.takeover`).catch(() => undefined);
      expect((await attempt).message).toMatch(refusalNaming(process.ppid, home));
      expect(await fs.readFile(lockFile, 'utf8')).toBe(String(process.ppid));
      expect(await exists(`${lockFile}.takeover`)).toBe(false);
    });
  }, 15_000);

  it('refuses over a marker nobody is inside, names it, and removes nothing', async () => {
    await inHome('marker-dead', async (_home, lockFile) => {
      const dead = deadPid();
      await seed(lockFile, String(dead));
      const marker = `${lockFile}.takeover`;
      await fs.mkdir(marker);
      const e = await acquireLock().then(
        () => new Error('resolved'),
        (err: Error) => err,
      );
      expect(e.message).toContain('another Quietpurse took it while this one was starting. Start again');
      expect(e.message).toContain(marker);
      expect(await fs.readFile(lockFile, 'utf8')).toBe(String(dead));
      expect(await exists(marker)).toBe(true);
    });
  }, 60_000);

  it('refuses with the real error when the lock path is a directory', async () => {
    await inHome('lock-is-dir', async (_home, lockFile) => {
      await fs.mkdir(lockFile, { recursive: true });
      const e = await acquireLock().then(
        () => new Error('resolved'),
        (err: Error) => err,
      );
      expect(e.message).toContain('EISDIR');
      expect(e.message).not.toContain('another Quietpurse');
      expect((await fs.stat(lockFile)).isDirectory()).toBe(true);
      expect(await exists(`${lockFile}.takeover`)).toBe(false);
    });
  });

  // chmod removes no access on Windows or from root, so every case that seeds a mode
  // skips there rather than pass for the wrong reason
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'refuses with the real error when the lock file cannot be read',
    async () => {
      await inHome('lock-unreadable', async (_home, lockFile) => {
        await seed(lockFile, String(process.ppid));
        await fs.chmod(lockFile, 0o000);
        try {
          const e = await acquireLock().then(
            () => new Error('resolved'),
            (err: Error) => err,
          );
          expect(e.message).toContain('EACCES');
          expect(e.message).not.toContain('another Quietpurse');
        } finally {
          await fs.chmod(lockFile, 0o600);
        }
        expect(await fs.readFile(lockFile, 'utf8')).toBe(String(process.ppid));
        expect(await exists(`${lockFile}.takeover`)).toBe(false);
      });
    },
  );

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'refuses with the real error when the folder cannot be written',
    async () => {
      await inHome('home-readonly', async (home, lockFile) => {
        await fs.mkdir(home, { recursive: true });
        await fs.chmod(home, 0o500);
        try {
          const e = await acquireLock().then(
            () => new Error('resolved'),
            (err: Error) => err,
          );
          expect(e.message).toContain('EACCES');
          expect(e.message).not.toContain('another Quietpurse');
          expect(await exists(lockFile)).toBe(false);
        } finally {
          await fs.chmod(home, 0o700);
        }
      });
    },
  );

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'refuses with the real error when the marker cannot be made',
    async () => {
      await inHome('home-readonly-dead', async (home, lockFile) => {
        const dead = deadPid();
        await seed(lockFile, String(dead));
        await fs.chmod(home, 0o500);
        try {
          const e = await acquireLock().then(
            () => new Error('resolved'),
            (err: Error) => err,
          );
          expect(e.message).toContain('EACCES');
          expect(e.message).not.toContain('another Quietpurse');
          expect(await fs.readFile(lockFile, 'utf8')).toBe(String(dead));
          expect(await exists(`${lockFile}.takeover`)).toBe(false);
        } finally {
          await fs.chmod(home, 0o700);
        }
      });
    },
  );
});

describe('the release', () => {
  it('leaves a file holding another pid alone', async () => {
    await inHome('release-foreign', async (_home, lockFile) => {
      await seed(lockFile, String(process.ppid));
      await releaseLock();
      expect(await fs.readFile(lockFile, 'utf8')).toBe(String(process.ppid));
    });
  });

  it('removes the file it holds', async () => {
    await inHome('release-own', async (_home, lockFile) => {
      await acquireLock();
      expect(await fs.readFile(lockFile, 'utf8')).toBe(String(process.pid));
      await releaseLock();
      expect(await exists(lockFile)).toBe(false);
    });
  });

  it('resolves when there is no file', async () => {
    await inHome('release-none', async (_home, lockFile) => {
      await releaseLock();
      expect(await exists(lockFile)).toBe(false);
    });
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'resolves, and leaves alone, a file it cannot read',
    async () => {
      await inHome('release-unreadable', async (_home, lockFile) => {
        await seed(lockFile, String(process.ppid));
        await fs.chmod(lockFile, 0o000);
        try {
          await releaseLock();
        } finally {
          await fs.chmod(lockFile, 0o600);
        }
        expect(await fs.readFile(lockFile, 'utf8')).toBe(String(process.ppid));
      });
    },
  );
});

describe('with a PostgreSQL server configured', () => {
  it('neither claims nor releases a file', async () => {
    await inHome('database-url', async (home, lockFile) => {
      config.databaseUrl = 'postgres://x';
      await acquireLock();
      expect(await exists(lockFile)).toBe(false);
      expect(await exists(home)).toBe(false);
      await releaseLock();
      expect(await exists(lockFile)).toBe(false);
    });
  });
});

describe('pidAlive', () => {
  it.skipIf(process.platform === 'win32')('reads a process it may not signal as alive', () => {
    // EPERM as this user, success as root, and it is true either way
    expect(pidAlive(1)).toBe(true);
  });

  it('reads an exited process as dead', () => {
    expect(pidAlive(deadPid())).toBe(false);
  });
});
