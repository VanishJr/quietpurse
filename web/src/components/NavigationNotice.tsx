import { useNavigationStatus } from '../url';
import { Notice } from './Notice';

export function NavigationNotice({ className }: { className?: string }) {
  const status = useNavigationStatus();
  if (status === 'ready') return null;
  return <Notice role="status" tone="warning" className={className}>
    {status === 'waiting'
      ? "The address bar will update when you go back to exactly the page you were on. Use the browser's Back or Forward button to return there, or go somewhere else. Changes you confirmed stay saved."
      : "Quietpurse can't tell where this view is in the browser history. Use the browser's Back or Forward button to return to the page you were on, or go somewhere else. Address changes wait so they don't replace another history entry."}
  </Notice>;
}
