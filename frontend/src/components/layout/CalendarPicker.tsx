import { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { formatCalendarDate, isCalendarDayDisabled, isCalendarDayUnavailable } from '../../lib/calendar';

interface CalendarPickerProps {
  value: string; // YYYY-MM-DD
  onChange: (date: string) => void;
  minDate: string; // YYYY-MM-DD
  maxDate: string; // YYYY-MM-DD
  availableDates?: string[]; // dates that actually have local candles
  onClose?: () => void;
  lightMode?: boolean;
}

export function CalendarPicker({ value, onChange, minDate, maxDate, availableDates = [], onClose, lightMode = false }: CalendarPickerProps) {
  const initialMonth = (() => {
    if (!value) return new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
    const [y, m] = value.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, 1));
  })();

  const [currentMonth, setCurrentMonth] = useState(initialMonth);

  const daysInMonth = new Date(Date.UTC(currentMonth.getUTCFullYear(), currentMonth.getUTCMonth() + 1, 0)).getUTCDate();
  const firstDayOfMonth = new Date(Date.UTC(currentMonth.getUTCFullYear(), currentMonth.getUTCMonth(), 1)).getUTCDay();
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dayNames = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

  const isDateDisabled = (date: Date) => isCalendarDayDisabled(date, minDate, maxDate, availableDates);
  const isSelected = (date: Date) => formatCalendarDate(date) === value;
  const isUnavailable = (date: Date) => isCalendarDayUnavailable(date, minDate, maxDate, availableDates);

  const handleDateClick = (date: Date) => {
    if (!isDateDisabled(date)) {
      onChange(formatCalendarDate(date));
      onClose?.();
    }
  };

  const handlePrevMonth = () => {
    setCurrentMonth(new Date(Date.UTC(currentMonth.getUTCFullYear(), currentMonth.getUTCMonth() - 1, 1)));
  };

  const handleNextMonth = () => {
    setCurrentMonth(new Date(Date.UTC(currentMonth.getUTCFullYear(), currentMonth.getUTCMonth() + 1, 1)));
  };

  const renderDays = () => {
    const days = [];
    const prevMonthDays = new Date(Date.UTC(currentMonth.getUTCFullYear(), currentMonth.getUTCMonth(), 0)).getUTCDate();

    // Previous month padding
    for (let i = firstDayOfMonth - 1; i >= 0; i--) {
      const date = new Date(Date.UTC(currentMonth.getUTCFullYear(), currentMonth.getUTCMonth() - 1, prevMonthDays - i, 12, 0, 0));
      days.push(
        <button
          key={`prev-${i}`}
          disabled
          className={`w-8 h-8 text-sm cursor-not-allowed ${lightMode ? 'text-gray-300' : 'text-[#4a4d55]'}`}
        >
          {date.getUTCDate()}
        </button>
      );
    }

    // Current month days
    for (let i = 1; i <= daysInMonth; i++) {
      const date = new Date(Date.UTC(currentMonth.getUTCFullYear(), currentMonth.getUTCMonth(), i, 12, 0, 0));
      const disabled = isDateDisabled(date);
      const selected = isSelected(date);
      const unavailable = isUnavailable(date);

      days.push(
        <button
          key={i}
          onClick={() => handleDateClick(date)}
          disabled={disabled}
          className={`w-8 h-8 text-sm rounded-md transition-colors ${
            selected
              ? 'bg-[#3b6fff] text-white font-semibold'
              : disabled
              ? lightMode
                ? `text-gray-300 cursor-not-allowed ${unavailable ? 'line-through' : ''}`
                : `text-[#4a4d55] cursor-not-allowed ${unavailable ? 'line-through' : ''}`
              : lightMode
              ? 'text-gray-800 hover:bg-gray-100'
              : 'text-[#d1d4dc] hover:bg-[#363a45]'
          }`}
        >
          {i}
        </button>
      );
    }

    // Next month padding
    const totalCells = days.length;
    const remainingCells = 42 - totalCells; // 6 rows of 7 days
    for (let i = 1; i <= remainingCells; i++) {
      const date = new Date(Date.UTC(currentMonth.getUTCFullYear(), currentMonth.getUTCMonth() + 1, i, 12, 0, 0));
      days.push(
        <button
          key={`next-${i}`}
          disabled
          className={`w-8 h-8 text-sm cursor-not-allowed ${lightMode ? 'text-gray-300' : 'text-[#4a4d55]'}`}
        >
          {date.getUTCDate()}
        </button>
      );
    }

    return days;
  };

  return (
    <div className={`border rounded-lg p-4 shadow-xl w-72 ${lightMode ? 'bg-white border-gray-200' : 'bg-[#1e222d] border-[#363a45]'}`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <button
          onClick={handlePrevMonth}
          className={`p-1 rounded transition-colors ${lightMode ? 'text-gray-600 hover:bg-gray-100' : 'text-[#d1d4dc] hover:bg-[#363a45]'}`}
        >
          <ChevronLeft size={18} />
        </button>
        <span className={`text-sm font-semibold ${lightMode ? 'text-gray-900' : 'text-[#d1d4dc]'}`}>
          {monthNames[currentMonth.getUTCMonth()]} {currentMonth.getUTCFullYear()}
        </span>
        <button
          onClick={handleNextMonth}
          className={`p-1 rounded transition-colors ${lightMode ? 'text-gray-600 hover:bg-gray-100' : 'text-[#d1d4dc] hover:bg-[#363a45]'}`}
        >
          <ChevronRight size={18} />
        </button>
      </div>

      {/* Day names */}
      <div className="grid grid-cols-7 gap-1 mb-2">
        {dayNames.map((day) => (
          <div key={day} className={`text-center text-xs font-medium ${lightMode ? 'text-gray-400' : 'text-[#787b86]'}`}>
            {day}
          </div>
        ))}
      </div>

      {/* Calendar grid */}
      <div className="grid grid-cols-7 gap-1">{renderDays()}</div>
    </div>
  );
}
