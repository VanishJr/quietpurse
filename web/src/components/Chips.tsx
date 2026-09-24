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
}

export function Chips({ options, selected, onSelect, label }: Props) {
  return (
    <div className="chips" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.key}
          className="chip"
          aria-pressed={o.key === selected}
          onClick={() => onSelect(o.key)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
