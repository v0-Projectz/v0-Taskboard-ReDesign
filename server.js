/**
 * VaderLabz TaskBoardAI — Preview/Dev Server
 * -------------------------------------------------------------------------
 * NOTE: This is a lightweight static + mock-API server used ONLY so that the
 * redesigned vanilla frontend can be previewed live. In production you serve
 * the same /app directory from your real Express backend on port 3001, which
 * already implements the /api/boards/* endpoints against
 * `.cursor/boards/msc-website-v9.json`.
 *
 * The mock endpoints below mirror the shape your real API returns so the
 * client (app/js/app.js) can bind without any changes.
 */
import express from "express"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const __dirname = dirname(fileURLToPath(import.meta.url))
const app = express()
const PORT = process.env.PORT || 3001

const SAMPLE_BOARD = join(__dirname, "app", "data", "msc-website-v9.json")

app.use(express.json())

// --- Mock API (production replaces these with the real Express handlers) ---
app.get("/api/boards/active", async (_req, res) => {
  try {
    const raw = await readFile(SAMPLE_BOARD, "utf8")
    res.type("application/json").send(raw)
  } catch (err) {
    res.status(500).json({ error: "Failed to load board", detail: String(err) })
  }
})

app.get("/api/services/status", (_req, res) => {
  res.json({
    services: [
      { name: "LiteLLM", port: 4000, status: "online" },
      { name: "ComfyUI", port: 8188, status: "online" },
      { name: "Postiz", port: 4007, status: "online" },
      { name: "Hermes", port: 8642, status: "online" },
    ],
  })
})

// --- Static assets ---
app.use(express.static(join(__dirname, "app")))

app.get("/", (_req, res) => {
  res.sendFile(join(__dirname, "app", "index.html"))
})

app.listen(PORT, () => {
  console.log(`[v0] TaskBoardAI preview server running on http://localhost:${PORT}`)
})
