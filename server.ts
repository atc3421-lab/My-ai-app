import express from "express";
import path from "path";
import fs from "fs";
import { createServer as createViteServer } from "vite";
import dotenv from "dotenv";
import { initializeApp } from "firebase/app";
import { getFirestore, doc, getDoc, setDoc, deleteDoc, disableNetwork, terminate } from "firebase/firestore";
import { REAL_STUDENT_ROSTERS } from "./src/data/realStudentData";

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

// Aggressive cleanup to terminate connections and retry loops
async function shutdownFirestore() {
  if (!db) return;
  try {
    await disableNetwork(db);
    console.log("[PWA Database] Successfully disabled background Firestore network streams.");
  } catch (err: any) {
    console.warn("[PWA Database] Error disabling network streams:", err.message || err);
  }
  try {
    await terminate(db);
    console.log("[PWA Database] Successfully terminated Firestore instance to release background resources.");
  } catch (err: any) {
    console.warn("[PWA Database] Error terminating Firestore instance:", err.message || err);
  }
}

// Dry-run health check on startup to verify if the Firestore API is enabled, accessible, and has active write quota
async function checkFirestoreConnection() {
  if (!db) {
    firestoreFunctional = false;
    return;
  }
  try {
    const docRef = doc(db, "school_data", "_boot_check");
    // Verify readable permissions first with a tight timeout
    await withTimeout(getDoc(docRef), 3000);
    
    // Verify write permissions and write quota (detect RESOURCE_EXHAUSTED immediately)
    await withTimeout(setDoc(docRef, { bootTime: new Date().toISOString() }), 3000);
    
    firestoreFunctional = true;
    console.log("[PWA Database] Firestore connection and read/write authorization verified successfully.");
  } catch (err: any) {
    const msg = err.message || err.code || "";
    firestoreFunctional = false;
    console.warn("[PWA Database] Firestore connection check failed (API disabled, inaccessible, or quota exceeded):", msg);
    console.warn("[PWA Database] Firestore circuit breaker has been tripped! System will serve multi-device requests seamlessly from local JSON file.");
    await shutdownFirestore();
  }
}

// Fallback handlers to local file
function shouldTripCircuitBreaker(err: any): boolean {
  if (!err) return false;
  const msg = (err.message || "").toLowerCase();
  const code = (err.code || "").toLowerCase();
  return (
    msg.includes("permission_denied") ||
    msg.includes("disabled") ||
    msg.includes("not been used in project") ||
    msg.includes("quota") ||
    msg.includes("exhausted") ||
    msg.includes("limit") ||
    msg.includes("resource_exhausted") ||
    msg.includes("timeout") ||
    msg.includes("expired") ||
    msg.includes("network") ||
    code.includes("permission-denied") ||
    code.includes("resource-exhausted") ||
    code.includes("timeout") ||
    err.code === 8 ||
    err.status === 8 ||
    err.name === "FirebaseError" ||
    msg.includes("firebase") ||
    msg.includes("firestore")
  );
}

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
function withTimeout<T>(promise: Promise<T>, ms: number = 10000): Promise<T> {
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

// Helper to populate/ensure students in classes are populated
function ensureClassesHaveStudents(classes: any[]): any[] {
  if (!Array.isArray(classes)) return [];
  
  return classes.map((cls) => {
    if (!cls || !cls.id) return cls;
    
    // If students is empty, populate it!
    if (!cls.students || cls.students.length === 0) {
      // Find the grade key in REAL_STUDENT_ROSTERS
      // e.g., class_i_o -> I O
      const gradePart = cls.id.replace("class_", "").toUpperCase().replace(/_/g, " "); // "I O" or "IX O" etc.
      const realNames = REAL_STUDENT_ROSTERS[gradePart];
      if (realNames && realNames.length > 0) {
        const students = realNames.map((fullName: string, studIdx: number) => {
          const rollNo = String(studIdx + 1).padStart(2, '0');
          return {
            id: `stud_${cls.id}_${studIdx + 1}`,
            name: fullName,
            rollNumber: rollNo
          };
        });
        return {
          ...cls,
          students
        };
      }
    }
    return cls;
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
  "activityLogs",
  "managementReviews"
];

// Memory cache to serve instant reads without exhausting Firestore quotas
let cachedServerState: any = null;

// Track stringified JSON of last saved keys to enable aggressive server-side dirty checking before Firestore writes
const lastSavedJson: { [key: string]: string } = {};

// Track the number of chunks stored for each key to allow cleaning up obsolete documents
const lastSavedChunkCounts: { [key: string]: number } = {};

// Single-flight background Firestore queue variables
let pendingStateToSave: any = null;
let isSavingToFirestore = false;

async function processFirestoreSaveQueue() {
  if (isSavingToFirestore || !db || !firestoreFunctional) return;
  if (!pendingStateToSave) return;

  isSavingToFirestore = true;
  const stateToSave = pendingStateToSave;
  pendingStateToSave = null; // Clear to capture next state change

  try {
    let savedAnyKey = false;
    // Write keys sequentially to prevent resource-exhausted issues on simultaneous connection streams
    for (const key of SERVER_KEYS) {
      if (!firestoreFunctional) break;
      if (stateToSave[key] !== undefined) {
        const currentJson = JSON.stringify(stateToSave[key]);
        // If this collection key hasn't changed compared to last saved state, skip write to save bandwidth/quota
        if (lastSavedJson[key] === currentJson) {
          continue;
        }

        try {
          const docRef = doc(db, "school_data", key);
          const items = stateToSave[key];

          if (Array.isArray(items) && items.length > 100) {
            // It's a large array, chunk it!
            const CHUNK_SIZE = 100;
            const chunks: any[][] = [];
            for (let i = 0; i < items.length; i += CHUNK_SIZE) {
              chunks.push(items.slice(i, i + CHUNK_SIZE));
            }

            // Write all chunks
            for (let i = 0; i < chunks.length; i++) {
              const chunkDocRef = doc(db, "school_data", `${key}_chunk_${i}`);
              await withTimeout(setDoc(chunkDocRef, { items: chunks[i] }), 15000);
            }

            // Write main document indicating chunking
            await withTimeout(setDoc(docRef, { isChunked: true, chunkCount: chunks.length }), 15000);

            // Clean up old chunks if there were more previously
            const prevCount = lastSavedChunkCounts[key] || 0;
            if (prevCount > chunks.length) {
              for (let i = chunks.length; i < prevCount; i++) {
                const obsoleteDocRef = doc(db, "school_data", `${key}_chunk_${i}`);
                try {
                  await withTimeout(deleteDoc(obsoleteDocRef), 15000);
                } catch (delErr) {
                  console.warn(`[PWA Db] Key '${key}' obsolete chunk deletion failed:`, delErr);
                }
              }
            }
            lastSavedChunkCounts[key] = chunks.length;
          } else {
            // Save normally (un-chunked)
            await withTimeout(setDoc(docRef, { items }), 15000);

            // If it was chunked previously, clean up all chunks
            const prevCount = lastSavedChunkCounts[key] || 0;
            if (prevCount > 0) {
              for (let i = 0; i < prevCount; i++) {
                const obsoleteDocRef = doc(db, "school_data", `${key}_chunk_${i}`);
                try {
                  await withTimeout(deleteDoc(obsoleteDocRef), 15000);
                } catch (delErr) {
                  console.warn(`[PWA Db] Key '${key}' obsolete chunk deletion failed:`, delErr);
                }
              }
            }
            lastSavedChunkCounts[key] = 0;
          }

          lastSavedJson[key] = currentJson; // Keep in sync on successful write
          savedAnyKey = true;
        } catch (innerSaveErr: any) {
          console.error(`[PWA Db] Key '${key}' save failed to Firestore:`, innerSaveErr.message || innerSaveErr);
          if (shouldTripCircuitBreaker(innerSaveErr)) {
            firestoreFunctional = false;
            console.warn("[PWA Database] Tripping Firestore circuit breaker dynamically due to save key failure/timeout/quota.");
            await shutdownFirestore();
            break;
          }
        }
      }
    }
    if (firestoreFunctional && savedAnyKey) {
      console.log("[PWA Db] Solidified and persisted changed state keys to Firestore Cloud.");
    }
  } catch (err: any) {
    console.error("[PWA Db] Error saving state to Firestore:", err);
    if (shouldTripCircuitBreaker(err)) {
      firestoreFunctional = false;
      console.warn("[PWA Database] Tripping Firestore circuit breaker dynamically due to general save failure/timeout/quota.");
      await shutdownFirestore();
    }
  } finally {
    isSavingToFirestore = false;
    // Process next queued state change with a small buffer delay to give Firestore streams breathing room
    if (pendingStateToSave && firestoreFunctional) {
      setTimeout(() => {
        processFirestoreSaveQueue().catch(e => console.error("[PWA Db] Queue error:", e));
      }, 1000);
    }
  }
}

let lastCacheLoadedTime = 0;
const CACHE_TTL_MS = 5000; // 5 seconds cache TTL

// Helper to load current server state (from Firestore, fallback to local file)
async function loadServerStateAsync(bypassCache = false): Promise<any> {
  const now = Date.now();
  // Return memory cache immediately for lightning-fast reads if within TTL and not bypassed
  if (!bypassCache && cachedServerState && (now - lastCacheLoadedTime < CACHE_TTL_MS)) {
    return cachedServerState;
  }

  const local = readLocalFile();
  let state: any = { ...local };
  
  if (db && firestoreFunctional) {
    try {
      console.log("[PWA Db] Memory cache miss / Server startup: Fetching initial state from Firestore Cloud...");
      // Fetch keys from Firestore sequentially to support immediate circuit breaking on error/quota exhaustion
      for (const key of SERVER_KEYS) {
        if (!firestoreFunctional) break;
        try {
          const docRef = doc(db, "school_data", key);
          const docSnap = await withTimeout(getDoc(docRef), 5000);
          if (docSnap.exists()) {
            const data = docSnap.data();
            if (data && data.isChunked) {
              const chunkCount = data.chunkCount || 0;
              lastSavedChunkCounts[key] = chunkCount;
              const mergedItems: any[] = [];
              for (let i = 0; i < chunkCount; i++) {
                const chunkDocRef = doc(db, "school_data", `${key}_chunk_${i}`);
                const chunkSnap = await withTimeout(getDoc(chunkDocRef), 5000);
                if (chunkSnap.exists()) {
                  const chunkData = chunkSnap.data();
                  if (chunkData && Array.isArray(chunkData.items)) {
                    mergedItems.push(...chunkData.items);
                  }
                }
              }
              state[key] = mergedItems;
            } else if (data && data.items !== undefined) {
              state[key] = data.items;
              lastSavedChunkCounts[key] = 0;
            }
          }
        } catch (innerDocErr: any) {
          console.warn(`[PWA Db] Key '${key}' load skipped from Firestore, using local fallback. Msg:`, innerDocErr.message || innerDocErr);
          if (shouldTripCircuitBreaker(innerDocErr)) {
            firestoreFunctional = false;
            console.warn("[PWA Database] Tripping Firestore circuit breaker dynamically due to load document failure/timeout/quota.");
            await shutdownFirestore();
            state = { ...local };
            break;
          }
        }
      }
    } catch (err: any) {
      console.error("[PWA Db] Error loading state from Firestore, falling back entirely to local file:", err);
      if (shouldTripCircuitBreaker(err)) {
        firestoreFunctional = false;
        await shutdownFirestore();
      }
      state = { ...local };
    }
  }

  // Ensure classes have students populated properly
  if (state && Array.isArray(state.classes)) {
    let changed = false;
    const oldClasses = state.classes;
    const populated = ensureClassesHaveStudents(state.classes);
    
    // Check if any students list was actually modified/filled from empty
    for (let i = 0; i < populated.length; i++) {
      const oldC = oldClasses[i];
      const newC = populated[i];
      if (newC && (!oldC || !oldC.students || oldC.students.length === 0) && newC.students && newC.students.length > 0) {
        changed = true;
        break;
      }
    }
    
    if (changed) {
      state.classes = populated;
      console.log("[PWA Db] Detected empty student lists in server state. Auto-populating student rosters and writing back to persistence.");
      // Fire-and-forget save so the fix is written back to local JSON and/or firestore
      saveServerStateAsync(state).catch(e => console.error("Auto-population save failed:", e));
    }
  }

  // Populate the dirty-checking cache so we don't rewrite unchanged keys to Firestore on the first save
  for (const key of SERVER_KEYS) {
    if (state[key] !== undefined) {
      lastSavedJson[key] = JSON.stringify(state[key]);
    }
  }

  cachedServerState = state;
  lastCacheLoadedTime = Date.now();
  return state;
}

// Helper to save server state (writes to Firestore sequentially, and local JSON file)
async function saveServerStateAsync(state: any): Promise<void> {
  // Instantly update the local memory cache to keep in-flight clients synchronized
  cachedServerState = state;
  lastCacheLoadedTime = Date.now();

  // Always write locally as a fallback persistence immediately
  writeLocalFile(state);

  if (!db || !firestoreFunctional) return;

  // Enqueue the state update for background processing in the single-flight worker
  pendingStateToSave = state;
  processFirestoreSaveQueue().catch(e => console.error("[PWA Db] Background queue push error:", e));
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
    const serverState = await loadServerStateAsync(true);
    const overwrite = clientState.overwrite === true;

    if (overwrite) {
      const updatedState: any = { ...serverState };
      SERVER_KEYS.forEach((key) => {
        if (clientState[key] !== undefined) {
          updatedState[key] = clientState[key];
        }
      });

      if (Array.isArray(updatedState.classes)) {
        updatedState.classes = ensureClassesHaveStudents(updatedState.classes);
      }

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
    mergeCollection("managementReviews");

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

    if (Array.isArray(mergedState.classes)) {
      mergedState.classes = ensureClassesHaveStudents(mergedState.classes);
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
      const serverState = await loadServerStateAsync(true);
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
  
  // Warm up and auto-populate state tables (including student rosters if they were empty) on server start
  try {
    console.log("[PWA Database] Pre-loading and verifying backend state tables...");
    await loadServerStateAsync();
  } catch (err) {
    console.error("[PWA Database] Error during server pre-load warming:", err);
  }

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
