import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Account } from '../types';
import { AccountTabs } from './AccountTabs';

/**
 * The strip's own arithmetic: which page is shown, and when it is allowed to move.
 *
 * Tested here rather than through the Overview screen because the two cases that
 * matter are about the props changing underneath a page the strip already picked —
 * the parent re-rendering with the same list, and the parent re-rendering with the
 * same selection at a different index. Both are one `rerender` away here and several
 * requests away there.
 */

const acct = (id: string, name: string): Account => ({
  id,
  provider: 'upload',
  name,
  currency: 'EUR',
  balance: 0,
  hidden: false,
});

/** Four accounts is two pages, which is the smallest list that has a wrong page. */
const ALPHA = acct('acc-1', 'Alpha');
const BRAVO = acct('acc-2', 'Bravo');
const CHARLIE = acct('acc-3', 'Charlie');
const ZULU = acct('acc-4', 'Zulu');

const strip = (accounts: Account[], selectedId: string) => (
  <AccountTabs
    accounts={accounts}
    selectedId={selectedId}
    onSelect={vi.fn()}
    onAdd={vi.fn()}
    // nothing hidden: what this file is about is the paging, and the switch that
    // reveals the hidden ones is asserted where the list it changes is decided
    hiddenCount={0}
    showHidden={false}
    onToggleHidden={vi.fn()}
  />
);

/** The strip's own label, which is where "which page of how many" is written down. */
const label = () => screen.getByText(/4 accounts/);

describe('which page the strip shows', () => {
  it('opens on the page the selection is on', () => {
    render(strip([ALPHA, BRAVO, CHARLIE, ZULU], ZULU.id));

    expect(screen.getByRole('button', { name: 'Zulu' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Alpha' })).not.toBeInTheDocument();
    expect(label()).toHaveTextContent('2 of 2');
  });

  it('leaves a page the reader turned to alone when the parent re-renders', () => {
    // the reason the ref exists: this screen re-renders several times per tab while
    // it loads, and a strip that re-derived its page each time would snap back
    const { rerender } = render(strip([ALPHA, BRAVO, CHARLIE, ZULU], ALPHA.id));

    fireEvent.click(screen.getByRole('button', { name: 'Next accounts' }));
    expect(screen.getByRole('button', { name: 'Zulu' })).toBeInTheDocument();

    rerender(strip([ALPHA, BRAVO, CHARLIE, ZULU], ALPHA.id));

    expect(screen.getByRole('button', { name: 'Zulu' })).toBeInTheDocument();
    expect(label()).toHaveTextContent('2 of 2');
  });

  it('follows the selection when the list moves it to another page', () => {
    // `listAccounts` sorts by provider then name and `applyAccount` patches the row in
    // place, so a rename shows in the old order until the next load puts it in the new
    // one. Keyed on the id alone this was early-returned, and the strip sat on page 2
    // with one unrelated tab on it and nothing marked current.
    const { rerender } = render(strip([ALPHA, BRAVO, CHARLIE, ZULU], ZULU.id));
    expect(screen.getByRole('button', { name: 'Zulu' })).toBeInTheDocument();

    const renamed = { ...ZULU, name: 'Aardvark' };
    rerender(strip([renamed, ALPHA, BRAVO, CHARLIE], renamed.id));

    const tab = screen.getByRole('button', { name: 'Aardvark' });
    expect(tab).toHaveAttribute('aria-current', 'true');
    expect(screen.queryByRole('button', { name: 'Charlie' })).not.toBeInTheDocument();
    expect(label()).toHaveTextContent('1 of 2');
  });

  it('keeps the paging region in the DOM while there is nothing to page', () => {
    // it was rendered under `pages > 1`, which is the one arrangement that cannot work:
    // the region and its first sentence arrived in the same commit, so there was never a
    // region present for that sentence to be a change TO — and paging, the one thing on
    // this rail a screen reader cannot otherwise tell happened, announced nothing
    render(strip([ALPHA], ALPHA.id));

    const region = document.querySelector('[aria-live="polite"]');
    expect(region).not.toBeNull();
    expect(region).toBeEmptyDOMElement();
  });

  it('fills that region in once a second page exists', () => {
    render(strip([ALPHA, BRAVO, CHARLIE, ZULU], ALPHA.id));

    expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent('1 of 2');
  });

  it('keeps the page when the list moves the selection within it', () => {
    // an account hidden ahead of the selection shifts its index without moving it off
    // the page being read, and undoing a deliberate page for that would be the same
    // snap-back in a rarer costume
    const { rerender } = render(strip([ALPHA, BRAVO, CHARLIE, ZULU], ALPHA.id));

    fireEvent.click(screen.getByRole('button', { name: 'Next accounts' }));
    expect(screen.getByRole('button', { name: 'Zulu' })).toBeInTheDocument();

    rerender(strip([ALPHA, CHARLIE, BRAVO, ZULU], ALPHA.id));

    expect(screen.getByRole('button', { name: 'Zulu' })).toBeInTheDocument();
  });
});
