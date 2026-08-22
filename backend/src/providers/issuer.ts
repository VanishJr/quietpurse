/**
 * Who issued a statement no template matched, read off the IBANs the document itself
 * prints. Nothing here can reach back into the template decision: the module imports no
 * template, its parameter cannot express one and its return type cannot be one.
 */

/** The shortest IBAN any country has registered, and the most ISO 13616 allows. */
const IBAN_MIN = 15;
const IBAN_MAX = 34;

const ALNUM = /[A-Z0-9]/u;

interface Bban {
  /** the whole IBAN's length, which is fixed per country */
  length: number;
  /** the half-open slice of the IBAN that is the bank identifier */
  bank: readonly [number, number];
}

/**
 * Country by country from the IBAN Registry, the ISO 13616-2 structure list SWIFT
 * publishes as registration authority. DE is `8!n` bank identifier + `10!n` account,
 * so the identifier is characters [4, 12) of 22. A country absent here yields no
 * identifier at all, which is what stops an unfamiliar BBAN being mis-sliced into a
 * bank code that means something else.
 */
const COUNTRIES: Readonly<Record<string, Bban>> = {
  DE: { length: 22, bank: [4, 12] },
};

/**
 * (country, bank identifier) -> what to call the institution. Every value is the
 * `Kurzbezeichnung` field of the Deutsche Bundesbank Bankleitzahlendatei, read one row
 * at a time.
 *
 * Adding one can never change WHICH candidate wins - the collapse to a single pair
 * happens before this lookup - only whether the winner has a name.
 */
export const ISSUERS: Readonly<Record<string, string>> = {
  'DE 50024024': 'C24 Bank',
  'DE 10011001': 'N26 Bank Berlin',
  'DE 10010178': 'Revolut Bank, Berlin',
};

/**
 * ISO 7064 MOD 97-10, one character at a time. `BigInt(iban)` throws on a literal it
 * cannot parse and nothing in this module may throw; a remainder that never leaves
 * 0..96 cannot.
 */
const checks = (iban: string): boolean => {
  let rem = 0;
  for (const ch of `${iban.slice(4)}${iban.slice(0, 4)}`) {
    const code = ch.charCodeAt(0);
    // A-Z stand for 10..35, which is two digits and not one
    rem = code > 57 ? (rem * 100 + code - 55) % 97 : (rem * 10 + code - 48) % 97;
  }
  return rem === 1;
};

/**
 * What one page prints that could be an IBAN, keyed by what a name would be asserted
 * from: `${country} ${bank identifier}` where the country's structure is known, and
 * the token's own first IBAN_MIN characters where it is not.
 *
 * A token from an unregistered country is kept rather than dropped, and that is the
 * difference between a lost name and a wrong one: dropped, a statement whose OWN IBAN
 * is foreign collapses onto whatever single German counterparty it happens to print on
 * every page, and gets named after it. Kept, it survives the every-page filter like
 * any other token and poisons the collapse - so it silences the name only when it too
 * is on every page. Keying it by its first IBAN_MIN characters rather than by the
 * whole run is what makes that survive a document that prints the same foreign IBAN
 * with a BIC glued to it on one page and without on the next.
 *
 * The length is read from the country table rather than matched, so no quantifier is
 * ever applied to document text: the walk is bounded and the slice is fixed, and a
 * token immediately after an IBAN - `IBAN: DE00… BIC: …`, which this parser's line
 * grouping does sometimes join - is simply not inside it.
 */
const tokens = (lines: readonly string[]): Set<string> => {
  const found = new Set<string>();
  for (const line of lines) {
    // per line, so that squashing whitespace cannot join the tail of one line to the
    // head of the next and fabricate a token neither of them printed
    const s = line.replace(/\s+/gu, '');
    for (const m of s.matchAll(/[A-Z]{2}[0-9]{2}/gu)) {
      const at = m.index;
      if (at === undefined) continue;
      let end = at;
      while (end - at < IBAN_MAX && ALNUM.test(s.charAt(end))) end++;
      // shorter than any registered IBAN: a creditor reference, not a candidate
      if (end - at < IBAN_MIN) continue;
      const code = s.slice(at, at + 2);
      const country = COUNTRIES[code];
      if (country === undefined) {
        found.add(s.slice(at, at + IBAN_MIN));
        continue;
      }
      if (end - at < country.length) continue;
      const iban = s.slice(at, at + country.length);
      if (!checks(iban)) continue;
      found.add(`${code} ${iban.slice(country.bank[0], country.bank[1])}`);
    }
  }
  return found;
};

/**
 * The institution whose statement this is, or nothing.
 *
 * Page-grouped text, one entry per page of the DOCUMENT including a page that produced
 * no lines: a denominator counted from the pages that happened to yield text is
 * derived from the same data it checks, and a four-page PDF whose last two pages carry
 * no text layer would make a counterparty printed on the first two "on every page".
 *
 * Total by construction - no parse, no BigInt, no unchecked index, no throw - because
 * it decides only HOW a refusal is worded and never whether one happens.
 */
export function issuerName(pages: readonly (readonly string[])[]): string | null {
  if (pages.length < 2) return null;

  const [first, ...rest] = pages.map(tokens);
  if (first === undefined) return null;

  const [only, ...more] = [...first].filter((key) => rest.every((page) => page.has(key)));
  if (only === undefined || more.length > 0) return null;
  return ISSUERS[only] ?? null;
}
