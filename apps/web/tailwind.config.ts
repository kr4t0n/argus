import type { Config } from 'tailwindcss';
import animate from 'tailwindcss-animate';

// Wrap a CSS variable as an HSL color so Tailwind's slash-opacity
// modifier (`bg-surface-1/60`) keeps working. The variable holds bare
// HSL components ("0 0% 9%") — see `:root` / `.dark` blocks in
// index.css — so this lives behind one `hsl()` call.
const hsl = (v: string) => `hsl(var(${v}) / <alpha-value>)`;

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
        // Semantic theme tokens. Replace literal neutral-* classes with
        // these so a single `dark` class flip on <html> swaps the
        // entire surface palette. See index.css for the variable
        // definitions and the rationale behind each step.
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
        // `border-default` reads naturally as a class (`border-default`
        // / `border border-default`) without colliding with Tailwind's
        // built-in `border` utility (which sets width).
        default: hsl('--border'),
        'default-strong': hsl('--border-strong'),
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
