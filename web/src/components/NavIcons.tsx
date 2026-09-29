export const ICON_BOX = {
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
  <svg {...ICON_BOX}>
    <rect x="2.75" y="2.75" width="14.5" height="14.5" rx="3" />
    <path d="M6.5 7.5h7M6.5 10.5h7M6.5 13.5h4" />
  </svg>
);

export const AnalyticsIcon = () => (
  <svg {...ICON_BOX}>
    <path d="M2.75 16.25h14.5" />
    <path d="M4.5 12.5l3.5-4 3 2.5 4.5-5.5" />
  </svg>
);

export const TransactionsIcon = () => (
  <svg {...ICON_BOX}>
    <path d="M3 7h11l-2.5-2.5M17 13H6l2.5 2.5" />
  </svg>
);

export const GoalsIcon = () => (
  <svg {...ICON_BOX}>
    <circle cx="10" cy="10" r="7.25" />
    <circle cx="10" cy="10" r="3.25" />
    <path d="M10 2.75v2M10 15.25v2M2.75 10h2M15.25 10h2" />
  </svg>
);

export const ImportIcon = () => (
  <svg {...ICON_BOX}>
    <path d="M10 2.75v8.5M6.75 8l3.25 3.25L13.25 8" />
    <path d="M3.5 13.5v2.25a1.5 1.5 0 001.5 1.5h10a1.5 1.5 0 001.5-1.5V13.5" />
  </svg>
);

export const SettingsIcon = () => (
  <svg {...ICON_BOX}>
    <path d="M8.4 2.5h3.2l.5 1.8 1.05.45 1.6-.95L17 6.05l-.95 1.6.45 1.05 1.8.5v3.2l-1.8.5-.45 1.05.95 1.6-2.25 2.25-1.6-.95-1.05.45-.5 1.8H8.4l-.5-1.8-1.05-.45-1.6.95L3 15.55l.95-1.6-.45-1.05-1.8-.5V9.2l1.8-.5.45-1.05L3 6.05 5.25 3.8l1.6.95 1.05-.45z" />
    <circle cx="10" cy="10.8" r="2.5" />
  </svg>
);

/**
 * `off` strikes it through, corner to corner rather than as a short bar: a slash that
 * stops inside the glyph reads as part of the drawing.
 */
export const AccountsIcon = ({ off = false }: { off?: boolean }) => (
  <svg {...ICON_BOX} width={17} height={17}>
    <path d="M5.75 3.75h8.5" />
    <rect x="2.75" y="6.25" width="14.5" height="10" rx="2.5" />
    <path d="M2.75 9.5h14.5" />
    {off && <path d="M3.75 16.75 16.25 3.25" />}
  </svg>
);
