import { useNavigationStatus } from '../url';
import { Notice } from './Notice';

export function NavigationNotice({ className }: { className?: string }) {
  const status = useNavigationStatus();
  if (status === 'ready') return null;
  return <Notice role="status" tone="warning" className={className}>
    {status === 'waiting'
      ? 'The browser address update is waiting for a verified return to the original history entry. Use browser history to return or choose another destination; confirmed changes remain saved.'
      : 'The browser history position is unverified for this view. Use browser history to return to the original entry or choose another destination. Address changes will wait rather than replace another history entry.'}
  </Notice>;
}
