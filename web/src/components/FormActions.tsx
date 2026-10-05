import type { ReactNode } from 'react';

export interface FormActionsProps {
  back?: ReactNode;
  cancel?: ReactNode;
  completion: ReactNode;
  className?: string;
}

export function FormActions({ back, cancel, completion, className }: FormActionsProps) {
  return (
    <div className={['form-actions', className].filter(Boolean).join(' ')}>
      {back && <div className="form-actions__back">{back}</div>}
      {cancel && <div className="form-actions__cancel">{cancel}</div>}
      <div className="form-actions__completion">{completion}</div>
    </div>
  );
}
