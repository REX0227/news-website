import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { initializeDatabase } from "./database.js";
import apiRouter from "./routes/api.js";
import v2Router from "./routes/v2.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from backend/ or parent directories
let dotenvResult = dotenv.config({ path: path.join(__dirname, ".env") });
if (dotenvResult.error) dotenvResult = dotenv.config({ path: path.join(__dirname, "..", "v1", ".env") });
if (dotenvResult.error) dotenv.config({ path: path.join(__dirname, "..", ".env") });

const PORT = process.env.PORT || 3000;
const DOCS_PATH = path.resolve(__dirname, "..", "v1", "docs");
const V2_PATH   = path.resolve(__dirname, "..", "v2");
const V3_PATH   = path.resolve(__dirname, "..", "v3");
const V4_PATH   = path.resolve(__dirname, "..", "v4", "docs");

// Initialize database tables
initializeDatabase();

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: "50mb" }));

// API routes
app.use("/api", apiRouter);
app.use("/api/v2", v2Router);

// V1 主前端
app.use(express.static(DOCS_PATH));

// V2 / V3 / V4 靜態頁面（各自從原本目錄提供）
app.use("/v2", express.static(V2_PATH));
app.use("/v3", express.static(V3_PATH));
app.use("/v4", express.static(V4_PATH));

// Catch-all: serve index.html for any unmatched route (SPA fallback)
app.get("*", (_req, res) => {
  res.sendFile(path.join(DOCS_PATH, "index.html"));
});

// Global error-handling middleware
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error("[server] Unhandled error:", err);
  res.status(500).json({ error: "Internal server error", detail: err.message });
});

app.listen(PORT, () => {
  console.log(`[server] CryptoPulse backend running at http://localhost:${PORT}`);
  console.log(`[server] Serving frontend from ${DOCS_PATH}`);
  console.log(`[server] API available at http://localhost:${PORT}/api`);
});
