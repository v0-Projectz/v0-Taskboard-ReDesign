/**
 * VaderLabz TaskBoardAI — Preview/Dev Server
 * -------------------------------------------------------------------------
 * Lightweight static + stateful mock-API server so the redesigned vanilla
 * frontend can be previewed live. The board is loaded from
 * `app/data/msc-website-v9.json` into memory on boot, then mutated by the
 * CRUD + feed-action endpoints below. In production you serve the same /app
 * directory from your real Express backend (PORT env, default 8080) which
 * persists to `.cursor/boards/msc-website-v9.json`.
 */
import express from "express"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const __dirname = dirname(fileURLToPath(import.meta.url))
const app = express()
const PORT = process.env.PORT || 8080

const SAMPLE_BOARD = join(__dirname, "app", "data", "msc-website-v9.json")

app.use(express.json())

/* --------------------------- In-memory state --------------------------- */
let board = null
let cardSeq = 100
let actSeq = 100

async function loadBoard() {
  const raw = await readFile(SAMPLE_BOARD, "utf8")
  board = JSON.parse(raw)
  // Seed sequence counters above any existing numeric ids.
  for (const c of board.cards || []) {
    const n = Number.parseInt(String(c.id).replace(/\D/g, ""), 10)
    if (!Number.isNaN(n) && n >= cardSeq) cardSeq = n + 1
  }
  for (const a of board.activity || []) {
    const n = Number.parseInt(String(a.id).replace(/\D/g, ""), 10)
    if (!Number.isNaN(n) && a.id && n >= actSeq) actSeq = n + 1
  }
}

function nextCardId() {
  return `card-${String(cardSeq++).padStart(3, "0")}`
}
function nextHermesId() {
  return `HRM-${2300 + Math.floor(Math.random() * 699)}`
}
function nextActId() {
  return `act-${String(actSeq++).padStart(3, "0")}`
}

function pushActivity(agent, action, opts = {}) {
  if (!board.activity) board.activity = []
  const initials = (opts.initials || agent || "??").slice(0, 2).toUpperCase()
  board.activity.unshift({
    id: nextActId(),
    agent,
    initials,
    action,
    time: "just now",
    live: !!opts.live,
    requiresApproval: false,
    status: opts.status || "done",
    details: opts.details || [],
    comments: [],
  })
  // Keep the feed from growing unbounded in the demo.
  if (board.activity.length > 30) board.activity.length = 30
}

/* ------------------------------ Board API ------------------------------ */
app.get("/api/boards/active", (_req, res) => {
  res.json(board)
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

/* ------------------------------ Task CRUD ------------------------------ */
app.post("/api/tasks", (req, res) => {
  const { title, content, columnId, assignee, priority, tags } = req.body || {}
  if (!title || !String(title).trim()) {
    return res.status(400).json({ error: "Task title is required" })
  }
  const card = {
    id: nextCardId(),
    title: String(title).trim(),
    content: content ? String(content).trim() : "",
    columnId: columnId || "backlog",
    assignee: assignee || { type: "human", name: "Tony" },
    priority: priority || "medium",
    agentStatus: assignee && assignee.type === "agent" ? "queued" : "queued",
    subtasks: [],
    tags: Array.isArray(tags) ? tags : [],
    dependencies: [],
    hermesTaskId: nextHermesId(),
  }
  board.cards.push(card)
  pushActivity(
    card.assignee.name || "System",
    `created task "${card.title}"`,
    { live: true },
  )
  res.status(201).json(card)
})

app.put("/api/tasks/:id", (req, res) => {
  const card = board.cards.find((c) => c.id === req.params.id)
  if (!card) return res.status(404).json({ error: "Task not found" })
  const { title, content, columnId, assignee, priority, agentStatus } = req.body || {}
  if (title !== undefined) card.title = String(title).trim() || card.title
  if (content !== undefined) card.content = String(content)
  if (columnId !== undefined) card.columnId = columnId
  if (assignee !== undefined) card.assignee = assignee
  if (priority !== undefined) card.priority = priority
  if (agentStatus !== undefined) card.agentStatus = agentStatus
  pushActivity(card.assignee?.name || "System", `updated task "${card.title}"`)
  res.json(card)
})

app.patch("/api/tasks/:id/move", (req, res) => {
  const card = board.cards.find((c) => c.id === req.params.id)
  if (!card) return res.status(404).json({ error: "Task not found" })
  const { columnId } = req.body || {}
  if (columnId) card.columnId = columnId
  res.json(card)
})

app.delete("/api/tasks/:id", (req, res) => {
  const idx = board.cards.findIndex((c) => c.id === req.params.id)
  if (idx === -1) return res.status(404).json({ error: "Task not found" })
  const [removed] = board.cards.splice(idx, 1)
  pushActivity("System", `deleted task "${removed.title}"`)
  res.json({ ok: true, id: removed.id })
})

/* --------------------------- Feed actions ------------------------------ */
function findFeed(id) {
  return (board.activity || []).find((a) => a.id === id)
}

app.post("/api/feed/:id/approve", (req, res) => {
  const item = findFeed(req.params.id)
  if (!item) return res.status(404).json({ error: "Feed item not found" })
  item.status = "approved"
  item.requiresApproval = false
  item.live = false
  const who = (req.body && req.body.by) || "Tony"
  item.comments.push({ author: who, text: `Approved by ${who}`, kind: "approve" })
  res.json(item)
})

app.post("/api/feed/:id/reject", (req, res) => {
  const item = findFeed(req.params.id)
  if (!item) return res.status(404).json({ error: "Feed item not found" })
  item.status = "rejected"
  item.requiresApproval = false
  item.live = false
  const reason = (req.body && req.body.reason) || "No reason provided"
  item.comments.push({ author: "Tony", text: `Rejected: ${reason}`, kind: "reject" })
  res.json(item)
})

app.post("/api/feed/:id/rerun", (req, res) => {
  const item = findFeed(req.params.id)
  if (!item) return res.status(404).json({ error: "Feed item not found" })
  // Re-running pushes a fresh live entry to the top of the feed.
  pushActivity(item.agent, `re-ran: ${item.action}`, {
    live: true,
    status: item.requiresApproval ? "pending" : "done",
    initials: item.initials,
    details: item.details,
  })
  res.json({ ok: true })
})

app.post("/api/feed/:id/comment", (req, res) => {
  const item = findFeed(req.params.id)
  if (!item) return res.status(404).json({ error: "Feed item not found" })
  const text = (req.body && req.body.text) || ""
  if (!text.trim()) return res.status(400).json({ error: "Comment text required" })
  item.comments.push({ author: "Tony", text: text.trim(), kind: "comment" })
  res.json(item)
})

/* ------------------------------ Build run ------------------------------ */
app.post("/api/build/verify", (_req, res) => {
  const ok = Math.random() > 0.15
  res.json({
    success: ok,
    steps: [
      { name: "Lint", status: "passed", detail: "0 errors, 0 warnings" },
      { name: "Typecheck", status: "passed", detail: "no type errors" },
      { name: "Unit", status: "passed", detail: "126 passed" },
      {
        name: "E2E",
        status: ok ? "passed" : "failed",
        detail: ok ? "48 passed" : "2 failed in checkout.spec.ts",
      },
      {
        name: "Deploy",
        status: ok ? "passed" : "skipped",
        detail: ok ? "staging ready" : "blocked by E2E",
      },
    ],
  })
})

/* --------------------------- Static assets ----------------------------- */
app.use(express.static(join(__dirname, "app")))

app.get("/", (_req, res) => {
  res.sendFile(join(__dirname, "app", "index.html"))
})

loadBoard().then(() => {
  app.listen(PORT, () => {
    console.log(`[v0] TaskBoardAI preview server running on http://localhost:${PORT}`)
  })
})
