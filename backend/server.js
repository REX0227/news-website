import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { initializeDatabase } from "./database.js";
import apiRouter from "./routes/api.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from backend/ or parent directories
let dotenvResult = dotenv.config({ path: path.join(__dirname, ".env") });
if (dotenvResult.error) dotenvResult = dotenv.config({ path: path.join(__dirname, "..", "v1", ".env") });
if (dotenvResult.error) dotenv.config({ path: path.join(__dirname, "..", ".env") });

const PORT = process.env.PORT || 3000;
const DOCS_PATH = path.resolve(__dirname, "..", "v1", "docs");

// Initialize database tables
initializeDatabase();

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: "50mb" }));

// API routes
app.use("/api", apiRouter);

// Serve frontend static files at /
// The v1/docs/ directory contains the existing frontend
app.use(express.static(DOCS_PATH));

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
