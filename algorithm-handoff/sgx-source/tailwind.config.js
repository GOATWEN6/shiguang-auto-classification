/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      // 老年友好字体大小
      fontSize: {
        'elder': '1.25rem',     // 20px - 老年用户默认字体
        'elder-lg': '1.5rem',   // 24px
        'elder-xl': '2rem',     // 32px
        'elder-2xl': '2.5rem',  // 40px
      },
      // 老年友好间距
      spacing: {
        'elder': '1.5rem',
        'elder-lg': '2rem',
        'elder-xl': '3rem',
      },
      // 颜色配置
      colors: {
        primary: {
          50: '#f0f9ff',
          100: '#e0f2fe',
          200: '#bae6fd',
          300: '#7dd3fc',
          400: '#38bdf8',
          500: '#0ea5e9',
          600: '#0284c7',
          700: '#0369a1',
          800: '#075985',
          900: '#0c4a6e',
        },
        // 老年友好高对比度颜色
        highContrast: {
          bg: '#ffffff',
          text: '#1a1a1a',
          border: '#333333',
        }
      },
      // 老年友好圆角
      borderRadius: {
        'elder': '0.75rem',
        'elder-lg': '1rem',
      },
    },
  },
  plugins: [],
}
