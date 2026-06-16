import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import dotenv from "dotenv";
import { initializeApp } from "firebase/app";
import { getFirestore, collection, doc, setDoc, getDoc, query, where, getDocs } from "firebase/firestore";

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json({ limit: "25mb" }));

// Initialize Firebase
const firebaseConfig = {
  projectId: "gen-lang-client-0257986625",
  appId: "1:256152819428:web:c931ddd8d9169e637fbef1",
  apiKey: "AIzaSyBOk3mVbtM5XW6Cp3LHo5FuPJUa02Rlmis",
  authDomain: "gen-lang-client-0257986625.firebaseapp.com",
  storageBucket: "gen-lang-client-0257986625.firebasestorage.app",
  messagingSenderId: "256152819428",
};

const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);

// Helper: Extract user ID from request (from auth token header)
function getUserIdFromRequest(req: express.Request): string | null {
  const authHeader = req.headers["authorization"];
  if (!authHeader) {
    // For demo purposes, use a default user ID
    return req.headers["x-user-id"] as string || "demo-user";
  }
  // In production, verify the token here
  return authHeader.split(" ")[1] || "demo-user";
}

// Sync Endpoint: Save records from mobile to Firestore
app.post("/api/sync-records", async (req, res) => {
  try {
    const { records } = req.body;
    const userId = getUserIdFromRequest(req);

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (!Array.isArray(records)) {
      return res.status(400).json({ error: "Records must be an array" });
    }

    // Save to Firestore under user's collection
    const userDataRef = doc(db, "users", userId, "projects", "projectBook");
    await setDoc(userDataRef, {
      records,
      lastSyncedAt: new Date().toISOString(),
      count: records.length,
    }, { merge: true });

    console.log(`[PWA Backend Sync] Saved ${records.length} records for user ${userId} to Firestore`);
    
    res.status(200).json({
      success: true,
      message: "Successfully synchronized and saved to database",
      count: records.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[PWA Backend Sync Error]", error);
    res.status(500).json({
      success: false,
      error: "Failed to sync records",
      message: (error as Error).message,
    });
  }
});

// Fetch Endpoint: Desktop retrieves data from Firestore
app.get("/api/get-records", async (req, res) => {
  try {
    const userId = getUserIdFromRequest(req);

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // Fetch from Firestore
    const userDataRef = doc(db, "users", userId, "projects", "projectBook");
    const docSnap = await getDoc(userDataRef);

    if (docSnap.exists()) {
      const data = docSnap.data();
      console.log(`[PWA Get Records] Retrieved ${data.count} records for user ${userId}`);
      res.status(200).json({
        success: true,
        records: data.records || [],
        lastSyncedAt: data.lastSyncedAt,
        timestamp: new Date().toISOString(),
      });
    } else {
      console.log(`[PWA Get Records] No data found for user ${userId}`);
      res.status(200).json({
        success: true,
        records: [],
        message: "No records found",
        timestamp: new Date().toISOString(),
      });
    }
  } catch (error) {
    console.error("[PWA Get Records Error]", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch records",
      message: (error as Error).message,
    });
  }
});

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.status(200).json({ status: "healthy", timestamp: new Date().toISOString() });
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
