/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
  theme: {
    extend: {
      colors: {
        // Two-level surface scheme. Slightly blue-tinted (chroma 0.010 at
        // hue 252), slightly brighter than pure black so cards register.
        // bg-0 = page floor, bg-1 = raised surface (cards, mocks). Anywhere
        // that needs to look "inset" inside a card uses bg-0 again.
        bg: {
          // Tinted toward the brand (green, hue 158) per
          // color-and-contrast.md doctrine. Cohesion with the live
          // status dot, brand accents, and laser beam.
          0: 'oklch(0.130 0.010 158)',
          1: 'oklch(0.170 0.012 158)',
          2: 'oklch(0.170 0.012 158)',
          3: 'oklch(0.130 0.010 158)',
        },
        fg: {
          0: 'oklch(0.96 0.004 158)',
          1: 'oklch(0.78 0.004 158)',
          2: 'oklch(0.58 0.004 158)',
          3: 'oklch(0.42 0.004 158)',
        },
        argus: {
          green: 'oklch(0.78 0.17 158)',
          glow: 'oklch(0.66 0.20 158)',
          rim: 'oklch(0.86 0.14 158)',
          deep: 'oklch(0.45 0.18 158)',
        },
      },
      fontFamily: {
        sans: ['"Onest Variable"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono Variable"', 'ui-monospace', 'monospace'],
        // Headings reuse Onest at higher weight for cohesion.
        display: ['"Onest Variable"', 'ui-sans-serif', 'sans-serif'],
      },
      fontSize: {
        // Tighter, editorial scale. Smaller across the board.
        'hero': ['clamp(2.25rem, 4.8vw, 4rem)', { lineHeight: '1.0', letterSpacing: '-0.025em' }],
        'h2': ['clamp(1.625rem, 2.6vw, 2.25rem)', { lineHeight: '1.1', letterSpacing: '-0.015em' }],
        'h3': ['1.25rem', { lineHeight: '1.25', letterSpacing: '-0.01em' }],
        'lead': ['1rem', { lineHeight: '1.6' }],
      },
      letterSpacing: {
        'tightest': '-0.03em',
      },
      maxWidth: {
        prose: '68ch',
        page: '1200px',
      },
      transitionTimingFunction: {
        'out-expo': 'cubic-bezier(0.16, 1, 0.3, 1)',
      },
      animation: {
        'blob-a': 'blob-a 64s ease-in-out infinite',
        'blob-b': 'blob-b 80s ease-in-out infinite',
        'blob-c': 'blob-c 50s ease-in-out infinite',
        'pulse-rim': 'pulse-rim 4s ease-in-out infinite',
        'cursor-blink': 'cursor-blink 1.05s steps(2, end) infinite',
      },
      keyframes: {
        'blob-a': {
          '0%, 100%': { transform: 'translate3d(-12%, -8%, 0) scale(1)' },
          '50%': { transform: 'translate3d(8%, 6%, 0) scale(1.1)' },
        },
        'blob-b': {
          '0%, 100%': { transform: 'translate3d(8%, 12%, 0) scale(1.05)' },
          '50%': { transform: 'translate3d(-10%, -6%, 0) scale(0.95)' },
        },
        'blob-c': {
          '0%, 100%': { transform: 'translate3d(0%, 0%, 0) scale(0.9)' },
          '50%': { transform: 'translate3d(6%, -10%, 0) scale(1.05)' },
        },
        'pulse-rim': {
          '0%, 100%': { opacity: '0.55' },
          '50%': { opacity: '1' },
        },
        'cursor-blink': {
          '0%, 49%': { opacity: '1' },
          '50%, 100%': { opacity: '0' },
        },
      },
    },
  },
  plugins: [],
};
