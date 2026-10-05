export interface ChipOption {
  key: string;
  label: string;
}

interface Props {
  options: ChipOption[];
  selected: string;
  onSelect: (key: string) => void;
  /** Describes the filter for screen readers, e.g. "Period". */
  label?: string;
  /** aria-disabled rather than disabled, so a chip that holds focus keeps it */
  locked?: boolean;
}

export function Chips({ options, selected, onSelect, label, locked = false }: Props) {
  return (
    <div className="chips choice-chips" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          className="chip"
          aria-pressed={o.key === selected}
          aria-disabled={locked || undefined}
          onClick={() => {
            if (!locked) onSelect(o.key);
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
