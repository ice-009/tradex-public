import type { MetadataRoute } from "next";

// Lets the terminal be added to the iPad / Mac Home Screen and dock as a
// full-screen app (and, on iPadOS 16.4+, lets it show notifications).
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Tradex Charts",
    short_name: "Tradex",
    description: "Charts, screeners and trade setups for NSE stocks.",
    start_url: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#131722",
    theme_color: "#131722",
    icons: [
      { src: "/icon", sizes: "512x512", type: "image/png" },
      { src: "/apple-icon", sizes: "180x180", type: "image/png" },
    ],
  };
}
