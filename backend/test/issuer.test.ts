/**
 * The issuer scan, at the seam it is unit-testable on: page-grouped text in, a name or
 * nothing out. No PDF is built here. What a PDF costs this rule is one page boundary,
 * and pdf.test.ts pins that end.
 *
 * Every IBAN below is invented and its check digits worked out by hand. None of them
 * is derived from ISSUERS, which is not tidiness: a fixture composed from the rule's
 * own literal goes on passing under every narrowing of that rule. The bank identifiers
 * are public routing data, from the Bundesbank file the directory's comment names. The
 * account digits after them are zeroes but for the last.
 */
import { describe, expect, it } from 'vitest';
import { issuerName } from '../src/providers/issuer';

// the three the directory carries, one made-up account each
const C24 = 'DE64500240240000000001';
const N26 = 'DE65100110010000000002';
const N26_OTHER = 'DE70100110010000000009';
const REVOLUT = 'DE42100101780000000003';
// a German bank code the directory does not carry, and a country the table does not
const UNLISTED = 'DE12999999990000000004';
const FOREIGN = 'LT711600000000000005';
const FOREIGN_OTHER = 'LT441600000000000006';
// the same shape as C24 above with the check digits it does not have
const CORRUPT = 'DE00500240240000000001';

/** A page of ordinary statement furniture, so no case is a bare IBAN on a blank page. */
const page = (...printed: string[]): string[] => [
  'Kontoauszug 06/2026',
  ...printed,
  '02.07.2026 REWE SAGT DANKE -5,68',
  'Seite 1',
];

describe('issuerName: what appears on every page', () => {
  /**
   * The measured shape of the owner's own N26 statement, and the whole of the evidence
   * the ranking rule rests on: the account's IBAN once per page across six pages, a
   * counterparty's twice a page across four. The counterparty is the more frequent by two
   * to one, and it is at a bank this directory also knows. A rule that ranked by
   * occurrences would name the counterparty's bank, confidently, to someone holding an
   * N26 statement.
   */
  it("names the account's bank and not the louder counterparty", () => {
    const pages = [1, 2, 3, 4, 5, 6].map((n) =>
      page(`IBAN: ${N26}`, ...(n <= 4 ? [`Empfänger: ${C24}`, `Auftraggeber: ${C24}`] : [])),
    );
    expect(issuerName(pages)).toBe('N26 Bank Berlin');
  });

  it('names nothing when two banks it knows are both on every page', () => {
    const pages = [1, 2, 3].map(() => page(`IBAN: ${N26}`, `Empfänger: ${C24}`));
    expect(issuerName(pages)).toBeNull();
  });

  it('collapses two accounts at one bank onto the bank', () => {
    const pages = [1, 2, 3].map(() => page(`IBAN: ${N26}`, `Unterkonto: ${N26_OTHER}`));
    expect(issuerName(pages)).toBe('N26 Bank Berlin');
  });

  /**
   * The Revolut directory entry. Without this case its key or its name could be retyped
   * wrong and the whole suite would stay green: the entry would simply never fire, and a
   * Revolut statement whose layout has moved would fall back to the unnamed sentence
   * with nothing red anywhere.
   */
  it('names the third bank the directory carries', () => {
    expect(issuerName([1, 2].map(() => page(`IBAN: ${REVOLUT}`)))).toBe('Revolut Bank, Berlin');
  });

  /**
   * One page cannot show that an IBAN is page furniture, and page furniture is the
   * entire claim. A single-page statement carrying one SEPA payment and no IBAN of its
   * own would otherwise be named after the payee.
   */
  it('names nothing on one page, however unambiguous the page is', () => {
    expect(issuerName([page(`IBAN: ${REVOLUT}`)])).toBeNull();
    expect(issuerName([])).toBeNull();
  });

  /**
   * The denominator is the document's pages and not the pages that yielded text. A
   * four-page PDF whose last page has no text layer still averages well past
   * MIN_CHARS_PER_PAGE, so it reaches this rule, and a counterparty on the three that
   * do carry text must not become "on every page" of a three-entry array.
   */
  it('counts a page that printed nothing', () => {
    const printed = [1, 2, 3].map(() => page(`Empfänger: ${C24}`));
    expect(issuerName(printed)).toBe('C24 Bank');
    expect(issuerName([...printed, []])).toBeNull();
  });
});

describe('issuerName: what counts as an IBAN', () => {
  /**
   * The real C24 statement prints the IBAN after `IBAN:` with `BIC: …` on the baseline
   * just below it, which this parser groups as two lines. Other banks print the grouped
   * spelling. All three spellings have to reach the same bank. The one that would catch
   * a greedy run replacing the fixed-length slice is the middle one: squashing THAT line
   * yields a token running into `BIC`, which fails mod-97 as a whole.
   */
  it('reads the spellings a statement actually prints as the same bank', () => {
    const twoLines = [`IBAN: ${C24}`, 'BIC: DEFFDEFFXXX'];
    const oneLine = [`IBAN: ${C24} BIC: DEFFDEFFXXX`];
    const grouped = ['IBAN: DE64 5002 4024 0000 0000 01'];
    for (const printed of [twoLines, oneLine, grouped]) {
      expect(issuerName([page(...printed), page(...printed)])).toBe('C24 Bank');
    }
  });

  it('discards a run that fails its check digits rather than letting it block a name', () => {
    const pages = [1, 2, 3].map(() => page(`IBAN: ${N26}`, `Verwendungszweck: ${CORRUPT}`));
    expect(issuerName(pages)).toBe('N26 Bank Berlin');
    // and on its own it is not a candidate either, so there is nothing to name
    expect(issuerName([1, 2].map(() => page(`IBAN: ${CORRUPT}`)))).toBeNull();
  });

  it('ignores a reference too short to be any registered IBAN', () => {
    const pages = [1, 2].map(() => page(`IBAN: ${C24}`, 'Referenz: RF18000000123'));
    expect(issuerName(pages)).toBe('C24 Bank');
  });
});

describe('issuerName: where it must not guess', () => {
  it('names nothing for a German bank code the directory does not carry', () => {
    expect(issuerName([1, 2].map(() => page(`IBAN: ${UNLISTED}`)))).toBeNull();
  });

  it('names nothing for a country the structure table does not carry', () => {
    expect(issuerName([1, 2].map(() => page(`IBAN: ${FOREIGN}`)))).toBeNull();
  });

  /**
   * The two halves of the poison rule, and they are the difference between a lost name
   * and a wrong one. A token whose country has no entry cannot be dropped before the
   * every-page filter: a Ukrainian statement printing one German counterparty on every
   * page would then collapse onto that counterparty and be named after it. Nor may it
   * poison before the filter, or one foreign IBAN anywhere in a document silences the
   * name its own every-page IBAN earned.
   */
  it('is silenced by a foreign IBAN on every page, and not by one on a single page', () => {
    const both = [1, 2, 3].map(() => page(`IBAN: ${N26}`, `Empfänger: ${FOREIGN}`));
    expect(issuerName(both)).toBeNull();

    const once = [1, 2, 3].map((n) => page(`IBAN: ${N26}`, ...(n === 1 ? [FOREIGN] : [])));
    expect(issuerName(once)).toBe('N26 Bank Berlin');
  });

  it('is silenced by two foreign IBANs that are on every page', () => {
    const pages = [1, 2].map(() => page(FOREIGN, FOREIGN_OTHER));
    expect(issuerName(pages)).toBeNull();
  });

  /**
   * The same foreign IBAN with a BIC glued to it on one page and without on the next.
   * Keyed by the whole run those are two tokens, neither on every page, and the German
   * counterparty beside them wins by default.
   */
  it('recognises a foreign IBAN as one token however it is printed', () => {
    const pages = [
      page(`IBAN: ${FOREIGN} BIC: REVOLT21XXX`, `Empfänger: ${C24}`),
      page(`IBAN: ${FOREIGN}`, `Empfänger: ${C24}`),
    ];
    expect(issuerName(pages)).toBeNull();
  });
});

/**
 * It decides how a refusal is worded and never whether one happens, so a throw here
 * would replace an actionable sentence with a stack trace in error_detail. It is total
 * by construction: no parse, no BigInt, no unchecked index. This is what watches the
 * construction.
 */
describe('issuerName: it answers on anything', () => {
  it('never throws', () => {
    const adversarial: string[][][] = [
      [[], []],
      [[''], ['']],
      [['\0\uFFFF\u{1F600}'], ['DE']],
      [['DE00'], ['DE00']],
      [[`DE${'0'.repeat(400)}`], [`DE${'0'.repeat(400)}`]],
      [['de65100110010000000002'], ['de65100110010000000002']],
      [[' '.repeat(5000)], ['\n\t\r'.repeat(1000)]],
      [[`${'A'.repeat(9999)}DE64`], ['DE64']],
    ];
    for (const pages of adversarial) {
      expect(() => issuerName(pages)).not.toThrow();
      expect(issuerName(pages)).toBeNull();
    }
  });
});
