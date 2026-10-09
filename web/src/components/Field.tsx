import type { ComponentPropsWithRef, ReactNode } from 'react';

interface FieldBase {
  id: string;
  label: ReactNode;
  help?: ReactNode;
  error?: ReactNode;
  invalid?: boolean;
  className?: string;
}

type NativeProps<T extends 'input' | 'select' | 'textarea'> =
  Omit<ComponentPropsWithRef<T>, 'id' | 'aria-invalid'>;

export type FieldProps = FieldBase & (
  | { control: 'input'; controlProps: NativeProps<'input'> }
  | { control: 'select'; controlProps: NativeProps<'select'> }
  | { control: 'textarea'; controlProps: NativeProps<'textarea'> }
);

export function Field(props: FieldProps) {
  const { id, label, help, error, invalid = false, className } = props;
  const hasHelp = help != null;
  const hasError = error != null;
  const shared = {
    id,
    className: ['native-field__control', props.controlProps.className].filter(Boolean).join(' '),
    'aria-invalid': invalid || hasError || undefined,
    'aria-describedby': [
      props.controlProps['aria-describedby'],
      hasHelp && `${id}-help`,
      hasError && `${id}-error`,
    ].filter(Boolean).join(' ') || undefined,
  };

  return (
    <div className={['native-field', className].filter(Boolean).join(' ')}>
      <label className="native-field__label" htmlFor={id}>{label}</label>
      {props.control === 'input' && <input {...props.controlProps} {...shared} />}
      {props.control === 'select' && <span className="native-field__select"><select {...props.controlProps} {...shared} /></span>}
      {props.control === 'textarea' && <textarea {...props.controlProps} {...shared} />}
      {hasHelp && <p className="native-field__help" id={`${id}-help`}>{help}</p>}
      {hasError && <p className="native-field__error" id={`${id}-error`}>{error}</p>}
    </div>
  );
}
