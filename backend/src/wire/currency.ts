import { z } from 'zod';

/**
 * The form two currencies are compared in and every answer sends, so a stored `eur` is `EUR`.
 * ASCII letters only, matching CURRENCY_KEY in backend/src/db: toUpperCase and the database's
 * UPPER disagree outside ASCII, and a stored currency can be any text.
 */
export const currencyKey = (code: string): string =>
  code.replace(/[a-z]/g, (c) => c.toUpperCase());

/** Every currency an answer carries is declared with this one schema; sentForm finds it by identity. */
export const currencySchema = z.string();
