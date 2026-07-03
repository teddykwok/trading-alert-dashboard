/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: "#0b0e11",
          raised: "#111418",
          border: "#1f242b",
        },
      },
    },
  },
  plugins: [],
};
