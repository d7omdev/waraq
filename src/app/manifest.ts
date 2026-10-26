import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Waraq",
    short_name: "Waraq",
    description: "Scan, store and share your documents on your own server.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#0c0b10",
    theme_color: "#0c0b10",
    categories: ["productivity", "utilities"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    share_target: {
      action: "/share-target",
      method: "POST",
      enctype: "multipart/form-data",
      params: {
        title: "title",
        text: "text",
        files: [{ name: "files", accept: ["application/pdf", "image/*"] }],
      },
    },
    // Long-press app icon quick actions (Android shows up to ~4).
    shortcuts: [
      {
        name: "Scan",
        short_name: "Scan",
        description: "Scan a new document",
        url: "/scan",
        icons: [
          { src: "/icons/shortcut-scan.png", sizes: "96x96", type: "image/png" },
          { src: "/icons/shortcut-scan-192.png", sizes: "192x192", type: "image/png" },
        ],
      },
      {
        name: "Import files",
        short_name: "Import",
        description: "Import PDFs and photos",
        url: "/?action=import",
        icons: [
          { src: "/icons/shortcut-import.png", sizes: "96x96", type: "image/png" },
          { src: "/icons/shortcut-import-192.png", sizes: "192x192", type: "image/png" },
        ],
      },
      {
        name: "Search",
        short_name: "Search",
        description: "Search documents and text",
        url: "/?action=search",
        icons: [
          { src: "/icons/shortcut-search.png", sizes: "96x96", type: "image/png" },
          { src: "/icons/shortcut-search-192.png", sizes: "192x192", type: "image/png" },
        ],
      },
      {
        name: "Starred",
        short_name: "Starred",
        description: "Your starred documents",
        url: "/starred",
        icons: [
          { src: "/icons/shortcut-starred.png", sizes: "96x96", type: "image/png" },
          { src: "/icons/shortcut-starred-192.png", sizes: "192x192", type: "image/png" },
        ],
      },
    ],
  };
}
