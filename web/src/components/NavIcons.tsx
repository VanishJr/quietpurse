/**
 * The navigation's icons. Stroked, 20px, `currentColor` — so a nav item that is
 * current lightens its icon by changing its own colour and nothing has to be swapped.
 *
 * `aria-hidden` on every one of them: each sits beside its own label, and an icon
 * announced next to the word it draws is the word twice.
 *
 * They are drawn on a phone and not on a wide window: the design's top bar is text
 * pills, and `styles.css` hides them there. There is no Account icon because Account
 * is the avatar in that bar rather than a section in the list.
 */

const box = {
  width: 20,
  height: 20,
  viewBox: '0 0 20 20',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

export const OverviewIcon = () => (
  <svg {...box}>
    <rect x="2.75" y="2.75" width="14.5" height="14.5" rx="3" />
    <path d="M6.5 7.5h7M6.5 10.5h7M6.5 13.5h4" />
  </svg>
);

export const AnalyticsIcon = () => (
  <svg {...box}>
    <path d="M2.75 16.25h14.5" />
    <path d="M4.5 12.5l3.5-4 3 2.5 4.5-5.5" />
  </svg>
);

export const TransactionsIcon = () => (
  <svg {...box}>
    <path d="M3 7h11l-2.5-2.5M17 13H6l2.5 2.5" />
  </svg>
);

export const GoalsIcon = () => (
  <svg {...box}>
    <circle cx="10" cy="10" r="7.25" />
    <circle cx="10" cy="10" r="3.25" />
    <path d="M10 2.75v2M10 15.25v2M2.75 10h2M15.25 10h2" />
  </svg>
);

export const ImportIcon = () => (
  <svg {...box}>
    <path d="M10 2.75v8.5M6.75 8l3.25 3.25L13.25 8" />
    <path d="M3.5 13.5v2.25a1.5 1.5 0 001.5 1.5h10a1.5 1.5 0 001.5-1.5V13.5" />
  </svg>
);

/**
 * Accounts: two cards, one behind the other. Not in the navigation — it is the rail's
 * hidden-accounts switch, and the only icon here with two states.
 *
 * `off` strikes it through. That is the whole of what the control says, so it is a
 * shape and not a colour, and it is drawn corner to corner rather than as a short bar:
 * a slash that stops inside the glyph reads as part of the drawing.
 */
export const AccountsIcon = ({ off = false }: { off?: boolean }) => (
  <svg {...box} width={17} height={17}>
    <path d="M5.75 3.75h8.5" />
    <rect x="2.75" y="6.25" width="14.5" height="10" rx="2.5" />
    <path d="M2.75 9.5h14.5" />
    {off && <path d="M3.75 16.75 16.25 3.25" />}
  </svg>
);
