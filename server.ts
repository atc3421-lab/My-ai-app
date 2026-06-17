import express from "express";
import path from "path";
import fs from "fs";
import { createServer as createViteServer } from "vite";
import dotenv from "dotenv";
import { initializeApp } from "firebase/app";
import { getFirestore, doc, getDoc, setDoc, disableNetwork } from "firebase/firestore";

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json({ limit: "50mb" }));

const STATE_FILE_PATH = path.join(process.cwd(), "school_state_db.json");
const CONFIG_PATH = path.join(process.cwd(), "firebase-applet-config.json");

let firebaseAppConfig: any = null;
let db: any = null;

try {
  if (fs.existsSync(CONFIG_PATH)) {
    firebaseAppConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  }
} catch (e) {
  console.error("[PWA Database] Failed to read firebase-applet-config.json:", e);
}

if (firebaseAppConfig) {
  try {
    const firebaseApp = initializeApp(firebaseAppConfig);
    db = firebaseAppConfig.firestoreDatabaseId 
      ? getFirestore(firebaseApp, firebaseAppConfig.firestoreDatabaseId)
      : getFirestore(firebaseApp);
    console.log("[PWA Database] Successfully connected server side to Firestore for Cloud Persistence!");
  } catch (err) {
    console.error("[PWA Database] Error initializing Firestore server-side:", err);
  }
} else {
  console.warn("[PWA Database] No firebase config found at root. Persistence will fallback to local JSON file.");
}

let firestoreFunctional = true;

// Dry-run health check on startup to verify if the Firestore API is enabled and accessible
async function checkFirestoreConnection() {
  if (!db) {
    firestoreFunctional = false;
    return;
  }
  try {
    const docRef = doc(db, "school_data", "_boot_check");
    // Verify readable permissions and API enablement with a rapid timeout
    await withTimeout(getDoc(docRef), 1500);
    firestoreFunctional = true;
    console.log("[PWA Database] Firestore connection & authorization verified successfully.");
  } catch (err: any) {
    const msg = err.message || "";
    firestoreFunctional = false;
    console.warn("[PWA Database] Firestore connection check failed, API is disabled or inaccessible:", msg);
    console.warn("[PWA Database] Firestore circuit breaker has been tripped! System will serve multi-device requests seamlessly from local JSON file.");
    try {
      await disableNetwork(db);
      console.log("[PWA Database] Successfully disabled background Firestore network streams to avoid retry noise.");
    } catch (networkErr: any) {
      console.error("[PWA Database] Could not disable Firestore network streams:", networkErr.message || networkErr);
    }
  }
}

// Fallback handlers to local file
function readLocalFile(): any {
  try {
    if (fs.existsSync(STATE_FILE_PATH)) {
      const data = fs.readFileSync(STATE_FILE_PATH, "utf8");
      return JSON.parse(data);
    }
  } catch (err) {
    console.error("Local file read warning:", err);
  }
  return {};
}

function writeLocalFile(state: any): void {
  try {
    fs.writeFileSync(STATE_FILE_PATH, JSON.stringify(state, null, 2), "utf8");
  } catch (err) {
    console.error("Local file write warning:", err);
  }
}

// Promise wrapper to force timeout for Firestore operations to prevent routing hang-ups
function withTimeout<T>(promise: Promise<T>, ms: number = 1500): Promise<T> {
  let timeoutId: any;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`Timeout of ${ms}ms exceeded`));
    }, ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutId);
  });
}

const SERVER_KEYS = [
  "classes",
  "tasks",
  "records",
  "academicTests",
  "testMarks",
  "allotments",
  "syllabusTopicStates",
  "subjects",
  "activityLogs"
];

// Helper to load current server state (from Firestore, fallback to local file)
async function loadServerStateAsync(): Promise<any> {
  const local = readLocalFile();
  if (!db || !firestoreFunctional) {
    return local;
  }
  
  try {
    const state: any = { ...local };
    // Fetch all keys from Firestore in parallel
    const promises = SERVER_KEYS.map(async (key) => {
      try {
        const docRef = doc(db, "school_data", key);
        const docSnap = await withTimeout(getDoc(docRef), 1200);
        if (docSnap.exists()) {
          const data = docSnap.data();
          if (data && data.items !== undefined) {
            state[key] = data.items;
          }
        }
      } catch (innerDocErr: any) {
        console.warn(`[PWA Db] Key '${key}' load skipped from Firestore, using local fallback. Msg:`, innerDocErr.message);
        const msg = innerDocErr.message || "";
        if (msg.includes("PERMISSION_DENIED") || msg.includes("disabled") || msg.includes("not been used in project")) {
          firestoreFunctional = false;
          console.warn("[PWA Database] Tripping Firestore circuit breaker dynamically due to load authentication/access failure.");
          disableNetwork(db).catch(() => {});
        }
      }
    });
    
    await Promise.all(promises);
    return state;
  } catch (err: any) {
    console.error("[PWA Db] Error loading state from Firestore, falling back entirely to local file:", err);
    const msg = err.message || "";
    if (msg.includes("PERMISSION_DENIED") || msg.includes("disabled") || msg.includes("not been used in project")) {
      firestoreFunctional = false;
      disableNetwork(db).catch(() => {});
    }
    return local;
  }
}

// Helper to save server state (writes to Firestore in parallel, and local JSON file)
async function saveServerStateAsync(state: any): Promise<void> {
  // Always write locally as a fallback persistence
  writeLocalFile(state);

  if (!db || !firestoreFunctional) return;

  try {
    const promises = SERVER_KEYS.map(async (key) => {
      if (state[key] !== undefined) {
        const docRef = doc(db, "school_data", key);
        await withTimeout(setDoc(docRef, { items: state[key] }), 1500);
      }
    });
    await Promise.all(promises);
    console.log("[PWA Db] Solidified and persisted school data payload to Firestore Cloud.");
  } catch (err: any) {
    console.error("[PWA Db] Error saving state to Firestore:", err);
    firestoreFunctional = false;
    console.warn("[PWA Database] Tripping Firestore circuit breaker dynamically due to save authorization/access failure.");
    disableNetwork(db).catch(() => {});
  }
}

// Endpoints for complete offline & multi-device sync
app.get("/api/sync-state", async (req, res) => {
  try {
    const currentState = await loadServerStateAsync();
    res.status(200).json({
      success: true,
      state: currentState,
      timestamp: new Date().toISOString()
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/sync-state", async (req, res) => {
  try {
    const clientState = req.body || {};
    const serverState = await loadServerStateAsync();
    const overwrite = clientState.overwrite === true;

    if (overwrite) {
      const updatedState: any = { ...serverState };
      SERVER_KEYS.forEach((key) => {
        if (clientState[key] !== undefined) {
          updatedState[key] = clientState[key];
        }
      });

      await saveServerStateAsync(updatedState);
      console.log(`[PWA Multi-Device Sync] Force-overwrote server state with client override!`);
      res.status(200).json({
        success: true,
        state: updatedState,
        message: "Server state successfully synchronized and overwritten with client data.",
        timestamp: new Date().toISOString()
      });
      return;
    }

    const mergedState: any = { ...serverState };

    // Generic helper to merge by ID, checking lastUpdatedAt timestamps where available
    const mergeCollection = (key: string, matchKey: string = "id") => {
      const serverItems = Array.isArray(serverState[key]) ? serverState[key] : [];
      const clientItems = Array.isArray(clientState[key]) ? clientState[key] : [];

      const map = new Map<string, any>();
      
      // Seed with server items
      serverItems.forEach((item: any) => {
        if (item && item[matchKey]) map.set(item[matchKey], item);
      });

      // Merge in client items based on newer timestamp or overwrite
      clientItems.forEach((clientItem: any) => {
        if (!clientItem || !clientItem[matchKey]) return;
        const existing = map.get(clientItem[matchKey]);
        if (!existing) {
          map.set(clientItem[matchKey], clientItem);
        } else {
          // Prefer newer if lastUpdatedAt or updatedAt exists
          const clientTimeStr = clientItem.lastUpdatedAt || clientItem.updatedAt;
          const serverTimeStr = existing.lastUpdatedAt || existing.updatedAt;
          if (clientTimeStr && serverTimeStr) {
            const clientTime = new Date(clientTimeStr).getTime();
            const existingTime = new Date(serverTimeStr).getTime();
            if (clientTime >= existingTime) {
              map.set(clientItem[matchKey], clientItem);
            }
          } else if (serverTimeStr && !clientTimeStr) {
            // If server has a newer valid timestamp and client doesn't, keep the server item as newer truth
            // do nothing, let existing remain in map
          } else {
            // Default: overwrite with latest client update
            map.set(clientItem[matchKey], { ...existing, ...clientItem });
          }
        }
      });

      mergedState[key] = Array.from(map.values());
    };

    // Merge the distinct tables
    mergeCollection("classes");
    mergeCollection("tasks");
    mergeCollection("records");
    mergeCollection("academicTests");
    mergeCollection("testMarks");
    mergeCollection("allotments", "grade");
    mergeCollection("syllabusTopicStates", "id");

    // Merge simple arrays
    if (Array.isArray(clientState.subjects)) {
      const existingSubs = Array.isArray(serverState.subjects) ? serverState.subjects : [];
      mergedState.subjects = Array.from(new Set([...existingSubs, ...clientState.subjects]));
    }

    // Merge activity logs with unique IDs or timestamp ordering
    if (Array.isArray(clientState.activityLogs)) {
      const existingLogs = Array.isArray(serverState.activityLogs) ? serverState.activityLogs : [];
      const logMap = new Map<string, any>();
      existingLogs.forEach((l: any) => { if (l && l.id) logMap.set(l.id, l); });
      clientState.activityLogs.forEach((l: any) => { if (l && l.id) logMap.set(l.id, l); });
      mergedState.activityLogs = Array.from(logMap.values())
        .sort((a: any, b: any) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime())
        .slice(0, 150); // Keep last 150
    }

    await saveServerStateAsync(mergedState);

    console.log(`[PWA Multi-Device Sync] Merged sync state successfully! Records count: ${mergedState.records?.length}, Test marks count: ${mergedState.testMarks?.length}`);

    res.status(200).json({
      success: true,
      state: mergedState,
      message: "Federated server sync completed successfully.",
      timestamp: new Date().toISOString()
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Swapped custom /api/sync-records helper
app.post("/api/sync-records", async (req, res) => {
  try {
    const { records } = req.body;
    const count = Array.isArray(records) ? records.length : 0;
    
    if (count > 0) {
      const serverState = await loadServerStateAsync();
      const serverRecords = Array.isArray(serverState.records) ? serverState.records : [];
      const map = new Map<string, any>();
      serverRecords.forEach((item: any) => {
        if (item && item.id) map.set(item.id, item);
      });
      records.forEach((clientItem: any) => {
        if (!clientItem || !clientItem.id) return;
        const existing = map.get(clientItem.id);
        if (!existing || !existing.lastUpdatedAt || !clientItem.lastUpdatedAt || new Date(clientItem.lastUpdatedAt).getTime() >= new Date(existing.lastUpdatedAt).getTime()) {
          map.set(clientItem.id, clientItem);
        }
      });
      serverState.records = Array.from(map.values());
      await saveServerStateAsync(serverState);
    }

    console.log(`[PWA Backend Sync] Standard endpoint synced ${count} checks.`);
    res.status(200).json({
      success: true,
      message: "Successfully synchronized notebook checks",
      count,
      timestamp: new Date().toISOString()
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Setup Vite & Static Assets routing
async function initServer() {
  await checkFirestoreConnection();
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
