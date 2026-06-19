/* =========================================================================
 * VaderLabz TaskBoardAI — Client Renderer (app.js)
 * -------------------------------------------------------------------------
 * This module fetches the active board from the Express backend and renders
 * the bento dashboard. In production the endpoints below are served by your
 * real Express server (PORT env, default 8080), reading/writing
 * `.cursor/boards/msc-website-v9.json`. The v0 preview server mocks the same
 * routes so the UI renders identically here.
 *
 * IMPORTANT: All DOM ids/classes the existing ES6 modules rely on are
 * preserved (#project-name, #board, #copy-board-info-btn, #refresh-board-btn,
 * #board-selector, #settings-btn, .next-steps-list, etc.).
 * ========================================================================= */

const API = {
  activeBoard: "/api/boards/active",
  serviceStatus: "/api/services/status",
  tasks: "/api/tasks",
}

// Current board cached in memory so menus/shortcuts can look cards up.
let currentBoard = null
let selectedCardId = null

// Known agents available for assignment. Derived list is merged with any
// agents already present on the board at render time.
const AGENT_ROSTER = ["Hermes", "Cartographer", "Postiz", "Sentinel", "LiteLLM", "ComfyUI"]
const HUMANS = ["Tony"]

// agentStatus → label/class used for the small card status badge.
const STATUS_META = {
  active: { label: "Active", cls: "active" },
  awaiting: { label: "Awaiting Human", cls: "awaiting" },
  error: { label: "Error", cls: "error" },
  queued: { label: "Queued", cls: "" },
  done: { label: "Done", cls: "done" },
}

/* ----------------------------- Utilities ------------------------------- */
function el(tag, className, attrs = {}) {
  const node = document.createElement(tag)
  if (className) node.className = className
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "text") node.textContent = v
    else node.setAttribute(k, v)
  }
  return node
}

function escapeHtml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

/* --------------------------- Data fetching ----------------------------- */
// fetch with a hard timeout so a hung backend doesn't leave us spinning.
async function fetchWithTimeout(url, opts = {}, ms = 5000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    return await fetch(url, { ...opts, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function fetchBoard() {
  // Up to 3 attempts with a 5s timeout each before giving up.
  let lastErr
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetchWithTimeout(API.activeBoard, { headers: { Accept: "application/json" } })
      if (!res.ok) throw new Error(`Board fetch failed: ${res.status}`)
      return await res.json()
    } catch (err) {
      lastErr = err
      console.log(`[v0] Board fetch attempt ${attempt} failed:`, err.message)
      if (attempt < 3) await new Promise((r) => setTimeout(r, 600 * attempt))
    }
  }
  throw lastErr
}

/* JSON helper for task mutations; throws with the server message on failure. */
async function apiSend(url, method, body) {
  const res = await fetchWithTimeout(url, {
    method,
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    let msg = `Request failed (${res.status})`
    try {
      const data = await res.json()
      if (data && data.error) msg = data.error
    } catch {}
    throw new Error(msg)
  }
  return res.status === 204 ? null : res.json()
}

async function fetchServices() {
  try {
    const res = await fetch(API.serviceStatus, { headers: { Accept: "application/json" } })
    if (!res.ok) throw new Error()
    const data = await res.json()
    return data.services || []
  } catch {
    // Fallback so the console always shows the four core services.
    return [
      { name: "LiteLLM", port: 4000, status: "online" },
      { name: "ComfyUI", port: 8188, status: "online" },
      { name: "Postiz", port: 4007, status: "online" },
      { name: "Hermes", port: 8642, status: "online" },
    ]
  }
}

/* ------------------------------ Rendering ------------------------------ */
function renderHeader(board) {
  const nameNode = document.getElementById("project-name")
  if (nameNode) {
    nameNode.innerHTML = `${escapeHtml(board.projectName || "TaskBoardAI")}<span class="live-dot" aria-hidden="true"></span>`
  }
  const label = document.getElementById("board-file-label")
  if (label && board.boardFile) label.textContent = board.boardFile
}

function renderNextSteps(steps = []) {
  const list = document.querySelector(".next-steps-list")
  const count = document.getElementById("next-steps-count")
  if (!list) return
  list.innerHTML = ""
  steps.forEach((step, i) => {
    const li = el("li")
    const num = el("span", "step-num", { text: `${i + 1}.` })
    const txt = el("span", "step-text", { text: step })
    li.append(num, txt)
    li.style.animationDelay = `${i * 0.06}s`
    list.appendChild(li)
  })
  if (count) count.textContent = String(steps.length)
}

function subtaskProgress(subtasks = []) {
  const total = subtasks.length
  const done = subtasks.filter((s) => s.done).length
  const pct = total ? Math.round((done / total) * 100) : 0
  return { total, done, pct }
}

function initials(name = "?") {
  const parts = String(name).trim().split(/\s+/)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return String(name).slice(0, 2).toUpperCase()
}

function renderCard(card) {
  const node = el("article", "card", {
    draggable: "true",
    "data-card-id": card.id,
    "data-column-id": card.columnId,
    "data-priority": card.priority || "medium",
  })

  // Header row: title + three-dot menu trigger.
  const head = el("div", "card-head")
  head.appendChild(el("h3", "card-title", { text: card.title || "Untitled" }))
  const menuBtn = el("button", "card-menu-btn", {
    type: "button",
    "aria-label": `Open menu for ${card.title || "task"}`,
    title: "Task options",
    "data-menu-for": card.id,
  })
  menuBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg>`
  head.appendChild(menuBtn)
  node.appendChild(head)

  if (card.content) node.appendChild(el("p", "card-content", { text: card.content }))

  // Assignee chip + agent status badge.
  const meta = el("div", "card-meta")
  const a = card.assignee || { type: "human", name: "Unassigned" }
  const chip = el("span", `assignee-chip ${a.type === "agent" ? "agent" : "human"}`)
  chip.append(
    el("span", "a-avatar", { text: initials(a.name) }),
    el("span", "a-name", { text: a.name || "Unassigned" }),
  )
  meta.appendChild(chip)
  const sMeta = STATUS_META[card.agentStatus] || STATUS_META.queued
  const badge = el("span", `status-badge ${sMeta.cls}`.trim(), { title: `Status: ${sMeta.label}` })
  badge.append(el("span", "s-dot"), document.createTextNode(sMeta.label))
  meta.appendChild(badge)
  node.appendChild(meta)

  if (Array.isArray(card.tags) && card.tags.length) {
    const tagWrap = el("div", "card-tags")
    card.tags.forEach((t) => tagWrap.appendChild(el("span", "tag", { text: t })))
    node.appendChild(tagWrap)
  }

  const foot = el("div", "card-foot")
  const { total, done, pct } = subtaskProgress(card.subtasks)
  if (total) {
    const meter = el("div", "subtask-meter")
    const track = el("div", "meter-track")
    const fill = el("div", "meter-fill")
    fill.style.width = `${pct}%`
    track.appendChild(fill)
    meter.append(track, el("span", "meter-label", { text: `${done}/${total}` }))
    foot.appendChild(meter)
  } else if (Array.isArray(card.dependencies) && card.dependencies.length) {
    foot.appendChild(el("span", "dep-flag", { text: `↳ ${card.dependencies.length} dep` }))
  } else {
    foot.appendChild(el("span", "dep-flag", { text: "no subtasks" }))
  }

  if (card.hermesTaskId) {
    foot.appendChild(el("span", "hermes-id", { text: card.hermesTaskId }))
  }
  node.appendChild(foot)

  attachDragHandlers(node)
  return node
}

function renderBoard(board) {
  const boardEl = document.getElementById("board")
  if (!boardEl) return
  boardEl.innerHTML = ""

  const columns = board.columns || []
  const cards = board.cards || []

  columns.forEach((col) => {
    const colCards = cards.filter((c) => c.columnId === col.id)

    const column = el("div", "column", { "data-hue": col.hue || col.id, "data-column-id": col.id })

    const head = el("div", "column-head")
    head.append(
      el("span", "column-rail"),
      el("span", "column-name", { text: col.name || col.id }),
      el("span", "column-count", { text: String(colCards.length) }),
    )
    column.appendChild(head)

    // Quick "+ New Task" button seeded with this column.
    const addBtn = el("button", "add-task-btn", { type: "button", "data-add-column": col.id })
    addBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14"/><path d="M5 12h14"/></svg> New Task`
    addBtn.addEventListener("click", () => openTaskModal({ columnId: col.id }))
    column.appendChild(addBtn)

    const cardWrap = el("div", "column-cards")
    colCards.forEach((c, i) => {
      const cardNode = renderCard(c)
      cardNode.style.animationDelay = `${i * 0.05}s`
      cardWrap.appendChild(cardNode)
    })
    column.appendChild(cardWrap)

    attachDropHandlers(column)
    boardEl.appendChild(column)
  })
}

function renderActivity(items = []) {
  const feed = document.getElementById("activity-feed")
  if (!feed) return
  feed.innerHTML = ""
  items.forEach((item, i) => {
    const li = el("li", "activity-item")
    li.style.animationDelay = `${i * 0.06}s`

    const avatar = el("span", "agent-avatar", { text: item.initials || (item.agent || "?").slice(0, 2).toUpperCase() })

    const body = el("div", "activity-body")
    const agentRow = el("div", "activity-agent")
    agentRow.appendChild(document.createTextNode(item.agent || "Agent"))
    if (item.live) agentRow.appendChild(el("span", "live-pill", { text: "live" }))
    body.appendChild(agentRow)
    body.appendChild(el("div", "activity-action", { text: item.action || "" }))
    body.appendChild(el("div", "activity-time", { text: item.time || "" }))

    li.append(avatar, body)
    feed.appendChild(li)
  })
}

function renderServices(services = []) {
  const wrap = document.getElementById("service-monitors")
  if (!wrap) return
  wrap.innerHTML = ""
  services.forEach((svc) => {
    const stateClass = svc.status === "offline" ? "offline" : svc.status === "warn" ? "warn" : ""
    const capsule = el("span", `service-capsule ${stateClass}`.trim())
    capsule.append(
      el("span", "svc-dot"),
      el("span", "svc-name", { text: svc.name }),
      el("span", "svc-port", { text: String(svc.port) }),
    )
    wrap.appendChild(capsule)
  })
}

/* ----------------------- Drag & drop (visual) -------------------------- */
let draggedCard = null

function attachDragHandlers(cardNode) {
  cardNode.addEventListener("dragstart", () => {
    draggedCard = cardNode
    cardNode.classList.add("dragging")
  })
  cardNode.addEventListener("dragend", () => {
    cardNode.classList.remove("dragging")
    draggedCard = null
    document.querySelectorAll(".column.drag-over").forEach((c) => c.classList.remove("drag-over"))
  })
}

function attachDropHandlers(column) {
  column.addEventListener("dragover", (e) => {
    e.preventDefault()
    column.classList.add("drag-over")
  })
  column.addEventListener("dragleave", () => column.classList.remove("drag-over"))
  column.addEventListener("drop", (e) => {
    e.preventDefault()
    column.classList.remove("drag-over")
    if (!draggedCard) return
    const target = column.querySelector(".column-cards")
    if (target) target.appendChild(draggedCard)
    // NOTE: hook your existing persistence call here, e.g.
    // PATCH /api/boards/active/cards/:id { columnId: column.dataset.columnId }
    updateColumnCounts()
  })
}

function updateColumnCounts() {
  document.querySelectorAll(".column").forEach((col) => {
    const count = col.querySelector(".column-count")
    const n = col.querySelectorAll(".column-cards .card").length
    if (count) count.textContent = String(n)
  })
}

/* --------------------------- Controls ---------------------------------- */
function wireControls(board) {
  document.getElementById("refresh-board-btn")?.addEventListener("click", () => init())

  document.getElementById("copy-board-info-btn")?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(board, null, 2))
      flashJarvis("board snapshot copied to clipboard")
    } catch {
      flashJarvis("clipboard unavailable")
    }
  })

  document.getElementById("board-selector")?.addEventListener("click", () => {
    flashJarvis("board switcher · connect to /api/boards")
  })
  document.getElementById("settings-btn")?.addEventListener("click", () => flashJarvis("settings panel"))
  document.getElementById("load-board-btn")?.addEventListener("click", () => flashJarvis("load board dialog"))
  document.getElementById("archive-board-btn")?.addEventListener("click", () => flashJarvis("archive current board"))

  document.querySelectorAll(".qa-btn").forEach((btn) => {
    btn.addEventListener("click", () => flashJarvis(`dispatching: ${btn.dataset.action}`))
  })

  wireActivityCollapse()
}

/* -------------------- Agent Activity collapse -------------------------- */
function setActivityCollapsed(collapsed) {
  const workspace = document.querySelector(".workspace")
  const panel = document.getElementById("activity-panel")
  const collapseBtn = document.getElementById("activity-collapse-btn")
  const expandBtn = document.getElementById("activity-expand-btn")
  if (!workspace || !panel) return

  workspace.classList.toggle("activity-collapsed", collapsed)
  panel.classList.toggle("collapsed", collapsed)
  collapseBtn?.setAttribute("aria-expanded", String(!collapsed))
  expandBtn?.setAttribute("aria-expanded", String(!collapsed))

  flashJarvis(collapsed ? "agent activity collapsed" : "agent activity expanded")
}

function wireActivityCollapse() {
  const collapseBtn = document.getElementById("activity-collapse-btn")
  const expandBtn = document.getElementById("activity-expand-btn")
  // Guard against double-binding when init() re-runs on refresh.
  if (collapseBtn && !collapseBtn.dataset.bound) {
    collapseBtn.dataset.bound = "1"
    collapseBtn.addEventListener("click", () => setActivityCollapsed(true))
  }
  if (expandBtn && !expandBtn.dataset.bound) {
    expandBtn.dataset.bound = "1"
    expandBtn.addEventListener("click", () => setActivityCollapsed(false))
  }
}

let jarvisTimer = null
function flashJarvis(message) {
  const sub = document.getElementById("jarvis-sub")
  if (!sub) return
  const original = "listening · agent CLI bridge"
  sub.textContent = message
  clearTimeout(jarvisTimer)
  jarvisTimer = setTimeout(() => {
    sub.textContent = original
  }, 2600)
}

/* ------------------------------- Init ---------------------------------- */
async function init() {
  try {
    const [board, services] = await Promise.all([fetchBoard(), fetchServices()])
    renderHeader(board)
    renderNextSteps(board.nextSteps || [])
    renderBoard(board)
    renderActivity(board.activity || [])
    renderServices(services)
    wireControls(board)
    console.log("[v0] TaskBoardAI rendered:", board.projectName)
  } catch (err) {
    console.log("[v0] Failed to initialize board:", err.message)
    const boardEl = document.getElementById("board")
    if (boardEl) {
      boardEl.innerHTML = `<div class="board-loading">Unable to reach the board API. Ensure the Express backend is running.</div>`
    }
  }
}

document.addEventListener("DOMContentLoaded", init)
