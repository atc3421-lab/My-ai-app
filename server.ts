import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import dotenv from "dotenv";
import * as admin from "firebase-admin";

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json({ limit: "25mb" }));

// Initialize Firebase Admin SDK
const serviceAccount = {
  projectId: "gen-lang-client-0257986625",
  clientEmail: process.env.FIREBASE_CLIENT_EMAIL || "firebase-adminsdk@gen-lang-client-0257986625.iam.gserviceaccount.com",
  privateKey: (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
};

try {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount as admin.ServiceAccount),
    projectId: "gen-lang-client-0257986625",
  });
} catch (error) {
  // Firebase already initialized
  console.log("Firebase already initialized or error:", (error as Error).message);
}

const db = admin.firestore();

// Helper: Extract user ID from request
function getUserIdFromRequest(req: express.Request): string {
  const authHeader = req.headers["authorization"];
  if (authHeader) {
    return authHeader.split(" ")[1] || "demo-user";
  }
  return (req.headers["x-user-id"] as string) || "demo-user";
}

// Sync Endpoint: Save records from mobile to Firestore
app.post("/api/sync-records", async (req, res) => {
  try {
    const { records } = req.body;
    const userId = getUserIdFromRequest(req);

    console.log(`[API] Sync request from user: ${userId}, records: ${Array.isArray(records) ? records.length : 0}`);

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (!Array.isArray(records)) {
      return res.status(400).json({ error: "Records must be an array" });
    }

    // Save to Firestore under user's collection
    const userDataRef = db.collection("users").doc(userId).collection("projects").doc("projectBook");
    await userDataRef.set({
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

    console.log(`[API] Get records request from user: ${userId}`);

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // Fetch from Firestore
    const userDataRef = db.collection("users").doc(userId).collection("projects").doc("projectBook");
    const docSnap = await userDataRef.get();

    if (docSnap.exists) {
      const data = docSnap.data();
      console.log(`[PWA Get Records] Retrieved ${data?.count || 0} records for user ${userId}`);
      res.status(200).json({
        success: true,
        records: data?.records || [],
        lastSyncedAt: data?.lastSyncedAt,
        count: data?.count || 0,
        timestamp: new Date().toISOString(),
      });
    } else {
      console.log(`[PWA Get Records] No data found for user ${userId}`);
      res.status(200).json({
        success: true,
        records: [],
        count: 0,
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
  res.status(200).json({ 
    status: "healthy", 
    timestamp: new Date().toISOString(),
    firebase: "connected"
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
