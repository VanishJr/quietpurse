import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button } from './components/Button';
import { isAvailable } from './dismiss';
import { ScreenShown } from './screen';
import { registerNavigationGuard } from './url';

interface EditorOptions {
  open: boolean;
  dirty: boolean;
  busy?: boolean;
  /** False where `busy` is an immediate write or a read, which settles behind a hidden screen;
   *  a pending save of the draft holds navigation until it lands. */
  busyHoldsNavigation?: boolean;
  onClose: () => void;
  onNavigationDiscard?: () => void;
}

export function useEditorSession({
  open, dirty, busy = false, busyHoldsNavigation = true, onClose, onNavigationDiscard,
}: EditorOptions) {
  const shown = useContext(ScreenShown);
  const [guarding, setGuarding] = useState(false);
  const [untracked, setUntracked] = useState(false);
  const pending = useRef<(() => void) | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const bypass = useRef(false);
  const resumed = useRef(false);
  const current = useRef({ open, dirty, busy, busyHoldsNavigation, shown, onClose, onNavigationDiscard });
  current.current = { open, dirty, busy, busyHoldsNavigation, shown, onClose, onNavigationDiscard };

  const finish = (action: () => void) => {
    pending.current = null;
    setGuarding(false);
    bypass.current = true;
    try { action(); } finally { bypass.current = false; }
  };

  const request = (action: () => void) => {
    const options = current.current;
    if (options.busy || pending.current) return;
    if (!options.dirty) { action(); return; }
    setUntracked(false);
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    pending.current = action;
    setGuarding(true);
  };

  const keepEditing = () => {
    pending.current = null;
    resumed.current = true;
    setGuarding(false);
  };

  const requestClose = () => {
    if (current.current.busy) return;
    if (pending.current) keepEditing();
    else request(current.current.onClose);
  };

  useEffect(() => {
    if (!open || !shown || (!dirty && !(busy && busyHoldsNavigation))) return;
    const leaveDocument = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', leaveDocument);
    return () => window.removeEventListener('beforeunload', leaveDocument);
  }, [open, shown, dirty, busy, busyHoldsNavigation]);

  useLayoutEffect(() => {
    if (!open || !shown) return;
    return registerNavigationGuard((proceed, unknownEntry = false) => {
      const options = current.current;
      if (bypass.current || !options.open || !options.shown) return false;
      if (options.busy) return options.busyHoldsNavigation;
      if (!options.dirty) return false;
      const commit = () => proceed(current.current.onNavigationDiscard);
      if (pending.current) pending.current = commit;
      else request(commit);
      setUntracked(unknownEntry);
      return true;
    });
  }, [open, shown]);

  useLayoutEffect(() => {
    if (open) return;
    pending.current = null;
    returnFocus.current = null;
    resumed.current = false;
    setGuarding(false);
  }, [open]);

  useLayoutEffect(() => {
    if (guarding || !resumed.current) return;
    resumed.current = false;
    const target = returnFocus.current;
    if (target && isAvailable(target)) {
      target.focus({ preventScroll: true });
      target.scrollIntoView?.({ block: 'nearest' });
    }
  }, [guarding]);

  const guard = guarding ? (
    <div className="editor-guard">
      <h3>Discard unsaved changes?</h3>
      <p className="body-text">Your changes have not been saved.</p>
      {untracked && <p className="body-text">This browser cannot restore the untracked history address automatically. Keep editing retains your draft here; use browser history to return to its address, or discard to continue.</p>}
      <div className="editor-guard-actions">
        <Button type="button" variant="primary" size="standard" data-sheet-focus onClick={keepEditing}>Keep editing</Button>
        <Button type="button" variant="destructive-secondary" size="standard" onClick={() => {
          const action = pending.current;
          if (action && !current.current.busy) finish(action);
        }}>Discard changes</Button>
      </div>
    </div>
  ) : undefined;

  return { request, requestClose, finish, guard, guarding };
}
