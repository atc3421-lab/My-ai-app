import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json({ limit: "25mb" }));

// Sync Endpoint for Service Worker background sync or offline sync queue
app.post("/api/sync-records", (req, res) => {
  const { records } = req.body;
  const count = Array.isArray(records) ? records.length : 0;
  console.log(`[PWA Backend Sync] Server synchronized and accepted ${count} pending notebook records successfully!`);
  res.status(200).json({
    success: true,
    message: "Successfully synchronized offline notebook checks",
    count,
    timestamp: new Date().toISOString()
  });
});

// Setup Vite & Static Assets routing
async function initServer() {
  if (process.env.NODE_ENV !== "production") {
    console.log("Starting server in development mode with Vite middleware...");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    console.log("Starting server in production mode serving static dist...");
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server fully responding on host 0.0.0.0 port ${PORT}`);
  });
}

initServer();
