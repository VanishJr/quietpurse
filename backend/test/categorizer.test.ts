import { describe, expect, it } from 'vitest';
import { categorize, isRefund } from '../src/categorizer';

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
});
