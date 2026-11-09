/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        brand: { 50: '#eafcf7', 100: '#cdf6ec', 500: '#14b8a6', 600: '#0d9488', 700: '#0f766e', 800: '#115e59' },
        success: { DEFAULT: '#16a34a', soft: '#dcfce7' },
        warning: { DEFAULT: '#d97706', soft: '#fef3c7' },
        danger: { DEFAULT: '#dc2626', soft: '#fee2e2' },
      },
      fontFamily: { sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'] },
    },
  },
  plugins: [],
}
