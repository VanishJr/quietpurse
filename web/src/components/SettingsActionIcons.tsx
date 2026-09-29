import { ICON_BOX } from './NavIcons';

export const HistoryIcon = () => (
  <svg {...ICON_BOX}>
    <path d="M3 5.5h14M4.5 5.5v10.25a1.5 1.5 0 001.5 1.5h8a1.5 1.5 0 001.5-1.5V5.5M3 2.75h14v2.75H3z" />
    <path d="M8 9.5h4M8 12.5h4" />
  </svg>
);

export const BackupIcon = () => (
  <svg {...ICON_BOX}>
    <path d="M4 2.75h8l4 4v10.5H4zM12 2.75v4h4" />
    <path d="M10 8.75v5.5m-2-2 2 2 2-2" />
  </svg>
);

export const MoreIcon = () => (
  <svg {...ICON_BOX}>
    <circle cx="10" cy="4" r="1.5" fill="currentColor" stroke="none" />
    <circle cx="10" cy="10" r="1.5" fill="currentColor" stroke="none" />
    <circle cx="10" cy="16" r="1.5" fill="currentColor" stroke="none" />
  </svg>
);

export const ChevronIcon = () => (
  <svg {...ICON_BOX}>
    <path d="m8 5 5 5-5 5" />
  </svg>
);
