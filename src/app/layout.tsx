import type { Metadata, Viewport } from "next";
import { Geist, Instrument_Sans, Geist_Mono, IBM_Plex_Sans_Arabic } from "next/font/google";
import { AppRuntime } from "@/components/app-runtime";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
// Display face for page titles + wordmark: Instrument Sans (light, compact via the wdth axis, pairs with Geist).
const display = Instrument_Sans({
  variable: "--font-display-face",
  subsets: ["latin"],
  axes: ["wdth"],
});
const arabic = IBM_Plex_Sans_Arabic({
  variable: "--font-arabic",
  subsets: ["arabic"],
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: { default: "Waraq", template: "%s · Waraq" },
  description: "Your scans and documents, on your own server.",
  applicationName: "Waraq",
  appleWebApp: { capable: true, title: "Waraq", statusBarStyle: "black-translucent" },
  icons: {
    icon: [
      { url: "/icons/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180" }],
  },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  themeColor: "#0c0b10",
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${display.variable} ${arabic.variable} antialiased`}
    >
      <body className="min-h-dvh">
        {children}
        <AppRuntime />
      </body>
    </html>
  );
}
