export interface ChartTheme {
  background: string;
  grid: string;
  text: string;
  textStrong: string;
  axisBorder: string;
  crosshair: string;
  crosshairLabel: string;
  up: string;
  down: string;
  upVolume: string;
  downVolume: string;
  line: string;
  areaTop: string;
  areaBottom: string;
  selection: string;
  font: string;
}

// Mirrors the design tokens in src/app/globals.css: the canvas is --bg, axis text is
// --text-muted / --text, hairlines are --border, candles use --pos / --neg.
// The grid is kept very faint so price action and levels carry the contrast.
export const DARK_THEME: ChartTheme = {
  background: "#0f1216",
  grid: "rgba(255, 255, 255, 0.035)",
  text: "#8b929d",
  textStrong: "#e2e5ea",
  axisBorder: "#22262d",
  crosshair: "rgba(160, 166, 176, 0.55)",
  crosshairLabel: "#2c323c",
  up: "#26a69a",
  down: "#ef5350",
  upVolume: "rgba(38, 166, 154, 0.32)",
  downVolume: "rgba(239, 83, 80, 0.32)",
  line: "#4c8dff",
  areaTop: "rgba(76, 141, 255, 0.22)",
  areaBottom: "rgba(76, 141, 255, 0.01)",
  selection: "#4c8dff",
  font: '11px Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
};
