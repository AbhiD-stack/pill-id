import type { MetadataRoute } from "next";

// Lets the app be added to a phone's home screen and open full-screen like
// a native app (reminders keep working while it's open).
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Pill ID — Medicine Manager",
    short_name: "Pill ID",
    description: "Identify pills, track daily doses, and check medicine safety.",
    start_url: "/v3",
    display: "standalone",
    background_color: "#f8fafc",
    theme_color: "#4f46e5",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
