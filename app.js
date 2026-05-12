const CACHE_KEY = "hot-dashboard-cache-v1";
const STATIC_DATA_PATHS = ["./data/hot-cache.json", "./hot-cache.json"];

const SOURCE_ORDER = [
  { id: "weibo", name: "微博" },
  { id: "baidu", name: "百度" },
  { id: "douyin", name: "抖音" },
  { id: "toutiao", name: "头条" },
  { id: "bilibili_hot", name: "B站热搜" },
  { id: "bilibili_all", name: "B站日榜" },
  { id: "zhihu", name: "知乎热榜" },
  { id: "zhihu_question", name: "知乎问题" },
  { id: "sogou", name: "搜狗" },
  { id: "sohu", name: "搜狐" },
  { id: "sspai", name: "少数派" },
  { id: "csdn", name: "CSDN" },
  { id: "juejin", name: "掘金" },
  { id: "github", name: "GitHub" },
  { id: "netease_news", name: "网易" },
  { id: "acfun", name: "AcFun" },
  { id: "dongqiudi", name: "懂球帝" },
  { id: "ifanr", name: "爱范儿" },
  { id: "51cto", name: "51CTO" },
  { id: "ker", name: "安全KER" },
  { id: "history", name: "历史今天" },
];

const SOURCE_NAMES = new Map(SOURCE_ORDER.map((source) => [source.id, source.name]));

const state = {
  activeSource: "all",
  search: "",
  items: [],
  sourceStatus: new Map(),
  lastUpdated: null,
  nextTimer: null,
  clockTimer: null,
};

const els = {
  summaryText: document.querySelector("#summaryText"),
  refreshButton: document.querySelector("#refreshButton"),
  searchInput: document.querySelector("#searchInput"),
  totalCount: document.querySelector("#totalCount"),
  sourceCount: document.querySelector("#sourceCount"),
  nextRefresh: document.querySelector("#nextRefresh"),
  clockChip: document.querySelector("#clockChip"),
  sourceTabs: document.querySelector("#sourceTabs"),
  sourceSelect: document.querySelector("#sourceSelect"),
  sourceSwitchHint: document.querySelector("#sourceSwitchHint"),
  statusStrip: document.querySelector("#statusStrip"),
  hotList: document.querySelector("#hotList"),
  leaderboardList: document.querySelector("#leaderboardList"),
  emptyState: document.querySelector("#emptyState"),
  template: document.querySelector("#hotItemTemplate"),
};

function safeJson(raw) {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function refreshAll({ silent = false } = {}) {
  if (!silent) {
    setStatus("正在刷新多个平台热点...");
  }
  els.refreshButton.disabled = true;
  state.sourceStatus.clear();

  let items = [];
  let payload = { items: [], sources: [], updatedAt: "" };

  try {
    payload = await fetchHotlist();
    items = payload.items;
    payload.sources.forEach((source) => {
      state.sourceStatus.set(source.id, source.status);
    });
  } catch (error) {
    console.error(error);
  }

  if (items.length > 0) {
    state.items = items;
    state.lastUpdated = payload.updatedAt || new Date().toISOString();
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({
        items: state.items,
        lastUpdated: state.lastUpdated,
        sources: [...state.sourceStatus.entries()],
      })
    );
    ensureActiveSourceExists();
    setStatus(buildStatusText());
  } else {
    restoreCache();
    ensureActiveSourceExists();
    setStatus("接口暂时不可用，已显示本地缓存。");
  }

  els.refreshButton.disabled = false;
  await updateAutomationSchedule();
  render();
}

async function fetchHotlist() {
  const endpoints = buildDataEndpoints();
  const errors = [];

  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, {
        cache: "no-store",
        headers: { Accept: "application/json" },
      });

      if (!response.ok) {
        throw new Error(`${endpoint} returned ${response.status}`);
      }

      const payload = await response.json();
      return {
        items: Array.isArray(payload.items) ? payload.items : [],
        sources: Array.isArray(payload.sources) ? payload.sources : [],
        updatedAt: payload.updatedAt || "",
      };
    } catch (error) {
      errors.push(error);
    }
  }

  throw new Error(errors.map((error) => error.message).join("; ") || "热点数据不可用");
}

function buildDataEndpoints() {
  const stamp = Date.now();
  const staticEndpoints = STATIC_DATA_PATHS.map((path) => `${path}?refresh=${stamp}`);
  const apiEndpoint = `/api/hotlist?refresh=${stamp}`;

  if (isLocalService()) {
    return [apiEndpoint, ...staticEndpoints];
  }

  return staticEndpoints;
}

function isLocalService() {
  return ["", "localhost", "127.0.0.1"].includes(window.location.hostname);
}

function restoreCache() {
  const cached = safeJson(localStorage.getItem(CACHE_KEY));
  if (cached?.items?.length) {
    state.items = cached.items;
    state.lastUpdated = cached.lastUpdated;
    if (Array.isArray(cached.sources)) {
      state.sourceStatus = new Map(cached.sources);
    }
  }
}

function getAvailableSources() {
  const counts = new Map();
  state.items.forEach((item) => {
    counts.set(item.sourceId, (counts.get(item.sourceId) || 0) + 1);
  });

  return SOURCE_ORDER.filter((source) => counts.has(source.id)).map((source) => ({
    ...source,
    count: counts.get(source.id),
  }));
}

function ensureActiveSourceExists() {
  if (state.activeSource === "all") {
    return;
  }

  const hasCurrentSource = getAvailableSources().some(
    (source) => source.id === state.activeSource
  );
  if (!hasCurrentSource) {
    state.activeSource = "all";
  }
}

function getFilteredItems() {
  const keyword = state.search.trim().toLowerCase();
  return state.items.filter((item) => {
    const sourceMatch =
      state.activeSource === "all" || item.sourceId === state.activeSource;
    const keywordMatch =
      !keyword ||
      `${item.title} ${item.desc} ${item.hot} ${item.sourceName}`
        .toLowerCase()
        .includes(keyword);
    return sourceMatch && keywordMatch;
  });
}

function render() {
  ensureActiveSourceExists();
  renderTabs();
  renderSourceSelect();
  const filtered = getFilteredItems();
  els.totalCount.textContent = String(filtered.length);
  els.sourceCount.textContent = String(getAvailableSources().length);
  els.summaryText.textContent = buildSummaryText();
  renderList(filtered);
  renderLeaderboard();
}

function renderTabs() {
  const sources = getAvailableSources();
  const tabs = [{ id: "all", name: "全部", count: state.items.length }, ...sources];
  els.sourceTabs.innerHTML = "";

  tabs.forEach((source) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "source-tab";
    button.dataset.source = source.id;
    button.textContent = `${source.name} ${source.count}`;
    button.classList.toggle("is-active", source.id === state.activeSource);
    button.addEventListener("click", () => {
      state.activeSource = source.id;
      render();
    });
    els.sourceTabs.append(button);
  });
}

function renderSourceSelect() {
  const sources = getAvailableSources();
  const tabs = [{ id: "all", name: "全部", count: state.items.length }, ...sources];
  const currentValue = state.activeSource;
  els.sourceSelect.innerHTML = "";
  tabs.forEach((source) => {
    const option = document.createElement("option");
    option.value = source.id;
    option.textContent = `${source.name} (${source.count})`;
    els.sourceSelect.append(option);
  });

  if (els.sourceSelect.value !== currentValue) {
    els.sourceSelect.value = currentValue;
  }

  els.sourceSwitchHint.textContent =
    tabs.length > 1
      ? "使用下拉框快速跳转平台，下面的平台按钮保留为平铺展示。"
      : "当前只有一个可用平台。";
}

function renderList(items) {
  els.hotList.innerHTML = "";
  els.emptyState.hidden = items.length !== 0;
  els.hotList.hidden = items.length === 0;

  items
    .slice()
    .sort((a, b) => sourceSortValue(a) - sourceSortValue(b) || a.rank - b.rank)
    .forEach((item) => {
      const node = els.template.content.firstElementChild.cloneNode(true);
      const link = node.querySelector(".hot-main");
      link.href = item.url;
      node.querySelector(".rank").textContent = String(item.rank).padStart(2, "0");
      node.querySelector(".hot-title").textContent = item.title;
      node.querySelector(".hot-meta").textContent = `${item.sourceName}${item.desc ? ` · ${item.desc}` : ""}`;
      node.querySelector(".heat").textContent = item.hot || "热榜";
      els.hotList.append(node);
    });
}

function renderLeaderboard() {
  const leaders = state.items.filter((item) => item.rank <= 3).slice(0, 8);

  els.leaderboardList.innerHTML = "";
  leaders.forEach((item) => {
    const link = document.createElement("a");
    link.className = "leader-card";
    link.href = item.url;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.innerHTML = `<strong></strong><span></span>`;
    link.querySelector("strong").textContent = item.title;
    link.querySelector("span").textContent = `${item.sourceName} · ${item.hot || "热榜"}`;
    els.leaderboardList.append(link);
  });
}

function sourceSortValue(item) {
  const index = SOURCE_ORDER.findIndex((source) => source.id === item.sourceId);
  return index === -1 ? 999 : index;
}

function buildSummaryText() {
  const availableIds = new Set(getAvailableSources().map((source) => source.id));
  const failed = [...state.sourceStatus.entries()]
    .filter(([id, status]) => status === "failed" && !availableIds.has(id))
    .map(([id]) => SOURCE_NAMES.get(id))
    .filter(Boolean);
  const updated = state.lastUpdated
    ? new Date(state.lastUpdated).toLocaleString("zh-CN", { hour12: false })
    : "尚未更新";

  if (failed.length) {
    return `最近更新：${updated}。已隐藏无数据平台：${failed.join("、")}。`;
  }
  return `最近更新：${updated}。仅展示当前真实返回数据的平台。`;
}

function buildStatusText() {
  const okCount = getAvailableSources().length;
  const failedCount = [...state.sourceStatus.values()].filter(
    (value) => value === "failed"
  ).length;
  return `已更新 ${okCount} 个可用平台${failedCount ? `，隐藏 ${failedCount} 个无数据平台` : ""}。`;
}

function setStatus(text) {
  els.statusStrip.textContent = text;
}

function parseLocalDateTime(value) {
  if (!value) return null;
  const normalized = value.includes("T") ? value : value.replace(" ", "T");
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatNextRunLabel(date) {
  if (!date) return "--";
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) {
    return date.toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  }
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function setNextRefresh(date) {
  clearTimeout(state.nextTimer);
  if (!date) {
    els.nextRefresh.textContent = "--";
    return;
  }

  const delay = date.getTime() - Date.now();
  els.nextRefresh.textContent = formatNextRunLabel(date);

  if (delay <= 0) {
    return;
  }

  state.nextTimer = window.setTimeout(() => {
    refreshAll({ silent: true });
  }, delay);
}

async function updateAutomationSchedule() {
  if (!isLocalService()) {
    setNextRefresh(null);
    return;
  }

  try {
    const response = await fetch(`/api/admin/status?refresh=${Date.now()}`, {
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`status returned ${response.status}`);
    }
    const payload = await response.json();
    const nextRun = parseLocalDateTime(payload?.automation?.nextRun?.time);
    setNextRefresh(nextRun);
  } catch (error) {
    console.error(error);
    if (!els.nextRefresh.textContent || els.nextRefresh.textContent === "--") {
      setNextRefresh(null);
    }
  }
}

function updateClock() {
  if (!els.clockChip) {
    return;
  }
  els.clockChip.textContent = new Date().toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function bindEvents() {
  els.refreshButton.addEventListener("click", () => refreshAll());
  els.searchInput.addEventListener("input", (event) => {
    state.search = event.target.value;
    render();
  });
  els.sourceSelect.addEventListener("change", (event) => {
    state.activeSource = event.target.value;
    render();
  });
}

bindEvents();
restoreCache();
updateClock();
state.clockTimer = window.setInterval(updateClock, 1000);
render();
refreshAll();
