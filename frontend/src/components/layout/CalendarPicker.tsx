import { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

interface CalendarPickerProps {
  value: string; // YYYY-MM-DD
  onChange: (date: string) => void;
  minDate: string; // YYYY-MM-DD
  maxDate: string; // YYYY-MM-DD
  onClose?: () => void;
  lightMode?: boolean;
}

export function CalendarPicker({ value, onChange, minDate, maxDate, onClose, lightMode = false }: CalendarPickerProps) {
  const [currentMonth, setCurrentMonth] = useState(() => {
    const d = value ? new Date(value) : new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });

  const daysInMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 0).getDate();
  const firstDayOfMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth(), 1).getDay();
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dayNames = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

  // Format using local date components so timezone conversion does not shift
  // the displayed day and accidentally grey out valid weekdays.
  const formatDate = (date: Date) => {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  };

  const isDateDisabled = (date: Date) => {
    const dateStr = formatDate(date);
    const day = date.getDay();
    // Disable weekends and clamp to the supplied bounds. Weekdays inside the
    // range remain fully clickable.
    return day === 0 || day === 6 || dateStr < minDate || dateStr > maxDate;
  };

  const isSelected = (date: Date) => {
    return formatDate(date) === value;
  };

  const handleDateClick = (date: Date) => {
    if (!isDateDisabled(date)) {
      onChange(formatDate(date));
      onClose?.();
    }
  };

  const handlePrevMonth = () => {
    setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1));
  };

  const handleNextMonth = () => {
    setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1));
  };

  const renderDays = () => {
    const days = [];
    const prevMonthDays = new Date(currentMonth.getFullYear(), currentMonth.getMonth(), 0).getDate();

    // Previous month padding
    for (let i = firstDayOfMonth - 1; i >= 0; i--) {
      const date = new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, prevMonthDays - i);
      days.push(
        <button
          key={`prev-${i}`}
          disabled
          className={`w-8 h-8 text-sm cursor-not-allowed ${lightMode ? 'text-gray-300' : 'text-[#4a4d55]'}`}
        >
          {date.getDate()}
        </button>
      );
    }

    // Current month days
    for (let i = 1; i <= daysInMonth; i++) {
      const date = new Date(currentMonth.getFullYear(), currentMonth.getMonth(), i);
      const disabled = isDateDisabled(date);
      const selected = isSelected(date);

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
                ? 'text-gray-300 cursor-not-allowed'
                : 'text-[#4a4d55] cursor-not-allowed'
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
      const date = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, i);
      days.push(
        <button
          key={`next-${i}`}
          disabled
          className={`w-8 h-8 text-sm cursor-not-allowed ${lightMode ? 'text-gray-300' : 'text-[#4a4d55]'}`}
        >
          {date.getDate()}
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
          {monthNames[currentMonth.getMonth()]} {currentMonth.getFullYear()}
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
