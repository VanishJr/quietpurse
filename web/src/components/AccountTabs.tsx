import { useEffect, useRef, useState } from 'react';
import { truncateMiddle } from '../format';
import { Account } from '../types';
import { AccountsIcon } from './NavIcons';
import { Button } from './Button';
import { ChevronIcon } from './SettingsActionIcons';

export const TABS_PER_PAGE = 3;

/**
 * How much of a name a tab shows, in characters.
 *
 * It is a character budget rather than a CSS `text-overflow` because the name is cut
 * in the middle: `truncateMiddle` carries the reason.
 *
 * The whole name is never lost. It is the tab's `title`, and it is the tab's accessible
 * name.
 */
export const TAB_NAME_BUDGET = 18;

interface Props {
  /** Already in the order and the visibility the screen decided. */
  accounts: Account[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
  /** How many accounts are hidden. None means no toggle: there is nothing to reveal. */
  hiddenCount: number;
  showHidden: boolean;
  onToggleHidden: () => void;
}

export function AccountTabs({
  accounts,
  selectedId,
  onSelect,
  onAdd,
  hiddenCount,
  showHidden,
  onToggleHidden,
}: Props) {
  const currentTab = useRef<HTMLButtonElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  const pages = Math.max(1, Math.ceil(accounts.length / TABS_PER_PAGE));
  const [page, setPage] = useState(0);

  /**
   * The strip follows a NEW selection onto its page, because an account just added has
   * to be visible wherever the order put it. It also follows the SAME selection when the
   * list has moved it to a different page. Paging by hand is neither, and is left alone.
   *
   * The ref is what tells the three apart, and it has to remember the page as well as
   * the id. Keyed on nothing, this effect re-runs on every render the parent causes and
   * each run would put the page back where the selection is: paging forward with the
   * first account still selected would last until the next render and then snap back.
   * Keyed on the id alone, a reorder that keeps the selection is missed, and a rename
   * can carry the selected account to another page on the next load.
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
  const shown = accounts.slice(
    current * TABS_PER_PAGE,
    current * TABS_PER_PAGE + TABS_PER_PAGE,
  );

  useEffect(() => {
    const tab = currentTab.current;
    const rail = tab?.parentElement;
    if (!tab || !rail) return;
    const reveal = () => {
      if (!rail.clientWidth) return;
      const left = tab.getBoundingClientRect().left - rail.getBoundingClientRect().left;
      const right = left + tab.offsetWidth - rail.clientWidth;
      if (left < 0 || tab.offsetWidth > rail.clientWidth) rail.scrollLeft += left;
      else if (right > 0) rail.scrollLeft += right;
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(rail);
    return () => observer.disconnect();
  }, [selectedId, current, accounts]);

  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    const measure = () => setOverflow(rail.scrollWidth > rail.clientWidth + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(rail);
    return () => observer.disconnect();
  }, [accounts, current]);

  const plural = hiddenCount === 1 ? 'account' : 'accounts';
  const hiddenLabel = showHidden
    ? `Hide ${hiddenCount} hidden ${plural} again`
    : `Show ${hiddenCount} hidden ${plural}`;

  return (
    <div className="acct-strip">
      <div className="rail-nav">
        {pages > 1 && (
          <Button type="button" variant="secondary" size="compact" iconOnly
            className="rail-arrow rail-arrow-prev"
            onClick={() => setPage(current - 1)}
            aria-disabled={current === 0}
            aria-label="Previous accounts"
          >
            <ChevronIcon />
          </Button>
        )}

        <div ref={railRef} className="rail-tabs" role="group" aria-label="Accounts">
          {shown.map((a) => (
            <button
              type="button"
              key={a.id}
              ref={a.id === selectedId ? currentTab : null}
              className="rail-tab"
              onClick={() => onSelect(a.id)}
              aria-current={a.id === selectedId ? 'true' : undefined}
              // the cut name is on screen; both of these carry the whole one
              title={a.name}
              aria-describedby={`account-currency-${a.id}`}
              // ...and the label has to carry the badge as well, because it REPLACES the
              // content of the button rather than adding to it: with the name alone, a
              // tab on the rail that is only there because the reader asked for the
              // hidden ones sounds exactly like the accounts that were never off it
              aria-label={a.hidden ? `${a.name} (hidden)` : a.name}
            >
              <AccountsIcon />
              <span className="rail-tab-name">
                {truncateMiddle(a.name, TAB_NAME_BUDGET)}
              </span>
              <span className="rail-currency" id={`account-currency-${a.id}`}>
                {a.currency}
              </span>
              {a.hidden && <span className="badge rail-tab-badge">hidden</span>}
            </button>
          ))}
        </div>

        {pages > 1 && (
          <Button type="button" variant="secondary" size="compact" iconOnly
            className="rail-arrow"
            onClick={() => setPage(current + 1)}
            aria-disabled={current === pages - 1}
            aria-label="Next accounts"
          >
            <ChevronIcon />
          </Button>
        )}
      </div>

      <span className="visually-hidden">
        {accounts.length === 1 ? '1 account' : `${accounts.length} accounts`}
        {/* the region is unconditional and only its text is not: a region mounted with
            its sentence has nothing for the sentence to be a change to */}
        <span aria-live="polite">
          {pages > 1 && (
            <>
              {' · '}
              {current + 1} of {pages}
            </>
          )}
        </span>
      </span>

      <div className="rail-actions">
        {hiddenCount > 0 && (
          <Button type="button" variant="tertiary" size="compact"
            className="rail-toggle"
            onClick={onToggleHidden}
            aria-pressed={showHidden}
            aria-label={hiddenLabel}
            title={hiddenLabel}
          >
            <AccountsIcon off={showHidden} />
            <span>{showHidden ? 'Hide hidden' : 'Show hidden'}</span>
          </Button>
        )}

        <Button type="button" variant="tertiary" size="compact" className="rail-add" onClick={onAdd}>
          <span aria-hidden="true">+</span> Add account
        </Button>
      </div>
      {overflow && <p className="rail-overflow-hint">Scroll to see all accounts on this page.</p>}
    </div>
  );
}
