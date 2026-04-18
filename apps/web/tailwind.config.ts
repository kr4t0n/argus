import type { Config } from 'tailwindcss';
import animate from 'tailwindcss-animate';

export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Geist Variable"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"Geist Mono Variable"', 'ui-monospace', 'monospace'],
      },
      colors: {
        agent: {
          'claude-code': '#fb923c', // orange
          codex: '#10b981', // emerald
          'cursor-cli': '#38bdf8', // sky
          custom: '#a3a3a3',
        },
        tool: {
          read: '#60a5fa',
          write: '#a78bfa',
          shell: '#34d399',
          task: '#38bdf8',
        },
      },
      keyframes: {
        blink: {
          '0%, 50%': { opacity: '1' },
          '50.01%, 100%': { opacity: '0' },
        },
      },
      animation: {
        blink: 'blink 1s steps(1) infinite',
      },
    },
  },
  plugins: [animate],
} satisfies Config;
