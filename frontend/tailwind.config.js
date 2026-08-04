/** @type {import('tailwindcss').Config} */
import tailwindcssAnimate from 'tailwindcss-animate';

export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        panel: {
          bg: 'var(--panel-bg)',
          surface: 'var(--panel-surface)',
          border: 'var(--panel-border)',
          hover: 'var(--panel-hover)',
        },
        text: {
          primary: 'var(--text-primary)',
          muted: 'var(--text-muted)',
        },
        accent: {
          buy: '#2e9461',
          sell: '#f23645',
          blue: '#3b6fff',
        },
        orion: {
          terminal: '#111111',
        },
        // Trading calendar tokens (sourced from CSS variables)
        background: 'var(--calendar-background)',
        foreground: 'var(--calendar-foreground)',
        'calendar-panel': 'var(--calendar-panel)',
        border: 'var(--calendar-border)',
        cell: 'var(--calendar-cell)',
        'cell-outside': 'var(--calendar-cell-outside)',
        popover: 'var(--calendar-popover)',
        muted: 'var(--calendar-muted)',
        'muted-foreground': 'var(--calendar-muted-foreground)',
        'grid-line': 'var(--calendar-grid-line)',
        profit: 'var(--calendar-profit)',
        'profit-strong': 'var(--calendar-profit-strong)',
        loss: 'var(--calendar-loss)',
        'loss-strong': 'var(--calendar-loss-strong)',
        gold: 'var(--calendar-gold)',
        neutralish: 'var(--calendar-gold)',
        'tint-fg': 'var(--calendar-tint-fg)',
      },
      fontFamily: {
        mono: ['"JetBrains Mono"', '"Fira Code"', 'Consolas', 'monospace'],
      },
      transitionDuration: {
        450: '450ms',
        600: '600ms',
      },
    },
  },
  plugins: [tailwindcssAnimate],
};
