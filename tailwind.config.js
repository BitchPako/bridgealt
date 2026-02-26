import plugin from 'tailwindcss/plugin';

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './index.tsx', './App.tsx', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      keyframes: {
        enter: {
          '0%': {
            opacity: 'var(--tw-enter-opacity, 1)',
            transform:
              'translate3d(var(--tw-enter-translate-x, 0), var(--tw-enter-translate-y, 0), 0) scale3d(var(--tw-enter-scale, 1), var(--tw-enter-scale, 1), 1)',
          },
          '100%': {
            opacity: '1',
            transform: 'translate3d(0, 0, 0) scale3d(1, 1, 1)',
          },
        },
        'stagger-entry': {
          '0%': { opacity: '0', transform: 'translateX(-20px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
        'enter-msg': {
          '0%': { opacity: '0', transform: 'translateY(20px) scale(0.98)' },
          '100%': { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
        'pulse-glow': {
          '0%, 100%': { boxShadow: '0 0 5px var(--accent-color)', transform: 'scale(1)' },
          '50%': { boxShadow: '0 0 12px var(--accent-color)', transform: 'scale(1.08)' },
        },
        'glitch-skew': {
          '0%': { transform: 'skew(0deg)' },
          '20%': { transform: 'skew(-10deg)' },
          '40%': { transform: 'skew(10deg)' },
          '60%': { transform: 'skew(-5deg)' },
          '80%': { transform: 'skew(5deg)' },
          '100%': { transform: 'skew(0deg)' },
        },
      },
      animation: {
        in: 'enter var(--motion-duration-md) var(--motion-ease-emphasis) both',
        'stagger-entry': 'stagger-entry var(--motion-duration-slow) var(--motion-ease-standard) both',
        'enter-msg': 'enter-msg var(--motion-duration-md) var(--motion-ease-emphasis) both',
        'pulse-glow': 'pulse-glow 2s infinite ease-in-out',
        'glitch-skew': 'glitch-skew var(--motion-duration-fast) linear',
      },
    },
  },
  plugins: [
    plugin(({ addUtilities }) => {
      addUtilities(
        {
          '.animate-in': {
            animation: 'enter var(--motion-duration-md) var(--motion-ease-emphasis) both',
          },
          '.fade-in': {
            '--tw-enter-opacity': '0',
          },
          '.zoom-in-95': {
            '--tw-enter-scale': '.95',
          },
          '.slide-in-from-top': {
            '--tw-enter-translate-y': '-0.5rem',
          },
          '.slide-in-from-top-1': {
            '--tw-enter-translate-y': '-0.25rem',
          },
          '.slide-in-from-top-2': {
            '--tw-enter-translate-y': '-0.5rem',
          },
          '.slide-in-from-right': {
            '--tw-enter-translate-x': '0.5rem',
          },
          '.slide-in-from-bottom': {
            '--tw-enter-translate-y': '0.5rem',
          },
          '.slide-in-from-bottom-0': {
            '--tw-enter-translate-y': '0',
          },
          '.slide-in-from-bottom-2': {
            '--tw-enter-translate-y': '0.5rem',
          },
          '.slide-in-from-bottom-5': {
            '--tw-enter-translate-y': '1.25rem',
          },
          '.slide-in-from-left-2': {
            '--tw-enter-translate-x': '-0.5rem',
          },
          '.animate-stagger-entry': {
            animation: 'stagger-entry var(--motion-duration-slow) var(--motion-ease-standard) both',
            opacity: '0',
          },
          '.animate-enter-msg': {
            animation: 'enter-msg var(--motion-duration-md) var(--motion-ease-emphasis) both',
          },
          '.hover-glitch:active': {
            animation: 'glitch-skew var(--motion-duration-fast) linear',
          },
          '.motion-fast': {
            transitionDuration: 'var(--motion-duration-fast)',
            animationDuration: 'var(--motion-duration-fast)',
          },
          '.motion-md': {
            transitionDuration: 'var(--motion-duration-md)',
            animationDuration: 'var(--motion-duration-md)',
          },
          '.motion-slow': {
            transitionDuration: 'var(--motion-duration-slow)',
            animationDuration: 'var(--motion-duration-slow)',
          },
        },
        ['responsive'],
      );
    }),
  ],
};
