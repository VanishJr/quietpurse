import type { ReactNode, Ref } from 'react';

export interface PageHeaderProps {
  title: string;
  context?: ReactNode;
  returnAction?: ReactNode;
  action?: ReactNode;
  titleId?: string;
  titleRef?: Ref<HTMLHeadingElement>;
  className?: string;
}

export function PageHeader({
  title,
  context,
  returnAction,
  action,
  titleId,
  titleRef,
  className,
}: PageHeaderProps) {
  return (
    <header className={['page-header', className].filter(Boolean).join(' ')}>
      {returnAction && <div className="page-header__return">{returnAction}</div>}
      <div className="page-header__identity">
        <h1 id={titleId} ref={titleRef} tabIndex={-1}>{title}</h1>
        {context && <div className="page-header__context">{context}</div>}
      </div>
      {action && <div className="page-header__action">{action}</div>}
    </header>
  );
}
