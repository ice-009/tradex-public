import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { AuthProvider } from "@/components/AuthProvider";
import "./globals.css";

// Inter for the whole UI; tabular figures are switched on in globals.css. next/font
// self-hosts it at build time, and --font-ui falls back to the system stack without it.
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Tradex Charts",
  description: "Live charting for the Indian markets: streaming candles, indicators, drawing tools and multi-chart layouts on the Fyers feed.",
  // Added to the iPad / iPhone Home Screen it opens full-screen, like an app.
  appleWebApp: { capable: true, title: "Tradex", statusBarStyle: "black" },
};

// iPad / Mac: dark browser chrome, and lay out under the home indicator (the dock pads itself).
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0b0d10",
  colorScheme: "dark",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} h-full antialiased`}
      data-scroll-behavior="smooth"
    >
      <body className="min-h-full flex flex-col">
        <AuthProvider>
          {children}
        </AuthProvider>
      </body>
    </html>
  );
}
