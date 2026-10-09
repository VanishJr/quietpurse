import type { ComponentPropsWithRef, ReactNode } from 'react';

export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'tertiary'
  | 'destructive-primary'
  | 'destructive-secondary';
export type ButtonSize = 'compact' | 'standard' | 'touch';

export type ButtonProps = Omit<ComponentPropsWithRef<'button'>, 'type' | 'children'> & {
  type: 'button' | 'submit' | 'reset';
  variant: ButtonVariant;
  size: ButtonSize;
  children: ReactNode;
  pending?: boolean;
} & ({ iconOnly: true; 'aria-label': string } | { iconOnly?: false });

export function Button({
  type,
  variant,
  size,
  children,
  pending = false,
  iconOnly = false,
  className,
  onClick,
  'aria-disabled': ariaDisabled,
  'aria-busy': ariaBusy,
  ...props
}: ButtonProps) {
  const locked = pending || ariaDisabled === true || ariaDisabled === 'true';
  return (
    <button
      {...props}
      type={type}
      className={[
        'action-button',
        `action-button--${variant}`,
        `action-button--${size}`,
        iconOnly && 'action-button--icon',
        className,
      ].filter(Boolean).join(' ')}
      aria-disabled={locked || ariaDisabled}
      aria-busy={pending || ariaBusy}
      data-pending={pending || undefined}
      onClick={(event) => {
        if (locked) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        onClick?.(event);
      }}
    >
      {children}
    </button>
  );
}
