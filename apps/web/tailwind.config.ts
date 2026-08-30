import type { Config } from 'tailwindcss';
import animate from 'tailwindcss-animate';

const hsl = (v: string) => `hsl(var(${v}) / <alpha-value>)`;

export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          '"Instrument Sans Variable"',
          'ui-sans-serif',
          'system-ui',
          'sans-serif',
        ],
        display: [
          '"Onest Variable"',
          'ui-sans-serif',
          'system-ui',
          'sans-serif',
        ],
        mono: ['"Fira Code Variable"', 'ui-monospace', 'monospace'],
      },
      colors: {
        surface: {
          0: hsl('--surface-0'),
          1: hsl('--surface-1'),
          2: hsl('--surface-2'),
        },
        fg: {
          primary: hsl('--fg-primary'),
          secondary: hsl('--fg-secondary'),
          tertiary: hsl('--fg-tertiary'),
          muted: hsl('--fg-muted'),
        },
        // Named `default` (not `border`) so it doesn't collide with
        // Tailwind's built-in `border` width utility.
        default: hsl('--border'),
        'default-strong': hsl('--border-strong'),
        primary: {
          DEFAULT: hsl('--primary-bg'),
          hover: hsl('--primary-bg-hover'),
          fg: hsl('--primary-fg'),
        },
        agent: {
          'claude-code': '#fb923c',
          codex: '#10b981',
          'cursor-cli': '#38bdf8',
          custom: '#a3a3a3',
        },
      },
      keyframes: {
        // Deep-link landing marker: a soft box that pulses in and back out.
        // Both the 0% and 100% stops are fully transparent, so after the
        // configured iteration count the highlight is simply gone — no
        // fill-mode, and nothing left behind to clear in JS.
        'turn-flash': {
          '0%, 100%': { boxShadow: '0 0 0 2px hsl(var(--flash-ring) / 0)' },
          '50%': { boxShadow: '0 0 0 2px hsl(var(--flash-ring) / 0.3)' },
        },
      },
      animation: {
        'turn-flash': 'turn-flash 0.6s ease-in-out 2',
      },
    },
  },
  plugins: [animate],
} satisfies Config;
