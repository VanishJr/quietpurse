import { describe, expect, it } from 'vitest';
import { getAccount, listTransactions } from '../src/db';
import {
  detectDelimiter,
  genericMapping,
  importCsv,
  parseAmount,
  parseCsv,
  parseCsvDate,
} from '../src/providers/csv';

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

describe('importCsv: pipeline and deduplication', () => {
  const sparkasse = [
    'Auftragskonto;Buchungstag;Verwendungszweck;Beguenstigter/Zahlungspflichtiger;Betrag;Waehrung',
    'DE1;05.01.26;Miete Januar;Hausverwaltung GmbH;-900,00;EUR',
    'DE1;06.01.26;REWE SAGT DANKE;REWE Markt;-23,45;EUR',
    // two identical rows = two real transactions
    'DE1;06.01.26;Kaffee;Espresso House;-3,50;EUR',
    'DE1;06.01.26;Kaffee;Espresso House;-3,50;EUR',
  ].join('\n');

  it('sparkasse preset: parses, categorizes, and does not duplicate files', async () => {
    const r1 = await importCsv({
      accountName: 'Sparkasse Giro',
      currency: 'EUR',
      preset: 'sparkasse',
      csv: sparkasse,
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

    // re-uploading the same file adds nothing
    const r2 = await importCsv({
      accountName: 'Sparkasse Giro',
      currency: 'EUR',
      preset: 'sparkasse',
      csv: sparkasse,
    });
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
    const r = await importCsv({
      accountName: 'Revolut',
      currency: 'EUR',
      preset: 'revolut',
      csv: revolut,
    });
    expect(r.inserted).toBe(1);
    expect(r.skipped).toBe(1);
    const [t] = await listTransactions({ accountId: r.accountId });
    expect(t.category).toBe('transport');
    expect(t.date).toBe('2026-02-02T10:00:00.000Z');
  });

  it('generic: column auto-detection; an unreadable file gives a clear error', async () => {
    const generic = ['Date,Amount,Description', '2026-03-01,-10,Something'].join('\n');
    const r = await importCsv({ accountName: 'Bank X', currency: 'USD', csv: generic });
    expect(r.inserted).toBe(1);
    const [t] = await listTransactions({ accountId: r.accountId });
    expect(t.currency).toBe('USD');

    await expect(
      importCsv({ accountName: 'Bad', currency: 'EUR', csv: 'foo,bar\n1,2' }),
    ).rejects.toThrow(/could not find date\/amount\/description columns/);
  });
});
