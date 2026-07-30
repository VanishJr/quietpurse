/**
 * The account id an uploaded statement lands in, derived from the name the user
 * typed. One function, because two callers a request apart depend on it agreeing
 * with itself: the upload, which shows the summary the account name is part of, and
 * the confirm, which creates the account and attaches the rows (ROADMAP 5.3). The
 * `imports` row records the name, never the id, so a name that slugifies
 * differently in two places would land the rows in an account the summary did not
 * name.
 *
 * The prefix is an opaque id, not a claim about the format: one bank uploaded as
 * CSV one month and as XLSX the next has to land in one account, or every
 * overlapping row inserts twice (ROADMAP 4.2).
 *
 * It lives here rather than in either caller because the data layer must not import
 * from the providers, and the providers already import from the data layer.
 */
export const uploadAccountId = (accountName: string): string =>
  `csv:${
    accountName
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '') || 'account'
  }`;
