import { describe, expect, it } from 'vitest';
import { getAccount, listTransactions } from '../src/db';
import {
  decodeCsv,
  detectDelimiter,
  genericMapping,
  parseAmount,
  parseCsv,
  parseCsvDate,
} from '../src/providers/csv';
import { importStatement } from '../src/providers/statement';

describe('parseCsv', () => {
  it('quotes, escaped quotes, CRLF, semicolon', () => {
    const rows = parseCsv('a;"b;c";"with ""a quote"""\r\n1;2;3\r\n', ';');
    expect(rows).toEqual([
      ['a', 'b;c', 'with "a quote"'],
      ['1', '2', '3'],
    ]);
  });

  it('detectDelimiter: the delimiter yielding more columns wins', () => {
    expect(detectDelimiter('Buchungstag;Betrag;Verwendungszweck')).toBe(';');
    expect(detectDelimiter('Type,Amount,Currency')).toBe(',');
  });
});

describe('parseAmount / parseCsvDate', () => {
  it('German and English number formats', () => {
    expect(parseAmount('-1.140,57', ',')).toBe(-1140.57);
    expect(parseAmount('1,234.56', '.')).toBe(1234.56);
    expect(parseAmount('-1140,57', 'auto')).toBe(-1140.57);
    expect(parseAmount('12.50', 'auto')).toBe(12.5);
    expect(parseAmount('rubbish', 'auto')).toBeNull();
  });

  it('dates: dmy with a two- and four-digit year, iso with a time', () => {
    expect(parseCsvDate('05.01.2026', 'dmy')).toBe('2026-01-05T00:00:00.000Z');
    expect(parseCsvDate('05.01.26', 'dmy')).toBe('2026-01-05T00:00:00.000Z');
    expect(parseCsvDate('2026-01-05 12:34:56', 'iso')).toBe('2026-01-05T12:34:56.000Z');
    expect(parseCsvDate('cucumber', 'dmy')).toBeNull();
  });

  /**
   * The generic preset detects the columns but not the locale, so it leaves the format
   * unset. Defaulting to iso used to drop every German statement on the floor.
   */
  it('dates: the default detects dmy and iso alike', () => {
    expect(parseCsvDate('05.01.2026')).toBe('2026-01-05T00:00:00.000Z');
    expect(parseCsvDate('2026-01-05')).toBe('2026-01-05T00:00:00.000Z');
    expect(parseCsvDate('2026-01-05 12:34:56')).toBe('2026-01-05T12:34:56.000Z');
    expect(parseCsvDate('cucumber')).toBeNull();
    // an explicit format still refuses the other shape
    expect(parseCsvDate('2026-01-05', 'dmy')).toBeNull();
    expect(parseCsvDate('05.01.2026', 'iso')).toBeNull();
  });
});

describe('genericMapping', () => {
  it('finds the usual columns case-insensitively', () => {
    const m = genericMapping(['Date', 'Amount', 'Description', 'Currency'])!;
    expect(m.date).toBe('Date');
    expect(m.currency).toBe('Currency');
    expect(genericMapping(['foo', 'bar'])).toBeNull();
  });
});

describe('a CSV statement: pipeline and deduplication', () => {
  const sparkasse = [
    'Auftragskonto;Buchungstag;Verwendungszweck;Beguenstigter/Zahlungspflichtiger;Betrag;Waehrung',
    'DE1;05.01.26;Miete Januar;Hausverwaltung GmbH;-900,00;EUR',
    'DE1;06.01.26;REWE SAGT DANKE;REWE Markt;-23,45;EUR',
    // two identical rows = two real transactions
    'DE1;06.01.26;Kaffee;Espresso House;-3,50;EUR',
    'DE1;06.01.26;Kaffee;Espresso House;-3,50;EUR',
  ].join('\n');

  it('sparkasse preset: parses, categorizes, and does not duplicate files', async () => {
    const r1 = await importStatement({
      accountName: 'Sparkasse Giro',
      currency: 'EUR',
      preset: 'sparkasse',
      bytes: Buffer.from(sparkasse, 'utf8'),
    });
    expect(r1.inserted).toBe(4);
    expect(r1.skipped).toBe(0);

    const txs = await listTransactions({ accountId: r1.accountId });
    expect(txs).toHaveLength(4);
    const rewe = txs.find((t) => t.description.includes('REWE'))!;
    expect(rewe.category).toBe('food');
    expect(rewe.amount).toBe(-23.45);
    // the description is joined from the payee and the purpose
    expect(rewe.description).toBe('REWE Markt REWE SAGT DANKE');

    // re-uploading the same file is caught by its hash before any parsing
    // happens at all (ROADMAP 4.3); see imports.test.ts for that layer
    const r2 = await importStatement({
      accountName: 'Sparkasse Giro',
      currency: 'EUR',
      preset: 'sparkasse',
      bytes: Buffer.from(sparkasse, 'utf8'),
    });
    expect(r2.duplicate).toBe(true);
    expect(r2.importId).toBe(r1.importId);
    expect(r2.inserted).toBe(0);

    // account balance = the sum of its transactions
    expect((await getAccount(r1.accountId))!.balance).toBe(-930.45);
  });

  it('revolut preset: State=COMPLETED filter, currency from the file', async () => {
    const revolut = [
      'Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance',
      'CARD_PAYMENT,Current,2026-02-01 10:00:00,2026-02-02 10:00:00,Uber Trip,-12.50,0,EUR,COMPLETED,100',
      'CARD_PAYMENT,Current,2026-02-03 10:00:00,,Pending Stuff,-5.00,0,EUR,PENDING,95',
    ].join('\n');
    const r = await importStatement({
      accountName: 'Revolut',
      currency: 'EUR',
      preset: 'revolut',
      bytes: Buffer.from(revolut, 'utf8'),
    });
    expect(r.inserted).toBe(1);
    expect(r.skipped).toBe(1);
    const [t] = await listTransactions({ accountId: r.accountId });
    expect(t.category).toBe('transport');
    expect(t.date).toBe('2026-02-02T10:00:00.000Z');
  });

  /**
   * The case the surrogate-key split exists for (ROADMAP 4.2): two statements
   * whose windows overlap. Every repeated row has to be recognised as the same
   * transaction, and only the genuinely new ones may be inserted.
   */
  it('overlapping statements insert only the rows the first one did not have', async () => {
    const rows = {
      mar05: '2026-03-05,-40.00,Mar 5 pharmacy',
      mar20: '2026-03-20,-60.00,Mar 20 hardware store',
      mar28: '2026-03-28,-15.00,Mar 28 bakery',
      apr02: '2026-04-02,-25.00,Apr 2 books',
      apr10: '2026-04-10,-35.00,Apr 10 cinema',
    };
    const file = (...keys: (keyof typeof rows)[]) =>
      ['date,amount,description', ...keys.map((k) => rows[k])].join('\n');

    const first = await importStatement({
      accountName: 'Overlap Bank',
      currency: 'EUR',
      bytes: Buffer.from(file('mar05', 'mar20', 'mar28'), 'utf8'),
    });
    expect(first.inserted).toBe(3);

    // Mar 15 - Apr 15: repeats Mar 20 and Mar 28, adds two April rows
    const second = await importStatement({
      accountName: 'Overlap Bank',
      currency: 'EUR',
      bytes: Buffer.from(file('mar20', 'mar28', 'apr02', 'apr10'), 'utf8'),
    });
    expect(second.inserted).toBe(2);

    const all = await listTransactions({ accountId: first.accountId });
    expect(all).toHaveLength(5);
  });

  it('a re-parse with a longer description does not become a second row', async () => {
    const statement = (description: string) =>
      ['date,amount,description', `2026-05-04,-23.45,${description}`].join('\n');

    const first = await importStatement({
      accountName: 'Reparse Bank',
      currency: 'EUR',
      bytes: Buffer.from(statement('REWE SAGT DANKE'), 'utf8'),
    });
    expect(first.inserted).toBe(1);

    // the same statement through an improved parser: one more field extracted
    const second = await importStatement({
      accountName: 'Reparse Bank',
      currency: 'EUR',
      bytes: Buffer.from(statement('REWE SAGT DANKE 12345'), 'utf8'),
    });
    expect(second.inserted).toBe(0);

    const all = await listTransactions({ accountId: first.accountId });
    expect(all).toHaveLength(1);
    expect(all[0].description).toBe('REWE SAGT DANKE');
  });

  it('generic: column auto-detection; an unreadable file gives a clear error', async () => {
    const generic = ['Date,Amount,Description', '2026-03-01,-10,Something'].join('\n');
    const r = await importStatement({
      accountName: 'Bank X',
      currency: 'USD',
      bytes: Buffer.from(generic, 'utf8'),
    });
    expect(r.inserted).toBe(1);
    const [t] = await listTransactions({ accountId: r.accountId });
    expect(t.currency).toBe('USD');

    await expect(
      importStatement({
        accountName: 'Bad',
        currency: 'EUR',
        bytes: Buffer.from('foo,bar\n1,2', 'utf8'),
      }),
    ).rejects.toThrow(/could not find date\/amount\/description columns/);
  });
});

/**
 * The server now holds bytes where the browser used to hand over a decoded string.
 * Two decoders and no detection: a BOM is believed, valid UTF-8 is never second-
 * guessed, and only a hard UTF-8 failure falls back to windows-1252.
 */
describe('decodeCsv', () => {
  it('cp1252 is used only where UTF-8 cannot be', () => {
    expect(decodeCsv(Buffer.from([0x53, 0x74, 0x72, 0x61, 0xdf, 0x65]))).toBe('Straße');
    expect(decodeCsv(Buffer.from('Straße', 'utf8'))).toBe('Straße');
    // a UTF-8 BOM is consumed by the decoder, not carried into the text
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a,b', 'utf8')]);
    expect(decodeCsv(withBom)).toBe('a,b');
  });

  /**
   * Excel's own "Unicode Text" export is UTF-16LE with a BOM. Half its bytes are
   * NUL, so the sniffer has to recognise the BOM before it decides the file is
   * binary - otherwise this branch is unreachable and the user is told their
   * statement is not a CSV.
   */
  it('a UTF-16LE statement imports the same rows as the UTF-8 one', async () => {
    const text = ['date,amount,description', '2026-06-01,-12.00,Utf16 bakery'].join('\n');
    const wide = await importStatement({
      accountName: 'Utf16 Bank',
      currency: 'EUR',
      bytes: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]),
    });
    const narrow = await importStatement({
      accountName: 'Utf8 Bank',
      currency: 'EUR',
      bytes: Buffer.from(text, 'utf8'),
    });
    expect(wide.inserted).toBe(1);
    expect(narrow.inserted).toBe(1);

    const fields = async (accountId: string) =>
      (await listTransactions({ accountId })).map((t) => [t.date, t.amount, t.description]);
    expect(await fields(wide.accountId)).toEqual(await fields(narrow.accountId));
  });

  /**
   * The big-endian branch needs an ICU-enabled Node, exactly as windows-1252 does.
   * On a build without it the decoder's constructor throws a RangeError, and a file
   * the design calls a CSV reaches the user as a 400 and a failed import.
   */
  it('a UTF-16BE statement imports the same rows as the UTF-8 one', async () => {
    const text = ['date,amount,description', '2026-06-02,-13.00,Utf16be bakery'].join('\n');
    const wide = await importStatement({
      accountName: 'Utf16be Bank',
      currency: 'EUR',
      bytes: Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, 'utf16le').swap16()]),
    });
    const narrow = await importStatement({
      accountName: 'Utf8 Big Endian Twin',
      currency: 'EUR',
      bytes: Buffer.from(text, 'utf8'),
    });
    expect(wide.inserted).toBe(1);
    expect(narrow.inserted).toBe(1);

    const fields = async (accountId: string) =>
      (await listTransactions({ accountId })).map((t) => [t.date, t.amount, t.description]);
    expect(await fields(wide.accountId)).toEqual(await fields(narrow.accountId));
  });
});
