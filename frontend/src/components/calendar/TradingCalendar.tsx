'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import {
  buildMonthGrid,
  dayTone,
  formatMetric,
  formatMoney,
  getDayStats,
  getMonthStats,
  intensity,
  METRICS,
  MONTH_NAMES,
  WEEKDAYS,
  type Metric,
} from '../../lib/journal';
import type { PerformanceLog } from '../../types';

interface TradingCalendarProps {
  isOpen: boolean;
  onClose: () => void;
  log: PerformanceLog;
  lightMode?: boolean;
}

export function TradingCalendar({ isOpen, onClose, log, lightMode = false }: TradingCalendarProps) {
  const [metric, setMetric] = useState<Metric>('dollar');
  const [view, setView] = useState<'month' | 'year'>('month');
  const [month, setMonth] = useState(new Date().getMonth());
  const [year, setYear] = useState(new Date().getFullYear());

  const metricLabel = METRICS.find((m) => m.id === metric)?.label ?? 'Dollar profit';
  const cells = buildMonthGrid(year, month);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
      aria-modal="true"
      role="dialog"
      aria-label="Trading performance calendar"
    >
      <section
        onClick={(e) => e.stopPropagation()}
        className={cn(
          'w-full max-w-[420px] rounded-[22px] border p-3 shadow-2xl shadow-black/40',
          lightMode ? 'border-gray-200 bg-white' : 'border-border bg-calendar-panel'
        )}
      >
        <div className="flex items-center justify-between px-1 pb-3 pt-1">
          <MetricSelect label={metricLabel} value={metric} onChange={setMetric} lightMode={lightMode} />
          <button
            type="button"
            onClick={onClose}
            className={cn(
              'rounded-md p-1 transition-colors',
              lightMode ? 'text-gray-500 hover:bg-gray-100' : 'text-muted-foreground hover:bg-popover'
            )}
            aria-label="Close calendar"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* period navigation */}
        <div className="flex items-center gap-1 px-1 pb-4">
          <NavButton
            label="Previous month"
            onClick={() => {
              const m = month - 1;
              if (m < 0) {
                setMonth(11);
                setYear(year - 1);
              } else setMonth(m);
            }}
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </NavButton>

          <span className="min-w-[68px] text-center text-[15px] font-medium text-foreground">
            {MONTH_NAMES[month]}
          </span>

          <NavButton
            label="Next month"
            onClick={() => {
              const m = month + 1;
              if (m > 11) {
                setMonth(0);
                setYear(year + 1);
              } else setMonth(m);
            }}
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </NavButton>

          <NavButton label="Previous year" onClick={() => setYear(year - 1)}>
            <ChevronLeft className="h-3.5 w-3.5" />
          </NavButton>

          <span className="min-w-[52px] text-center text-[15px] font-medium text-foreground">{year}</span>

          <NavButton label="Next year" onClick={() => setYear(year + 1)}>
            <ChevronRight className="h-3.5 w-3.5" />
          </NavButton>

          <div className="ml-auto flex items-center rounded-full bg-transparent p-0.5 text-[12px]">
            <button
              type="button"
              onClick={() => setView('month')}
              aria-pressed={view === 'month'}
              className={cn(
                'rounded-full px-3 py-1.5 transition-colors',
                view === 'month' ? 'bg-popover text-foreground' : 'text-muted-foreground hover:text-foreground'
              )}
            >
              Month
            </button>
            <button
              type="button"
              onClick={() => setView('year')}
              aria-pressed={view === 'year'}
              className={cn(
                'rounded-full px-3 py-1.5 transition-colors',
                view === 'year' ? 'bg-popover text-foreground' : 'bg-muted/70 text-muted-foreground hover:text-foreground'
              )}
            >
              Year
            </button>
          </div>
        </div>

        {view === 'month' ? (
          <>
            {/* weekday header */}
            <div className="grid grid-cols-7 pb-2">
              {WEEKDAYS.map((d) => (
                <div key={d} className="text-center text-[12px] text-muted-foreground">
                  {d}
                </div>
              ))}
            </div>

            {/* day grid */}
            <div className="grid grid-cols-7 gap-px overflow-hidden rounded-[6px] bg-grid-line">
              {cells.map(({ date, outside }) => (
                <DayCell
                  key={date.toISOString()}
                  date={date}
                  outside={outside}
                  metric={metric}
                  stats={outside ? null : getDayStats(log, date.getFullYear(), date.getMonth(), date.getDate())}
                />
              ))}
            </div>
          </>
        ) : (
          <YearGrid year={year} log={log} onPick={(m) => { setMonth(m); setView('month'); }} />
        )}
      </section>
    </div>
  );
}

function NavButton({
  children,
  label,
  onClick,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-popover hover:text-foreground"
    >
      {children}
    </button>
  );
}

function DayCell({
  date,
  outside,
  stats,
  metric,
}: {
  date: Date;
  outside: boolean;
  stats: ReturnType<typeof getDayStats>;
  metric: Metric;
}) {
  const tone = dayTone(stats?.profit);
  const plain = tone === 'none' || tone === 'flat';
  const profit = stats?.profit ?? 0;

  return (
    <div
      title={
        stats
          ? `${date.toDateString()} — ${formatMoney(profit, true)} over ${stats.trades} trades`
          : `${date.toDateString()} — no trades`
      }
      className={cn(
        'relative flex aspect-[1.12/1] flex-col justify-end px-2 pb-1.5 pt-1 transition-[filter]',
        !outside && 'hover:brightness-125',
        outside && 'bg-cell-outside',
        !outside && plain && 'bg-cell',
        !outside && tone === 'profit' && 'bg-profit',
        !outside && tone === 'profit-strong' && 'bg-profit-strong',
        !outside && tone === 'loss' && 'bg-loss',
        !outside && tone === 'loss-strong' && 'bg-loss-strong'
      )}
    >
      <span
        className={cn(
          'absolute right-2 top-1 text-[11px] leading-tight',
          outside ? 'text-muted-foreground/60' : plain ? 'text-muted-foreground' : 'text-tint-fg'
        )}
      >
        {date.getDate()}
      </span>

      {stats && !outside && (
        <>
          <span
            className={cn(
              'text-[11px] font-medium leading-tight',
              plain ? 'text-foreground/90' : 'text-tint-fg'
            )}
          >
            {formatMetric(metric, stats)}
          </span>
          <span
            className={cn(
              'text-[10px] leading-tight',
              plain ? 'text-muted-foreground' : 'text-tint-fg/75'
            )}
          >
            {stats.trades} {stats.trades === 1 ? 'trade' : 'trades'}
          </span>
        </>
      )}
    </div>
  );
}

function YearGrid({
  year,
  log,
  onPick,
}: {
  year: number;
  log: PerformanceLog;
  onPick: (m: number) => void;
}) {
  return (
    <div className="grid grid-cols-3 gap-px overflow-hidden rounded-[6px] bg-grid-line">
      {MONTH_NAMES.map((name, m) => {
        const s = getMonthStats(log, year, m);
        const level = intensity(s.profit);
        const positive = s.profit > 0;
        return (
          <button
            key={name}
            type="button"
            onClick={() => onPick(m)}
            className={cn(
              'flex aspect-[1.5/1] flex-col justify-end px-2.5 pb-2 pt-2 text-left transition-opacity hover:opacity-90',
              s.profit === 0 && 'bg-cell',
              s.profit !== 0 && positive && (level === 2 ? 'bg-profit-strong' : 'bg-profit'),
              s.profit !== 0 && !positive && (level === 2 ? 'bg-loss-strong' : 'bg-loss')
            )}
          >
            <span className={cn('text-[11px]', level === 0 ? 'text-muted-foreground' : 'text-tint-fg/80')}>
              {name.slice(0, 3)}
            </span>
            <span
              className={cn(
                'mt-auto text-[12px] font-medium',
                level === 0 ? 'text-foreground/90' : 'text-tint-fg'
              )}
            >
              {formatMoney(s.profit, true)}
            </span>
            <span className={cn('text-[10px]', level === 0 ? 'text-muted-foreground' : 'text-tint-fg/70')}>
              {s.trades} trades
            </span>
          </button>
        );
      })}
    </div>
  );
}

function MetricSelect({
  label,
  value,
  onChange,
  lightMode,
}: {
  label: string;
  value: Metric;
  onChange: (m: Metric) => void;
  lightMode: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn(
          'flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[12px] transition-colors',
          lightMode
            ? 'border-gray-200 bg-gray-50 text-gray-900 hover:bg-gray-100'
            : 'border-border bg-cell text-foreground/90 hover:bg-popover'
        )}
      >
        {label}
        <ChevronDown className="h-3 w-3 text-muted-foreground" />
      </button>

      {open && (
        <ul
          role="listbox"
          className={cn(
            'absolute left-0 top-[calc(100%+4px)] z-10 w-40 overflow-hidden rounded-lg border py-1 shadow-xl shadow-black/50',
            lightMode ? 'border-gray-200 bg-white' : 'border-border bg-popover'
          )}
        >
          {METRICS.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                role="option"
                aria-selected={m.id === value}
                onClick={() => {
                  onChange(m.id);
                  setOpen(false);
                }}
                className={cn(
                  'w-full px-3 py-1.5 text-left text-[12px] transition-colors hover:bg-muted',
                  m.id === value ? 'text-foreground' : 'text-muted-foreground'
                )}
              >
                {m.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
