/**
 * The suite's half of the answer check: a reporter the door records mismatches into,
 * and a drain the setup file empties in its after hooks so the case that produced a
 * mismatch is the case that fails with it. Recorded and never thrown from inside
 * res.json - a throw there is caught by Express and answered as `internal error`,
 * with the path in a silenced log.
 */
import type express from 'express';
import { ANSWER_CHECK } from '../src/app';

export interface AnswerCheck {
  /** Every mismatch recorded since the last drain, in order; empties the list. */
  drain: () => string[];
}

export function installAnswerCheck(app: express.Express): AnswerCheck {
  const recorded: string[] = [];
  app.set(ANSWER_CHECK, (mismatch: string) => {
    recorded.push(mismatch);
  });
  return { drain: () => recorded.splice(0) };
}
