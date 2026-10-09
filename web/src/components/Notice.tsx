import type { ReactNode } from 'react';

export interface NoticeProps {
  children: ReactNode;
  title?: ReactNode;
  remedy?: ReactNode;
  tone?: 'neutral' | 'success' | 'warning' | 'error';
  placement?: 'inline' | 'content';
  role?: 'status' | 'alert';
  id?: string;
  className?: string;
}

export function Notice({
  children,
  title,
  remedy,
  tone = 'neutral',
  placement = 'inline',
  role,
  id,
  className,
}: NoticeProps) {
  return (
    <div
      id={id}
      className={['notice', `notice--${tone}`, `notice--${placement}`, className].filter(Boolean).join(' ')}
      role={role}
    >
      {title && <p className="notice__title">{title}</p>}
      <div className="notice__facts">{children}</div>
      {remedy && <div className="notice__remedy">{remedy}</div>}
    </div>
  );
}
