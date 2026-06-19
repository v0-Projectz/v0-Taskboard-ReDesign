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
  feed: "/api/feed",
  buildVerify: "/api/build/verify",
  systemStats: "/api/system/stats",
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

/* --------------------------- System HUD -------------------------------- */
let hudTimer = null

async function fetchSystemStats() {
  try {
    const res = await fetch(API.systemStats, { headers: { Accept: "application/json" } })
    if (!res.ok) throw new Error()
    return await res.json()
  } catch {
    return null
  }
}

function formatUptime(sec = 0) {
  const h = String(Math.floor(sec / 3600)).padStart(2, "0")
  const m = String(Math.floor((sec % 3600) / 60)).padStart(2, "0")
  const s = String(sec % 60).padStart(2, "0")
  return `${h}:${m}:${s}`
}

function setGauge(metric, value) {
  const bar = document.getElementById(`hud-${metric}-bar`)
  const val = document.getElementById(`hud-${metric}-val`)
  if (bar) {
    bar.style.width = `${value}%`
    // Shift the bar toward the warning/critical color as it fills.
    bar.classList.toggle("warn", value >= 70 && value < 88)
    bar.classList.toggle("crit", value >= 88)
  }
  if (val) val.textContent = `${value}%`
}

function renderSystemStats(stats) {
  if (!stats) return
  setGauge("cpu", stats.cpu)
  setGauge("mem", stats.mem)
  setGauge("gpu", stats.gpu)
  setGauge("net", stats.net)
  const set = (id, v) => {
    const node = document.getElementById(id)
    if (node) node.textContent = String(v)
  }
  set("hud-agents", stats.activeAgents)
  set("hud-queued", stats.queued)
  set("hud-errors", stats.errors)
  const up = document.getElementById("hud-uptime")
  if (up) up.textContent = formatUptime(stats.uptimeSec)
  const hud = document.getElementById("system-hud")
  if (hud) hud.classList.toggle("has-errors", stats.errors > 0)
}

// Poll the HUD on a light interval so the gauges feel alive.
function startSystemHud() {
  wireHudToggle()
  // One immediate paint, then continuous polling only if the setting allows.
  const tick = async () => renderSystemStats(await fetchSystemStats())
  tick()
  if (settings.livePolling) setLivePolling(true)
}

// Start/stop the HUD polling interval (driven by the Settings toggle).
function setLivePolling(enabled) {
  if (enabled) {
    if (hudTimer) return
    const tick = async () => renderSystemStats(await fetchSystemStats())
    hudTimer = setInterval(tick, 2500)
  } else if (hudTimer) {
    clearInterval(hudTimer)
    hudTimer = null
  }
}

// Collapse/expand the HUD body via the header toggle.
let hudToggleWired = false
function wireHudToggle() {
  if (hudToggleWired) return
  const hud = document.getElementById("system-hud")
  const toggle = document.getElementById("hud-toggle")
  if (!hud || !toggle) return
  hudToggleWired = true
  toggle.addEventListener("click", () => {
    const collapsed = hud.classList.toggle("collapsed")
    toggle.setAttribute("aria-expanded", String(!collapsed))
  })
}

/* ------------------------------ Settings ------------------------------- */
const SETTINGS_KEY = "msc.settings.v1"
const DEFAULT_SETTINGS = {
  showHud: true,
  showNextSteps: true,
  reduceMotion: false,
  livePolling: true,
  compact: false,
}
let settings = { ...DEFAULT_SETTINGS }

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (raw) settings = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }
  } catch {
    settings = { ...DEFAULT_SETTINGS }
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  } catch {
    /* storage unavailable — settings stay in-memory for the session */
  }
}

// Reflect a single setting in the live UI.
function applySetting(key) {
  const v = settings[key]
  switch (key) {
    case "showHud": {
      const hud = document.getElementById("system-hud")
      if (hud) hud.style.display = v ? "" : "none"
      break
    }
    case "showNextSteps": {
      const panel = document.querySelector('aside.panel[aria-label="Next steps"]')
      if (panel) panel.style.display = v ? "" : "none"
      break
    }
    case "reduceMotion":
      document.body.classList.toggle("reduce-motion", v)
      break
    case "compact":
      document.body.classList.toggle("compact", v)
      break
    case "livePolling":
      setLivePolling(v)
      break
  }
}

function applyAllSettings() {
  Object.keys(settings).forEach(applySetting)
}

// Sync the switch buttons in the modal to the current settings.
function syncSettingsUI() {
  document.querySelectorAll("#settings-modal .switch").forEach((sw) => {
    const key = sw.dataset.setting
    sw.setAttribute("aria-checked", String(!!settings[key]))
  })
}

function openSettingsModal() {
  const modal = document.getElementById("settings-modal")
  if (!modal) return
  syncSettingsUI()
  modal.hidden = false
}

function closeSettingsModal() {
  const modal = document.getElementById("settings-modal")
  if (modal) modal.hidden = true
}

let settingsWired = false
function wireSettings() {
  if (settingsWired) return
  settingsWired = true

  document.querySelectorAll("#settings-modal .switch").forEach((sw) => {
    sw.addEventListener("click", () => {
      const key = sw.dataset.setting
      settings[key] = !settings[key]
      sw.setAttribute("aria-checked", String(settings[key]))
      applySetting(key)
      saveSettings()
    })
  })

  document.getElementById("settings-close")?.addEventListener("click", closeSettingsModal)
  document.getElementById("settings-done")?.addEventListener("click", closeSettingsModal)
  document.getElementById("settings-modal")?.addEventListener("click", (e) => {
    if (e.target.id === "settings-modal") closeSettingsModal()
  })
  document.getElementById("settings-reset")?.addEventListener("click", () => {
    settings = { ...DEFAULT_SETTINGS }
    applyAllSettings()
    syncSettingsUI()
    saveSettings()
    flashJarvis("settings restored to defaults")
  })
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !document.getElementById("settings-modal")?.hidden) closeSettingsModal()
  })
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

  // Header row: subtle priority dot + title + three-dot menu trigger.
  const head = el("div", "card-head")
  const prio = card.priority || "medium"
  head.appendChild(el("span", `priority-dot prio-${prio}`, { title: `${prio[0].toUpperCase()}${prio.slice(1)} priority` }))
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
    const addBtn = el("button", "add-task-btn", {
      type: "button",
      "data-add-column": col.id,
      title: `Add a task to ${col.name || "this column"} (press N)`,
    })
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

// Tracks which feed items are expanded so re-renders preserve open state.
const expandedFeed = new Set()

// status → label/class for the small feed status pill.
const FEED_STATUS = {
  pending: { label: "Needs Review", cls: "pending" },
  approved: { label: "Approved", cls: "approved" },
  rejected: { label: "Rejected", cls: "rejected" },
  done: { label: "Done", cls: "done" },
}

// Render an action string with @Mentions turned into highlighted spans.
function withMentions(text) {
  const frag = document.createDocumentFragment()
  const parts = String(text || "").split(/(@[A-Za-z][\w-]*)/g)
  parts.forEach((p) => {
    if (/^@[A-Za-z][\w-]*$/.test(p)) frag.appendChild(el("span", "mention", { text: p }))
    else frag.appendChild(document.createTextNode(p))
  })
  return frag
}

function renderActivity(items = []) {
  const feed = document.getElementById("activity-feed")
  if (!feed) return
  feed.innerHTML = ""
  if (!items.length) {
    feed.appendChild(el("li", "activity-empty", { text: "No agent activity yet." }))
    return
  }
  items.forEach((item, i) => {
    const status = item.status || (item.requiresApproval ? "pending" : "done")
    const meta = FEED_STATUS[status] || FEED_STATUS.done
    const li = el("li", `activity-item status-${status}${item.live ? " is-live" : ""}`, {
      "data-feed-id": item.id || "",
    })
    li.style.animationDelay = `${i * 0.05}s`

    const avatar = el("span", "agent-avatar", {
      text: item.initials || (item.agent || "?").slice(0, 2).toUpperCase(),
    })

    const body = el("div", "activity-body")

    // Top row: agent name + live pill + status pill.
    const agentRow = el("div", "activity-agent")
    agentRow.appendChild(document.createTextNode(item.agent || "Agent"))
    if (item.live) agentRow.appendChild(el("span", "live-pill", { text: "live" }))
    agentRow.appendChild(el("span", `status-pill ${meta.cls}`, { text: meta.label }))
    body.appendChild(agentRow)

    const action = el("div", "activity-action")
    action.appendChild(withMentions(item.action || ""))
    body.appendChild(action)
    body.appendChild(el("div", "activity-time", { text: item.time || "" }))

    // Expandable detail logs.
    const hasDetails = Array.isArray(item.details) && item.details.length
    const hasComments = Array.isArray(item.comments) && item.comments.length
    if (hasDetails || hasComments) {
      const isOpen = expandedFeed.has(item.id)
      const toggle = el("button", "feed-toggle", { type: "button" })
      toggle.textContent = isOpen ? "Hide details" : "View details"
      toggle.setAttribute("aria-expanded", String(isOpen))
      const drawer = el("div", `feed-drawer${isOpen ? " open" : ""}`)

      if (hasDetails) {
        const log = el("pre", "feed-log")
        log.textContent = item.details.join("\n")
        drawer.appendChild(log)
      }
      if (hasComments) {
        const thread = el("div", "feed-comments")
        item.comments.forEach((c) => {
          const row = el("div", `feed-comment kind-${c.kind || "comment"}`)
          row.append(
            el("span", "fc-author", { text: c.author || "User" }),
            el("span", "fc-text", { text: c.text || "" }),
          )
          thread.appendChild(row)
        })
        drawer.appendChild(thread)
      }

      toggle.addEventListener("click", () => {
        const open = drawer.classList.toggle("open")
        toggle.textContent = open ? "Hide details" : "View details"
        toggle.setAttribute("aria-expanded", String(open))
        if (open) expandedFeed.add(item.id)
        else expandedFeed.delete(item.id)
      })
      body.append(toggle, drawer)
    }

    // Action buttons.
    const actions = el("div", "feed-actions")
    if (status === "pending" && item.requiresApproval) {
      const approve = el("button", "feed-btn approve", { type: "button", text: "Approve" })
      approve.addEventListener("click", () => feedAction(item.id, "approve"))
      const reject = el("button", "feed-btn reject", { type: "button", text: "Reject" })
      reject.addEventListener("click", () => feedReject(item.id))
      actions.append(approve, reject)
    }
    const rerun = el("button", "feed-btn ghost", { type: "button", text: "Re-run" })
    rerun.addEventListener("click", () => feedAction(item.id, "rerun"))
    const comment = el("button", "feed-btn ghost", { type: "button", text: "Comment" })
    comment.addEventListener("click", () => feedComment(item.id))
    actions.append(rerun, comment)
    body.appendChild(actions)

    li.append(avatar, body)
    feed.appendChild(li)
  })
}

/* ----------------------- Feed action handlers -------------------------- */
async function refreshFeedOnly() {
  const board = await fetchBoard()
  currentBoard = board
  renderActivity(board.activity || [])
  updateAttentionBadge()
}

async function feedAction(id, kind) {
  if (!id) return
  try {
    await apiSend(`${API.feed}/${id}/${kind}`, "POST", {})
    toast(kind === "approve" ? "Action approved" : "Re-run dispatched", "success")
    flashJarvis(kind === "approve" ? "approved agent action" : "re-running agent action")
    await refreshFeedOnly()
  } catch (err) {
    toast(err.message || "Action failed", "error")
  }
}

async function feedReject(id) {
  if (!id) return
  const reason = window.prompt("Reason for rejection (optional):", "")
  if (reason === null) return // user cancelled
  try {
    await apiSend(`${API.feed}/${id}/reject`, "POST", { reason: reason || "No reason provided" })
    toast("Action rejected", "info")
    flashJarvis("rejected agent action")
    await refreshFeedOnly()
  } catch (err) {
    toast(err.message || "Reject failed", "error")
  }
}

async function feedComment(id) {
  if (!id) return
  const text = window.prompt("Add a comment:", "")
  if (!text || !text.trim()) return
  try {
    await apiSend(`${API.feed}/${id}/comment`, "POST", { text: text.trim() })
    expandedFeed.add(id) // open the drawer so the new comment is visible
    toast("Comment added", "success")
    await refreshFeedOnly()
  } catch (err) {
    toast(err.message || "Comment failed", "error")
  }
}

/* =================== Needs Attention inbox ============================= */
// An item needs attention if an agent is awaiting human approval, or a card
// or feed entry is in an error state.
function collectAttention() {
  const board = currentBoard || {}
  const feedItems = (board.activity || []).filter(
    (a) => (a.requiresApproval && a.status === "pending") || a.status === "error",
  )
  const errorCards = (board.cards || []).filter((c) => c.agentStatus === "error")
  return { feedItems, errorCards, total: feedItems.length + errorCards.length }
}

function updateAttentionBadge() {
  const badge = document.getElementById("attention-badge")
  const btn = document.getElementById("needs-attention-btn")
  if (!badge || !btn) return
  const { total } = collectAttention()
  badge.textContent = String(total)
  badge.hidden = total === 0
  btn.classList.toggle("has-attention", total > 0)
}

function openAttentionModal() {
  const modal = document.getElementById("attention-modal")
  const body = document.getElementById("attention-body")
  if (!modal || !body) return
  const { feedItems, errorCards, total } = collectAttention()
  body.innerHTML = ""

  if (total === 0) {
    const empty = el("div", "attention-empty")
    empty.append(
      el("div", "attention-empty-icon", { text: "✓" }),
      el("div", "attention-empty-title", { text: "All clear" }),
      el("div", "attention-empty-sub", { text: "No agents are waiting and no errors need review." }),
    )
    body.appendChild(empty)
    modal.hidden = false
    return
  }

  if (errorCards.length) {
    body.appendChild(el("div", "attention-group-label", { text: `Errors (${errorCards.length})` }))
    errorCards.forEach((c) => {
      const row = el("div", "attention-row error")
      const info = el("div", "attention-info")
      info.append(
        el("div", "attention-row-title", { text: c.title }),
        el("div", "attention-row-meta", { text: `${c.assignee?.name || "Unassigned"} · in ${columnName(c.columnId)}` }),
      )
      const view = el("button", "feed-btn ghost", { type: "button", text: "Open task" })
      view.addEventListener("click", () => {
        closeAttentionModal()
        openTaskModal({ cardId: c.id })
      })
      row.append(el("span", "attention-dot", { "aria-hidden": "true" }), info, view)
      body.appendChild(row)
    })
  }

  if (feedItems.length) {
    body.appendChild(el("div", "attention-group-label", { text: `Awaiting approval (${feedItems.length})` }))
    feedItems.forEach((item) => {
      const row = el("div", "attention-row pending")
      const info = el("div", "attention-info")
      const titleEl = el("div", "attention-row-title")
      titleEl.append(document.createTextNode(`${item.agent} · `), withMentions(item.action || ""))
      info.append(titleEl, el("div", "attention-row-meta", { text: item.time || "" }))
      const actions = el("div", "attention-actions")
      const approve = el("button", "feed-btn approve", { type: "button", text: "Approve" })
      approve.addEventListener("click", async () => {
        await feedAction(item.id, "approve")
        refreshAttentionModal()
      })
      const reject = el("button", "feed-btn reject", { type: "button", text: "Reject" })
      reject.addEventListener("click", async () => {
        await feedReject(item.id)
        refreshAttentionModal()
      })
      actions.append(approve, reject)
      row.append(el("span", "attention-dot", { "aria-hidden": "true" }), info, actions)
      body.appendChild(row)
    })
  }

  modal.hidden = false
}

// Re-open against fresh data after an inline action.
function refreshAttentionModal() {
  if (!document.getElementById("attention-modal")?.hidden) openAttentionModal()
  updateAttentionBadge()
}

function closeAttentionModal() {
  const modal = document.getElementById("attention-modal")
  if (modal) modal.hidden = true
}

function columnName(columnId) {
  const col = (currentBoard?.columns || []).find((c) => c.id === columnId)
  return col?.name || columnId || "board"
}

/* =================== Verify Build terminal ============================= */
let buildRunning = false

function openBuildModal() {
  const modal = document.getElementById("build-modal")
  if (!modal) return
  modal.hidden = false
  runBuildVerify()
}

function closeBuildModal() {
  const modal = document.getElementById("build-modal")
  if (modal) modal.hidden = true
}

function termLine(text, cls = "") {
  const out = document.getElementById("terminal-output")
  if (!out) return null
  const line = el("div", `term-line ${cls}`.trim(), { text })
  out.appendChild(line)
  out.scrollTop = out.scrollHeight
  return line
}

async function runBuildVerify() {
  if (buildRunning) return
  buildRunning = true
  const out = document.getElementById("terminal-output")
  const rerunBtn = document.getElementById("build-rerun")
  if (out) out.innerHTML = ""
  if (rerunBtn) rerunBtn.disabled = true

  termLine("$ jarvis verify-build --env staging", "term-cmd")
  flashJarvis("running build verification")

  try {
    const result = await apiSend(API.buildVerify, "POST", {})
    const steps = result.steps || []
    // Stream each step with a small delay for a live terminal feel.
    for (const step of steps) {
      const pending = termLine(`▸ ${step.name}…`, "term-pending")
      await delay(420)
      if (pending) {
        const mark = step.status === "passed" ? "✓" : step.status === "failed" ? "✕" : "⊘"
        pending.textContent = `${mark} ${step.name} — ${step.detail}`
        pending.className = `term-line term-${step.status}`
      }
    }
    await delay(200)
    if (result.success) {
      termLine("", "")
      termLine("✓ Build verified — staging is ready to deploy.", "term-success")
      toast("Build passed", "success")
    } else {
      termLine("", "")
      termLine("✕ Build failed — resolve failing steps before deploy.", "term-fail")
      toast("Build failed", "error")
    }
  } catch (err) {
    termLine(`✕ verify-build error: ${err.message}`, "term-fail")
    toast("Build run failed", "error")
  } finally {
    buildRunning = false
    if (rerunBtn) rerunBtn.disabled = false
    flashJarvis("listening · agent CLI bridge")
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

  // Click selects the card (for keyboard shortcuts); ignore menu-button clicks.
  cardNode.addEventListener("click", (e) => {
    if (e.target.closest(".card-menu-btn")) return
    selectCard(cardNode.dataset.cardId)
  })

  // Three-dot menu trigger.
  cardNode.querySelector(".card-menu-btn")?.addEventListener("click", (e) => {
    e.stopPropagation()
    selectCard(cardNode.dataset.cardId)
    openCardMenu(cardNode.dataset.cardId, e.currentTarget)
  })
}

function selectCard(id) {
  selectedCardId = id
  document.querySelectorAll(".card.selected").forEach((c) => c.classList.remove("selected"))
  document.querySelector(`.card[data-card-id="${id}"]`)?.classList.add("selected")
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
    const cardId = draggedCard.dataset.cardId
    const newColumn = column.dataset.columnId
    const fromColumn = draggedCard.dataset.columnId
    if (target) {
      target.appendChild(draggedCard)
      draggedCard.dataset.columnId = newColumn
      draggedCard.classList.remove("just-moved")
      void draggedCard.offsetWidth
      draggedCard.classList.add("just-moved")
    }
    updateColumnCounts()

    if (cardId && newColumn && newColumn !== fromColumn) {
      // Persist the move and keep our in-memory board in sync.
      apiSend(`${API.tasks}/${cardId}/move`, "PATCH", { columnId: newColumn })
        .then(() => {
          const c = currentBoard?.cards?.find((x) => x.id === cardId)
          if (c) c.columnId = newColumn
          flashJarvis(`moved task to ${newColumn}`)
        })
        .catch((err) => {
          toast("Move failed — reverting", "error")
          console.log("[v0] Move persist failed:", err.message)
          init()
        })
    }
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
  document.getElementById("settings-btn")?.addEventListener("click", openSettingsModal)
  document.getElementById("load-board-btn")?.addEventListener("click", () => flashJarvis("load board dialog"))
  document.getElementById("archive-board-btn")?.addEventListener("click", () => flashJarvis("archive current board"))

  document.querySelectorAll(".qa-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.action === "verify-build") openBuildModal()
      else flashJarvis(`dispatching: ${btn.dataset.action}`)
    })
  })

  wireActivityCollapse()
}

// One-time wiring for the Attention + Build modals (open/close + overlays).
let phase4Wired = false
function wirePhase4Modals() {
  if (phase4Wired) return
  phase4Wired = true

  document.getElementById("needs-attention-btn")?.addEventListener("click", openAttentionModal)
  document.getElementById("attention-close")?.addEventListener("click", closeAttentionModal)
  document.getElementById("attention-modal")?.addEventListener("click", (e) => {
    if (e.target.id === "attention-modal") closeAttentionModal()
  })

  document.getElementById("build-close")?.addEventListener("click", closeBuildModal)
  document.getElementById("build-cancel")?.addEventListener("click", closeBuildModal)
  document.getElementById("build-rerun")?.addEventListener("click", runBuildVerify)
  document.getElementById("build-modal")?.addEventListener("click", (e) => {
    if (e.target.id === "build-modal" && !buildRunning) closeBuildModal()
  })

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return
    if (!document.getElementById("attention-modal")?.hidden) closeAttentionModal()
    if (!document.getElementById("build-modal")?.hidden && !buildRunning) closeBuildModal()
  })
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

/* ------------------------------ Toasts --------------------------------- */
function toast(message, kind = "success") {
  const stack = document.getElementById("toast-stack")
  if (!stack) return
  const icons = { success: "✓", error: "✕", info: "i" }
  const node = el("div", `toast ${kind}`)
  node.append(el("span", "t-icon", { text: icons[kind] || "•" }), document.createTextNode(message))
  stack.appendChild(node)
  setTimeout(() => {
    node.classList.add("exiting")
    node.addEventListener("animationend", () => node.remove(), { once: true })
  }, 2800)
}

/* --------------------------- Assignee helpers -------------------------- */
function buildAssigneeOptions(selectEl, current) {
  if (!selectEl) return
  selectEl.innerHTML = ""
  const mk = (value, label) => {
    const o = document.createElement("option")
    o.value = value
    o.textContent = label
    return o
  }
  HUMANS.forEach((h) => selectEl.appendChild(mk(`human:${h}`, `👤 ${h}`)))
  // Merge known agents with any already on the board.
  const agents = new Set(AGENT_ROSTER)
  ;(currentBoard?.cards || []).forEach((c) => {
    if (c.assignee?.type === "agent" && c.assignee.name) agents.add(c.assignee.name)
  })
  ;[...agents].sort().forEach((a) => selectEl.appendChild(mk(`agent:${a}`, `🤖 ${a}`)))
  if (current) selectEl.value = `${current.type}:${current.name}`
}

function parseAssignee(value) {
  const [type, ...rest] = String(value).split(":")
  return { type: type === "agent" ? "agent" : "human", name: rest.join(":") }
}

/* ------------------------------ Task modal ----------------------------- */
let modalMode = "create"

function openTaskModal({ columnId = "backlog", card = null } = {}) {
  const overlay = document.getElementById("task-modal")
  if (!overlay) return
  modalMode = card ? "edit" : "create"
  document.getElementById("task-modal-title").textContent = card ? "Edit Task" : "New Task"
  document.getElementById("task-submit").textContent = card ? "Save Changes" : "Create Task"
  document.getElementById("task-id").value = card ? card.id : ""
  document.getElementById("task-column").value = card ? card.columnId : columnId
  document.getElementById("task-title").value = card ? card.title || "" : ""
  document.getElementById("task-content").value = card ? card.content || "" : ""
  document.getElementById("task-priority").value = card ? card.priority || "medium" : "medium"
  buildAssigneeOptions(
    document.getElementById("task-assignee"),
    card ? card.assignee : { type: "human", name: HUMANS[0] },
  )
  overlay.hidden = false
  setTimeout(() => document.getElementById("task-title").focus(), 40)
}

function closeTaskModal() {
  const overlay = document.getElementById("task-modal")
  if (overlay) overlay.hidden = true
}

async function submitTaskForm(e) {
  e.preventDefault()
  const id = document.getElementById("task-id").value
  const payload = {
    title: document.getElementById("task-title").value.trim(),
    content: document.getElementById("task-content").value.trim(),
    columnId: document.getElementById("task-column").value,
    assignee: parseAssignee(document.getElementById("task-assignee").value),
    priority: document.getElementById("task-priority").value,
  }
  if (!payload.title) {
    toast("Title is required", "error")
    return
  }
  try {
    if (modalMode === "edit" && id) {
      await apiSend(`${API.tasks}/${id}`, "PUT", payload)
      toast("Task updated", "success")
    } else {
      await apiSend(API.tasks, "POST", payload)
      toast("Task created", "success")
    }
    closeTaskModal()
    await refreshBoardData()
  } catch (err) {
    toast(err.message || "Save failed", "error")
  }
}

/* --------------------------- Card context menu ------------------------- */
let menuCardId = null

function openCardMenu(cardId, anchorEl) {
  const menu = document.getElementById("card-menu")
  if (!menu) return
  menuCardId = cardId
  buildAssigneeOptions(document.getElementById("menu-assign-select"), null)
  const card = currentBoard?.cards?.find((c) => c.id === cardId)
  const sel = document.getElementById("menu-assign-select")
  if (card?.assignee) sel.value = `${card.assignee.type}:${card.assignee.name}`

  menu.hidden = false
  // Position near the trigger, clamped to the viewport.
  const rect = anchorEl.getBoundingClientRect()
  const mw = menu.offsetWidth
  const mh = menu.offsetHeight
  let left = rect.right - mw
  let top = rect.bottom + 6
  if (left < 8) left = 8
  if (top + mh > window.innerHeight - 8) top = rect.top - mh - 6
  menu.style.left = `${left}px`
  menu.style.top = `${top}px`
}

function closeCardMenu() {
  const menu = document.getElementById("card-menu")
  if (menu) menu.hidden = true
  menuCardId = null
}

async function duplicateTask(cardId) {
  const card = currentBoard?.cards?.find((c) => c.id === cardId)
  if (!card) return
  try {
    await apiSend(API.tasks, "POST", {
      title: `${card.title} (Copy)`,
      content: card.content,
      columnId: card.columnId,
      assignee: card.assignee,
      priority: card.priority,
      tags: card.tags,
    })
    toast("Task duplicated", "success")
    await refreshBoardData()
  } catch (err) {
    toast(err.message || "Duplicate failed", "error")
  }
}

async function deleteTask(cardId) {
  const card = currentBoard?.cards?.find((c) => c.id === cardId)
  if (!card) return
  if (!window.confirm(`Are you sure you want to delete "${card.title}"?`)) return
  try {
    await apiSend(`${API.tasks}/${cardId}`, "DELETE")
    toast("Task deleted", "info")
    if (selectedCardId === cardId) selectedCardId = null
    await refreshBoardData()
  } catch (err) {
    toast(err.message || "Delete failed", "error")
  }
}

async function assignTask(cardId, value) {
  try {
    await apiSend(`${API.tasks}/${cardId}`, "PUT", { assignee: parseAssignee(value) })
    toast("Agent assigned", "success")
    await refreshBoardData()
  } catch (err) {
    toast(err.message || "Assign failed", "error")
  }
}

function wireMenuAndModal() {
  // These bind to static elements, so only wire once across init() re-runs.
  if (document.body.dataset.menuBound) return
  document.body.dataset.menuBound = "1"

  // Modal controls.
  document.getElementById("task-form")?.addEventListener("submit", submitTaskForm)
  document.getElementById("task-modal-close")?.addEventListener("click", closeTaskModal)
  document.getElementById("task-cancel")?.addEventListener("click", closeTaskModal)
  document.getElementById("task-modal")?.addEventListener("click", (e) => {
    if (e.target.id === "task-modal") closeTaskModal()
  })

  // Context menu actions.
  const menu = document.getElementById("card-menu")
  menu?.querySelectorAll(".menu-item").forEach((item) => {
    item.addEventListener("click", () => {
      const act = item.dataset.act
      const id = menuCardId
      closeCardMenu()
      if (!id) return
      if (act === "edit") openTaskModal({ card: currentBoard.cards.find((c) => c.id === id) })
      else if (act === "duplicate") duplicateTask(id)
      else if (act === "delete") deleteTask(id)
    })
  })
  document.getElementById("menu-assign-select")?.addEventListener("change", (e) => {
    const id = menuCardId
    closeCardMenu()
    if (id) assignTask(id, e.target.value)
  })

  // Dismiss menu on outside click / scroll / escape.
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#card-menu") && !e.target.closest(".card-menu-btn")) closeCardMenu()
  })
  window.addEventListener("scroll", closeCardMenu, true)
}

/* --------------------------- Keyboard shortcuts ------------------------ */
function wireKeyboardShortcuts() {
  if (document.body.dataset.shortcutsBound) return
  document.body.dataset.shortcutsBound = "1"
  document.addEventListener("keydown", (e) => {
    const mod = e.metaKey || e.ctrlKey
    const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "")
    const modalOpen = !document.getElementById("task-modal")?.hidden

    if (e.key === "Escape") {
      closeCardMenu()
      if (modalOpen) closeTaskModal()
      return
    }
    if (mod && e.key.toLowerCase() === "k") {
      e.preventDefault()
      openTaskModal({ columnId: "backlog" })
      flashJarvis("quick add · ⌘K")
      return
    }
    if (modalOpen || inField) return
    if (mod && e.key.toLowerCase() === "e" && selectedCardId) {
      e.preventDefault()
      openTaskModal({ card: currentBoard.cards.find((c) => c.id === selectedCardId) })
    } else if ((e.key === "Delete" || e.key === "Backspace") && selectedCardId) {
      e.preventDefault()
      deleteTask(selectedCardId)
    }
  })
}

/* Re-fetch + re-render the board after a mutation, preserving selection. */
async function refreshBoardData() {
  const board = await fetchBoard()
  currentBoard = board
  renderHeader(board)
  renderNextSteps(board.nextSteps || [])
  renderBoard(board)
  renderActivity(board.activity || [])
  updateAttentionBadge()
  if (selectedCardId) selectCard(selectedCardId)
}

/* ------------------------------- Init ---------------------------------- */
function renderBoardSkeleton() {
  const boardEl = document.getElementById("board")
  if (!boardEl) return
  const cols = [3, 2, 2, 2]
  boardEl.innerHTML = `<div class="board-skeleton">${cols
    .map(
      (n) =>
        `<div class="skeleton-col"><div class="skeleton-block head"></div>${'<div class="skeleton-block card"></div>'.repeat(n)}</div>`,
    )
    .join("")}</div>`
}

function renderBoardError(message) {
  const boardEl = document.getElementById("board")
  if (!boardEl) return
  boardEl.innerHTML = ""
  const wrap = el("div", "board-error")
  const icon = el("div", "err-icon")
  icon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 9v4"/><path d="M12 17h.01"/><circle cx="12" cy="12" r="10"/></svg>`
  const title = el("div", "err-title", { text: "Backend unreachable" })
  const msg = el("div", "err-msg")
  msg.innerHTML = message
  const retry = el("button", "ctrl-btn primary", { type: "button", text: "Retry Connection" })
  retry.addEventListener("click", () => init())
  wrap.append(icon, title, msg, retry)
  boardEl.appendChild(wrap)
}

async function init() {
  flashJarvis("connecting to backend…")
  loadSettings()
  renderBoardSkeleton()
  try {
    const [board, services] = await Promise.all([fetchBoard(), fetchServices()])
    currentBoard = board
    renderHeader(board)
    renderNextSteps(board.nextSteps || [])
    renderBoard(board)
    renderActivity(board.activity || [])
    renderServices(services)
    updateAttentionBadge()
    wireControls(board)
    wireMenuAndModal()
    wireKeyboardShortcuts()
    wirePhase4Modals()
    wireSettings()
    startSystemHud()
    applyAllSettings()
    if (selectedCardId) selectCard(selectedCardId)
    flashJarvis("connected · agent CLI bridge")
    console.log("[v0] TaskBoardAI rendered:", board.projectName)
  } catch (err) {
    console.log("[v0] Failed to initialize board:", err.message)
    renderBoardError(
      'Could not reach the board API after 3 attempts. Ensure the Express backend is running on <code>http://localhost:8080</code>.',
    )
    flashJarvis("backend unreachable")
  }
}

document.addEventListener("DOMContentLoaded", init)
