import { useEffect, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';

// =============================================================================
// TickerSearchInput — TradingView-style autocomplete for symbol selection.
//
// Filters a static `tickers` list by prefix against the current input value
// and renders a keyboard-navigable dropdown. Designed to be drop-in for both
// the initial Start Session form and the in-app Toolbar symbol switcher.
//
// Keyboard:
//   ArrowDown / ArrowUp  — move highlight
//   Enter                — commit highlighted (or first matching) ticker
//   Escape               — close dropdown without committing
//
// Mouse:
//   Click outside        — close dropdown
//   Click on item        — commit
// =============================================================================

interface TickerSearchInputProps {
  tickers: string[];
  value: string;
  onCommit: (symbol: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  lightMode?: boolean;
  /** Visual size variant. 'lg' is for the start screen, 'sm' for the toolbar. */
  size?: 'sm' | 'lg';
  className?: string;
  /** Called whenever the user types — useful when caller wants to mirror the
   *  draft into its own state (e.g. start form's controlled symbol). */
  onChangeDraft?: (draft: string) => void;
}

export function TickerSearchInput({
  tickers,
  value,
  onCommit,
  placeholder = 'Search symbol…',
  autoFocus,
  lightMode = false,
  size = 'lg',
  className = '',
  onChangeDraft,
}: TickerSearchInputProps) {
  const [draft, setDraft] = useState(value);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);

  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Keep local draft in sync if the parent updates `value` externally
  // (e.g. after a successful symbol switch).
  useEffect(() => {
    setDraft(value);
  }, [value]);

  // Filter suggestions: prefix match (case-insensitive). The dropdown has its
  // own max-height/overflow, so the full list can be scrolled with the wheel.
  const suggestions = useMemo(() => {
    const q = draft.trim().toUpperCase();
    if (!q) return tickers;
    return tickers.filter((t) => t.toUpperCase().startsWith(q));
  }, [draft, tickers]);

  // Reset highlight when suggestions change.
  useEffect(() => {
    setHighlight(0);
  }, [suggestions]);

  // Click-outside-to-close.
  useEffect(() => {
    if (!open) return;
    const handle = (e: MouseEvent) => {
      if (
        wrapperRef.current &&
        !wrapperRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [open]);

  const commit = (symbol: string) => {
    const sym = symbol.trim().toUpperCase();
    if (!sym) return;
    setDraft(sym);
    setOpen(false);
    onCommit(sym);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setHighlight((h) => Math.min(h + 1, Math.max(suggestions.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (suggestions.length > 0) {
        commit(suggestions[highlight] ?? suggestions[0]);
      } else if (draft.trim()) {
        // Allow committing a free-form ticker even if it's not in the list —
        // the backend will return an error if there's no data, surfacing the
        // typo to the user without us having to maintain a strict allowlist.
        commit(draft);
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
      setDraft(value);
      inputRef.current?.blur();
    }
  };

  // Styling helpers — keep dark/light parity with the rest of the app.
  const inputBaseDark =
    'bg-[#1e222d] border-[#363a45] text-[#d1d4dc] placeholder-[#787b86] focus:border-[#2962ff]';
  const inputBaseLight =
    'bg-white border-gray-300 text-gray-900 placeholder-gray-400 focus:border-[#2962ff]';

  const sizeClasses =
    size === 'lg'
      ? 'pl-9 pr-3 py-2.5 text-sm rounded-lg'
      : 'pl-7 pr-2 py-1 text-[13px] rounded';

  const iconLeft = size === 'lg' ? 'left-3' : 'left-2';
  const iconSize = size === 'lg' ? 14 : 12;

  return (
    <div ref={wrapperRef} className={`relative ${className}`}>
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          value={draft}
          autoFocus={autoFocus}
          onChange={(e) => {
            const next = e.target.value.toUpperCase();
            setDraft(next);
            setOpen(true);
            onChangeDraft?.(next);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          className={`w-full font-mono border outline-none transition-colors ${sizeClasses} ${
            lightMode ? inputBaseLight : inputBaseDark
          }`}
        />
        <Search
          size={iconSize}
          className={`absolute ${iconLeft} top-1/2 -translate-y-1/2 ${
            lightMode ? 'text-gray-400' : 'text-[#787b86]'
          }`}
        />
      </div>

      {open && suggestions.length > 0 && (
        <ul
          className={`absolute left-0 right-0 z-50 mt-1 max-h-60 overflow-y-auto rounded-lg border shadow-lg ${
            lightMode
              ? 'bg-white border-gray-200'
              : 'bg-[#1e222d] border-[#363a45]'
          }`}
        >
          {suggestions.map((sym, idx) => {
            const isHighlight = idx === highlight;
            const q = draft.trim().toUpperCase();
            const matchLen = q && sym.toUpperCase().startsWith(q) ? q.length : 0;
            const head = sym.slice(0, matchLen);
            const tail = sym.slice(matchLen);

            const baseRow = lightMode
              ? 'text-gray-800 hover:bg-gray-100'
              : 'text-[#d1d4dc] hover:bg-[#2a2e39]';
            const activeRow = lightMode
              ? 'bg-[#e3f0ff] text-[#2962ff]'
              : 'bg-[#2962ff]/15 text-[#2962ff]';

            return (
              <li
                key={sym}
                onMouseEnter={() => setHighlight(idx)}
                onMouseDown={(e) => {
                  // mousedown so we beat the input's onBlur close logic.
                  e.preventDefault();
                  commit(sym);
                }}
                className={`flex items-center justify-between px-3 py-1.5 font-mono text-[13px] cursor-pointer ${
                  isHighlight ? activeRow : baseRow
                }`}
              >
                <span>
                  <span className="font-semibold">{head}</span>
                  <span>{tail}</span>
                </span>
                <span
                  className={`text-[10px] uppercase tracking-wider ${
                    lightMode ? 'text-gray-400' : 'text-[#787b86]'
                  }`}
                >
                  Stock
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
