/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      fontFamily: {
        sans: [
          '"Onest Variable"',
          "-apple-system",
          "BlinkMacSystemFont",
          '"Segoe UI Variable"',
          '"Segoe UI"',
          "system-ui",
          "Roboto",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
      },
      // Uygulamanın paleti: sınıf adları (zinc, indigo, emerald, rose) korunur, tonlar temaya göre değişir.
      colors: {
        // Sıcak nötr: açık temada #f2f2ef zemin, koyu temada #18191b zemin / #242528 kart
        zinc: {
          50: "#f2f2ef",
          100: "#ebebe7",
          200: "#e0e0db",
          300: "#cfcfca",
          400: "#a3a29c",
          500: "#73726c",
          600: "#57564f",
          700: "#3e3e3b",
          800: "#313236",
          900: "#242528",
          950: "#18191b",
        },
        // Yumuşak kot mavisi (vurgu rengi)
        indigo: {
          50: "#eef3f8",
          100: "#e3ebf3",
          200: "#c9d8e7",
          300: "#a6bfd8",
          400: "#86a5c4",
          500: "#6389b0",
          600: "#4f7aa3",
          700: "#3f6589",
          800: "#35536f",
          900: "#2b3846",
          950: "#1d2733",
        },
        // Gelir / olumlu
        emerald: {
          50: "#ecf6ef",
          100: "#d8eedf",
          200: "#b3dcc0",
          300: "#8fcfa6",
          400: "#5bb07a",
          500: "#3a9a5b",
          600: "#2f8049",
          700: "#28683d",
          800: "#235334",
          900: "#1f3628",
          950: "#132219",
        },
        // Gider / olumsuz
        rose: {
          50: "#fcefee",
          100: "#f9dcdb",
          200: "#f2bab8",
          300: "#e99290",
          400: "#e06363",
          500: "#d64545",
          600: "#c13636",
          700: "#a12c2c",
          800: "#842828",
          900: "#46242a",
          950: "#2e1619",
        },
      },
      borderRadius: {
        "2xl": "18px",
      },
    },
  },
  plugins: [],
};
