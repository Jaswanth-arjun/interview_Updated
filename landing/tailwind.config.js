/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "#000000",
        surface: "rgba(255, 255, 255, 0.05)",
        primary: "#3B82F6",
        "primary-hover": "#60A5FA",
        "accent-purple": "#A855F7",
        "custom-border": "rgba(255, 255, 255, 0.1)",
        "text-main": "#FFFFFF",
        "text-muted": "rgba(255, 255, 255, 0.7)",
        "text-dim": "rgba(255, 255, 255, 0.5)",
      },
      fontFamily: {
        geist: ["Geist", "sans-serif"],
        inter: ["Inter", "sans-serif"],
      },
      spacing: {
        xs: "4px",
        sm: "12px",
        md: "24px",
        lg: "48px",
        xl: "80px",
        section: "96px",
      },
      borderRadius: {
        sm: "4px",
        md: "8px",
        lg: "16px",
      },
      animation: {
        "dash-flow": "dash-flow 10s linear infinite",
        "fade-slide-in": "fadeSlideIn 1s ease-out forwards",
      },
      keyframes: {
        "dash-flow": {
          "0%": { strokeDashoffset: "0" },
          "100%": { strokeDashoffset: "-1000" },
        },
        fadeSlideIn: {
          "0%": { opacity: "0", transform: "translateY(30px)", filter: "blur(8px)" },
          "100%": { opacity: "1", transform: "translateY(0)", filter: "blur(0)" },
        },
      },
    },
  },
  plugins: [],
}
