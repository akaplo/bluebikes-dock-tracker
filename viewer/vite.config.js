import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import bluebikesApi from "./vite-plugin-bluebikes.js";

// Serve on a fixed port, localhost only. The bluebikesApi plugin adds the
// small /api routes the page uses to read the CSV and edit the station list.
export default defineConfig({
  plugins: [react(), bluebikesApi()],
  server: { port: 5273, host: false },
  preview: { port: 5273, host: false },
});
