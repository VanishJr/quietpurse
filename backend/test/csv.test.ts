import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { ERROR_DETAIL_MAX, getAccount, listTransactions } from '../src/db';
import {
  CSV_PRESETS,
  CsvMapping,
  decodeCsv,
  detectDelimiter,
  genericMapping,
  matchColumn,
  parseAmount,
  parseCsv,
  parseCsvDate,
} from '../src/providers/csv';
import { MAX_DATA_ROWS, Sheet } from '../src/providers/sheet';
import { importAndConfirm } from './helpers';
import {
  CURRENCY_CODE_MAX,
  ImportSummary,
  ParsedFile,
  balanceBreaks,
  feeRefused,
  importStatement,
  noRowsParsed,
  reconcile,
} from '../src/providers/statement';
import { NewTransaction } from '../src/types';

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

  /**
   * "Дата начала" is when the transaction started and "Дата выполнения" when it
   * completed, and the completed one is the date this importer means - a date days
   * off goes into the dedup key (ROADMAP 4.2), where it cannot be corrected by
   * re-importing. Correctness, not the exactness holder: see the matchColumn case.
   */
  it('a header carrying both Revolut date columns resolves to the completed one', () => {
    const ru = ['Тип', 'Дата начала', 'Дата выполнения', 'Описание', 'Сумма', 'Валюта'];
    expect(genericMapping(ru)!.date).toBe('Дата выполнения');
  });

  /**
   * Pins the ORDER of GENERIC_CANDIDATES.date, not the matcher: "дата выполнения"
   * wins a header carrying a bare "Дата" only because it is tried first, and a name
   * appended to that list for tidiness re-sorts it back. The header above cannot hold
   * this - it has no bare "Дата", so it is green under either order.
   */
  it('a bare Дата beside Дата выполнения still resolves to the completed one', () => {
    const both = ['Дата', 'Дата выполнения', 'Сумма', 'Описание'];
    expect(genericMapping(both)!.date).toBe('Дата выполнения');
  });
});

/**
 * Where "matched exactly, or not at all" is held. Not at import level, on either
 * path: through a preset neither accepted name is a prefix of "Дата начала", and
 * through generic the candidate order puts "дата выполнения" first, so a startsWith
 * matcher never reaches "дата" and returns the right column anyway. Both would be
 * green against exactly the defect they were written to catch.
 */
describe('matchColumn', () => {
  it('a candidate that is a prefix of a present column matches nothing', () => {
    expect(matchColumn(['Дата начала', 'Дата выполнения'], ['дата'])).toBeUndefined();
    expect(matchColumn(['Description', 'Description Extra'], ['descriptio'])).toBeUndefined();
  });

  it('the candidate list breaks a tie, not the header order', () => {
    const header = ['Дата начала', 'Дата выполнения'];
    expect(matchColumn(header, ['дата выполнения', 'дата начала'])).toBe('Дата выполнения');
    expect(matchColumn(header, ['дата начала', 'дата выполнения'])).toBe('Дата начала');
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
    const r1 = await importAndConfirm({
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
    const r2 = await importAndConfirm({
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

  /**
   * The `PENDING` row states a balance, which the real export never does - kept as
   * found (row 54, D3), because it is the case R10's discriminator was written for:
   * the balance column covers a row this import drops, so the gate turns itself off
   * rather than reading a run it does not cover. That verdict is asserted on its own
   * fixture in the gate block below - `importAndConfirm` hands back no summary, so it
   * cannot be asserted here - and this case is still about the status filter and the
   * currency column.
   */
  it('revolut preset: State=COMPLETED filter, currency from the file', async () => {
    const revolut = [
      'Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance',
      'CARD_PAYMENT,Current,2026-02-01 10:00:00,2026-02-02 10:00:00,Uber Trip,-12.50,0,EUR,COMPLETED,100',
      'CARD_PAYMENT,Current,2026-02-03 10:00:00,,Pending Stuff,-5.00,0,EUR,PENDING,95',
    ].join('\n');
    const r = await importAndConfirm({
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

    const first = await importAndConfirm({
      accountName: 'Overlap Bank',
      currency: 'EUR',
      bytes: Buffer.from(file('mar05', 'mar20', 'mar28'), 'utf8'),
    });
    expect(first.inserted).toBe(3);

    // Mar 15 - Apr 15: repeats Mar 20 and Mar 28, adds two April rows
    const second = await importAndConfirm({
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

    const first = await importAndConfirm({
      accountName: 'Reparse Bank',
      currency: 'EUR',
      bytes: Buffer.from(statement('REWE SAGT DANKE'), 'utf8'),
    });
    expect(first.inserted).toBe(1);

    // the same statement through an improved parser: one more field extracted
    const second = await importAndConfirm({
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
    const r = await importAndConfirm({
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

  /**
   * The promise of the typed cell seam: a CSV cell is a string, so the CSV path
   * takes only the string branches and its messages are what they always were.
   * Asserted with toBe rather than a regex - it has to fail if the CSV path ever
   * acquires a sheet notice (the sentence would grow a " - …" tail), if the prose
   * changes, or if the row label drifts off the CSV line number.
   */
  it('nothing parsed: the CSV message is the row reason and nothing else', async () => {
    const unreadable = ['date,amount,description', 'not a date,not a number,broken'].join('\n');
    const thrown = await importStatement({
      accountName: 'Unreadable Bank',
      currency: 'EUR',
      bytes: Buffer.from(unreadable, 'utf8'),
    }).catch((e) => e as Error);

    expect(thrown.message).toBe(
      'no row could be parsed (1 skipped): row 2: could not parse the date "not a date" or the amount "not a number"',
    );
  });
});

/**
 * One bank, one export, fifteen languages (ROADMAP 5.2). The header below is the
 * Russian Revolut one, reproduced from a measured file - column names are the bank's,
 * not personal data, and every row under it is fabricated here: no real statement
 * enters this repository.
 */
describe('a bank export in a language the preset also accepts', () => {
  const RU_HEADER =
    'Тип,Продукт,Дата начала,Дата выполнения,Описание,Сумма,Комиссия,Валюта,State,Остаток средств';

  const EN_HEADER =
    'Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance';

  /**
   * The balance column reads 195.30 and not 195.80, and the pending row states none.
   * Both were repaired towards what the real export was measured to do (row 54, D3):
   * this fixture broke by EXACTLY the fee, which is the pre-037a arithmetic the bank's
   * own running balance disproves, and the real export leaves the cell empty on every
   * `В ОБРАБОТКЕ` row. Tuning either number to make the gate pass would have put that
   * defect back inside a test.
   */
  it('the Russian export imports under the same revolut preset', async () => {
    const ru = [
      RU_HEADER,
      'CARD_PAYMENT,Current,2026-02-01 09:00:00,2026-02-02 10:00:00,Кофейня на углу,-4.20,0.00,EUR,ВЫПОЛНЕНО,95.80',
      'TOPUP,Current,2026-02-04 08:00:00,2026-02-04 08:30:00,Пополнение счёта,100.00,0.50,EUR,ВЫПОЛНЕНО,195.30',
      'CARD_PAYMENT,Current,2026-02-05 12:00:00,,Ожидает подтверждения,-9.99,0.00,EUR,В ОБРАБОТКЕ,',
    ].join('\n');

    const r = await importAndConfirm({
      accountName: 'Revolut RU',
      currency: 'USD',
      preset: 'revolut',
      bytes: Buffer.from(ru, 'utf8'),
    });
    expect(r.inserted).toBe(2);
    expect(r.skipped).toBe(1);

    const txs = await listTransactions({ accountId: r.accountId });
    const coffee = txs.find((t) => t.description === 'Кофейня на углу')!;
    // the completed date, not the started one two columns to its left
    expect(coffee.date).toBe('2026-02-02T10:00:00.000Z');
    expect(coffee.amount).toBe(-4.2);
    // the file's own currency column, not the USD the request asked for
    expect(coffee.currency).toBe('EUR');
    // Сумма MINUS Комиссия. This assertion read 100 until row 037a: the fee is
    // stated on top of the amount, so the account moved by 99.50 and the old
    // arithmetic stored a number the statement's own balance never shows
    const topup = txs.find((t) => t.description === 'Пополнение счёта')!;
    expect(topup.amount).toBe(99.5);
    expect(topup.fee).toBe(0.5);
    // a stated zero is a fee the file stated, and is not the absent one a header
    // without the column gives
    expect(coffee.fee).toBe(0);

    expect(r.problems).toEqual([
      '1 row skipped: the "State" value is not one of the accepted ones - "В ОБРАБОТКЕ" (1)',
    ]);
  });

  /**
   * Deny by default. A status value in neither accepted list means "not completed"
   * and the row is skipped - the alternative, skipping only the values listed as
   * pending, imports every reverted and declined row shipped in a language nobody
   * has listed yet as money that never moved.
   */
  it('a status in neither list is skipped, not imported, and says so', async () => {
    const file = [
      EN_HEADER,
      'CARD_PAYMENT,Current,2026-03-01 10:00:00,2026-03-01 10:00:00,Kept One,-10.00,0,EUR,COMPLETED,100',
      'CARD_PAYMENT,Current,2026-03-02 10:00:00,2026-03-02 10:00:00,Reverted One,-20.00,0,EUR,REVERTED,120',
      'CARD_PAYMENT,Current,2026-03-03 10:00:00,2026-03-03 10:00:00,Reverted Two,-25.00,0,EUR,REVERTED,145',
      'CARD_PAYMENT,Current,2026-03-04 10:00:00,2026-03-04 10:00:00,Declined One,-30.00,0,EUR,DECLINED,145',
    ].join('\n');

    const r = await importAndConfirm({
      accountName: 'Revolut Reverted',
      currency: 'EUR',
      preset: 'revolut',
      bytes: Buffer.from(file, 'utf8'),
    });
    expect(r.inserted).toBe(1);
    expect(r.skipped).toBe(3);
    expect((await listTransactions({ accountId: r.accountId })).map((t) => t.description)).toEqual([
      'Kept One',
    ]);
    // one line however many rows, the most frequent value first so the informative
    // one survives the bound
    expect(r.problems).toEqual([
      '3 rows skipped: the "State" value is not one of the accepted ones - "REVERTED" (2), "DECLINED" (1)',
    ]);
  });

  it('a file where every status is unrecognised is refused, naming the values', async () => {
    const file = [
      EN_HEADER,
      'CARD_PAYMENT,Current,2026-04-01 10:00:00,2026-04-01 10:00:00,One,-10.00,0,EUR,ЗАВЕРШЕНО,100',
      'CARD_PAYMENT,Current,2026-04-02 10:00:00,2026-04-02 10:00:00,Two,-20.00,0,EUR,ЗАВЕРШЕНО,120',
    ].join('\n');

    const thrown = await importStatement({
      accountName: 'Revolut Unknown Status',
      currency: 'EUR',
      preset: 'revolut',
      bytes: Buffer.from(file, 'utf8'),
    }).catch((e) => e as Error);

    // the value, because no preset chip fixes a status nobody has listed - which is
    // exactly what the bare "(2 skipped)" sentence used to send the user off to try
    expect(thrown.message).toBe(
      'no row could be parsed (2 skipped): every row\'s "State" value is not one of the accepted ones - "ЗАВЕРШЕНО" (2)',
    );
  });

  /**
   * The aggregate outranks a fifth per-row reason: four row problems and the line
   * saying the import is partial beat five row problems and silence.
   */
  it('the skipped-status line survives a file already full of row problems', async () => {
    const bad = (n: number) =>
      `CARD_PAYMENT,Current,2026-05-0${n} 10:00:00,not a date,Bad ${n},not a number,0,EUR,COMPLETED,100`;
    const file = [
      EN_HEADER,
      ...[1, 2, 3, 4, 5].map(bad),
      'CARD_PAYMENT,Current,2026-05-06 10:00:00,2026-05-06 10:00:00,Reverted,-9.00,0,EUR,REVERTED,100',
      'CARD_PAYMENT,Current,2026-05-07 10:00:00,2026-05-07 10:00:00,Kept,-11.00,0,EUR,COMPLETED,89',
    ].join('\n');

    const r = await importAndConfirm({
      accountName: 'Revolut Crowded Problems',
      currency: 'EUR',
      preset: 'revolut',
      bytes: Buffer.from(file, 'utf8'),
    });
    expect(r.inserted).toBe(1);
    expect(r.skipped).toBe(6);
    expect(r.problems).toHaveLength(5);
    expect(r.problems[0]).toBe(
      '1 row skipped: the "State" value is not one of the accepted ones - "REVERTED" (1)',
    );
    expect(r.problems.slice(1)).toHaveLength(4);
    for (const p of r.problems.slice(1)) expect(p).toMatch(/^row \d+: /);
  });

  it('a header matching no accepted name names the slots and what was tried', async () => {
    const file = ['Дата,Сумма операции,Назначение', '2026-06-01,-1.00,тест'].join('\n');

    const thrown = await importStatement({
      accountName: 'Revolut Unlisted Language',
      currency: 'EUR',
      preset: 'revolut',
      bytes: Buffer.from(file, 'utf8'),
    }).catch((e) => e as Error);

    // every unresolved slot, the names tried, then the header - in that order,
    // because the header dump is unbounded and the cap cuts the tail
    expect(thrown.message).toBe(
      'no column matched for date (tried "Completed Date", "Дата выполнения"), ' +
        'amount (tried "Amount", "Сумма"), description (tried "Description", "Описание"), ' +
        'currency (tried "Currency", "Валюта"), status (tried "State") ' +
        '- pick a different preset or set a mapping; ' +
        'the header reads: Дата, Сумма операции, Назначение',
    );
  });

  /**
   * A prototype member and not another invented slug: CSV_PRESETS is a plain object
   * literal, so `toString` reads as a truthy entry there while `not-a-bank` does not.
   * Looked up without hasOwn it would slip past this throw carrying an undefined
   * mapping and die inside readSheet on `preset.mapping.delimiter` - an internal
   * TypeError in error_detail, on a failed import row a client bug should never write.
   */
  it('a preset named after an Object.prototype member is refused like any other', async () => {
    const file = ['Дата выполнения,Сумма,Описание', '2026-06-01,-1.00,тест'].join('\n');

    const thrown = await importStatement({
      accountName: 'Revolut Prototype Preset',
      currency: 'EUR',
      preset: 'toString',
      bytes: Buffer.from(file, 'utf8'),
    }).catch((e) => e as Error);

    expect(thrown.message).toBe('unknown preset: toString');
  });

  /**
   * ROADMAP row 56, and the incident it was raised for: the same file read by the
   * preset and by the generic reader produces the SAME five headline figures, so the
   * screen was right by coincidence three times running while nothing on it said which
   * reader had run. The two summaries differ in readAs and the counts do not - which is
   * what makes the differing descriptor evidence rather than decoration.
   *
   * Both uploads go through importStatement and neither is confirmed: committing the
   * first would make the second answer `duplicate`, which carries no summary at all.
   * The rows differ from the committing case above by their descriptions and by
   * nothing else, for the same reason one file up: identical bytes would already be
   * committed by the time this runs, and file order inside a run is vitest's.
   */
  it('the same file names the preset that read it, or the generic reader', async () => {
    const ru = [
      RU_HEADER,
      'CARD_PAYMENT,Current,2026-02-01 09:00:00,2026-02-02 10:00:00,Пекарня у дома,-4.20,0.00,EUR,ВЫПОЛНЕНО,95.80',
      'TOPUP,Current,2026-02-04 08:00:00,2026-02-04 08:30:00,Перевод на счёт,100.00,0.50,EUR,ВЫПОЛНЕНО,195.30',
      'CARD_PAYMENT,Current,2026-02-05 12:00:00,,Ожидает обработки,-9.99,0.00,EUR,В ОБРАБОТКЕ,',
    ].join('\n');
    const upload = (preset?: string) =>
      importStatement({
        accountName: 'Revolut Named Reader',
        currency: 'EUR',
        preset,
        bytes: Buffer.from(ru, 'utf8'),
      });

    const named = await upload('revolut');
    const auto = await upload();
    if (named.outcome !== 'awaiting_confirmation' || auto.outcome !== 'awaiting_confirmation') {
      throw new Error('both uploads were expected to stage');
    }

    // the title comes off CSV_PRESETS and is never re-spelled here: it is the string
    // the chip renders, and comparing the two is the whole point of the field
    expect(named.summary.readAs).toEqual({
      kind: 'preset',
      preset: 'revolut',
      title: CSV_PRESETS.revolut.title,
      columns: { date: 'Дата выполнения', amount: 'Сумма', description: ['Описание'] },
    });
    expect(auto.summary.readAs).toEqual({
      kind: 'auto-detected',
      columns: { date: 'Дата выполнения', amount: 'Сумма', description: ['Описание'] },
    });
    expect(auto.summary.readAs).not.toEqual(named.summary.readAs);

    const headline = (s: ImportSummary) => ({
      total: s.total,
      accepted: s.accepted,
      skipped: s.skipped,
      from: s.from,
      to: s.to,
    });
    expect(headline(named.summary)).toEqual({
      total: 3,
      accepted: 2,
      skipped: 1,
      from: '2026-02-02',
      to: '2026-02-04',
    });
    // the pending row is dropped by onlyWhen under the preset and by its empty date
    // under the generic reader, so all five agree and none of them says so
    expect(headline(auto.summary)).toEqual(headline(named.summary));
  });
});

/**
 * The rest of row 56: what the descriptor names when a preset is not what read the
 * file. Every case here drives importStatement rather than building a summary, because
 * a descriptor that echoes the request passes any test that does not open the file.
 */
describe('the summary names the columns the parser settled on', () => {
  /**
   * A header carrying two date columns and two description ones, so a wrong answer is
   * visible: sparkasse takes Buchungstag and joins two description columns, the generic
   * reader takes Datum (candidate order: date, datum, buchungstag) and one. The two
   * date columns hold different dates, so `from`/`to` move with the descriptor and it
   * is asserted to track a parse that demonstrably happened rather than to be a label.
   */
  const TWO_DATES = [
    'Buchungstag;Datum;Betrag;Beguenstigter/Zahlungspflichtiger;Verwendungszweck;Waehrung',
    '01.03.2026;02.03.2026;-12,50;Baecker Mueller;Broetchen;EUR',
    '05.03.2026;06.03.2026;-30,00;Stadtwerke;Strom;EUR',
  ].join('\n');

  it("names the file's own header cells, and they differ by reader", async () => {
    const upload = (preset?: string) =>
      importStatement({
        accountName: 'Two Date Columns',
        currency: 'EUR',
        preset,
        bytes: Buffer.from(TWO_DATES, 'utf8'),
      });

    const named = await upload('sparkasse');
    const auto = await upload();
    if (named.outcome !== 'awaiting_confirmation' || auto.outcome !== 'awaiting_confirmation') {
      throw new Error('both uploads were expected to stage');
    }

    expect(named.summary.readAs).toEqual({
      kind: 'preset',
      preset: 'sparkasse',
      title: CSV_PRESETS.sparkasse.title,
      columns: {
        date: 'Buchungstag',
        amount: 'Betrag',
        description: ['Beguenstigter/Zahlungspflichtiger', 'Verwendungszweck'],
      },
    });
    expect(auto.summary.readAs).toEqual({
      kind: 'auto-detected',
      columns: { date: 'Datum', amount: 'Betrag', description: ['Verwendungszweck'] },
    });

    // the dates the two readers actually imported, one column apart
    expect([named.summary.from, named.summary.to]).toEqual(['2026-03-01', '2026-03-05']);
    expect([auto.summary.from, auto.summary.to]).toEqual(['2026-03-02', '2026-03-06']);
  });

  /**
   * The arm no client in this repository reaches and every other one does: POST
   * /api/imports accepts a mapping, so an iOS or Android client can send one. The
   * generic reader WOULD have matched this header - the request replaces one slot of
   * three - which is the boundary of the predicate rather than its easy end.
   */
  it('a request that overrides one column of three reads as a request mapping', async () => {
    const file = [
      'date,amount,description,note',
      '2026-04-01,-5.00,Card payment,Kiosk am Bahnhof',
      '2026-04-02,-6.00,Card payment,Baecker Mueller',
    ].join('\n');
    const upload = (mapping?: Partial<CsvMapping>) =>
      importStatement({
        accountName: 'Mapping Sent With The Upload',
        currency: 'EUR',
        mapping,
        bytes: Buffer.from(file, 'utf8'),
      });

    const sent = await upload({ description: 'note' });
    const auto = await upload();
    if (sent.outcome !== 'awaiting_confirmation' || auto.outcome !== 'awaiting_confirmation') {
      throw new Error('both uploads were expected to stage');
    }

    expect(sent.summary.readAs).toEqual({
      kind: 'request-mapping',
      columns: { date: 'date', amount: 'amount', description: ['note'] },
    });
    // the same bytes with nothing overridden: the generic reader would have found all
    // three, and names the column the request replaced
    expect(auto.summary.readAs).toEqual({
      kind: 'auto-detected',
      columns: { date: 'date', amount: 'amount', description: ['description'] },
    });
  });
});

/**
 * A fee a statement states on top of the amount (ROADMAP 37a). Every shape below is
 * one the measured Revolut export actually carries, reproduced with fabricated rows:
 * the amount column alone is short by the fee on every charge that has one, and the
 * plan-fee row - Amount 0.00, Fee 2.99 - is a real charge the importer used to drop
 * whole at the `amount === 0` guard.
 *
 * These assertions were the only thing holding the arithmetic until row 54 gave this
 * path a gate; the bank's own running balance now says the same thing independently,
 * in the block below.
 *
 * Neither header carries a `Balance` column any more. It sat in both as filler - the
 * parser ignored it, so a literal 0 on every row cost nothing - and filler becomes an
 * assertion the day something reads the column: every one of those rows claims the
 * account was left at zero. A fixture must not carry a column it does not mean (row
 * 54, D3), and what these cases mean is the fee.
 */
describe('a fee the statement states beside the amount', () => {
  const WITH_FEE = 'Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State';
  const WITHOUT_FEE = 'Type,Product,Started Date,Completed Date,Description,Amount,Currency,State';

  const withFee = (description: string, amount: string, fee: string, day = '01'): string =>
    `CARD_PAYMENT,Current,2026-08-${day} 09:00:00,2026-08-${day} 10:00:00,${description},${amount},${fee},EUR,COMPLETED`;

  const withoutFee = (description: string, amount: string, day = '01'): string =>
    `CARD_PAYMENT,Current,2026-08-${day} 09:00:00,2026-08-${day} 10:00:00,${description},${amount},EUR,COMPLETED`;

  const importRevolut = (accountName: string, ...rows: string[]) =>
    importAndConfirm({
      accountName,
      currency: 'EUR',
      preset: 'revolut',
      bytes: Buffer.from(rows.join('\n'), 'utf8'),
    });

  it('the stored amount is the movement the account made, fee included', async () => {
    const r = await importRevolut(
      'Fee Movement',
      WITH_FEE,
      withFee('Wizz Air', '-63.18', '0.44', '20'),
      withFee('No Fee Here', '-12.50', '0.00', '21'),
    );
    expect(r.inserted).toBe(2);
    expect(r.skipped).toBe(0);

    const txs = await listTransactions({ accountId: r.accountId });
    const wizz = txs.find((t) => t.description === 'Wizz Air')!;
    // the number the PDF of the same month prints for this operation, to the cent
    expect(wizz.amount).toBe(-63.62);
    expect(wizz.fee).toBe(0.44);
    // and a stated zero changes nothing about the amount while still being stated
    const plain = txs.find((t) => t.description === 'No Fee Here')!;
    expect(plain.amount).toBe(-12.5);
    expect(plain.fee).toBe(0);
  });

  it('a row whose amount is zero and whose fee is not is a charge, and imports', async () => {
    const r = await importRevolut(
      'Fee Only Charge',
      WITH_FEE,
      withFee('Premium plan fee', '0.00', '2.99', '26'),
    );
    expect(r.inserted).toBe(1);
    expect(r.skipped).toBe(0);
    expect(r.problems).toEqual([]);

    const [t] = await listTransactions({ accountId: r.accountId });
    expect(t.amount).toBe(-2.99);
    expect(t.fee).toBe(2.99);
  });

  /**
   * The guard did not lose its job, it changed which number it reads. A credit whose
   * fee eats the whole of it moved nothing, and importing it as a zero would put a
   * transaction in the history the statement does not show. Note the sign: the fee is
   * always taken, so a -5.00 row with a 5.00 fee is a -10.00 movement, not a zero.
   */
  it('a row with no movement at all is still skipped', async () => {
    const r = await importRevolut(
      'Fee No Movement',
      WITH_FEE,
      withFee('Nothing Moved', '0.00', '0.00', '02'),
      withFee('Given And Taken', '5.00', '5.00', '03'),
      withFee('Kept', '-1.00', '0.00', '04'),
    );
    expect(r.inserted).toBe(1);
    expect(r.skipped).toBe(2);
    expect((await listTransactions({ accountId: r.accountId })).map((t) => t.description)).toEqual([
      'Kept',
    ]);
  });

  /**
   * Trap 1. The fee is resolved outside resolvePreset's match(), so it records no
   * unresolved slot - and resolveColumns is the XLSX header scan's predicate as well
   * as the mapper's, so a fee that could refuse a header would move which row the
   * scan settles on.
   */
  it('a preset naming a fee column against a header without one imports every row', async () => {
    const r = await importRevolut(
      'Fee Column Absent',
      WITHOUT_FEE,
      withoutFee('First', '-10.00', '05'),
      withoutFee('Second', '-20.00', '06'),
    );
    expect(r.inserted).toBe(2);
    expect(r.skipped).toBe(0);

    const txs = await listTransactions({ accountId: r.accountId });
    expect(txs.map((t) => t.amount).sort((a, b) => a - b)).toEqual([-20, -10]);
    // NULL, not 0: this file stated no fee, which is not the same fact as a zero
    for (const t of txs) expect(t.fee).toBeUndefined();
  });

  /**
   * Refusing the row and not the file, deliberately. There is no way to override a
   * fee column, so a file-level refusal leaves one route open - the generic preset,
   * which resolves no fee column and would import every row of that statement
   * pre-fee, silently. That is the defect this row exists to remove.
   */
  it('a fee cell that cannot be read refuses its row and says which cell', async () => {
    const r = await importRevolut(
      'Fee Unreadable',
      WITH_FEE,
      withFee('Bad Fee', '-10.00', 'cucumber', '07'),
      withFee('Good Fee', '-20.00', '0.10', '08'),
    );
    expect(r.inserted).toBe(1);
    expect(r.skipped).toBe(1);
    expect(r.problems).toEqual([
      'row 2: the fee cell reads "cucumber", which this parser cannot read as a fee' +
        ' - the row is skipped rather than imported without it',
    ]);

    const [t] = await listTransactions({ accountId: r.accountId });
    expect(t.description).toBe('Good Fee');
    expect(t.amount).toBe(-20.1);
  });

  /**
   * A negative fee subtracted would INCREASE the movement, and no source in this
   * tree states one. If a bank ever does, this refusal is how it is found - rather
   * than by a user noticing their balance is off.
   */
  it('a negative fee refuses its row the same way', async () => {
    const r = await importRevolut(
      'Fee Negative',
      WITH_FEE,
      withFee('Negative Fee', '-10.00', '-0.44', '09'),
      withFee('Fine', '-20.00', '0.00', '10'),
    );
    expect(r.inserted).toBe(1);
    expect(r.skipped).toBe(1);
    expect(r.problems).toEqual([
      'row 2: the fee cell reads "-0.44", which this parser cannot read as a fee' +
        ' - the row is skipped rather than imported without it',
    ]);
  });

  /**
   * The other branch of the Cell seam, owed because XLSX_PARSER_VERSION moves with
   * CSV_PARSER_VERSION: a workbook hands the mapper a float, never a string, and
   * cellAmount passes it through without going near parseAmount.
   */
  it('a workbook states its fee as a number and it is read the same way', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Statement');
    ws.addRow(WITH_FEE.split(','));
    ws.addRow([
      'CARD_PAYMENT',
      'Current',
      new Date('2026-08-20T09:00:00.000Z'),
      new Date('2026-08-20T10:00:00.000Z'),
      'Workbook Wizz',
      -63.18,
      0.44,
      'EUR',
      'COMPLETED',
    ]);

    const r = await importAndConfirm({
      accountName: 'Fee Workbook',
      currency: 'EUR',
      preset: 'revolut',
      bytes: Buffer.from(await wb.xlsx.writeBuffer()),
    });
    expect(r.inserted).toBe(1);

    const [t] = await listTransactions({ accountId: r.accountId });
    expect(t.amount).toBe(-63.62);
    expect(t.fee).toBe(0.44);
  });

  /**
   * I2 in miniature, and it needs no real file: the same operation stated two ways -
   * the fee beside the amount, and the fee already inside it - is ONE transaction.
   * That holds only while `amount` means the same thing for every format, and it goes
   * red the moment the fee stops being folded in or starts entering the dedup key.
   */
  it('the same operation stated with and without its fee is one row', async () => {
    const first = await importRevolut(
      'Fee Two Statements',
      WITH_FEE,
      withFee('One Payment', '-9.50', '0.50', '11'),
    );
    expect(first.inserted).toBe(1);

    const second = await importAndConfirm({
      accountName: 'Fee Two Statements',
      currency: 'EUR',
      preset: 'revolut',
      bytes: Buffer.from([WITHOUT_FEE, withoutFee('One Payment', '-10.00', '11')].join('\n'), 'utf8'),
    });
    expect(second.inserted).toBe(0);
    expect(await listTransactions({ accountId: first.accountId })).toHaveLength(1);
  });
});

/**
 * The gate the sheet path did not have (ROADMAP row 54). The statement prints a
 * running balance after each row, so every accepted row is a step from the balance
 * before it to the one after it, and a complete statement's steps form ONE unbroken
 * run. A row the parser dropped or misread splits the run in two, and the gap where
 * it splits is the missing money.
 *
 * Every fixture below is fabricated, and the three headline numbers of the first case
 * are the ones the owner's real July export was measured to state: two products under
 * one balance column, 387.40 at the start, 579.85 at the end, 192.45 net - which is
 * also what the PDF of the same month prints about itself.
 */
describe("the statement's own running balance, on the sheet path", () => {
  const HEADER =
    'Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance';
  /** the same export from a bank that does not print one, which has to keep importing */
  const NO_BALANCE =
    'Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State';

  interface Row {
    description: string;
    amount: string;
    /** the running balance after this row; '' is a cell the file left empty */
    balance?: string;
    product?: string;
    fee?: string;
    currency?: string;
    state?: string;
    day?: string;
  }

  const line = (r: Row): string =>
    [
      'CARD_PAYMENT',
      r.product ?? 'Current',
      `2026-09-${r.day ?? '01'} 09:00:00`,
      `2026-09-${r.day ?? '01'} 10:00:00`,
      r.description,
      r.amount,
      r.fee ?? '0.00',
      r.currency ?? 'EUR',
      r.state ?? 'COMPLETED',
      r.balance ?? '',
    ].join(',');

  const upload = (accountName: string, header: string, rows: Row[]) =>
    importStatement({
      accountName,
      currency: 'EUR',
      preset: 'revolut',
      bytes: Buffer.from([header, ...rows.map(line)].join('\n'), 'utf8'),
    });

  const summaryOf = async (accountName: string, ...rows: Row[]) => {
    const result = await upload(accountName, HEADER, rows);
    if (result.outcome !== 'awaiting_confirmation') {
      throw new Error(`expected a summary, got ${JSON.stringify(result)}`);
    }
    return result.summary;
  };

  const refusalOf = async (accountName: string, ...rows: Row[]): Promise<string> => {
    const thrown = await summaryOf(accountName, ...rows).then(
      () => null,
      (e: Error) => e,
    );
    if (!thrown) throw new Error('expected a refusal, got a summary');
    return thrown.message;
  };

  // Текущий 72.40 -> 66.72 -> 166.72 -> 134.85 and Сбережения 315.00 -> 445.00, in
  // the real export's own shape: two products interleaved under one balance column,
  // the single-row one first, and the file in no date order at all
  const SAVINGS: Row = {
    description: 'Savings top-up',
    product: 'Savings',
    amount: '130.00',
    balance: '445.00',
    day: '02',
  };
  const CARD: Row = { description: 'Card payment', amount: '-5.68', balance: '66.72', day: '03' };
  const IN: Row = { description: 'Incoming', amount: '100.00', balance: '166.72', day: '04' };
  const RENT: Row = { description: 'Rent', amount: '-31.87', balance: '134.85', day: '05' };

  it('two products under one balance column reconcile to the pair the file implies', async () => {
    const summary = await summaryOf('Balance Two Series', SAVINGS, RENT, CARD, IN);

    expect(summary.accepted).toBe(4);
    // neither number appears in any cell of the file: they are sums across the two
    // running balances it states, which is why the card has to say how many
    expect(summary.balances).toEqual({
      opening: 387.40,
      closing: 579.85,
      currency: 'EUR',
      series: 2,
    });
    expect(summary.balancesNotShown).toBeUndefined();
    expect(summary.totals).toEqual([{ currency: 'EUR', net: 192.45 }]);
  });

  /**
   * R1, and the reason the check is stated over links rather than over the first and
   * last row: file order is a property of one bank's exporter, and the day one of
   * them ships newest-first a gate that read row 1 as the opening starts refusing
   * good statements. Nothing here reads a row index.
   */
  it('the verdict and the pair are the same under any order of the rows', async () => {
    const expected = {
      opening: 387.40,
      closing: 579.85,
      currency: 'EUR',
      series: 2,
    };
    const shuffled = await summaryOf('Balance Shuffled', IN, SAVINGS, RENT, CARD);
    expect(shuffled.balances).toEqual(expected);
    // fully reversed, which is what a newest-first export is
    const reversed = await summaryOf('Balance Reversed', IN, CARD, RENT, SAVINGS);
    expect(reversed.balances).toEqual(expected);
  });

  /**
   * The €2.99 case, which is the whole reason this row exists: a row that never
   * reached the import, found by the file's own arithmetic instead of by a human
   * comparing two formats a month later.
   */
  it('one row removed is refused, and the sentence names the gap', async () => {
    // in posting order, so the two lines the sentence names really are the two the
    // missing operation sat between and the gap really is its movement.
    //
    // "Current" and not "current": the Product cell is folded to decide which rows
    // share a running balance, and the folded form may not reach the sentence
    expect(await refusalOf('Balance Row Removed', CARD, RENT)).toBe(
      'this statement\'s own running balance breaks: in "Current" the line stating' +
        ' 134.85 EUR does not follow the one stating 66.72 EUR - 100.00 EUR is unaccounted' +
        ' for between them, so an operation is probably missing - export the same statement' +
        ' again from your online banking and upload it',
    );
  });

  /**
   * Q7, and the limit of the diagnostic said out loud. The VERDICT is order-independent
   * and this file is refused either way; the two lines the sentence names are the first
   * adjacent pair that does not chain in the file's own order, so on a file that is not
   * in posting order they are a true fact about two lines rather than the missing
   * operation. The wording claims only that one does not follow the other.
   */
  it('the same file out of order is refused too, naming two lines that do not chain', async () => {
    expect(await refusalOf('Balance Row Removed Shuffled', RENT, CARD)).toBe(
      'this statement\'s own running balance breaks: in "Current" the line stating' +
        ' 66.72 EUR does not follow the one stating 134.85 EUR - 62.45 EUR is unaccounted' +
        ' for between them, so an operation is probably missing - export the same statement' +
        ' again from your online banking and upload it',
    );
  });

  /** No tolerance, anywhere: one cent of slack hides a systematically dropped fee. */
  it('a one-cent break is a break', async () => {
    expect(await refusalOf('Balance One Cent', { ...CARD, balance: '66.73' }, IN, RENT)).toContain(
      '0.01 EUR is unaccounted for between them',
    );
  });

  /**
   * Cents throughout, never decimals: 0.10 + 0.20 is 0.30000000000000004 in binary
   * floating point, and a comparison made there refuses a statement that is exact.
   */
  it('a statement of tenths reconciles', async () => {
    const summary = await summaryOf(
      'Balance Tenths',
      { description: 'One', amount: '0.10', balance: '0.10', day: '06' },
      { description: 'Two', amount: '0.20', balance: '0.30', day: '07' },
      { description: 'Three', amount: '0.30', balance: '0.60', day: '08' },
    );
    expect(summary.balances).toMatchObject({ opening: 0, closing: 0.6, series: 1 });
  });

  /**
   * Connectivity is load-bearing rather than decoration: the degrees below balance
   * everywhere but the second pair is a run of its own, and a check that counted only
   * excesses would call this one unbroken series.
   */
  it('a proper chain plus a detached cycle is two runs, and is refused', async () => {
    expect(
      await refusalOf(
        'Balance Detached Cycle',
        { description: 'A', amount: '10.00', balance: '110.00', day: '09' },
        { description: 'B', amount: '20.00', balance: '130.00', day: '10' },
        { description: 'C', amount: '100.00', balance: '600.00', day: '11' },
        { description: 'D', amount: '-100.00', balance: '500.00', day: '12' },
      ),
    ).toContain("this statement's own running balance breaks");
  });

  /**
   * DoD 4, and feeColumn's argument applied to a second slot: the balance column is
   * resolved outside resolvePreset, so it records no unresolved slot and cannot refuse
   * a header - and resolveColumns is the XLSX header scan's predicate too.
   */
  it('a Revolut-preset header with no balance column imports exactly as it did', async () => {
    const result = await upload('Balance Column Absent', NO_BALANCE, [
      { description: 'First', amount: '-10.00', day: '13' },
      { description: 'Second', amount: '-20.00', day: '14' },
    ]);
    if (result.outcome !== 'awaiting_confirmation') throw new Error('expected a summary');

    expect(result.summary.accepted).toBe(2);
    expect(result.summary.skipped).toBe(0);
    // both absent: this file never claimed to carry a balance, so nothing on the
    // screen may say it could not be checked (row 6b, Trap 9)
    expect(result.summary.balances).toBeUndefined();
    expect(result.summary.balancesNotShown).toBeUndefined();
  });

  /**
   * R10's second class, and the case that would otherwise be a regression on the
   * fallback path: the pending row states a balance the import correctly drops, so the
   * run the gate can see has a hole in it that is not missing money. The gate turns
   * itself off and says which state it is in - it does not refuse, and it does not
   * spell the same as a file that states no balance at all.
   */
  it('a skipped row that states a balance turns the gate off rather than refusing', async () => {
    const summary = await summaryOf(
      'Balance Covers Skipped',
      { description: 'Before', amount: '-10.00', balance: '90.00', day: '15' },
      {
        description: 'Pending',
        amount: '-15.00',
        balance: '75.00',
        state: 'PENDING',
        day: '16',
      },
      { description: 'After', amount: '-5.00', balance: '70.00', day: '17' },
    );
    expect(summary.accepted).toBe(2);
    expect(summary.balances).toBeUndefined();
    expect(summary.balancesNotShown).toBe('rows-outside-the-balance');
  });

  it('an imported row that states no balance turns it off too', async () => {
    const summary = await summaryOf(
      'Balance Missing Cell',
      { description: 'Stated', amount: '-10.00', balance: '90.00', day: '18' },
      { description: 'Unstated', amount: '-5.00', day: '19' },
    );
    expect(summary.accepted).toBe(2);
    expect(summary.balances).toBeUndefined();
    expect(summary.balancesNotShown).toBe('rows-without-a-balance');
  });

  /**
   * D14, and the two cases the pair above cannot pin: both of them are single-series
   * files, where "a run we cannot use turns the gate off" and "a broken run refuses"
   * agree. They disagree the moment a file has two running balances and one of each,
   * and there the file's own arithmetic saying money is missing outranks our
   * uncertainty about a DIFFERENT balance - one blank cell anywhere would otherwise
   * disarm the refusal for the whole file, which is the €2.99 case surviving the row
   * built to catch it.
   */
  it('a run we cannot use does not disarm a break in another one', async () => {
    expect(
      await refusalOf(
        'Balance Unusable Beside Broken',
        CARD,
        RENT,
        { description: 'Savings, no cell', product: 'Savings', amount: '130.00', day: '26' },
      ),
    ).toContain('100.00 EUR is unaccounted for between them');
  });

  it('and neither does a skipped row that states a balance', async () => {
    expect(
      await refusalOf(
        'Balance Skipped Beside Broken',
        CARD,
        RENT,
        SAVINGS,
        {
          description: 'Savings pending',
          product: 'Savings',
          amount: '-40.00',
          balance: '370.00',
          state: 'PENDING',
          day: '27',
        },
      ),
    ).toContain('100.00 EUR is unaccounted for between them');
  });

  /**
   * Q5: the run is provably unbroken, and the balances alone cannot say which value it
   * starts at. Nothing says money is missing, so refusing would be the R10 mistake.
   */
  it('a series that ends where it began shows no pair and is not refused', async () => {
    const summary = await summaryOf(
      'Balance Circuit',
      { description: 'Up', amount: '10.00', balance: '110.00', day: '20' },
      { description: 'Down', amount: '-10.00', balance: '100.00', day: '21' },
    );
    expect(summary.accepted).toBe(2);
    expect(summary.balances).toBeUndefined();
    expect(summary.balancesNotShown).toBe('balance-closes-on-itself');
  });

  /**
   * Trap 5. The pdf arm REFUSES a file whose rows are not all in the balances'
   * currency, because the document states its box in one; the sheet arm must not
   * inherit that - a Revolut file with two pockets imports today and nothing printed a
   * single claim about it. Each currency is its own running balance, each is checked,
   * and what is missing is only the pair.
   */
  it('a file carrying two currencies is checked per currency and still imports', async () => {
    const summary = await summaryOf(
      'Balance Two Currencies',
      { description: 'Euro out', amount: '-5.00', balance: '95.00', day: '22' },
      { description: 'Zloty out', amount: '-20.00', balance: '80.00', currency: 'PLN', day: '23' },
    );
    expect(summary.accepted).toBe(2);
    expect(summary.balances).toBeUndefined();
    expect(summary.balancesNotShown).toBe('more-than-one-currency');
  });

  it('and a break in either of them still refuses the file', async () => {
    expect(
      await refusalOf(
        'Balance Two Currencies Broken',
        { description: 'Euro out', amount: '-5.00', balance: '95.00', day: '22' },
        { description: 'Zloty A', amount: '-20.00', balance: '80.00', currency: 'PLN', day: '23' },
        { description: 'Zloty B', amount: '-20.00', balance: '40.00', currency: 'PLN', day: '24' },
      ),
    ).toContain('20.00 PLN is unaccounted for between them');
  });

  /**
   * Trap 3, and it is a behaviour change on merged code stated rather than discovered:
   * a row with an unreadable fee is refused row-level and deliberately so (037a), but
   * the money really did not import, and the statement's own balance now says so. The
   * file-level refusal is the right end of that - an import short by a row, reported as
   * complete, is the failure CLAUDE.md ranks above a crash.
   */
  it('a row refused for its fee refuses the file, and is named as the cause', async () => {
    const message = await refusalOf('Balance Fee Refused', CARD, { ...IN, fee: 'cucumber' }, RENT);
    expect(message).toContain('100.00 EUR is unaccounted for between them');
    expect(message).toContain(
      'the 1 transaction line this importer could not read are probably where it went',
    );
  });

  /**
   * Trap 4, and it needs no special case: a row whose movement is zero is dropped
   * before it becomes a transaction, and its balance equals its predecessor's - so the
   * step it would have been is a loop on one value, and removing it changes no degree
   * and joins no two values.
   */
  it('a zero-movement row is dropped and the run is unaffected', async () => {
    const summary = await summaryOf(
      'Balance Zero Movement',
      CARD,
      { description: 'Nothing moved', amount: '0.00', balance: '66.72', day: '25' },
      IN,
      RENT,
    );
    expect(summary.accepted).toBe(3);
    expect(summary.skipped).toBe(1);
    expect(summary.balances).toEqual({
      opening: 72.40,
      closing: 134.85,
      currency: 'EUR',
      series: 1,
    });
  });

  /**
   * And the cause clause counts rows the parser genuinely failed on, never the ones it
   * dropped on purpose (row 6b, R5). A zero-movement row was read perfectly and is
   * provably not where the money went - its balance is a self-loop - so pointing the
   * user at it names a cause that is not the cause.
   */
  it('a row dropped for a zero movement is not named as a line that could not be read', async () => {
    const message = await refusalOf(
      'Balance Zero Movement Broken',
      CARD,
      { description: 'Nothing moved', amount: '0.00', balance: '66.72', day: '25' },
      RENT,
    );
    expect(message).toContain('100.00 EUR is unaccounted for between them');
    expect(message).toContain('so an operation is probably missing');
    expect(message).not.toContain('could not read');
  });

  /**
   * The two arrays are aligned by index and by nothing else, and every link is built
   * from `stated.rows[i]` against `txs[i]`. A caller that filtered `txs` between
   * building the pairs and calling this would read every balance against the wrong
   * row - refusing good files or passing broken ones, and never indexing past the end,
   * so nothing would fail. The check is structural because a review pass cannot see
   * the edit that breaks it.
   */
  it('reconcile refuses balances that are not one per transaction', () => {
    const parsed: ParsedFile = {
      kind: 'sheet',
      sheet: { rows: [], rowLabel: (i) => i },
      preset: null,
      mapping: undefined,
    };
    const tx: NewTransaction = {
      accountId: 'a',
      provider: 'upload',
      amount: -1,
      currency: 'EUR',
      date: '2026-09-01T00:00:00.000Z',
      description: 'One',
      category: 'other',
      fee: null,
    };
    expect(() =>
      reconcile(parsed, [tx], 0, {
        kind: 'stated',
        rows: [
          { series: '', label: '', postCents: 100 },
          { series: '', label: '', postCents: 90 },
        ],
        coveredButSkipped: [],
        unreadable: 0,
      }),
    ).toThrow('stated balances and transactions are not the same length');
  });

  /**
   * Trap 9: the XLSX path shares this arm and there is no real Revolut workbook in the
   * tree. A workbook hands the mapper a float where a CSV hands it a string, so this
   * is the other branch of the Cell seam through the same gate - and there is no second
   * implementation for it to drift from.
   */
  describe('the same gate through a workbook', () => {
    const workbook = async (rows: (string | number | Date)[][]): Promise<Buffer> => {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Statement');
      ws.addRow(HEADER.split(','));
      for (const r of rows) ws.addRow(r);
      return Buffer.from(await wb.xlsx.writeBuffer());
    };
    const sheetRow = (
      description: string,
      amount: number,
      balance: number,
      day: number,
    ): (string | number | Date)[] => [
      'CARD_PAYMENT',
      'Current',
      new Date(`2026-09-${String(day).padStart(2, '0')}T09:00:00.000Z`),
      new Date(`2026-09-${String(day).padStart(2, '0')}T10:00:00.000Z`),
      description,
      amount,
      0,
      'EUR',
      'COMPLETED',
      balance,
    ];

    it('reconciles off numeric balance cells', async () => {
      const result = await importStatement({
        accountName: 'Balance Workbook',
        currency: 'EUR',
        preset: 'revolut',
        bytes: await workbook([
          sheetRow('Book card', -5.68, 66.72, 3),
          sheetRow('Book in', 100, 166.72, 4),
          sheetRow('Book rent', -31.87, 134.85, 5),
        ]),
      });
      if (result.outcome !== 'awaiting_confirmation') throw new Error('expected a summary');
      expect(result.summary.balances).toEqual({
        opening: 72.40,
        closing: 134.85,
        currency: 'EUR',
        series: 1,
      });
    });

    it('and refuses the same workbook with a row taken out', async () => {
      const thrown = await importStatement({
        accountName: 'Balance Workbook Broken',
        currency: 'EUR',
        preset: 'revolut',
        bytes: await workbook([
          sheetRow('Book card', -5.68, 66.72, 3),
          sheetRow('Book rent', -31.87, 134.85, 5),
        ]),
      }).catch((e) => e as Error);
      expect((thrown as Error).message).toContain('100.00 EUR is unaccounted for between them');
    });
  });
});

/**
 * The two sentences this row composes, at their extremes rather than on an example.
 * Both are bounded by constants that a later "the values are longer than that"
 * would raise without anything else noticing.
 */
describe('what the new refusals may spend', () => {
  it('every preset composes a refusal error_detail keeps whole', async () => {
    for (const key of Object.keys(CSV_PRESETS)) {
      const thrown = await importStatement({
        accountName: `Budget ${key}`,
        currency: 'EUR',
        preset: key,
        bytes: Buffer.from(`nothing,matches,here\n${key},2,3`, 'utf8'),
      }).catch((e) => e as Error);

      expect(thrown.message).toMatch(/^no column matched for /);
      expect(thrown.message.length).toBeLessThanOrEqual(ERROR_DETAIL_MAX);
      // the actionable half alone, since the header dump is what yields
      expect(thrown.message.split('; the header reads:')[0].length).toBeLessThanOrEqual(
        ERROR_DETAIL_MAX,
      );
    }
  });

  /**
   * The other cap, and the one that binds first: on the XLSX path this refusal is
   * carried inside closestClause, whose 300 characters are cut mid-token. Every cut
   * lands in prose today, so nothing reaching a user names a column the file has not
   * got - but that is held by a measurement rather than by margin, and each accepted
   * name added to a slot ahead of the cut spends its own length plus 4 of it. An odd
   * number of quotes in the delivered message is exactly a quoted name cut in half.
   *
   * Through a real workbook, because the cap lives in xlsx.ts and only a delivered
   * message says what was cut. Both headers, because which preset composes the
   * longest refusal depends on the header: revolut resolves amount and description
   * out of an English one and is then the shortest of the three, and the longest
   * against a header it matches nothing in.
   */
  it('no preset composes an xlsx refusal that is cut through a column name', async () => {
    for (const header of [
      ['date', 'amount', 'description'],
      ['nothing', 'matches', 'here'],
    ]) {
      for (const key of Object.keys(CSV_PRESETS)) {
        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet('Statement');
        ws.addRow(header);
        ws.addRow([new Date('2026-09-01T00:00:00.000Z'), -5, 'one']);

        const thrown = await importStatement({
          accountName: `Cut ${key} ${header[0]}`,
          currency: 'EUR',
          preset: key,
          bytes: Buffer.from(await wb.xlsx.writeBuffer()),
        }).catch((e) => e as Error);

        // the refusal is in there at all, so an even count cannot pass by vacancy
        expect(thrown.message).toContain('no column matched for ');
        const quotes = (thrown.message.match(/"/g) ?? []).length;
        expect(quotes % 2, `${key} against ${header.join(',')}: ${thrown.message}`).toBe(0);
      }
    }
  });

  /**
   * 199 is what xlsx.ts derives NOTICE_MAX from - "the longest reason the parser
   * composes". Restated here rather than imported, because when it moves a human
   * should be made to look at that arithmetic again. Swept rather than sampled: the
   * value list's bound is spent differently by many short values than by one long
   * one, and only one of the two arrangements is the maximum.
   */
  it('the skipped-status reason stays under the number NOTICE_MAX is derived from', () => {
    let longest = 0;
    for (let width = 1; width <= 40; width++) {
      for (let distinct = 1; distinct <= 60; distinct++) {
        const counts = new Map<string, number>();
        for (let i = 0; i < distinct; i++) counts.set(`${'V'.repeat(width)}${i}`, MAX_DATA_ROWS - i);
        const composed = noRowsParsed(MAX_DATA_ROWS, [], [], {
          column: 'C'.repeat(200),
          counts,
          skipped: MAX_DATA_ROWS,
        });
        longest = Math.max(longest, composed.length);
      }
    }
    expect(longest).toBeLessThanOrEqual(199);
  });

  /**
   * The same 199, for the sentence an unreadable fee cell composes. Through
   * feeRefused rather than through an import, because the extreme is a row label at
   * Excel's own ceiling and no file this suite can build reaches one. Swept over the
   * cell width, since what FEE_QUOTE_MAX buys is only spent by a cell wide enough to
   * be cut.
   */
  it('the unreadable-fee reason stays under the number NOTICE_MAX is derived from', () => {
    const sheet: Sheet = { rows: [], rowLabel: () => 1_048_576 };
    let longest = 0;
    for (let width = 1; width <= 200; width++) {
      const composed = noRowsParsed(
        MAX_DATA_ROWS,
        [feeRefused(sheet, 1, 'Ф'.repeat(width))],
        [],
        null,
      );
      longest = Math.max(longest, composed.length);
    }
    expect(longest).toBeLessThanOrEqual(199);
  });

  /**
   * And row 54's, against ERROR_DETAIL_MAX rather than against 199: it is a throw from
   * reconcile, not a clause of noRowsParsed, so xlsx.ts's NOTICE_MAX is untouched by
   * it. Built FROM the bounds rather than beside them (row 6b, D10) - the currency
   * code is composed out of CURRENCY_CODE_MAX, and the series name is swept rather
   * than sampled because what its bound buys is only spent by a name wide enough to
   * be cut.
   *
   * Every amount is at the widest toFixed(2) produces before it turns to exponential
   * notation, and negative, which is the only way any of the three can be wider still.
   * Both shapes of the sentence, because the located-pair clause is what a run whose
   * every adjacent pair chains cannot supply.
   */
  it('the broken-balance refusal fits what error_detail keeps, at its extreme', () => {
    const located = {
      before: { preCents: 0, postCents: -1e22 },
      after: { preCents: -3e22, postCents: -1e22 },
    };
    let longest = 0;
    for (let width = 1; width <= 200; width++) {
      for (const unreadable of [0, MAX_DATA_ROWS]) {
        for (const at of [located, undefined]) {
          const composed = balanceBreaks(
            'П'.repeat(width),
            'C'.repeat(CURRENCY_CODE_MAX + 2),
            at,
            unreadable,
          );
          expect(composed).toContain("this statement's own running balance breaks");
          longest = Math.max(longest, composed.length);
        }
      }
    }
    expect(longest).toBeLessThanOrEqual(ERROR_DETAIL_MAX);
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
    const wide = await importAndConfirm({
      accountName: 'Utf16 Bank',
      currency: 'EUR',
      bytes: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]),
    });
    const narrow = await importAndConfirm({
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
    const wide = await importAndConfirm({
      accountName: 'Utf16be Bank',
      currency: 'EUR',
      bytes: Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, 'utf16le').swap16()]),
    });
    const narrow = await importAndConfirm({
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
