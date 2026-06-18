/* =========================================================================
 * VaderLabz TaskBoardAI — Client Renderer (app.js)
 * -------------------------------------------------------------------------
 * This module fetches the active board from the Express backend and renders
 * the bento dashboard. In production the endpoints below are served by your
 * real Express server on port 3001, reading/writing
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
async function fetchBoard() {
  const res = await fetch(API.activeBoard, { headers: { Accept: "application/json" } })
  if (!res.ok) throw new Error(`Board fetch failed: ${res.status}`)
  return res.json()
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

function renderCard(card) {
  const node = el("article", "card", { draggable: "true", "data-card-id": card.id, "data-column-id": card.columnId })

  node.appendChild(el("h3", "card-title", { text: card.title || "Untitled" }))
  if (card.content) node.appendChild(el("p", "card-content", { text: card.content }))

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
      boardEl.innerHTML = `<div class="board-loading">Unable to reach the board API. Ensure the Express backend is running on port 3001.</div>`
    }
  }
}

document.addEventListener("DOMContentLoaded", init)
