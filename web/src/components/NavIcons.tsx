/**
 * The sidebar's icons. Stroked, 20px, `currentColor` — so a nav item that is current
 * lightens its icon by changing its own colour and nothing has to be swapped.
 *
 * `aria-hidden` on every one of them: each sits beside its own label, and an icon
 * announced next to the word it draws is the word twice.
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

export const AccountIcon = () => (
  <svg {...box}>
    <circle cx="10" cy="7" r="3.25" />
    <path d="M4 16.5c1.2-2.6 3.4-3.9 6-3.9s4.8 1.3 6 3.9" />
  </svg>
);

export const ImportIcon = () => (
  <svg {...box}>
    <path d="M10 2.75v8.5M6.75 8l3.25 3.25L13.25 8" />
    <path d="M3.5 13.5v2.25a1.5 1.5 0 001.5 1.5h10a1.5 1.5 0 001.5-1.5V13.5" />
  </svg>
);
