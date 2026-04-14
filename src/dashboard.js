// X Unfollow — Dashboard

const mainContent = document.getElementById("main-content");

let port = null;
let scanData = null;
let selectedIds = new Set();
let whitelist = {};
let sessionCap = 200;
let unfollowSpeed = "slow";
let currentPage = 1;
const PAGE_SIZE = 50;

// --- Event Delegation ---
// All click handlers go through a single delegated listener to avoid inline onclick

document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;

  const action = btn.dataset.action;
  const handlers = {
    "check-readiness": () => sendMessage("get-readiness"),
    "start-scan": startScan,
    "cancel-scan": () => sendMessage("cancel-scan"),
    "show-idle": showIdleState,
    "select-all": selectAll,
    "deselect-all": deselectAll,
    "start-unfollow": startUnfollow,
    "cancel-unfollow": () => sendMessage("cancel-unfollow"),
    "back-to-list": () => showReviewState(scanData),
  };

  // Dynamic actions
  if (action === "toggle-whitelist") {
    toggleWhitelist(btn.dataset.userId, btn.dataset.screenName);
    return;
  }
  if (action === "page-prev") {
    currentPage--;
    renderReviewUI(scanData);
    window.scrollTo(0, 0);
    return;
  }
  if (action === "page-next") {
    currentPage++;
    renderReviewUI(scanData);
    window.scrollTo(0, 0);
    return;
  }
  if (action === "page-goto") {
    currentPage = parseInt(btn.dataset.page, 10);
    renderReviewUI(scanData);
    window.scrollTo(0, 0);
    return;
  }

  if (handlers[action]) handlers[action]();
});

// Checkbox changes via delegation
document.addEventListener("change", (e) => {
  if (e.target.matches('input[type="checkbox"][data-user-id]')) {
    toggleUser(e.target.dataset.userId, e.target.checked);
  }
});

// Settings input via delegation
document.addEventListener("change", (e) => {
  if (e.target.matches("#cap-input")) {
    updateSessionCap(e.target.value);
  }
  if (e.target.matches("#speed-select")) {
    updateSpeed(e.target.value);
  }
});

// --- Port Connection ---

function connectPort() {
  port = browser.runtime.connect({ name: "dashboard" });

  port.onMessage.addListener((msg) => {
    switch (msg.type) {
      case "get-readiness-response":
        handleReadiness(msg.data);
        break;
      case "start-scan-response":
        handleScanComplete(msg.data);
        break;
      case "scan-progress":
        handleScanProgress(msg.data);
        break;
      case "start-unfollow-response":
        handleUnfollowComplete(msg.data);
        break;
      case "unfollow-progress":
        handleUnfollowProgress(msg.data);
        break;
      case "error":
        showError(msg.message);
        break;
    }
  });

  port.onDisconnect.addListener(() => {
    port = null;
  });
}

function sendMessage(type, data = {}) {
  if (port) {
    port.postMessage({ type, ...data });
  }
}

// --- Initialization ---

async function init() {
  const stored = await browser.storage.local.get(["whitelist", "sessionCap", "unfollowSpeed"]);
  whitelist = stored.whitelist || {};
  sessionCap = stored.sessionCap || 200;
  unfollowSpeed = stored.unfollowSpeed || "slow";

  connectPort();
  sendMessage("get-readiness");
}

// --- Readiness ---

function handleReadiness(readiness) {
  if (readiness.ready) {
    showIdleState();
  } else {
    showInitGuidance(readiness);
  }
}

function showInitGuidance(readiness) {
  const missing = [];
  if (!readiness.bearer || !readiness.csrf) missing.push("authentication tokens");
  if (!readiness.queryId || !readiness.features) missing.push("API configuration");
  if (!readiness.userId) missing.push("user ID");

  mainContent.innerHTML = `
    <div class="status-card">
      <h2>Initialize Extension</h2>
      <p>
        To get started, browse <a href="https://x.com" target="_blank">x.com</a> while logged in,
        then visit any profile's <strong>Following</strong> page.
      </p>
      <p style="margin-top: 8px; font-size: 13px;">
        Still needed: ${missing.join(", ")}
      </p>
      <button class="btn btn-primary" data-action="check-readiness" style="margin-top: 12px;">
        Check Again
      </button>
    </div>
  `;
}

// --- Idle ---

function showIdleState() {
  mainContent.innerHTML = `
    <div class="status-card">
      <h2>Ready to Scan</h2>
      <p>Scan your following list to find accounts that don't follow you back.</p>
      <button class="btn btn-primary" data-action="start-scan">
        Scan Following List
      </button>
    </div>
  `;
}

// --- Scanning ---

function startScan() {
  mainContent.innerHTML = `
    <div class="status-card">
      <h2>Scanning...</h2>
      <p id="scan-status">Starting scan...</p>
      <div class="progress-container">
        <div class="progress-bar-track">
          <div class="progress-bar-fill" id="scan-progress-bar" style="width: 0%"></div>
        </div>
        <div class="progress-text" id="scan-progress-text"></div>
      </div>
      <button class="btn btn-secondary btn-small" data-action="cancel-scan" style="margin-top: 12px;">
        Cancel
      </button>
    </div>
  `;
  sendMessage("start-scan");
}

function handleScanProgress(data) {
  const statusEl = document.getElementById("scan-status");
  const barEl = document.getElementById("scan-progress-bar");
  const textEl = document.getElementById("scan-progress-text");

  if (statusEl) statusEl.textContent = `Scanning page ${data.page}...`;
  if (textEl) textEl.textContent = `${data.collected} accounts scanned \u00b7 ${data.nonFollowers} non-followers found`;
  if (barEl) barEl.style.width = `${Math.min(90, data.page * 5)}%`;
}

function cancelScan() {
  sendMessage("cancel-scan");
}

function handleScanComplete(data) {
  scanData = data;

  if (data.error && (!data.nonFollowers || data.nonFollowers.length === 0)) {
    showError(data.error);
    return;
  }

  if ((!data.nonFollowers || data.nonFollowers.length === 0) && (!data.unknowns || data.unknowns.length === 0)) {
    mainContent.innerHTML = `
      <div class="status-card">
        <h2>Everyone follows you back!</h2>
        <p>No non-followers found among your ${data.total} following.</p>
        <button class="btn btn-secondary" data-action="show-idle" style="margin-top: 12px;">
          Scan Again
        </button>
      </div>
    `;
    return;
  }

  showReviewState(data);
}

// --- Review ---

function showReviewState(data) {
  selectedIds = new Set();
  for (const user of data.nonFollowers) {
    if (!whitelist[user.id]) {
      selectedIds.add(user.id);
    }
  }
  currentPage = 1;
  renderReviewUI(data);
}

function renderReviewUI(data) {
  const warningHtml = data.partial
    ? `<div class="warning-banner">Scan was incomplete: ${data.error || "Some data may be missing."}</div>`
    : "";

  const statsHtml = `
    <div class="stats-bar">
      <div class="stat">
        <div class="stat-value">${data.total}</div>
        <div class="stat-label">Following</div>
      </div>
      <div class="stat">
        <div class="stat-value">${data.nonFollowers.length}</div>
        <div class="stat-label">Non-followers</div>
      </div>
      <div class="stat">
        <div class="stat-value" id="selected-count">${selectedIds.size}</div>
        <div class="stat-label">Selected</div>
      </div>
    </div>
  `;

  const controlsHtml = `
    <div class="controls-bar">
      <div class="left-controls">
        <button class="btn btn-secondary btn-small" data-action="select-all">Select All</button>
        <button class="btn btn-secondary btn-small" data-action="deselect-all">Deselect All</button>
      </div>
      <button class="btn btn-danger" id="unfollow-btn" data-action="start-unfollow" ${selectedIds.size === 0 ? "disabled" : ""}>
        Unfollow Selected (${selectedIds.size})
      </button>
    </div>
  `;

  // Paginate non-followers
  const totalNF = data.nonFollowers.length;
  const totalPages = Math.max(1, Math.ceil(totalNF / PAGE_SIZE));
  currentPage = Math.max(1, Math.min(currentPage, totalPages));
  const startIdx = (currentPage - 1) * PAGE_SIZE;
  const pageUsers = data.nonFollowers.slice(startIdx, startIdx + PAGE_SIZE);
  const nonFollowerCards = pageUsers.map((u) => userCardHtml(u)).join("");

  const paginationHtml = totalPages > 1 ? buildPaginationHtml(currentPage, totalPages, totalNF) : "";

  let unknownsHtml = "";
  if (data.unknowns && data.unknowns.length > 0) {
    const unknownCards = data.unknowns.map((u) => userCardHtml(u, true)).join("");
    unknownsHtml = `
      <div class="section-header">Unknown Follow Status (${data.unknowns.length})</div>
      <p style="font-size: 13px; color: #8899a6; margin-bottom: 8px;">
        Could not determine if these accounts follow you back. Review manually.
      </p>
      <div class="user-list">${unknownCards}</div>
    `;
  }

  mainContent.innerHTML = `
    ${warningHtml}
    ${statsHtml}
    ${controlsHtml}
    ${paginationHtml}
    <div class="user-list" id="user-list">${nonFollowerCards}</div>
    ${paginationHtml}
    ${unknownsHtml}
    <div class="settings-section">
      <div class="section-header">Settings</div>
      <div class="settings-row">
        <span class="settings-label">Unfollow speed</span>
        <select class="settings-select" id="speed-select">
          <option value="slow" ${unfollowSpeed === "slow" ? "selected" : ""}>Slow (5–12s) — Safest</option>
          <option value="medium" ${unfollowSpeed === "medium" ? "selected" : ""}>Medium (2–6s)</option>
          <option value="fast" ${unfollowSpeed === "fast" ? "selected" : ""}>Fast (0.5–1.5s) — Risky</option>
        </select>
      </div>
      <div class="settings-row">
        <span class="settings-label">Per-session unfollow cap</span>
        <input type="number" class="settings-input" id="cap-input" value="${sessionCap}" min="1" max="1000" />
      </div>
    </div>
    <div style="text-align: center; margin-top: 20px;">
      <button class="btn btn-secondary" data-action="show-idle">Scan Again</button>
    </div>
  `;
}

function userCardHtml(user, isUnknown = false) {
  const isWl = !!whitelist[user.id];
  const checked = selectedIds.has(user.id) ? "checked" : "";
  const wlClass = isWl ? "whitelisted" : "";
  const wlBadge = isWl ? '<span class="whitelist-badge">Whitelisted</span>' : "";
  const wlBtnText = isWl ? "Remove from Whitelist" : "Whitelist";
  const avatarUrl = user.avatar ? user.avatar.replace("_normal.", "_bigger.") : "";
  const fallbackSvg = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect fill="#38444d" width="48" height="48" rx="24"/></svg>');

  return `
    <div class="user-card ${wlClass}" data-user-id="${user.id}">
      <input type="checkbox" ${checked} ${isUnknown ? "disabled" : ""}
        data-user-id="${user.id}" />
      <img class="user-avatar" src="${avatarUrl || fallbackSvg}" data-fallback="${fallbackSvg}" />
      <div class="user-info">
        <div class="user-name">${escapeHtml(user.name)} ${wlBadge}</div>
        <div class="user-handle">@${escapeHtml(user.screenName)}</div>
      </div>
      <div class="user-actions">
        <button class="btn btn-secondary btn-small"
          data-action="toggle-whitelist"
          data-user-id="${user.id}"
          data-screen-name="${escapeHtml(user.screenName)}">
          ${wlBtnText}
        </button>
      </div>
    </div>
  `;
}

// --- Pagination ---

function buildPaginationHtml(current, totalPages, totalItems) {
  const startItem = (current - 1) * PAGE_SIZE + 1;
  const endItem = Math.min(current * PAGE_SIZE, totalItems);

  let pageButtons = "";

  // Always show first page
  pageButtons += pageBtn(1, current);

  // Ellipsis or pages near start
  if (current > 3) {
    pageButtons += `<span class="pagination-ellipsis">\u2026</span>`;
  }

  // Pages around current
  for (let p = Math.max(2, current - 1); p <= Math.min(totalPages - 1, current + 1); p++) {
    pageButtons += pageBtn(p, current);
  }

  // Ellipsis or pages near end
  if (current < totalPages - 2) {
    pageButtons += `<span class="pagination-ellipsis">\u2026</span>`;
  }

  // Always show last page
  if (totalPages > 1) {
    pageButtons += pageBtn(totalPages, current);
  }

  return `
    <div class="pagination">
      <button class="btn btn-secondary btn-small" data-action="page-prev" ${current <= 1 ? "disabled" : ""}>
        \u2190 Prev
      </button>
      <div class="pagination-pages">${pageButtons}</div>
      <button class="btn btn-secondary btn-small" data-action="page-next" ${current >= totalPages ? "disabled" : ""}>
        Next \u2192
      </button>
      <span class="pagination-info">${startItem}\u2013${endItem} of ${totalItems}</span>
    </div>
  `;
}

function pageBtn(page, current) {
  const active = page === current ? "pagination-active" : "";
  return `<button class="btn btn-secondary btn-small pagination-btn ${active}" data-action="page-goto" data-page="${page}">${page}</button>`;
}

// --- Selection ---

function toggleUser(userId, checked) {
  if (checked) {
    selectedIds.add(userId);
  } else {
    selectedIds.delete(userId);
  }
  updateSelectionUI();
}

function selectAll() {
  if (!scanData) return;
  selectedIds = new Set();
  for (const user of scanData.nonFollowers) {
    if (!whitelist[user.id]) {
      selectedIds.add(user.id);
    }
  }
  updateCheckboxes();
  updateSelectionUI();
}

function deselectAll() {
  selectedIds.clear();
  updateCheckboxes();
  updateSelectionUI();
}

function updateCheckboxes() {
  const checkboxes = document.querySelectorAll('input[type="checkbox"][data-user-id]');
  for (const cb of checkboxes) {
    if (!cb.disabled) {
      cb.checked = selectedIds.has(cb.dataset.userId);
    }
  }
}

function updateSelectionUI() {
  const countEl = document.getElementById("selected-count");
  if (countEl) countEl.textContent = selectedIds.size;

  const btn = document.getElementById("unfollow-btn");
  if (btn) {
    btn.disabled = selectedIds.size === 0;
    btn.textContent = `Unfollow Selected (${selectedIds.size})`;
  }
}

// --- Whitelist ---

async function toggleWhitelist(userId, screenName) {
  if (whitelist[userId]) {
    delete whitelist[userId];
  } else {
    whitelist[userId] = { screenName, addedAt: Date.now() };
    selectedIds.delete(userId);
  }
  await browser.storage.local.set({ whitelist });
  if (scanData) renderReviewUI(scanData);
}

// --- Settings ---

async function updateSessionCap(value) {
  const cap = Math.max(1, Math.min(1000, parseInt(value, 10) || 200));
  sessionCap = cap;
  await browser.storage.local.set({ sessionCap: cap });
}

async function updateSpeed(value) {
  unfollowSpeed = value;
  await browser.storage.local.set({ unfollowSpeed: value });
}

// --- Unfollow ---

function startUnfollow() {
  if (selectedIds.size === 0) return;

  if (selectedIds.size > sessionCap) {
    // Can't use confirm() in extension pages with strict CSP — just proceed with cap
  }

  const userIds = Array.from(selectedIds);

  mainContent.innerHTML = `
    <div class="status-card">
      <h2>Unfollowing...</h2>
      <p id="unfollow-status">Starting...</p>
      <div class="progress-container">
        <div class="progress-bar-track">
          <div class="progress-bar-fill" id="unfollow-progress-bar" style="width: 0%"></div>
        </div>
        <div class="progress-text" id="unfollow-progress-text"></div>
      </div>
      <button class="btn btn-secondary btn-small" data-action="cancel-unfollow" style="margin-top: 12px;">
        Cancel
      </button>
    </div>
  `;

  sendMessage("start-unfollow", { userIds });
}

function handleUnfollowProgress(data) {
  const statusEl = document.getElementById("unfollow-status");
  const barEl = document.getElementById("unfollow-progress-bar");
  const textEl = document.getElementById("unfollow-progress-text");

  if (statusEl) {
    statusEl.textContent = data.currentUser
      ? `Unfollowing @${data.currentUser}...`
      : "Processing...";
  }
  if (barEl && data.total > 0) {
    barEl.style.width = `${(data.completed / data.total) * 100}%`;
  }
  if (textEl) {
    textEl.textContent = `${data.completed} of ${data.total} processed`;
  }
}

function handleUnfollowComplete(data) {
  const successCount = data.results ? data.results.success.length : 0;
  const failedCount = data.results ? data.results.failed.length : 0;
  const skippedCount = data.results ? data.results.skipped.length : 0;

  if (scanData && data.results) {
    const unfollowedIds = new Set(data.results.success.map((u) => u.id));
    scanData.nonFollowers = scanData.nonFollowers.filter((u) => !unfollowedIds.has(u.id));
    for (const id of unfollowedIds) {
      selectedIds.delete(id);
    }
  }

  const hasRemaining = scanData && scanData.nonFollowers.length > 0;

  mainContent.innerHTML = `
    <div class="status-card">
      <h2>Unfollow Complete</h2>
      <div class="results-summary">
        <span class="result-stat result-success">${successCount} unfollowed</span>
        ${failedCount > 0 ? `<span class="result-stat result-failed">${failedCount} failed</span>` : ""}
        ${skippedCount > 0 ? `<span class="result-stat result-skipped">${skippedCount} skipped</span>` : ""}
      </div>
      ${data.error ? `<div class="warning-banner">${escapeHtml(data.error)}</div>` : ""}
      <div style="display: flex; gap: 8px; justify-content: center; margin-top: 12px;">
        ${hasRemaining ? '<button class="btn btn-secondary" data-action="back-to-list">Back to List</button>' : ""}
        <button class="btn btn-primary" data-action="show-idle">New Scan</button>
      </div>
    </div>
  `;
}

// --- Error ---

function showError(message) {
  mainContent.innerHTML = `
    <div class="status-card">
      <h2>Error</h2>
      <div class="error-banner">${escapeHtml(message)}</div>
      <button class="btn btn-primary" data-action="show-idle" style="margin-top: 12px;">
        Try Again
      </button>
    </div>
  `;
}

// --- Utilities ---

function escapeHtml(str) {
  if (!str) return "";
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// --- Avatar fallback (CSP-safe, no inline onerror) ---

document.addEventListener("error", (e) => {
  if (e.target.matches && e.target.matches("img.user-avatar")) {
    const fallback = e.target.dataset.fallback;
    if (fallback && e.target.src !== fallback) {
      e.target.src = fallback;
    }
  }
}, true); // useCapture: true to catch error events that don't bubble

// --- Start ---

init();
