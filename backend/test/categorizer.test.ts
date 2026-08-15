import crypto from 'crypto';
import { describe, expect, it } from 'vitest';
import {
  categorize,
  isRefund,
  INCOME_KEYWORD_RULES,
  KEYWORD_RULES,
  REFUND_MARKERS,
  RULES_VERSION,
} from '../src/categorizer';

/**
 * Glue for the "not inside a word" guard, taken from a DIFFERENT script than the
 * keyword's first letter. That is the only glue that catches both a bare `includes`
 * and a \b boundary: \b is defined over [A-Za-z0-9_], so it sees a boundary between
 * the Latin "x" and the Cyrillic "к" of "xкафе" and matches, while same-script glue
 * ("якафе") is refused by \b and by the real matcher alike and so tells them apart
 * from nothing.
 */
const glue = (keyword: string): string =>
  /\p{Script=Cyrillic}/u.test(keyword[0]) ? 'x' : 'я';

/**
 * Reddens whenever a rule list changes. Bump RULES_VERSION in src/categorizer.ts and
 * paste the value below — without the bump rulesSignature() does not move and the
 * change re-tags nobody's existing database.
 */
it('the rule lists carry the version that reaches existing databases', () => {
  const stamp = `${RULES_VERSION}:${crypto
    .createHash('sha256')
    .update(JSON.stringify([KEYWORD_RULES, INCOME_KEYWORD_RULES, REFUND_MARKERS]))
    .digest('hex')
    .slice(0, 12)}`;
  expect(stamp).toBe('9:d31e418ae7d2');
});

describe('the boundary rule, over the rule lists themselves', () => {
  it('no keyword matches inside a word', () => {
    const leaks: string[] = [];
    for (const [kw, cat, bound] of KEYWORD_RULES) {
      const d = glue(kw) + kw;
      if (categorize(undefined, d, -10) === cat) leaks.push(`spending: "${d}" -> ${cat}`);
      // The right-hand bound of a "word" keyword, glued cross-script for the same
      // reason as the left: "barx" is refused by \b too and so separates nothing.
      if (bound === 'word') {
        const r = kw + glue(kw);
        if (categorize(undefined, r, -10) === cat) leaks.push(`spending: "${r}" -> ${cat}`);
      }
    }
    for (const [kw, cat] of INCOME_KEYWORD_RULES) {
      const d = glue(kw) + kw;
      if (categorize(undefined, d, 10) === cat) leaks.push(`income: "${d}" -> ${cat}`);
    }
    for (const marker of REFUND_MARKERS) {
      const d = glue(marker) + marker;
      if (isRefund(10, d)) leaks.push(`refund: "${d}"`);
    }
    expect(leaks).toEqual([]);
  });

  it('every keyword still fires, and fires as itself', () => {
    const misses: string[] = [];
    for (const [kw, cat] of KEYWORD_RULES) {
      const got = categorize(undefined, kw, -10);
      if (got !== cat) misses.push(`spending: "${kw}" -> ${got}, expected ${cat}`);
    }
    for (const [kw, cat] of INCOME_KEYWORD_RULES) {
      const got = categorize(undefined, kw, 10);
      if (got !== cat) misses.push(`income: "${kw}" -> ${got}, expected ${cat}`);
    }
    for (const marker of REFUND_MARKERS) {
      if (!isRefund(10, marker)) misses.push(`refund: "${marker}"`);
    }
    expect(misses).toEqual([]);
  });
});

describe('categorize: spending', () => {
  it('MCC beats keywords', () => {
    expect(categorize(5411, 'anything at all', -10)).toBe('food');
    expect(categorize(5732, 'Miele Operations  Paym', -20)).toBe('shopping');
    expect(categorize(6011, '', -100)).toBe('cash');
  });

  it('German merchants from the dictionary (Enable Banking sends no MCC)', () => {
    expect(categorize(undefined, 'Rewe Markt Mueller', -14)).toBe('food');
    expect(categorize(undefined, 'Baeckerei Kranz Inh. T', -5)).toBe('food');
    expect(categorize(undefined, 'Www.riverty.com*bvg', -3.8)).toBe('transport');
    expect(categorize(undefined, 'Rsg Group Gmbh', -5.1)).toBe('health');
    expect(categorize(undefined, 'Vodafone Gmbh Callya', -15)).toBe('subscriptions');
    expect(categorize(undefined, 'Galaxus Deu Gmbh', -249)).toBe('shopping');
    expect(categorize(undefined, 'Miele Operations  Paym', -20)).toBe('shopping');
    expect(categorize(undefined, 'Cash at Vrb Musterbank eG', -31)).toBe('cash');
    expect(categorize(undefined, 'Faceit', -11)).toBe('entertainment');
  });

  it('rent by the German keyword', () => {
    expect(categorize(undefined, 'Miete Juli', -900)).toBe('housing');
    expect(categorize(undefined, 'Wohnung Nebenkosten', -120)).toBe('housing');
  });

  it('a specific rule comes before a general one', () => {
    expect(categorize(undefined, 'Kaufland Marketplace', -50)).toBe('shopping');
    expect(categorize(undefined, 'Kaufland Eppendorf', -20)).toBe('food');
    expect(categorize(undefined, 'Uber   *one Membership', -4.99)).toBe('subscriptions');
    expect(categorize(undefined, 'Uber Trip', -12)).toBe('transport');
  });

  it('unknown falls back to other', () => {
    expect(categorize(undefined, 'Something Random Gmbh', -10)).toBe('other');
  });
});

describe('word boundaries', () => {
  it('a keyword still matches the start of a longer word', () => {
    expect(categorize(undefined, "McDonald's Berlin", -9)).toBe('food');
    expect(categorize(undefined, 'Groceries Ltd', -30)).toBe('food');
    expect(categorize(undefined, 'ATB-Market', -120)).toBe('food');
    expect(categorize(undefined, 'Обмен валюты в банкоматах', -50)).toBe('cash');
    expect(categorize(undefined, 'Apple Отправитель: Apple.com/bill, Cork', -0.99))
      .toBe('subscriptions');
    expect(categorize(undefined, 'Cash at Vrb Musterbank eG', -31)).toBe('cash');
    expect(categorize(undefined, 'Uber   *one Membership', -4.99)).toBe('subscriptions');
    expect(categorize(undefined, 'P2P 4149***1234', -500)).toBe('transfers');
    expect(categorize(undefined, 'Зарахування зарплати', 20000)).toBe('salary');
  });

  it('a keyword does not match inside a word, in either script', () => {
    expect(categorize(undefined, 'Barcelona City Tour', -40)).toBe('other');
    expect(categorize(undefined, 'Barbershop Mitte', -25)).toBe('other');
    expect(categorize(undefined, 'Мкафе', -12)).toBe('other');
    expect(categorize(undefined, 'Скафедра', -12)).toBe('other');
  });

  it('a digit binds a keyword as tightly as a letter does', () => {
    expect(categorize(undefined, '7atb', -10)).toBe('other');
  });

  it('a whole-word keyword is bounded on the right as well', () => {
    expect(categorize(undefined, 'Lido Bar', -18)).toBe('food');
    expect(categorize(undefined, 'BAR A MARQUESA', -7)).toBe('food');
    expect(categorize(undefined, 'Bar, Coimbra', -7)).toBe('food');
    expect(categorize(undefined, 'Barcelona', -40)).toBe('other');
  });

  it('metro is a whole word now, so it also matches at the end of a description', () => {
    expect(categorize(undefined, 'Kyiv metro', -8)).toBe('transport');
    expect(categorize(undefined, 'Metro Ticket', -8)).toBe('transport');
    expect(categorize(undefined, 'Metropolitan Museum', -22)).toBe('other');
  });

  it('answers descriptions no dictionary was written for, without throwing', () => {
    const pathological = [
      '',
      '   ',
      '....',
      '\u0000',
      'ﬁ ﬂ ǅ',
      '🙂'.repeat(50),
      'A'.repeat(946),
    ];
    for (const d of pathological) {
      expect(() => categorize(undefined, d, -10)).not.toThrow();
      expect(() => categorize(undefined, d, 10)).not.toThrow();
      expect(() => isRefund(10, d)).not.toThrow();
    }
  });
});

describe('more spellings as statements print them', () => {
  it('spends by the keyword', () => {
    expect(categorize(undefined, 'Cafe Extrablatt', -12.8)).toBe('food');
    expect(categorize(undefined, 'ESPL BAR O FULANO', -4.2)).toBe('food');
    expect(categorize(undefined, 'Farmacia Beltrano', -7.15)).toBe('health');
    expect(categorize(undefined, 'Снятие наличных Vrb Musterbank eG', -100)).toBe('cash');
  });

  it('the same descriptions as income stay out of the spending rules', () => {
    expect(categorize(undefined, 'Cafe Extrablatt', 12.8)).toBe('other');
    expect(categorize(undefined, 'ESPL BAR O FULANO', 4.2)).toBe('other');
    expect(categorize(undefined, 'Farmacia Beltrano', 7.15)).toBe('other');
    expect(categorize(undefined, 'Снятие наличных Vrb Musterbank eG', 100)).toBe('other');
  });
});

describe('categorize: income', () => {
  it('German payslip LOHN/GEHALT', () => {
    expect(categorize(undefined, 'Lohn/Gehalt August 2025', 1500)).toBe('salary');
    expect(categorize(undefined, 'LOHN / GEHALT         01/26', 1500)).toBe('salary');
  });

  it('Ukrainian salary and cashback', () => {
    expect(categorize(undefined, 'Зарахування заробітної плати', 20000)).toBe('salary');
    expect(categorize(undefined, 'Кешбек за жовтень', 120)).toBe('cashback');
  });

  it('p2p income is a transfer', () => {
    expect(categorize(undefined, 'Від: Becker Anna', 15000)).toBe('transfers');
    expect(categorize(6536, '', 500)).toBe('transfers');
  });

  it('income has its own rule set: a merchant keyword does not fire', () => {
    expect(categorize(undefined, 'ANNA BECKER', 500)).toBe('other');
  });
});

describe('isRefund', () => {
  it('only positive amounts with a marker count as a refund', () => {
    expect(isRefund(265, 'Скасування. Bolt')).toBe(true);
    expect(isRefund(50, 'Refund: Amazon order')).toBe(true);
    expect(isRefund(-265, 'Скасування. Bolt')).toBe(false);
    expect(isRefund(265, 'Bolt')).toBe(false);
  });

  it('the English export writes the same marker as "Cancellation."', () => {
    expect(isRefund(8.6, 'Cancellation. Bolt')).toBe(true);
    expect(isRefund(-8.6, 'Cancellation. Bolt')).toBe(false);
    // a refund is categorized as the spending it reverses, not as income
    expect(categorize(undefined, 'Cancellation. Bolt', 8.6)).toBe('transport');
    expect(categorize(undefined, 'Cancellation. Bolt', -8.6)).toBe('transport');
  });
});
