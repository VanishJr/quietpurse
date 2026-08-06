import { describe, expect, it } from 'vitest';
import { initialOf } from './identity';

/**
 * The letter is drawn into an `aria-hidden` span while the button around it is named
 * by the address, so nothing in the DOM suite can see it: `Account: owner@example.com`
 * is the accessible name whichever letter went inside. Two screens draw it from this
 * one function, which is the reason it is a module — and the reason a rule change here
 * has to be caught here.
 */
describe('the letter that stands where a photograph would', () => {
  it('takes the surname, which is the last word of the name', () => {
    expect(initialOf({ name: 'Yurii Kalvenko', email: 'ivan@example.com' })).toBe('K');
  });

  it('takes the only word there is when the name is one', () => {
    expect(initialOf({ name: 'ivan', email: 'ivan@example.com' })).toBe('I');
  });

  it('falls back to the address when there is no name to take one from', () => {
    expect(initialOf({ email: 'owner@example.com' })).toBe('O');
    // a name of nothing but spaces is a name the fallback has to catch: `.charAt(0)`
    // on it answers a space, and a blank disc says less than the address's letter
    expect(initialOf({ name: '   ', email: 'owner@example.com' })).toBe('O');
  });
});
