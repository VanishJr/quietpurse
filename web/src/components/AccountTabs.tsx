/**
 * One account per tab, three tabs to a line, and an arrow when there are more.
 *
 * Not a `role="tablist"`. The app already has one idiom for "which of these is the
 * current one" and it is `aria-current` on a plain button (`.nav-item` in
 * SignedIn.tsx); a real tablist would also make each tab a composite widget, which
 * buys a roving tabindex nobody asked for on a strip of at most three controls.
 *
 * A tab is a name and nothing else. The balance, and the ⋮ that acts on the account,
 * are on the card directly below — which is where the reference design puts them, and
 * what lets three tabs share a line without the row becoming a control panel.
 */
import { useEffect, useRef, useState } from 'react';
import { truncateMiddle } from '../format';
import { Account } from '../types';

/** The line the design draws: three accounts, then an arrow. */
export const TABS_PER_PAGE = 3;

/**
 * How much of a name a tab shows, in characters.
 *
 * A tab is a third of the rail, and this is what fits at the narrowest width the app
 * lays out for without the row of three breaking. It is a character budget rather
 * than a CSS `text-overflow` because the name is cut in the middle — see
 * `truncateMiddle`, and the reason there: the default name is the statement's
 * filename, and everything that distinguishes two of them is at the end.
 *
 * The whole name is never lost. It is the tab's `title`, it is the tab's accessible
 * name, and it is the heading of the account's own panel.
 */
export const TAB_NAME_BUDGET = 18;

interface Props {
  /** Already in the order and the visibility the screen decided. */
  accounts: Account[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
}

export function AccountTabs({ accounts, selectedId, onSelect, onAdd }: Props) {
  const pages = Math.max(1, Math.ceil(accounts.length / TABS_PER_PAGE));
  const [page, setPage] = useState(0);

  /**
   * The strip follows a NEW selection onto its page — "Add more" appends a fourth
   * account and the tab it made has to be visible — and it follows the SAME selection
   * when the list has moved it to a different page. Paging by hand is neither, and is
   * left alone.
   *
   * The ref is what tells the three apart, and it has to remember the page as well as
   * the id. Keyed on nothing, this effect re-runs on every render the parent causes
   * (and this screen causes several per tab, loading data) and each run would put the
   * page back where the selection is: paging forward with the first account still
   * selected would last until the next render and then snap back. Keyed on the id
   * alone — which is what it was — a reorder that keeps the selection was early-
   * returned, and `listAccounts` sorts by provider then name while `applyAccount`
   * patches the row in place: rename the account on page 2 and reload, and the strip
   * stayed on page 2 showing one unrelated tab with nothing marked current.
   *
   * The page rather than the index, because they are different questions: an account
   * hidden ahead of the selection shifts its index without moving it off the page
   * being read, and that is not a reason to undo a deliberate page.
   */
  const followed = useRef<{ id: string | null; page: number | null } | null>(null);
  useEffect(() => {
    const index = accounts.findIndex((a) => a.id === selectedId);
    const target = index >= 0 ? Math.floor(index / TABS_PER_PAGE) : null;
    if (followed.current?.id === selectedId && followed.current.page === target) return;
    followed.current = { id: selectedId, page: target };
    if (target !== null) setPage(target);
  }, [selectedId, accounts]);

  // a page that emptied under a hide is not a page
  const current = Math.min(page, pages - 1);
  const shown = accounts.slice(current * TABS_PER_PAGE, current * TABS_PER_PAGE + TABS_PER_PAGE);

  return (
    <div className="acct-strip">
      <div className="acct-rail">
        {pages > 1 && (
          <button
            className="rail-arrow"
            onClick={() => setPage(current - 1)}
            disabled={current === 0}
            aria-label="Previous accounts"
          >
            ‹
          </button>
        )}
        <div className="rail-tabs" role="group" aria-label="Accounts">
          {shown.map((a) => (
            <button
              key={a.id}
              className="rail-tab"
              onClick={() => onSelect(a.id)}
              aria-current={a.id === selectedId ? 'true' : undefined}
              // the cut name is on screen; both of these carry the whole one
              title={a.name}
              aria-label={a.name}
            >
              <span className="rail-tab-name">{truncateMiddle(a.name, TAB_NAME_BUDGET)}</span>
              {a.hidden && <span className="badge rail-tab-badge">hidden</span>}
            </button>
          ))}
        </div>
        {pages > 1 && (
          <button
            className="rail-arrow"
            onClick={() => setPage(current + 1)}
            disabled={current === pages - 1}
            aria-label="Next accounts"
          >
            ›
          </button>
        )}
      </div>

      <div className="acct-strip-bar">
        <span className="acct-strip-label">
          {accounts.length === 1 ? '1 account' : `${accounts.length} accounts`}
          {pages > 1 && (
            <span aria-live="polite">
              {' · '}
              {current + 1} of {pages}
            </span>
          )}
        </span>
        <button className="btn btn-sm" onClick={onAdd}>
          Add more +
        </button>
      </div>
    </div>
  );
}
