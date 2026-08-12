/* 流光 — 前端逻辑 */
'use strict';

// ---------- 工具 ----------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const uid = () => 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

function toast(msg, isError = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' error' : '');
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

// ---------- 桌面版（Tauri）环境 ----------
const isDesktop = () => !!(window.__TAURI_INTERNALS__ && typeof window.__TAURI_INTERNALS__.invoke === 'function');
function tauriInvoke(cmd, args) {
  if (!isDesktop()) return Promise.reject(new Error('not in desktop app'));
  return window.__TAURI_INTERNALS__.invoke(cmd, args || {}, {});
}
let API_BASE = '';
(function initTauri() {
  if (!isDesktop()) return;
  document.body.classList.add('desktop');
  tauriInvoke('get_server_info').then((port) => {
    if (port) API_BASE = 'http://localhost:' + port;
  }).catch((e) => console.warn('sidecar init failed', e));
  // 无边框窗口：最小化 / 最大化 / 关闭，双击标题栏还原或最大化
  const tbMin = document.getElementById('tb-min');
  const tbMax = document.getElementById('tb-max');
  const tbClose = document.getElementById('tb-close');
  if (tbMin) tbMin.addEventListener('click', () => tauriInvoke('window_minimize').catch(() => {}));
  if (tbMax) tbMax.addEventListener('click', () => tauriInvoke('window_toggle_maximize').catch(() => {}));
  if (tbClose) tbClose.addEventListener('click', () => tauriInvoke('window_close').catch(() => {}));
})();

// ---------- 状态 ----------
const STORE_KEY = 'inspo-desk-lite:v1';
const AI_CFG_KEY = 'liuguang:aiConfig:v1';
const AI_CFG_KEY_OLD = 'jieziyuan:aiConfig:v1';
try { if (!localStorage.getItem(AI_CFG_KEY) && localStorage.getItem(AI_CFG_KEY_OLD)) localStorage.setItem(AI_CFG_KEY, localStorage.getItem(AI_CFG_KEY_OLD)); } catch {}
let aiConfig = {};
try { aiConfig = JSON.parse(localStorage.getItem(AI_CFG_KEY)) || {}; } catch { aiConfig = {}; }
function saveAiConfig() { try { localStorage.setItem(AI_CFG_KEY, JSON.stringify(aiConfig)); } catch {} }
const state = {
  projects: [],          // [{id, title, cards, connections, view, createdAt, updatedAt}]
  activeId: null,
  cards: [],             // 当前画布的快捷引用（其余代码沿用）
  connections: [],
  view: { x: 60, y: 60, s: 1 },
  dirty: false,
};

let aiPlacement = 0;
let slotN = 0;
let saveTimer = null;
// ---------- 调试面板（?debug=1 显示） ----------
if (new URLSearchParams(location.search).has('debug')) {
  const dbg = document.createElement('div');
  dbg.id = 'drag-dbg';
  dbg.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:9999;background:rgba(0,0,0,.78);color:#4f4;font:11px/1.5 monospace;padding:6px 8px;border-radius:6px;max-width:520px;white-space:pre-wrap;pointer-events:none';
  document.body.appendChild(dbg);
  const dbgLog = (msg) => {
    const lines = dbg.textContent.split('\n').slice(-19);
    lines.push(new Date().toLocaleTimeString() + ' ' + msg);
    dbg.textContent = lines.join('\n');
  };
  document.addEventListener('pointerdown', (e) => {
    dbgLog('down btn=' + e.button + ' alt=' + e.altKey + ' ctrl=' + e.ctrlKey + ' tgt=' + (e.target.className || e.target.tagName));
  }, true);
  document.addEventListener('pointermove', (e) => {
    if (typeof drag !== 'undefined' && drag) dbgLog('move ' + (drag.copy ? 'COPY' : 'MOVE') + ' x=' + Math.round(e.clientX) + ' y=' + Math.round(e.clientY));
  }, true);
  document.addEventListener('pointerup', (e) => {
    dbgLog('up alt=' + e.altKey + ' drag=' + !!drag + ' cards=' + state.cards.length);
  }, true);
  document.addEventListener('dragstart', (e) => dbgLog('dragstart tgt=' + (e.target.className || e.target.tagName)), true);
  document.addEventListener('drop', (e) => dbgLog('drop files=' + (e.dataTransfer ? e.dataTransfer.files.length : 0) + ' text=' + String((e.dataTransfer && e.dataTransfer.getData('text/plain') || '').slice(0, 30))), true);
}

function markDirty() {
  state.dirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 900);
}

function currentProject() {
  return state.projects.find((p) => p.id === state.activeId) || null;
}

function persistProjects() {
  const p = currentProject();
  if (p) {
    p.cards = state.cards;
    p.connections = state.connections;
    p.view = state.view;
    p.updatedAt = Date.now();
  }
  return {
    version: 2,
    activeId: state.activeId,
    projects: state.projects.map((x) => ({
      id: x.id, title: x.title, cards: x.cards, connections: x.connections,
      view: x.view, createdAt: x.createdAt, updatedAt: x.updatedAt, bg: x.bg,
    })),
  };
}

let saveRetryTimer = null;
let saveFailCount = 0;
let quotaMigrating = false; // 本地空间不足时正在把内嵌素材搬进 IndexedDB，防止重复触发

function save() {
  clearTimeout(saveTimer);
  clearTimeout(saveRetryTimer);
  // 保护：启动加载完成前（或画布为空时）禁止写入，防止覆盖已有数据
  if (!state.projects.length) return;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(persistProjects()));
    state.dirty = false;
    saveFailCount = 0;
  } catch (e) {
    // localStorage 写入失败（多数是浏览器瞬时抖动）：自动重试，素材本体已在大容量存储里
    console.warn('本地保存失败', e);
    state.dirty = true;
    saveFailCount++;
    if (saveFailCount === 1) toast('保存失败，正在自动重试…', true);
    if (saveFailCount >= 4) {
      toast('保存失败：浏览器本地存储暂时不可用，本次改动可能未保存，建议先导出备份', true);
      return;
    }
    // 空间不足（通常是导入了带内嵌大图 / 封面的画布）：先把素材搬进 IndexedDB，再重试保存
    if (/quota/i.test(String((e && e.name) || '') + String((e && e.message) || '')) && !quotaMigrating) {
      quotaMigrating = true;
      saveRetryTimer = setTimeout(() => {
        Promise.all([migrateImageCardsToIDB(), migrateUrlCoversToIDB()])
          .catch(() => {})
          .finally(() => { quotaMigrating = false; if (state.dirty) save(); });
      }, 300);
      return;
    }
    saveRetryTimer = setTimeout(() => { if (state.dirty) save(); }, [1200, 2500, 5000][Math.min(saveFailCount - 1, 2)]);
  }
}
// 切回页面 / 重新聚焦 / 关闭页面前，把未保存的改动补存一次
function flushDirtySave() { if (state.dirty) save(); }
document.addEventListener('visibilitychange', () => { if (!document.hidden) flushDirtySave(); });
window.addEventListener('focus', flushDirtySave);
window.addEventListener('pagehide', flushDirtySave);

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    if (Array.isArray(data.projects) && data.projects.length) {
      state.projects = data.projects;
      state.activeId = data.activeId && state.projects.some((p) => p.id === data.activeId)
        ? data.activeId : state.projects[0].id;
    } else {
      // 旧版本单画布数据：迁移成一张画布
      const pid = uid();
      state.projects = [{
        id: pid, title: '画布 1',
        cards: data.cards || [], connections: data.connections || [],
        view: data.view || { x: 60, y: 60, s: 1 }, bg: { id: 'default', color: null },
        createdAt: Date.now(), updatedAt: Date.now(),
      }];
      state.activeId = pid;
    }
    const active = currentProject();
    state.cards = active.cards || [];
    state.connections = active.connections || [];
    state.view = active.view || { x: 60, y: 60, s: 1 };
    state.cards.forEach((c) => { if (c.type === 'note') c.type = 'text'; });
    applyProjectBg();
    return state.cards.length > 0;
  } catch {
    return false;
  }
}

function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 900);
}

// ---------- 多画布 ----------
function updateCanvasSelect() {
  const sel = $('#canvas-select');
  if (!sel) return;
  sel.innerHTML = state.projects.map((p) =>
    `<option value="${p.id}">${esc(p.title || '未命名')}</option>`).join('');
  sel.value = state.activeId;
}

function syncActiveToProject() {
  const p = currentProject();
  if (!p) return;
  p.cards = state.cards;
  p.connections = state.connections;
  p.view = state.view;
  p.updatedAt = Date.now();
}

function switchProject(id, silent) {
  const p = state.projects.find((x) => x.id === id);
  if (!p || id === state.activeId) return;
  syncActiveToProject();
  state.activeId = id;
  state.cards = p.cards || [];
  state.connections = p.connections || [];
  state.view = p.view || { x: 60, y: 60, s: 1 };
  undoStack.length = 0;
  redoStack.length = 0;
  selected.clear();
  updateUndoUI();
  updateSelectionUI();
  render();
  applyView();
  updateCanvasSelect();
  applyProjectBg();
  markDirty();
  if (!silent) toast('已切换到「' + (p.title || '未命名') + '」');
}

function createProject(title) {
  const pid = uid();
  const now = Date.now();
  state.projects.push({
    id: pid, title: (title || '').trim() || ('画布 ' + (state.projects.length + 1)),
    cards: [], connections: [], view: { x: 60, y: 60, s: 1 }, bg: { id: 'default', color: null },
    createdAt: now, updatedAt: now,
  });
  switchProject(pid);
  return pid;
}

function renameProject(id, title) {
  const p = state.projects.find((x) => x.id === id);
  if (!p) return;
  p.title = (title || '').trim() || p.title;
  p.updatedAt = Date.now();
  updateCanvasSelect();
  markDirty();
}

function deleteProject(id) {
  const idx = state.projects.findIndex((x) => x.id === id);
  if (idx < 0 || state.projects.length <= 1) { toast('至少保留一张画布', true); return; }
  const removedProject = state.projects[idx];
  state.projects.splice(idx, 1);
  if (state.activeId === id) {
    const next = state.projects[Math.min(idx, state.projects.length - 1)];
    state.activeId = next.id;
    state.cards = next.cards || [];
    state.connections = next.connections || [];
    state.view = next.view || { x: 60, y: 60, s: 1 };
    undoStack.length = 0;
    redoStack.length = 0;
    selected.clear();
    updateUndoUI();
    updateSelectionUI();
    render();
    applyView();
  }
  updateCanvasSelect();
  markDirty();
  toast('已删除画布');
  if (removedProject) cleanupOrphanOfficeFiles();
}
// ---------- 撤销 / 重做（Ctrl+Z / Ctrl+Y） ----------
const undoStack = [];
const redoStack = [];
const HISTORY_LIMIT = 100;
let noteEditId = null;

function cloneState() {
  return {
    cards: state.cards.map((c) => ({ ...c, data: c.data ? { ...c.data } : c.data })),
    connections: state.connections.map((cn) => ({ ...cn })),
  };
}

function pushHistory(before) {
  undoStack.push(before || cloneState());
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  redoStack.length = 0;
  updateUndoUI();
}

function applySnapshot(snap) {
  state.cards = snap.cards;
  state.connections = snap.connections;
  selected.clear();
  render();
  updateSelectionUI();
  markDirty();
}

function undo() {
  if (!undoStack.length) return;
  redoStack.push(cloneState());
  applySnapshot(undoStack.pop());
  updateUndoUI();
}

function redo() {
  if (!redoStack.length) return;
  undoStack.push(cloneState());
  applySnapshot(redoStack.pop());
  updateUndoUI();
}

function updateUndoUI() {
  const u = $('#more-menu [data-act="undo"]'), r = $('#more-menu [data-act="redo"]');
  if (u) u.disabled = !undoStack.length;
  if (r) r.disabled = !redoStack.length;
}

// ---------- 画布视图 ----------
const viewport = $('#viewport');
const world = $('#world');

function applyView() {
  world.style.transform = `translate(${state.view.x}px, ${state.view.y}px) scale(${state.view.s})`;
  world.style.setProperty('--ws', state.view.s);
  updateOverlays();
}

function cardCenter(c) {
  const el = document.querySelector(`.card[data-id="${c.id}"]`);
  if (!el) return null;
  return { x: el.offsetLeft + el.offsetWidth / 2, y: el.offsetTop + el.offsetHeight / 2 };
}

// React Flow / infinite-canvas 风格连线：锚点取卡片朝向另一张卡的边缘中点，
// 出线/入线都是水平平滑切线，曲率 = max(水平距离 × 0.5, 50)，观感统一、不僵硬。
function edgeMid(cx, cy, w, h, tx, ty) {
  const dx = tx - cx, dy = ty - cy;
  if (!dx && !dy) return { x: cx + w / 2, y: cy };
  if (Math.abs(dx) / w >= Math.abs(dy) / h) {
    return { x: cx + (dx >= 0 ? w / 2 : -w / 2), y: cy };
  }
  return { x: cx, y: cy + (dy >= 0 ? h / 2 : -h / 2) };
}

// 纯水平贝塞尔（与 infinite-canvas / React Flow 公式一致）：
// 曲率只看水平距离，max(|dx| × 0.5, 50)，方向感知镜像，所有连线风格统一。
function curvePath(x1, y1, x2, y2) {
  const dx = x2 - x1;
  const s = dx >= 0 ? 1 : -1;
  const k = Math.max(Math.abs(dx) * 0.5, 50);
  return `M ${x1} ${y1} C ${x1 + s * k} ${y1}, ${x2 - s * k} ${y2}, ${x2} ${y2}`;
}

function drawConnections() {
  const svg = $('#lines');
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const parts = [];
  for (const conn of state.connections) {
    const a = state.cards.find((c) => c.id === conn.from);
    const b = state.cards.find((c) => c.id === conn.to);
    if (!a || !b) continue;
    const ea = document.querySelector(`.card[data-id="${a.id}"]`);
    const eb = document.querySelector(`.card[data-id="${b.id}"]`);
    if (!ea || !eb) continue;
    const ca = { x: ea.offsetLeft + ea.offsetWidth / 2, y: ea.offsetTop + ea.offsetHeight / 2 };
    const cb = { x: eb.offsetLeft + eb.offsetWidth / 2, y: eb.offsetTop + eb.offsetHeight / 2 };
    const pa = edgeMid(ca.x, ca.y, ea.offsetWidth, ea.offsetHeight, cb.x, cb.y);
    const pb = edgeMid(cb.x, cb.y, eb.offsetWidth, eb.offsetHeight, ca.x, ca.y);
    // 锚点圆点稍微外移，避免被卡片盖住半个（连线现在在卡片下层）
    const offDot = (p, c) => {
      const dx = p.x - c.x, dy = p.y - c.y;
      const len = Math.hypot(dx, dy) || 1;
      return { x: p.x + (dx / len) * 7, y: p.y + (dy / len) * 7 };
    };
    const da = offDot(pa, ca), db = offDot(pb, cb);

    const d = curvePath(pa.x, pa.y, pb.x, pb.y);
    const mx = (pa.x + pb.x) / 2, my = (pa.y + pb.y) / 2;
    minX = Math.min(minX, pa.x, pb.x, mx);
    minY = Math.min(minY, pa.y, pb.y, my);
    maxX = Math.max(maxX, pa.x, pb.x, mx);
    maxY = Math.max(maxY, pa.y, pb.y, my);
    parts.push(
      `<g class="conn" data-conn="${conn.id}">` +
      `<path class="conn-hit" d="${d}"/>` +
      `<path class="conn-path-glow" d="${d}"/>` +
      `<path class="conn-path" d="${d}"/>` +
      `<circle class="conn-dot" cx="${da.x}" cy="${da.y}" r="4"/>` +
      `<circle class="conn-dot" cx="${db.x}" cy="${db.y}" r="4"/>` +
      `<g class="conn-del" data-del="${conn.id}">` +
      `<circle class="conn-del-circle" cx="${mx}" cy="${my}" r="10"/>` +
      `<path class="conn-del-x" d="M ${mx - 3.2} ${my - 3.2} L ${mx + 3.2} ${my + 3.2} M ${mx + 3.2} ${my - 3.2} L ${mx - 3.2} ${my + 3.2}"/>` +
      `</g></g>`
    );
  }
  if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 1; maxY = 1; }
  svg.setAttribute('width', Math.max(1, maxX - minX + 200));
  svg.setAttribute('height', Math.max(1, maxY - minY + 200));
  svg.innerHTML = parts.join('');
}

// ---------- 小地图 & 缩放率（参考 infinite-canvas 的 Minimap） ----------
const MM_W = 200, MM_H = 140, MM_PAD = 120;
const mmEl = $('#minimap');
const mmCards = $('#mm-cards');
const mmView = $('#mm-viewport');
const zoomLabel = $('#zoom-label');
let mmSig = '';

function mmBounds() {
  if (!state.cards.length) return { x: -500, y: -500, w: 1000, h: 1000 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of state.cards) {
    minX = Math.min(minX, c.x); minY = Math.min(minY, c.y);
    maxX = Math.max(maxX, c.x + (c.w || 260)); maxY = Math.max(maxY, c.y + (c.h || 180));
  }
  minX -= MM_PAD; minY -= MM_PAD; maxX += MM_PAD; maxY += MM_PAD;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function mmTransform() {
  const b = mmBounds();
  const scale = Math.min(MM_W / b.w, MM_H / b.h);
  return { b, scale, ox: (MM_W - b.w * scale) / 2, oy: (MM_H - b.h * scale) / 2 };
}

function updateMinimap() {
  const { b, scale, ox, oy } = mmTransform();
  const sig = state.cards.map((c) => `${c.id}:${Math.round(c.x)}:${Math.round(c.y)}:${Math.round(c.w || 260)}:${Math.round(c.h || 180)}`).join('|');
  if (sig !== mmSig) {
    mmSig = sig;
    mmCards.innerHTML = state.cards.map((c) =>
      `<i class="mm-dot t-${c.type}" data-id="${c.id}" style="left:${(c.x - b.x) * scale + ox}px;top:${(c.y - b.y) * scale + oy}px;width:${Math.max(c.w * scale, 2)}px;height:${Math.max(c.h * scale, 2)}px"></i>`
    ).join('');
  }
  const vw = viewport.clientWidth / state.view.s;
  const vh = viewport.clientHeight / state.view.s;
  const vx = -state.view.x / state.view.s, vy = -state.view.y / state.view.s;
  const x = clamp((vx - b.x) * scale + ox, -2, MM_W);
  const y = clamp((vy - b.y) * scale + oy, -2, MM_H);
  mmView.style.left = x + 'px';
  mmView.style.top = y + 'px';
  mmView.style.width = Math.min(clamp(vw * scale, 4, MM_W + 4), MM_W - x + 2) + 'px';
  mmView.style.height = Math.min(clamp(vh * scale, 4, MM_H + 4), MM_H - y + 2) + 'px';
}

function updateZoomLabel() {
  if (zoomLabel) zoomLabel.textContent = Math.round(state.view.s * 100) + '%';
}

function updateOverlays() {
  updateZoomLabel();
  updateMinimap();
}

function mmToCenter(e) {
  const rect = mmEl.getBoundingClientRect();
  const { b, scale, ox, oy } = mmTransform();
  const wx = (e.clientX - rect.left - ox) / scale + b.x;
  const wy = (e.clientY - rect.top - oy) / scale + b.y;
  state.view.x = viewport.clientWidth / 2 - wx * state.view.s;
  state.view.y = viewport.clientHeight / 2 - wy * state.view.s;
  applyView();
}

if (mmEl) {
  let mmDrag = false;
  mmEl.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    mmDrag = true;
    try { mmEl.setPointerCapture(e.pointerId); } catch {}
    mmToCenter(e);
  });
  mmEl.addEventListener('pointermove', (e) => { if (mmDrag) mmToCenter(e); });
  mmEl.addEventListener('pointerup', () => { if (mmDrag) { mmDrag = false; saveSoon(); } });
  mmEl.addEventListener('pointerleave', () => { mmDrag = false; });
}
function resetView100() {
  const rect = viewport.getBoundingClientRect();
  const cx = (rect.width / 2 - state.view.x) / state.view.s;
  const cy = (rect.height / 2 - state.view.y) / state.view.s;
  state.view.s = 1;
  state.view.x = rect.width / 2 - cx;
  state.view.y = rect.height / 2 - cy;
  applyView();
  saveSoon();
}
if (zoomLabel) zoomLabel.addEventListener('click', resetView100);
const zoomReset = $('#zoom-reset');
if (zoomReset) zoomReset.addEventListener('click', resetView100);
const mmToggle = $('#mm-toggle');
if (mmToggle && mmEl) {
  mmToggle.addEventListener('click', () => {
    const hidden = mmEl.classList.toggle('hidden');
    mmToggle.classList.toggle('active', !hidden);
  });
}


// ---------- 卡片渲染 ----------
const CROP_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/></svg>';
const AI_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3z"/></svg>';
const CROP_CANCEL_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>';
const EDIT_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';
const CROP_APPLY_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';
const PLAY_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M8 5.14v13.72a1 1 0 0 0 1.5.86l11-6.86a1 1 0 0 0 0-1.72l-11-6.86a1 1 0 0 0-1.5.86z"/></svg>';
const PAUSE_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1.2"/><rect x="14" y="5" width="4" height="14" rx="1.2"/></svg>';
const PREV_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M6 5h2.2v14H6zM20 5l-11.5 7L20 19z"/></svg>';
const NEXT_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M15.8 5H18v14h-2.2zM4 5l11.5 7L4 19z"/></svg>';
const UPDOWN_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M7 9.5l5-5 5 5"/><path d="M7 14.5l5 5 5-5"/></svg>';

// 文字卡字号随卡片尺寸等比缩放：默认 300×220 → 20px，双倍尺寸字号翻倍
function noteFontSize(w, h) {
  const base = Math.min(w || 300, h || 220);
  return Math.max(12, Math.min(72, Math.round((base / 220) * 20)));
}

function cardHTML(c) {
  const tagMap = { url: '网页', image: '图片', video: '视频', text: '文字', audio: '音频', note: '文字', ai: 'AI 卡片', file: '文档' };
  let iconHTML = '<div class="card-icon"></div>';
  let title = '';
  let body = '';
  let actions = '';
  let floatBar = '';
  let editTitleVal = '';
  let editing = false;

  if (c.type === 'url') {
    const d = c.data;
    editing = c.id === urlEditingId;
    title = d.title || d.host || '网页';
    if (d.icon) iconHTML = `<img class="card-icon" src="${d.icon}" alt="">`;
    const coverHTML = d.thumbKey
      ? `<img class="card-img" data-thumb="${d.thumbKey}" alt="">`
      : (d.thumb ? `<img class="card-img" src="${d.thumb}" alt="">` : '<div class="card-thumb-placeholder">🌐</div>');
    if (editing) {
      editTitleVal = d.title || '';
      body = `<div class="card-edit-cover">
        ${coverHTML}
        <div class="card-edit-cover-bar">
          <button class="mini-btn" data-act="edit-thumb">${CROP_ICON}<span>换封面</span></button>
          <button class="mini-btn" data-act="edit-icon">${CROP_ICON}<span>换图标</span></button>
        </div>
      </div>
      <div class="card-edit-text">
        <input class="card-edit-title" value="${esc(editTitleVal)}" placeholder="标题">
        <textarea class="card-edit-desc" placeholder="简介（可手动输入）">${esc(d.desc || '')}</textarea>
      </div>`;
      actions = `<button class="mini-btn go-btn" data-act="save-url">保存</button><button class="mini-btn" data-act="cancel-url">取消</button>`;
    } else {
      body = `<div class="url-cover">
        ${coverHTML}
      </div>
      <div class="url-text">
        <div class="card-desc">${esc(d.desc || '（无简介）')}</div>
        <div class="card-url">${esc(d.url || d.host || '')}</div>
      </div>`;
      actions = `<button class="mini-btn go-btn" data-act="open" data-value="${esc(d.url)}"><span>跳转</span><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg></button>`;
      floatBar = `<button class="mini-btn" data-act="edit-url">${EDIT_ICON}<span>编辑</span></button>`;
    }
  } else if (c.type === 'image') {
    const d = c.data;
    title = d.name || '图片';
    body = d.storageKey
      ? `<img class="card-img" data-key="${d.storageKey}"${d.thumbKey ? ` data-thumb="${d.thumbKey}"` : ''} alt="">`
      : `<img class="card-img" src="${d.dataUrl || ''}" alt="">`;
    floatBar = `<button class="mini-btn" data-act="crop">${CROP_ICON}<span>裁剪</span></button><span class="sep"></span><button class="mini-btn ai-btn" data-act="analyze">${AI_ICON}<span>AI 分析</span></button>`;
  } else if (c.type === 'text' || c.type === 'note') {
    title = '文字';
    body = `<div class="card-note-grip" title="拖动卡片"></div><textarea class="card-note-input" placeholder="写点什么…" spellcheck="false" style="font-size:${noteFontSize(c.w || 300, c.h || 220)}px">${esc(c.data.text)}</textarea>`;
  } else if (c.type === 'video') {
    const d = c.data;
    title = d.title || '视频';
    if (d.storageKey) {
      const mUrl = mediaUrlCache.get(d.storageKey) || '';
      body = `<video class="card-video" data-key="${d.storageKey}"${mUrl ? ` src="${mUrl}"` : ''} controls preload="metadata"></video>`;
    } else if (d.url && !d.url.startsWith('blob:')) {
      body = `<video class="card-video" src="${d.url}" controls preload="metadata"></video>`;
    } else if (d.thumb) {
      body = `<img class="card-img" src="${d.thumb}" alt="">`;
    } else {
      body = '<div class="card-thumb-placeholder">🎬</div>';
    }
  } else if (c.type === 'audio') {
    const d = c.data;
    const name = d.title || '音频';
    const sub = d.size != null ? fmtSize(d.size) : (d.sub || '本地音频');
    const ax = audioAxis(c);
    const prevDisabled = !ax.prevId;
    const nextDisabled = !ax.nextId;
    const upDownDisabled = !(ax.up || ax.down);
    const prevBtn = `<button class="audio-skip" data-act="audio-prev" title="上一首"${prevDisabled ? ' disabled' : ''}>${PREV_ICON}</button>`;
    const nextBtn = `<button class="audio-skip" data-act="audio-next" title="下一首"${nextDisabled ? ' disabled' : ''}>${NEXT_ICON}</button>`;
    const upDownBtn = `<button class="audio-updown" data-act="audio-updown" title="上下切换"${upDownDisabled ? ' disabled' : ''}>${UPDOWN_ICON}</button>`;
    let player = '';
    if (d.storageKey) {
      const mUrl = mediaUrlCache.get(d.storageKey) || '';
      player = `<audio class="card-audio" data-key="${d.storageKey}"${mUrl ? ` src="${mUrl}"` : ''} preload="metadata"></audio>`;
    } else if (d.url && !d.url.startsWith('blob:')) {
      player = `<audio class="card-audio" src="${d.url}" preload="metadata"></audio>`;
    }
    body = player
      ? `<div class="audio-card">
        ${player}
        <div class="audio-top">
          <div class="audio-cover"><div class="audio-eq"><span></span><span></span><span></span><span></span><span></span></div><div class="audio-note">🎵</div></div>
          <div class="audio-text">
            <div class="audio-title" title="${esc(name)}">${esc(name)}</div>
            <div class="audio-sub">${esc(sub)}</div>
          </div>
        </div>
        <div class="audio-progress" data-act="audio-seek"><div class="audio-elapsed"></div></div>
        <div class="audio-row">
          <span class="audio-time audio-now">0:00</span>
          <div class="audio-btns">${prevBtn}<button class="audio-play" data-act="audio-toggle" title="播放 / 暂停">${PLAY_ICON}</button>${nextBtn}${upDownBtn}</div>
          <span class="audio-time audio-full">0:00</span>
        </div>
      </div>`
      : '<div class="card-thumb-placeholder">🎵</div>';
  } else if (c.type === 'file') {
    const d = c.data;
    const name = d.title || '文档';
    const ext = String(name.split('.').pop() || '').toLowerCase();
    const extColor = { doc: '#2b5bd7', docx: '#2b5bd7', xls: '#1e7d43', xlsx: '#1e7d43', csv: '#1e7d43', ppt: '#d24726', pptx: '#d24726', pdf: '#d93025' }[ext] || '#6b7280';
    const extLabel = { doc: 'doc', docx: 'docx', xls: 'xls', xlsx: 'xlsx', csv: 'csv', ppt: 'ppt', pptx: 'pptx', pdf: 'pdf' }[ext] || 'file';
    const sub = d.importing ? '正在导入…' : (d.size != null ? fmtSize(d.size) : '本地文档') + ' · 双击打开';
    title = name;
    body = `<div class="file-card">
      <div class="file-ic" style="--fc:${extColor}"><span>${esc(extLabel)}</span></div>
      <div class="file-info">
        <div class="file-name" title="${esc(name)}">${esc(name)}</div>
        <div class="file-sub">${esc(sub)}</div>
      </div>
    </div>`;
    floatBar = `<button class="mini-btn go-btn" data-act="open-file"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg><span>打开</span></button>`;
  } else if (c.type === 'ai') {
    const d = c.data;
    title = d.kind === 'canvas' ? '✨ 画布分析' : '✨ AI 分析';
    let kw = '';
    if (d.keywords && d.keywords.length) {
      kw = `<div class="keywords">${d.keywords.map((k) => `<span class="keyword" data-act="copy" data-value="${esc(k)}">${esc(k)}</span>`).join('')}</div>`;
    }
    let sug = '';
    if (d.suggestions && d.suggestions.length) {
      sug = `<ul class="suggest-list">${d.suggestions.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>`;
    }
    body = `<div class="card-ai-summary">${esc(d.summary || '')}</div>${kw}${sug}`;
    if (d.sourceId) actions = `<button class="mini-btn" data-act="jump" data-value="${d.sourceId}">定位素材</button>`;
  }

  return `
    <div class="card t-${c.type} no-grab${editing ? ' editing' : ''}" data-id="${c.id}" style="left:${c.x}px;top:${c.y}px;width:${c.w}px;${c.h ? `height:${c.h}px;` : ''}">
      <div class="card-body">${body}</div>
      ${actions ? `<div class="card-actions">${actions}</div>` : ''}
      ${floatBar ? `<div class="card-float-bar">${floatBar}</div>` : ''}
      <div class="conn-handle" title="拖到另一张卡片建立连线"></div>
      <div class="resize-handle" title="拖拽缩放卡片"></div>
    </div>`;
}

function render() {
  $('#cards').innerHTML = state.cards.map(cardHTML).join('');
  drawConnections();
  updateGroupResize();
  updateMinimap();
  updateStats();
  resolveMediaCards();
  initAudioPlayers();
}

function storageUsedText() {
  try {
    const raw = localStorage.getItem(STORE_KEY) || '';
    const kb = (raw.length * 2) / 1024;
    return kb >= 1024 ? (kb / 1024).toFixed(2) + 'MB' : Math.round(kb) + 'KB';
  } catch { return '?'; }
}
function updateStats() {
  const n = state.cards.length;
  const byType = (t) => state.cards.filter((c) => c.type === t).length;
  const detail = `网页 ${byType('url')} · 图片 ${byType('image')} · 视频 ${byType('video')} · 文字 ${byType('text') + byType('note')} · 音频 ${byType('audio')} · 文档 ${byType('file')} · 连线 ${state.connections.length}`;
  $('#help-stats-main').textContent = `共 ${n} 素材 · 存储 ${storageUsedText()}`;
  $('#help-stats-detail').textContent = detail;
  if (navigator.storage && navigator.storage.estimate) {
    navigator.storage.estimate().then((est) => {
      if (est && est.quota) {
        const used = (est.usage || 0) / 1048576;
        const quota = est.quota / 1048576;
        $('#help-stats-detail').textContent += `\n浏览器空间 ${used.toFixed(1)}MB / ${quota.toFixed(0)}MB`;
      }
    }).catch(() => {});
  }
}

function addCard(card) {
  pushHistory();
  state.cards.push(card);
  render();
  markDirty();
  return card;
}

function viewCenter() {
  const rect = viewport.getBoundingClientRect();
  return {
    x: (rect.width / 2 - state.view.x) / state.view.s,
    y: (rect.height / 2 - state.view.y) / state.view.s,
  };
}

// ---------- 图片处理 ----------
function downscaleDataUrl(dataUrl, maxSize = 1600) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      let { width: w, height: h } = img;
      const scale = Math.min(1, maxSize / Math.max(w, h));
      w = Math.round(w * scale);
      h = Math.round(h * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', 0.9));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

function makeImageBlob(dataUrl, maxSize = 2400, quality = 0.92) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        canvas.toBlob((b) => b ? resolve(b) : reject(new Error('图片编码失败')), 'image/jpeg', quality);
      } catch (e) { reject(e); }
    };
    img.onerror = () => reject(new Error('图片加载失败'));
    img.src = dataUrl;
  });
}

function addImageFromFile(file) {
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const original = reader.result;
      const thumb = await downscaleDataUrl(original, 720);
      const dim = await new Promise((res) => { const im = new Image(); im.onload = () => res({ w: im.width, h: im.height }); im.onerror = () => res({ w: 240, h: 300 }); im.src = thumb; });
      const aspect = dim.w / dim.h;
      let cw = 300, ch = Math.round(cw / aspect);
      if (ch < 160) { ch = 160; cw = Math.round(ch * aspect); }
      if (ch > 420) { ch = 420; cw = Math.round(ch * aspect); }
      if (cw < 140) cw = 140;
      const center = viewCenter();
      const off2 = slotN++ * 80;
      const base = {
        id: uid(), type: 'image',
        x: center.x - 120 + off2, y: center.y - 150 + off2,
        w: cw, h: ch,
      };
      try {
        const storageKey = 'img:' + uid();
        const thumbKey = 'thumb:' + storageKey;
        const fullBlob = dataUrlToBlob(original) || await makeImageBlob(original, 4096, 0.95);
        const thumbBlob = dataUrlToBlob(thumb) || await makeImageBlob(thumb, 720, 0.9);
        await saveMediaBlob(storageKey, fullBlob);
        await saveMediaBlob(thumbKey, thumbBlob);
        mediaUrlCache.set(storageKey, URL.createObjectURL(fullBlob));
        addCard({ ...base, data: { name: file.name, storageKey, thumbKey, size: fullBlob.size, mimeType: fullBlob.type || file.type || 'image/jpeg' } });
      } catch (e) {
        addCard({ ...base, data: { name: file.name, dataUrl: thumb } });
        toast('大容量存储不可用，已用压缩图保存', true);
      }
    } catch (e) {
      toast('保存图片失败：' + e.message, true);
    }
  };
  reader.onerror = () => toast('读取图片失败', true);
  reader.readAsDataURL(file);
}

function fmtSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// ---------- 视频 / 音频：IndexedDB 持久化存储 ----------
// 借鉴 infinite-canvas：文件本体存进 IndexedDB（不占 localStorage、容量大），
// 卡片只存 storageKey，刷新后按 key 重新取回 Blob 并生成新的临时 URL
const IDB_NAME = 'inspo-desk-lite';
const IDB_STORE = 'media';
let mediaDB = null;
const mediaUrlCache = new Map(); // storageKey -> objectURL

function openMediaDB() {
  return new Promise((resolve, reject) => {
    if (mediaDB) return resolve(mediaDB);
    if (!('indexedDB' in window)) return reject(new Error('当前浏览器不支持 IndexedDB'));
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) req.result.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => { mediaDB = req.result; resolve(mediaDB); };
    req.onerror = () => reject(req.error);
  });
}

async function saveMediaBlob(storageKey, blob) {
  const db = await openMediaDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(blob, storageKey);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function loadMediaBlob(storageKey) {
  const db = await openMediaDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(storageKey);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function resolveMediaUrl(storageKey) {
  if (!storageKey) return '';
  const cached = mediaUrlCache.get(storageKey);
  if (cached) return cached;
  try {
    const blob = await loadMediaBlob(storageKey);
    if (!blob) return '';
    const url = URL.createObjectURL(blob);
    mediaUrlCache.set(storageKey, url);
    return url;
  } catch (e) {
    console.warn('读取媒体失败', e);
    return '';
  }
}

async function resolveMediaCards() {
  const targets = $$('.card-video[data-key], .card-audio[data-key], .card-img[data-key], .card-img[data-thumb]');
  await Promise.all(targets.map(async (el) => {
    try {
      if (el.classList.contains('card-img')) {
        if (el.dataset.resolved) return;
        const thumbUrl = el.dataset.thumb ? await resolveMediaUrl(el.dataset.thumb) : '';
        const key = el.dataset.key;
        if (!key) {
          // 只有封面（如网页卡片）：缩略图即最终图
          if (thumbUrl) { el.dataset.resolved = '1'; el.src = thumbUrl; }
          return;
        }
        // 图片卡片：先用缩略图秒开，再用原图替换
        if (thumbUrl) el.src = thumbUrl;
        const url = await resolveMediaUrl(key);
        if (url) {
          el.dataset.resolved = '1';
          el.src = url;
        }
      } else if (!el.getAttribute('src')) {
        const key = el.dataset.key;
        if (!key) return;
        const url = await resolveMediaUrl(key);
        if (url) el.src = url;
      }
    } catch {}
  }));
}

function usedMediaKeys() {
  const keys = new Set();
  for (const p of state.projects) {
    for (const c of (p.cards || [])) {
      const d = c.data || {};
      if (typeof d.storageKey === 'string' && d.storageKey) keys.add(d.storageKey);
      if (typeof d.thumbKey === 'string' && d.thumbKey) keys.add(d.thumbKey);
    }
  }
  return keys;
}

async function cleanupOrphanMedia() {
  try {
    const db = await openMediaDB();
    const stored = await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).getAllKeys();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const used = usedMediaKeys();
    const orphans = stored.filter((k) => !used.has(k));
    if (!orphans.length) return;
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      for (const k of orphans) tx.objectStore(IDB_STORE).delete(k);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    for (const k of orphans) {
      const u = mediaUrlCache.get(k);
      if (u) URL.revokeObjectURL(u);
      mediaUrlCache.delete(k);
    }
  } catch (e) {
    console.warn('媒体清理失败', e);
  }
}

// 把网页封面存进大容量存储，localStorage 只留 key；IDB 不可用时由调用方退回 dataUrl
async function setUrlCover(card, dataUrl, maxDim) {
  const small = maxDim ? await downscaleDataUrl(dataUrl, maxDim) : dataUrl;
  const thumbKey = 'thumb:url:' + card.id;
  const blob = dataUrlToBlob(small) || await makeImageBlob(small, maxDim || 1600, 0.9);
  await saveMediaBlob(thumbKey, blob);
  // 同 key 覆盖保存时，刷新缓存里的 objectURL，否则渲染会拿到旧图
  const old = mediaUrlCache.get(thumbKey);
  if (old) URL.revokeObjectURL(old);
  mediaUrlCache.set(thumbKey, URL.createObjectURL(blob));
  card.data.thumbKey = thumbKey;
  delete card.data.thumb;
  return true;
}

async function migrateImageCardsToIDB() {
  const jobs = [];
  for (const p of state.projects) {
    for (const c of (p.cards || [])) {
      if (c.type !== 'image' || !c.data) continue;
      const d = c.data;
      if (typeof d.dataUrl !== 'string' || !d.dataUrl.length) continue;
      if (d.storageKey && !d.thumbKey) {
        jobs.push({ c, onlyThumb: true });
      } else if (!d.storageKey) {
        // 所有图片都搬进 IndexedDB，localStorage 只留元数据
        jobs.push({ c, onlyThumb: false });
      }
    }
  }
  if (!jobs.length) return;
  let done = 0;
  for (const { c, onlyThumb } of jobs) {
    try {
      await new Promise((r) => setTimeout(r, 0)); // 分批处理，避免大画布启动卡顿
      if (onlyThumb) {
        // 原图已在 IndexedDB，把缩略图也搬进去，localStorage 不再存图片数据
        const thumbKey = 'thumb:' + c.data.storageKey;
        const thumbBlob = dataUrlToBlob(c.data.dataUrl) || await makeImageBlob(c.data.dataUrl, 720, 0.9);
        await saveMediaBlob(thumbKey, thumbBlob);
        c.data.thumbKey = thumbKey;
        delete c.data.dataUrl;
      } else {
        // 整张图（原图 + 缩略图）都搬进 IndexedDB
        const thumb = await downscaleDataUrl(c.data.dataUrl, 720);
        const storageKey = 'img:' + uid();
        const thumbKey = 'thumb:' + storageKey;
        const fullBlob = dataUrlToBlob(c.data.dataUrl) || await makeImageBlob(c.data.dataUrl, 4096, 0.95);
        await saveMediaBlob(storageKey, fullBlob);
        await saveMediaBlob(thumbKey, dataUrlToBlob(thumb) || await makeImageBlob(thumb, 720, 0.9));
        mediaUrlCache.set(storageKey, URL.createObjectURL(fullBlob));
        c.data.storageKey = storageKey;
        c.data.thumbKey = thumbKey;
        c.data.size = fullBlob.size;
        c.data.mimeType = fullBlob.type || c.data.mimeType || 'image/jpeg';
        delete c.data.dataUrl;
      }
      done++;
    } catch (e) {
      console.warn('图片迁移失败', e);
    }
  }
  if (!done) return;
  markDirty();
  render();
  toast('已把 ' + done + ' 张图片的缩略图移入大容量存储，释放了本地空间');
}

async function migrateUrlCoversToIDB() {
  const jobs = [];
  for (const p of state.projects) {
    for (const c of (p.cards || [])) {
      if (c.type === 'url' && c.data && typeof c.data.thumb === 'string' && c.data.thumb.length > 0 && !c.data.thumbKey) jobs.push(c);
    }
  }
  if (!jobs.length) return;
  let done = 0;
  for (const c of jobs) {
    await new Promise((r) => setTimeout(r, 0)); // 分批处理
    try {
      if (await setUrlCover(c, c.data.thumb, 1280)) done++;
    } catch (e) {
      console.warn('网页封面迁移失败', e);
    }
  }
  if (!done) return;
  markDirty();
  render();
  toast('已把 ' + done + ' 张网页封面移入大容量存储');
}

async function addVideoFromFile(file) {
  const center = viewCenter();
  const off = slotN++ * 80;
  const storageKey = 'video:' + uid();
  try {
    await saveMediaBlob(storageKey, file);
    mediaUrlCache.set(storageKey, URL.createObjectURL(file));
    addCard({
      id: uid(), type: 'video',
      x: center.x - 160 + off, y: center.y - 150 + off,
      w: 320, h: 240,
      data: { title: file.name, storageKey, size: file.size, mimeType: file.type || 'video/mp4' },
    });
  } catch (e) {
    toast('保存视频失败：' + e.message, true);
  }
}

async function addAudioFromFile(file) {
  const center = viewCenter();
  const off = slotN++ * 80;
  const storageKey = 'audio:' + uid();
  try {
    await saveMediaBlob(storageKey, file);
    mediaUrlCache.set(storageKey, URL.createObjectURL(file));
    addCard({
      id: uid(), type: 'audio',
      x: center.x - 150 + off, y: center.y - 75 + off, w: 300, h: 150,
      data: { title: file.name, storageKey, size: file.size, mimeType: file.type || 'audio/mpeg' },
    });
  } catch (e) {
    toast('保存音频失败：' + e.message, true);
  }
}

// ---------- 文档卡片（Word / Excel / PPT / PDF，桌面版） ----------
async function addFileFromFile(file) {
  if (!isDesktop()) {
    toast('文档卡片仅桌面版支持，请用桌面版拖入', true);
    return;
  }
  if (!API_BASE) { toast('服务未就绪，请稍后重试', true); return; }
  const center = viewCenter();
  const off = slotN++ * 80;
  const placeholder = addCard({
    id: uid(), type: 'file',
    x: center.x - 150 + off, y: center.y - 90 + off,
    w: 280, h: 110,
    data: { title: file.name, size: file.size, mimeType: file.type, importing: true },
  });
  try {
    toast('正在导入文档…');
    const tmpPath = await uploadMediaToTemp(file, file.name);
    const res = await tauriInvoke('import_office_file', { tmpPath, name: file.name });
    if (!res || !res.ok || !res.path) throw new Error((res && res.error) || '导入失败');
    placeholder.data.path = res.path;
    placeholder.data.importing = false;
    render();
    markDirty();
    toast('已添加文档，双击卡片用 WPS / Office 打开');
  } catch (err) {
    state.cards = state.cards.filter((c) => c.id !== placeholder.id);
    render();
    markDirty();
    toast('导入文档失败：' + (err.message || err), true);
  }
}

// 从剪贴板粘贴一段文字 -> 直接生成文字卡片（按文字量估算卡片大小）
function addTextFromClipboard(text) {
  const center = viewCenter();
  const off = slotN++ * 80;
  const t = String(text || '').replace(/\r\n/g, '\n');
  const w = 320;
  const font = 20;
  const cpl = Math.max(10, Math.floor((w - 44) / font));
  const lines = Math.max(1, Math.ceil(t.length / cpl));
  const h = Math.max(150, Math.min(420, lines * 30 + 48));
  addCard({
    id: uid(), type: 'text',
    x: center.x - 160 + off, y: center.y - 120 + off,
    w, h,
    data: { text: t },
  });
  toast('已粘贴文字');
}

function fmtTime(t) {
  if (!isFinite(t) || t < 0) return '0:00';
  const s = Math.floor(t);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function updateAudioUI(cardEl, audio) {
  const now = cardEl.querySelector('.audio-now');
  const full = cardEl.querySelector('.audio-full');
  const elapsed = cardEl.querySelector('.audio-elapsed');
  const playBtn = cardEl.querySelector('.audio-play');
  const cover = cardEl.querySelector('.audio-cover');
  if (now) now.textContent = fmtTime(audio.currentTime);
  if (full && isFinite(audio.duration)) full.textContent = fmtTime(audio.duration);
  if (elapsed) {
    const ratio = isFinite(audio.duration) && audio.duration > 0 ? audio.currentTime / audio.duration : 0;
    elapsed.style.width = (ratio * 100).toFixed(2) + '%';
  }
  if (playBtn) playBtn.innerHTML = audio.paused || audio.ended ? PLAY_ICON : PAUSE_ICON;
  if (cover) cover.classList.toggle('playing', !audio.paused && !audio.ended);
}

function initAudioPlayers() {
  $$('.card.t-audio').forEach((cardEl) => {
    const audio = cardEl.querySelector('audio.card-audio');
    if (!audio) return;
    ['loadedmetadata', 'timeupdate', 'play', 'pause', 'ended'].forEach((evt) => {
      audio.addEventListener(evt, () => updateAudioUI(cardEl, audio));
    });
    updateAudioUI(cardEl, audio);
  });
}

function audioNeighbors(card) {
  const out = [];
  for (const cn of state.connections) {
    let otherId = null;
    if (cn.from === card.id) otherId = cn.to;
    else if (cn.to === card.id) otherId = cn.from;
    if (!otherId) continue;
    const other = state.cards.find((c) => c.id === otherId && c.type === 'audio');
    if (other) out.push(other);
  }
  return out;
}

function audioAxis(card) {
  const cx = card.x + card.w / 2;
  const cy = card.y + (card.h || 150) / 2;
  let left = null, right = null, up = null, down = null;
  let ld = Infinity, rd = Infinity, ud = Infinity, dd = Infinity;
  for (const nb of audioNeighbors(card)) {
    const nx = nb.x + nb.w / 2;
    const ny = nb.y + (nb.h || 150) / 2;
    const dx = nx - cx, dy = ny - cy;
    const dist = Math.hypot(dx, dy);
    if (Math.abs(dx) >= Math.abs(dy)) {
      if (dx < 0) { if (dist < ld) { ld = dist; left = nb; } }
      else { if (dist < rd) { rd = dist; right = nb; } }
    } else {
      if (dy < 0) { if (dist < ud) { ud = dist; up = nb; } }
      else { if (dist < dd) { dd = dist; down = nb; } }
    }
  }
  const hasH = !!(left || right);
  const hasV = !!(up || down);
  return {
    left, right, up, down, hasH, hasV,
    prevId: hasH ? (left ? left.id : null) : (up ? up.id : null),
    nextId: hasH ? (right ? right.id : null) : (down ? down.id : null),
  };
}

const audioUpDownDir = new Map();

function switchAudioCard(fromCardEl, toCardId) {
  const toEl = document.querySelector(`.card[data-id="${toCardId}"]`);
  const toAudio = toEl && toEl.querySelector('audio.card-audio');
  const fromAudio = fromCardEl && fromCardEl.querySelector('audio.card-audio');
  if (!toAudio) return;
  if (fromAudio && fromAudio !== toAudio) fromAudio.pause();
  toAudio.currentTime = 0;
  toAudio.play().catch(() => {});
}

function refreshAudioButtons() {
  $$('.card.t-audio').forEach((cardEl) => {
    const card = state.cards.find((c) => c.id === cardEl.dataset.id);
    if (!card) return;
    const ax = audioAxis(card);
    const setBtn = (act, disabled) => {
      const b = cardEl.querySelector('[data-act="' + act + '"]');
      if (b) b.disabled = !!disabled;
    };
    setBtn('audio-prev', !ax.prevId);
    setBtn('audio-next', !ax.nextId);
    setBtn('audio-updown', !(ax.up || ax.down));
  });
}

// ---------- 网页素材 ----------
async function addUrl(url) {
  const center = viewCenter();
  const off = slotN++ * 80;
  const placeholder = addCard({
    id: uid(), type: 'url',
    x: center.x - 130 + off, y: center.y - 145 + off,
    w: 260, h: 290,
    data: { url, title: '抓取中…', host: '', desc: '', icon: null, thumb: null },
  });
  try {
    const res = await fetch(API_BASE + '/api/metadata?url=' + encodeURIComponent(url));
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || '抓取失败');
    if (placeholder.data.title === '抓取中…') {
      // 用户还没手动编辑，直接填充抓取结果
      if (json.thumb) {
        try { await setUrlCover(placeholder, await downscaleDataUrl(json.thumb, 1280), 1280); } catch {}
      }
      Object.assign(placeholder.data, {
        url: json.url, title: json.title, desc: json.desc,
        host: json.host, icon: json.icon,
      });
      placeholder.h = json.thumb ? 310 : 240;
    } else {
      // 用户已手动编辑过，只补 host / url
      placeholder.data.host = placeholder.data.host || json.host || '';
      placeholder.data.url = json.url || placeholder.data.url;
    }
    render();
    markDirty();
    toast('已添加网页素材');
  } catch (e) {
    if (placeholder.data.title === '抓取中…') {
      placeholder.data.title = '抓取失败';
      placeholder.data.desc = e.message;
    }
    render();
    markDirty();
    toast('网页信息抓取失败：' + e.message, true);
  }
}

// ---------- AI ----------
function parseResult(json) {
  if (json.ok) return json;
  if (json.error && json.raw) return { keywords: [], summary: json.raw };
  throw new Error(json.error || '未知错误');
}

async function analyzeImageCard(card, btn) {
  if (btn) { btn.disabled = true; btn.textContent = '分析中…'; }
  try {
    const res = await fetch(API_BASE + '/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: await resolveMediaUrl(card.data.storageKey) || card.data.dataUrl, aiConfig }),
    });
    const json = await res.json();
    const r = parseResult(json);
    const center = cardCenter(card) || { x: card.x + card.w / 2, y: card.y + card.h / 2 };
    addCard({
      id: uid(), type: 'ai',
      x: card.x + card.w + 30 + aiPlacement * 40, y: card.y + aiPlacement * 40,
      w: 280, h: 260,
      data: {
        kind: 'image', sourceId: card.id,
        summary: r.summary || '',
        keywords: r.keywords || [],
        suggestions: [],
      },
    });
    aiPlacement++;
    toast('AI 分析完成，已生成关键词卡片');
  } catch (e) {
    if (/API Key|未配置/.test(e.message || '')) { toast('请先配置 AI 模型：⋯ → AI 模型设置', true); openAiSettings(); }
    else toast('AI 分析失败：' + e.message, true);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '✨ AI 分析'; }
  }
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片加载失败'));
    img.src = src;
  });
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

async function buildCanvasShot() {
  const cards = state.cards.filter((c) => c.type !== 'ai');
  if (!cards.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of cards) {
    const el = document.querySelector(`.card[data-id="${c.id}"]`);
    const w = el ? el.offsetWidth : c.w;
    const h = el ? el.offsetHeight : c.h;
    minX = Math.min(minX, c.x); minY = Math.min(minY, c.y);
    maxX = Math.max(maxX, c.x + w); maxY = Math.max(maxY, c.y + h);
  }
  const pad = 40;
  const bw = maxX - minX + pad * 2, bh = maxY - minY + pad * 2;
  const scale = Math.min(1, 1400 / Math.max(bw, bh));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(2, Math.round(bw * scale));
  canvas.height = Math.max(2, Math.round(bh * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#f4f1ff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (const c of cards) {
    const el = document.querySelector(`.card[data-id="${c.id}"]`);
    const w = (el ? el.offsetWidth : c.w) * scale;
    const h = (el ? el.offsetHeight : c.h) * scale;
    const x = (c.x - minX + pad) * scale;
    const y = (c.y - minY + pad) * scale;
    ctx.fillStyle = '#ffffff';
    roundRect(ctx, x, y, w, h, 12);
    ctx.fill();
    ctx.strokeStyle = '#d9d2f2';
    ctx.lineWidth = 1;
    roundRect(ctx, x, y, w, h, 12);
    ctx.stroke();
    let src = null;
    if (c.type === 'image') src = await resolveMediaUrl(c.data.storageKey) || c.data.dataUrl || null;
    if (c.type === 'url') src = await resolveMediaUrl(c.data.thumbKey) || c.data.thumb || null;
    if (src) {
      try {
        const img = await loadImage(src);
        const ir = Math.min(w / img.width, h / img.height);
        const iw = img.width * ir, ih = img.height * ir;
        ctx.save();
        roundRect(ctx, x, y, w, h, 12);
        ctx.clip();
        ctx.drawImage(img, x + (w - iw) / 2, y + (h - ih) / 2, iw, ih);
        ctx.restore();
      } catch {}
    } else {
      ctx.fillStyle = (c.type === 'text' || c.type === 'note') ? '#fff3d0' : '#e9e3ff';
      roundRect(ctx, x + 6, y + 6, w - 12, h - 12, 8);
      ctx.fill();
      ctx.fillStyle = '#6b7189';
      ctx.font = '13px sans-serif';
      const label = ((c.type === 'text' || c.type === 'note') ? c.data.text : c.data.title || c.data.host || '').slice(0, 40);
      ctx.fillText(label || '素材', x + 14, y + 28, w - 28);
    }
  }
  return canvas.toDataURL('image/jpeg', 0.85);
}

async function aiSeeCanvas() {
  $('#loading-mask').classList.remove('hidden');
  $('#loading-text').textContent = 'AI 正在看整张画布…';
  try {
    const shot = await buildCanvasShot();
    if (!shot) { toast('画布还没有素材'); return; }
    const cards = state.cards
      .filter((c) => c.type !== 'ai')
      .map((c) => ({ type: c.type, title: c.type === 'image' ? (c.data.name || '图片') : (c.data.title || c.data.text || c.type) }));
    const res = await fetch(API_BASE + '/api/analyze-canvas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: shot, cards, aiConfig }),
    });
    const json = await res.json();
    const r = parseResult(json);
    const center = viewCenter();
    addCard({
      id: uid(), type: 'ai',
      x: center.x - 140 + aiPlacement * 40, y: center.y - 130 + aiPlacement * 40,
      w: 300, h: 320,
      data: {
        kind: 'canvas',
        summary: r.summary || '',
        keywords: r.keywords || [],
        suggestions: r.suggestions || [],
      },
    });
    aiPlacement++;
    toast('画布分析完成');
  } catch (e) {
    if (/API Key|未配置/.test(e.message || '')) { toast('请先配置 AI 模型：⋯ → AI 模型设置', true); openAiSettings(); }
    else toast('画布分析失败：' + e.message, true);
  } finally {
    $('#loading-mask').classList.add('hidden');
  }
}

// ---------- 交互：缩放 / 平移 ----------
function zoomAt(clientX, clientY, factor) {
  const rect = viewport.getBoundingClientRect();
  const mx = clientX - rect.left, my = clientY - rect.top;
  const ns = clamp(state.view.s * factor, 0.05, 5);
  const wx = (mx - state.view.x) / state.view.s;
  const wy = (my - state.view.y) / state.view.s;
  state.view.x = mx - wx * ns;
  state.view.y = my - wy * ns;
  state.view.s = ns;
  applyView();
}

function zoomFit() {
  const cards = state.cards;
  if (!cards.length) { state.view = { x: 60, y: 60, s: 1 }; applyView(); return; }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of cards) {
    minX = Math.min(minX, c.x); minY = Math.min(minY, c.y);
    maxX = Math.max(maxX, c.x + c.w); maxY = Math.max(maxY, c.y + c.h);
  }
  const rect = viewport.getBoundingClientRect();
  const bw = maxX - minX + 160, bh = maxY - minY + 160;
  const s = clamp(Math.min(rect.width / bw, rect.height / bh), 0.05, 1.5);
  state.view = {
    s,
    x: (rect.width - bw * s) / 2 - (minX - 80) * s,
    y: (rect.height - bh * s) / 2 - (minY - 80) * s,
  };
  applyView();
}

let panStart = null;
viewport.addEventListener('wheel', (e) => {
  e.preventDefault();
  zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.1 : 1 / 1.1);
  saveSoon();
}, { passive: false });

// 平移：右键拖拽 或 按住空格+左键拖拽（左键留给框选）
let spaceDown = false;
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !(e.target.matches && e.target.matches('input, textarea'))) {
    spaceDown = true;
    e.preventDefault();
  }
});
document.addEventListener('keyup', (e) => {
  if (e.code === 'Space') spaceDown = false;
});
viewport.addEventListener('pointerdown', (e) => {
  const panByRight = e.button === 2 && !e.target.closest('.card'); // 右键在卡片上留给删除菜单，空白处仍平移
  const panBySpace = e.button === 0 && spaceDown;
  const panByLeft = e.button === 0 && !spaceDown && !e.ctrlKey && !e.metaKey &&
    (e.target === viewport || e.target === $('#lines')); // 左键拖空白处平移画布
  if (!panByRight && !panBySpace && !panByLeft) return;
  if (panByLeft) e.preventDefault();
  panStart = { x: e.clientX, y: e.clientY, vx: state.view.x, vy: state.view.y };
  viewport.classList.add('panning');
  try { viewport.setPointerCapture(e.pointerId); } catch {}
});
viewport.addEventListener('pointermove', (e) => {
  if (!panStart) return;
  state.view.x = panStart.vx + (e.clientX - panStart.x);
  state.view.y = panStart.vy + (e.clientY - panStart.y);
  applyView();
});
viewport.addEventListener('pointerup', () => {
  if (panStart) { panStart = null; viewport.classList.remove('panning'); saveSoon(); }
});

// 卡片拖拽（已选多张时整组移动；Alt+左键拖拽 = 复制拖出）
let drag = null;
document.addEventListener('pointerdown', (e) => {
  const cardEl = e.target.closest('.card');
  if (!cardEl) return;
  if (e.button !== 0 || e.ctrlKey || e.metaKey) return; // Alt 允许：Alt+左键拖拽 = 复制
  if (e.target.closest('textarea, input, button, [data-act], .conn-handle, .resize-handle, .crop-overlay')) return; // 交互元素不触发拖拽
  const mediaEl = e.target.closest('video, audio');
  if (mediaEl) {
    if (mediaEl.tagName === 'AUDIO') return; // 音频条整体是控制条，不触发拖拽
    const mr = mediaEl.getBoundingClientRect();
    if (e.clientY > mr.bottom - 44) return; // 视频底部控制条不触发拖拽
  }
  const card = state.cards.find((c) => c.id === cardEl.dataset.id);
  if (!card) return;
  const ids = selected.has(card.id) && selected.size > 1 ? [...selected] : [card.id];
  if (e.altKey) {
    // Alt+左键拖拽：把选中卡片复制一份拖出去（原卡片不动）
    const idMap = new Map();
    const clones = [];
    for (const cid of ids) {
      const c = state.cards.find((x) => x.id === cid);
      if (!c) continue;
      const nid = uid();
      idMap.set(cid, nid);
      clones.push({ ...c, id: nid, x: c.x, y: c.y, data: c.data ? { ...c.data } : c.data });
    }
    if (!clones.length) return;
    state.cards.push(...clones);
    render();
    const draggedCloneId = idMap.get(card.id);
    drag = {
      id: draggedCloneId, ids: clones.map((c) => c.id), sx: e.clientX, sy: e.clientY,
      start: clones.map((c) => ({ id: c.id, x: c.x, y: c.y })),
      copy: true,
    };
    const cloneEl = document.querySelector('.card[data-id="' + draggedCloneId + '"]');
    if (cloneEl) { cloneEl.classList.add('dragging'); try { cloneEl.setPointerCapture(e.pointerId); } catch {} }
    e.preventDefault();
    return;
  }
  drag = {
    id: card.id, ids, sx: e.clientX, sy: e.clientY,
    start: ids.map((cid) => { const c = state.cards.find((x) => x.id === cid); return { id: cid, x: c.x, y: c.y }; }),
  };
  cardEl.classList.add('dragging');
  try { cardEl.setPointerCapture(e.pointerId); } catch {}
  e.preventDefault();
});
document.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = (e.clientX - drag.sx) / state.view.s;
  const dy = (e.clientY - drag.sy) / state.view.s;
  for (const item of drag.start) {
    const c = state.cards.find((x) => x.id === item.id);
    if (!c) continue;
    c.x = item.x + dx;
    c.y = item.y + dy;
    const el = document.querySelector(`.card[data-id="${item.id}"]`);
    if (el) { el.style.left = c.x + 'px'; el.style.top = c.y + 'px'; }
  }
  drawConnections();
  updateMinimap();
  updateGroupResize();
});
document.addEventListener('pointerup', () => {
  if (drag) {
    const moved = drag.start.some((item) => {
      const c = state.cards.find((x) => x.id === item.id);
      return c && (c.x !== item.x || c.y !== item.y);
    });
    let changed = false;
    if (drag.copy) {
      if (moved) {
        const before = cloneState();
        before.cards = before.cards.filter((c) => !drag.ids.includes(c.id));
        pushHistory(before);
        selected = new Set(drag.ids);
        updateSelectionUI();
        changed = true;
      } else {
        // 原地没拖动：撤销刚才创建的副本
        state.cards = state.cards.filter((c) => !drag.ids.includes(c.id));
        render();
      }
    } else if (moved) {
      const before = cloneState();
      for (const item of drag.start) {
        const c = before.cards.find((x) => x.id === item.id);
        if (c) { c.x = item.x; c.y = item.y; }
      }
      pushHistory(before);
      changed = true;
    }
    // 图片卡片拖到网页卡片上：自动替换封面（重叠面积超过拖拽卡片 30% 即视为投放）
    if (!drag.copy && moved && drag.ids.length === 1) {
      const srcCard = state.cards.find((c) => c.id === drag.ids[0]);
      if (srcCard && srcCard.type === 'image' && srcCard.data && (srcCard.data.dataUrl || srcCard.data.storageKey)) {
        const srcEl = document.querySelector('.card[data-id="' + srcCard.id + '"]');
        if (srcEl) {
          const sr = srcEl.getBoundingClientRect();
          let target = null;
          for (const c of state.cards) {
            if (c.type !== 'url' || c.id === srcCard.id) continue;
            const el = document.querySelector('.card[data-id="' + c.id + '"]');
            if (!el) continue;
            const tr = el.getBoundingClientRect();
            const ix = Math.max(0, Math.min(sr.right, tr.right) - Math.max(sr.left, tr.left));
            const iy = Math.max(0, Math.min(sr.bottom, tr.bottom) - Math.max(sr.top, tr.top));
            if (ix * iy >= sr.width * sr.height * 0.3) { target = c; break; }
          }
          if (target) {
            changed = true;
            (async () => {
              try {
                const full = await resolveMediaUrl(srcCard.data.storageKey) || srcCard.data.dataUrl;
                await setUrlCover(target, full, 1600);
              } catch {
                const full = await resolveMediaUrl(srcCard.data.storageKey) || srcCard.data.dataUrl;
                target.data.thumb = full ? await downscaleDataUrl(full, 1600) : null;
              }
              render();
              const targetEl = document.querySelector('.card[data-id="' + target.id + '"]');
              if (targetEl) { targetEl.classList.add('cover-flash'); setTimeout(() => targetEl.classList.remove('cover-flash'), 800); }
              toast('已替换网页卡片封面');
            })();
          }
        }
      }
    }
    drag = null;
    $$('.card.dragging').forEach((el) => el.classList.remove('dragging'));
    if (changed) markDirty();
    updateGroupResize();
    refreshAudioButtons();
  }
});

// 卡片缩放（右下角手柄，最小 120×80）
let resize = null;
document.addEventListener('pointerdown', (e) => {
  const handle = e.target.closest('.resize-handle');
  if (!handle) return;
  if (e.button !== 0 || e.altKey || e.ctrlKey || e.metaKey) return;
  const cardEl = handle.closest('.card');
  const card = state.cards.find((c) => c.id === cardEl.dataset.id);
  if (!card) return;
  resize = { id: card.id, sx: e.clientX, sy: e.clientY, ow: card.w || 260, oh: card.h || 180 };
  cardEl.classList.add('resizing');
  try { handle.setPointerCapture(e.pointerId); } catch {}
  e.preventDefault();
});
document.addEventListener('pointermove', (e) => {
  if (!resize) return;
  const card = state.cards.find((c) => c.id === resize.id);
  if (!card) return;
  card.w = Math.max(120, Math.round(resize.ow + (e.clientX - resize.sx) / state.view.s));
  card.h = Math.max(80, Math.round(resize.oh + (e.clientY - resize.sy) / state.view.s));
  const el = document.querySelector(`.card[data-id="${resize.id}"]`);
  if (el) {
    el.style.width = card.w + 'px';
    el.style.height = card.h + 'px';
    if (card.type === 'text' || card.type === 'note') {
      const ta = el.querySelector('textarea.card-note-input');
      if (ta) ta.style.fontSize = noteFontSize(card.w, card.h) + 'px';
    }
  }
  drawConnections();
  updateMinimap();
});
document.addEventListener('pointerup', () => {
  if (resize) {
    const c = state.cards.find((x) => x.id === resize.id);
    if (c && (c.w !== resize.ow || c.h !== resize.oh)) {
      const before = cloneState();
      const bc = before.cards.find((x) => x.id === resize.id);
      if (bc) { bc.w = resize.ow; bc.h = resize.oh; }
      pushHistory(before);
    }
    resize = null;
    $$('.card.resizing').forEach((el) => el.classList.remove('resizing'));
    markDirty();
    refreshAudioButtons();
  }
});

// 整组缩放（多选时拖右下角手柄，整体等比缩放）
let groupResize = null;
document.addEventListener('pointerdown', (e) => {
  const h = e.target.closest('#group-resize');
  if (!h) return;
  if (e.button !== 0 || e.altKey || e.ctrlKey || e.metaKey) return;
  const ids = [...selected];
  const cards = state.cards.filter((c) => ids.includes(c.id));
  if (cards.length < 2) return;
  e.preventDefault();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const originals = cards.map((c) => ({ c, x: c.x, y: c.y, w: c.w || 260, h: c.h || 180 }));
  for (const o of originals) {
    minX = Math.min(minX, o.x); minY = Math.min(minY, o.y);
    maxX = Math.max(maxX, o.x + o.w); maxY = Math.max(maxY, o.y + o.h);
  }
  groupResize = { sx: e.clientX, sy: e.clientY, ox: minX, oy: minY, ow: maxX - minX, oh: maxY - minY, originals };
  h.classList.add('active');
  try { h.setPointerCapture(e.pointerId); } catch {}
});
document.addEventListener('pointermove', (e) => {
  if (!groupResize) return;
  const gr = groupResize;
  const scale = clamp((gr.ow + (e.clientX - gr.sx) / state.view.s) / gr.ow, 0.12, 6);
  for (const o of gr.originals) {
    const c = o.c;
    c.x = Math.round(gr.ox + (o.x - gr.ox) * scale);
    c.y = Math.round(gr.oy + (o.y - gr.oy) * scale);
    c.w = Math.max(40, Math.round(o.w * scale));
    c.h = Math.max(40, Math.round(o.h * scale));
    const el = document.querySelector(`.card[data-id="${c.id}"]`);
    if (el) {
      el.style.left = c.x + 'px';
      el.style.top = c.y + 'px';
      el.style.width = c.w + 'px';
      el.style.height = c.h + 'px';
      if (c.type === 'text' || c.type === 'note') {
        const ta = el.querySelector('textarea.card-note-input');
        if (ta) ta.style.fontSize = noteFontSize(c.w, c.h) + 'px';
      }
    }
  }
  updateGroupResize();
  drawConnections();
  updateMinimap();
});
document.addEventListener('pointerup', () => {
  if (!groupResize) return;
  const gr = groupResize;
  const changed = gr.originals.some((o) => o.c.x !== o.x || o.c.y !== o.y || o.c.w !== o.w || o.c.h !== o.h);
  if (changed) {
    const before = cloneState();
    for (const o of gr.originals) {
      const bc = before.cards.find((x) => x.id === o.c.id);
      if (bc) { bc.x = o.x; bc.y = o.y; bc.w = o.w; bc.h = o.h; }
    }
    pushHistory(before);
    markDirty();
  }
  groupResize = null;
  const h = $('#group-resize');
  if (h) h.classList.remove('active');
  updateGroupResize();
  refreshAudioButtons();
});
// ---------- 左键批量选择：框选 / 点选，可整组复制、删除、移动 ----------
let selected = new Set();
let marquee = null;

function updateSelectionUI() {
  $$('.card.selected').forEach((el) => { el.classList.remove('selected'); el.classList.remove('multi'); });
  for (const id of selected) {
    const el = document.querySelector(`.card[data-id="${id}"]`);
    if (el) { el.classList.add('selected'); el.classList.toggle('multi', selected.size > 1); }
  }
  const bar = $('#sel-bar');
  if (bar) {
    bar.classList.toggle('hidden', selected.size === 0);
    $('#sel-count').textContent = `已选 ${selected.size} 张`;
  }
  updateGroupResize();
}

// 整组缩放的虚线框 + 右下角手柄（仅多选时显示）
function updateGroupResize() {
  const box = $('#group-box'), handle = $('#group-resize');
  if (!box || !handle) return;
  if (selected.size < 2) {
    box.classList.add('hidden');
    handle.classList.add('hidden');
    return;
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const id of selected) {
    const c = state.cards.find((x) => x.id === id);
    if (!c) continue;
    const w = c.w || 260, h = c.h || 180;
    minX = Math.min(minX, c.x); minY = Math.min(minY, c.y);
    maxX = Math.max(maxX, c.x + w); maxY = Math.max(maxY, c.y + h);
  }
  if (!isFinite(minX)) {
    box.classList.add('hidden');
    handle.classList.add('hidden');
    return;
  }
  box.classList.remove('hidden');
  handle.classList.remove('hidden');
  box.style.left = minX + 'px';
  box.style.top = minY + 'px';
  box.style.width = (maxX - minX) + 'px';
  box.style.height = (maxY - minY) + 'px';
  handle.style.left = maxX + 'px';
  handle.style.top = maxY + 'px';
}

function selectCardsInRect(x1, y1, x2, y2) {
  selected.clear();
  for (const c of state.cards) {
    const w = c.w || 260, h = c.h || 180;
    if (c.x < x2 && c.x + w > x1 && c.y < y2 && c.y + h > y1) selected.add(c.id);
  }
  updateSelectionUI();
}

function deleteSelected() {
  if (!selected.size) return;
  pushHistory();
  for (const id of selected) {
    state.cards = state.cards.filter((c) => c.id !== id);
    state.connections = state.connections.filter((cn) => cn.from !== id && cn.to !== id);
  }
  selected.clear();
  render();
  updateSelectionUI();
  markDirty();
  toast('已删除');
}

function deleteCard(id) {
  pushHistory();
  state.cards = state.cards.filter((c) => c.id !== id);
  state.connections = state.connections.filter((cn) => cn.from !== id && cn.to !== id);
  render();
  markDirty();
  toast('已删除');
}


function duplicateSelected() {
  const ids = [...selected];
  if (!ids.length) return;
  pushHistory();
  const idMap = new Map();
  const clones = [];
  for (const id of ids) {
    const c = state.cards.find((x) => x.id === id);
    if (!c) continue;
    const nid = uid();
    idMap.set(id, nid);
    clones.push({ ...c, id: nid, x: c.x + 28, y: c.y + 28 });
  }
  state.cards.push(...clones);
  for (const cn of [...state.connections]) {
    if (ids.includes(cn.from) && ids.includes(cn.to)) {
      state.connections.push({ id: uid(), from: idMap.get(cn.from), to: idMap.get(cn.to) });
    }
  }
  selected = new Set(clones.map((c) => c.id));
  render();
  updateSelectionUI();
  markDirty();
  toast(`已复制 ${clones.length} 张`);
}

viewport.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || spaceDown || !(e.ctrlKey || e.metaKey)) return; // Ctrl+左键拖空白处框选
  if (e.target !== viewport && e.target !== $('#lines')) return; // 从空白处开始框选
  e.preventDefault();
  selected.clear();
  updateSelectionUI();
  const rect = viewport.getBoundingClientRect();
  const wx = (e.clientX - rect.left - state.view.x) / state.view.s;
  const wy = (e.clientY - rect.top - state.view.y) / state.view.s;
  marquee = { x1: wx, y1: wy, x2: wx, y2: wy };
  const box = document.createElement('div');
  box.id = 'marquee';
  box.className = 'marquee';
  $('#world').appendChild(box);
  try { viewport.setPointerCapture(e.pointerId); } catch {}
});
viewport.addEventListener('pointermove', (e) => {
  if (!marquee) return;
  const rect = viewport.getBoundingClientRect();
  marquee.x2 = (e.clientX - rect.left - state.view.x) / state.view.s;
  marquee.y2 = (e.clientY - rect.top - state.view.y) / state.view.s;
  const box = $('#marquee');
  if (!box) return;
  const x = Math.min(marquee.x1, marquee.x2), y = Math.min(marquee.y1, marquee.y2);
  box.style.left = x + 'px';
  box.style.top = y + 'px';
  box.style.width = Math.abs(marquee.x2 - marquee.x1) + 'px';
  box.style.height = Math.abs(marquee.y2 - marquee.y1) + 'px';
});
function endMarquee() {
  if (!marquee) return;
  const box = $('#marquee');
  if (box) box.remove();
  const x1 = Math.min(marquee.x1, marquee.x2), y1 = Math.min(marquee.y1, marquee.y2);
  const x2 = Math.max(marquee.x1, marquee.x2), y2 = Math.max(marquee.y1, marquee.y2);
  if (x2 - x1 > 4 || y2 - y1 > 4) selectCardsInRect(x1, y1, x2, y2);
  marquee = null;
}
document.addEventListener('pointerup', endMarquee);
viewport.addEventListener('pointerup', endMarquee);

// 左键点击卡片：单选；Ctrl+左键：切换选中（按钮/输入框/手柄除外）
viewport.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || spaceDown) return;
  if (e.target.closest('[data-act]') || e.target.closest('textarea, input') ||
      e.target.closest('.conn-handle') || e.target.closest('.resize-handle')) return;
  const cardEl = e.target.closest('.card');
  if (!cardEl) return;
  const id = cardEl.dataset.id;
  if (e.ctrlKey || e.metaKey) {
    if (selected.has(id)) selected.delete(id); else selected.add(id);
  } else if (!selected.has(id)) {
    selected = new Set([id]);
  }
  updateSelectionUI();
});

// 操作条
$('#sel-copy').addEventListener('click', duplicateSelected);
$('#sel-delete').addEventListener('click', deleteSelected);
$('#sel-clear').addEventListener('click', () => { selected.clear(); updateSelectionUI(); });
// 屏蔽浏览器右键菜单（右键用于平移）
// ---------- 右键菜单 ----------
// 复制卡片内容到系统剪贴板，可在其他应用粘贴
async function copyCardToClipboard(id) {
  const c = state.cards.find((x) => x.id === id);
  if (!c) return;
  const d = c.data || {};
  try {
    if (c.type === 'text' || c.type === 'note' || c.type === 'ai') {
      await navigator.clipboard.writeText(d.text || d.summary || '');
      toast('内容已复制，可粘贴到其他地方');
    } else if (c.type === 'url') {
      await navigator.clipboard.writeText(d.url || '');
      toast('链接已复制，可粘贴到其他地方');
    } else if (c.type === 'image') {
      const src = await resolveMediaUrl(d.storageKey) || d.dataUrl || d.thumb || null;
      if (!src) { toast('图片复制失败', true); return; }
      const png = await withTimeout(imageSrcToPngBlob(src), 6000, '图片处理超时');
      await withTimeout(navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]), 4000, '剪贴板写入超时');
      toast('图片已复制，可粘贴到其他地方');
    } else if (c.type === 'file') {
      if (isDesktop() && d.path) {
        const res = await tauriInvoke('export_media_file', { path: d.path, mode: 'copy' });
        if (res && res.ok) toast('文件已复制，可粘贴到其他地方');
        else toast((res && res.error) || '复制失败', true);
      } else {
        toast('浏览器不支持复制本地文件到系统剪贴板', true);
      }
    } else if (c.type === 'video' || c.type === 'audio') {
      if (isDesktop() && d.storageKey) {
        await exportDesktopMedia(id, 'copy');
      } else if (d.url && !d.url.startsWith('blob:')) {
        await navigator.clipboard.writeText(d.url);
        toast('链接已复制，可粘贴到其他地方');
      } else {
        toast((c.type === 'video' ? '视频' : '音频') + '为本地文件，浏览器不支持复制到系统剪贴板', true);
      }
    } else {
      await navigator.clipboard.writeText(d.title || '');
      toast('已复制');
    }
  } catch (err) {
    toast('复制失败：' + (err.message || '浏览器未授权剪贴板'), true);
  }
}

// 文档卡片：双击 / 按钮用系统默认程序（WPS / Office）打开
function openFileCard(card) {
  const d = card && card.data;
  if (!d || !d.path) { toast('文档文件不存在，请重新拖入', true); return; }
  if (!isDesktop()) { toast('文档卡片仅桌面版支持打开', true); return; }
  tauriInvoke('open_file', { path: d.path }).catch((err) => {
    toast((err && err.message) || '文件不存在或已被移动，请重新拖入', true);
  });
}

// 收集所有画布里仍被引用的文档路径，供清理孤儿文件使用
function collectInUseOfficePaths() {
  const set = new Set();
  for (const p of state.projects) {
    for (const c of (p.cards || [])) {
      if (c.type === 'file' && c.data && c.data.path) set.add(c.data.path);
    }
  }
  return [...set];
}
function cleanupOrphanOfficeFiles() {
  if (!isDesktop()) return;
  tauriInvoke('cleanup_office_files', { keep: collectInUseOfficePaths() }).catch(() => {});
}

// ---------- 桌面版媒体导出（保存 / 复制 / 拖出） ----------
async function exportDesktopMedia(id, mode) {
  const card = state.cards.find((c) => c.id === id);
  if (!card) return;
  if (!API_BASE) { toast('服务未就绪，请稍后重试', true); return; }
  const d = card.data || {};
  const name = d.title || (card.type === 'video' ? 'video.mp4' : 'audio.mp3');
  const msg = { save: '保存到文件夹', copy: '复制到剪贴板', drag: '拖出窗口' }[mode] || mode;
  try {
    let tmpPath;
    if (d.storageKey) {
      const blob = await loadMediaBlob(d.storageKey);
      if (!blob) { toast('文件数据丢失，无法导出', true); return; }
      tmpPath = await uploadMediaToTemp(blob, name);
    } else if (d.url && !d.url.startsWith('blob:')) {
      tmpPath = await downloadRemoteToTemp(d.url, name);
    } else {
      toast('没有可导出的文件', true);
      return;
    }
    let preview = null;
    if (mode === 'drag' && card.type === 'video') preview = await captureVideoPreview(id);
    const res = await tauriInvoke('export_media_file', { path: tmpPath, mode, name, preview });
    if (res && res.ok) toast(msg + '成功');
    else toast((res && res.error) || '导出失败', true);
  } catch (err) {
    toast('导出失败：' + (err.message || err), true);
  }
}

async function uploadMediaToTemp(blob, name) {
  const res = await fetch(API_BASE + '/api/export-media', {
    method: 'POST',
    headers: { 'X-File-Name': encodeURIComponent(name) },
    body: blob,
  });
  const j = await res.json();
  if (!j.ok) throw new Error(j.error || '上传失败');
  return j.tmpPath;
}

async function downloadRemoteToTemp(url, name) {
  const res = await fetch(API_BASE + '/api/export-remote?url=' + encodeURIComponent(url));
  const j = await res.json();
  if (!j.ok) throw new Error(j.error || '下载失败');
  return j.tmpPath;
}

async function captureVideoPreview(id) {
  try {
    const el = document.querySelector('.card[data-id="' + id + '"] video.card-video');
    if (!el || el.readyState < 2 || !el.videoWidth) return null;
    const canvas = document.createElement('canvas');
    canvas.width = Math.min(320, el.videoWidth);
    canvas.height = Math.round(canvas.width * el.videoHeight / Math.max(1, el.videoWidth));
    canvas.getContext('2d').drawImage(el, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) return null;
    return await new Promise((resolve) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result).split(',')[1] || null);
      fr.onerror = () => resolve(null);
      fr.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

// 任意图片来源（data/blob/http）统一重编码为 PNG，Chromium 剪贴板只支持写 PNG 图片
async function imageSrcToPngBlob(src) {
  const img = await loadImage(src);
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  canvas.getContext('2d').drawImage(img, 0, 0);
  return await new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('图片编码失败'))), 'image/png');
  });
}

function withTimeout(promise, ms, msg) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(msg)), ms)),
  ]);
}

// ---------- 右键菜单（删除 / 复制到画外） ----------
let ctxMenu = { id: null };

function showCtxMenu(e, cardEl) {
  ctxMenu.id = cardEl.dataset.id;
  const menu = $('#ctx-menu');
  const card = state.cards.find((c) => c.id === cardEl.dataset.id);
  const isMedia = isDesktop() && card && (card.type === 'video' || card.type === 'audio');
  menu.querySelectorAll('[data-ctx="save-file"],[data-ctx="copy-file"],[data-ctx="drag-file"]').forEach((el) => el.classList.toggle('hidden', !isMedia));
  const sep = document.getElementById('ctx-file-sep');
  if (sep) sep.classList.toggle('hidden', !isMedia);
  const openFileItem = menu.querySelector('[data-ctx="open-file"]');
  if (openFileItem) openFileItem.classList.toggle('hidden', !(isDesktop() && card && card.type === 'file'));
  menu.classList.remove('hidden');
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  let x = e.clientX, y = e.clientY;
  if (x + mw > window.innerWidth - 8) x = window.innerWidth - mw - 8;
  if (y + mh > window.innerHeight - 8) y = window.innerHeight - mh - 8;
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
}

function hideCtxMenu() {
  const menu = $('#ctx-menu');
  if (menu) menu.classList.add('hidden');
  ctxMenu.id = null;
}

viewport.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  hideCtxMenu();
  const cardEl = e.target.closest('.card');
  if (cardEl) showCtxMenu(e, cardEl);
});

$('#ctx-menu').addEventListener('click', (e) => {
  const item = e.target.closest('[data-ctx]');
  if (!item) return;
  if (item.dataset.ctx === 'save-file' && ctxMenu.id) {
    exportDesktopMedia(ctxMenu.id, 'save');
  } else if (item.dataset.ctx === 'copy-file' && ctxMenu.id) {
    exportDesktopMedia(ctxMenu.id, 'copy');
  } else if (item.dataset.ctx === 'drag-file' && ctxMenu.id) {
    exportDesktopMedia(ctxMenu.id, 'drag');
  } else if (item.dataset.ctx === 'open-file' && ctxMenu.id) {
    const card = state.cards.find((c) => c.id === ctxMenu.id);
    if (card) openFileCard(card);
  } else if (item.dataset.ctx === 'copy' && ctxMenu.id) {
    copyCardToClipboard(ctxMenu.id);
  } else if (item.dataset.ctx === 'delete' && ctxMenu.id) {
    deleteCard(ctxMenu.id);
  }
  hideCtxMenu();
});

// 点击别处 / 滚轮 / 缩放窗口时关闭菜单
document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('#ctx-menu')) hideCtxMenu();
}, true);
document.addEventListener('wheel', hideCtxMenu, { passive: true });
window.addEventListener('resize', hideCtxMenu);

// 快捷键：Ctrl+Z 撤销 · Ctrl+Y 重做 · Ctrl+S 保存 · Ctrl+O 导入 · Ctrl+E 导出 · Ctrl+N 新建画布
document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  // 文件 / 画布快捷键：输入框里也生效
  if (mod && !e.altKey) {
    const k = (e.key || '').toLowerCase();
    if (k === 's') { e.preventDefault(); save(); toast('已保存到本地'); return; }
    if (k === 'o') { e.preventDefault(); $('#import-file').click(); return; }
    if (k === 'e') {
      e.preventDefault();
      exportCanvas().catch(() => {
        $('#loading-mask').classList.add('hidden');
        toast('导出失败', true);
      });
      return;
    }
    if (k === 'n') { e.preventDefault(); createProject(); return; }
  }
  if (e.target.matches && e.target.matches('input, textarea')) return;
  if (mod && !e.altKey && (e.key === 'z' || e.key === 'Z')) {
    e.preventDefault();
    if (e.shiftKey) redo(); else undo();
    return;
  }
  if (mod && !e.altKey && (e.key === 'y' || e.key === 'Y')) {
    e.preventDefault();
    redo();
    return;
  }
  if (selected.size && (e.key === 'Delete' || e.key === 'Backspace')) {
    e.preventDefault();
    deleteSelected();
  } else if (e.key === 'Escape') {
    if (crop) exitCrop();
    hideCtxMenu();
    if (selected.size) { selected.clear(); updateSelectionUI(); }
  }
});
// ---------- 卡片按钮 / 连线 ----------
// ---------- 拖拽连线：拖卡片右侧小圆点到另一张卡片 ----------
let connDrag = null;

document.addEventListener('pointerdown', (e) => {
  const handle = e.target.closest('.conn-handle');
  if (!handle) return;
  if (e.button !== 0 || e.altKey || e.ctrlKey || e.metaKey) return;
  e.preventDefault();
  const cardEl = handle.closest('.card');
  connDrag = { fromId: cardEl.dataset.id };
  cardEl.classList.add('connecting');
  let dragSvg = $('#conn-drag-svg');
  if (!dragSvg) {
    dragSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    dragSvg.id = 'conn-drag-svg';
    dragSvg.setAttribute('class', 'conn-drag-svg');
    world.appendChild(dragSvg);
  }
  dragSvg.insertAdjacentHTML('beforeend', '<path class="conn-drag-line" id="conn-drag-line" d=""/>');
  updateConnDrag(e.clientX, e.clientY);
  try { cardEl.setPointerCapture(e.pointerId); } catch {}
});

function updateConnDrag(clientX, clientY) {
  const line = $('#conn-drag-line');
  const el = document.querySelector(`.card[data-id="${connDrag ? connDrag.fromId : ''}"]`);
  if (!line || !el) return;
  const rect = viewport.getBoundingClientRect();
  const wx = (clientX - rect.left - state.view.x) / state.view.s;
  const wy = (clientY - rect.top - state.view.y) / state.view.s;
  const pa = { x: el.offsetLeft + el.offsetWidth, y: el.offsetTop + el.offsetHeight / 2 };
  line.setAttribute('d', curvePath(pa.x, pa.y, wx, wy));
}

document.addEventListener('pointermove', (e) => {
  if (!connDrag) return;
  updateConnDrag(e.clientX, e.clientY);
  // 高亮当前悬停的目标卡片
  $$('.card.conn-target').forEach((el) => el.classList.remove('conn-target'));
  if (document.elementsFromPoint) {
    for (const h of document.elementsFromPoint(e.clientX, e.clientY)) {
      if (h.closest && h.closest('.card')) {
        const hovered = h.closest('.card');
        if (hovered.dataset.id !== connDrag.fromId) hovered.classList.add('conn-target');
        break;
      }
    }
  }
});

document.addEventListener('pointerup', (e) => {
  if (!connDrag) return;
  const fromId = connDrag.fromId;
  const dsvg = $('#conn-drag-svg');
  if (dsvg) dsvg.remove();
  const el = document.querySelector(`.card[data-id="${fromId}"]`);
  if (el) el.classList.remove('connecting');
  let target = null;
  const hits = document.elementsFromPoint ? document.elementsFromPoint(e.clientX, e.clientY) : [];
  for (const h of hits) {
    if (h.closest && h.closest('.card')) { target = h.closest('.card'); break; }
  }
  if (target && target.dataset.id !== fromId) {
    const toId = target.dataset.id;
    const exists = state.connections.some((cn) =>
      (cn.from === fromId && cn.to === toId) || (cn.from === toId && cn.to === fromId));
    if (!exists) {
      pushHistory();
      state.connections.push({ id: uid(), from: fromId, to: toId });
      drawConnections();
      refreshAudioButtons();
      updateStats();
      markDirty();
      toast('已连接');
    }
  }
  $$('.card.conn-target').forEach((el) => el.classList.remove('conn-target'));
  connDrag = null;
});

$('#cards').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (btn) {
    const act = btn.dataset.act;
    const cardEl = btn.closest('.card');
    const card = state.cards.find((c) => c.id === cardEl.dataset.id);
    if (act === 'delete') {
      deleteCard(card.id);
    } else if (act === 'open') {
      const url = btn.dataset.value || '';
      if (!/^https?:\/\//i.test(url)) { toast('无效链接', true); return; }
      if (isDesktop()) {
        tauriInvoke('open_url', { url }).catch(() => toast('打开失败', true));
      } else {
        window.open(url, '_blank', 'noopener');
      }
    } else if (act === 'open-file') {
      openFileCard(card);
    } else if (act === 'copy') {
      try { await navigator.clipboard.writeText(btn.dataset.value || ''); toast('已复制'); }
      catch { toast('复制失败', true); }
    } else if (act === 'analyze') {
      analyzeImageCard(card, btn);
    } else if (act === 'crop') {
      startCrop(card, cardEl);
    } else if (act === 'jump') {
      const target = state.cards.find((c) => c.id === btn.dataset.value);
      if (target) {
        const rect = viewport.getBoundingClientRect();
        state.view.x = rect.width / 2 - (target.x + target.w / 2) * state.view.s;
        state.view.y = rect.height / 2 - (target.y + target.h / 2) * state.view.s;
        applyView();
      }
    } else if (act === 'audio-toggle') {
      const audio = cardEl.querySelector('.card-audio');
      if (!audio) return;
      if (audio.paused) audio.play().catch(() => {}); else audio.pause();
    } else if (act === 'audio-seek') {
      const audio = cardEl.querySelector('.card-audio');
      if (!audio || !isFinite(audio.duration)) return;
      const r = btn.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      audio.currentTime = ratio * audio.duration;
      updateAudioUI(cardEl, audio);
    } else if (act === 'audio-prev' || act === 'audio-next') {
      const ax = audioAxis(card);
      const targetId = act === 'audio-prev' ? ax.prevId : ax.nextId;
      if (targetId) switchAudioCard(cardEl, targetId);
    } else if (act === 'audio-updown') {
      const ax = audioAxis(card);
      let dir = audioUpDownDir.get(card.id) || 'up';
      let target = dir === 'up' ? ax.up : ax.down;
      if (!target) {
        dir = dir === 'up' ? 'down' : 'up';
        target = dir === 'up' ? ax.up : ax.down;
      }
      if (target) {
        audioUpDownDir.set(card.id, dir === 'up' ? 'down' : 'up');
        switchAudioCard(cardEl, target.id);
      }
    } else if (act === 'edit-url') {
      urlEditingId = card.id;
      render();
    } else if (act === 'save-url') {
      const el = document.querySelector('.card[data-id="' + card.id + '"]');
      const t = el.querySelector('.card-edit-title').value.trim();
      const de = el.querySelector('.card-edit-desc').value.trim();
      pushHistory();
      card.data.title = t || card.data.host || '网页';
      card.data.desc = de;
      urlEditingId = null;
      render(); markDirty();
      toast('已保存');
    } else if (act === 'cancel-url') {
      urlEditingId = null;
      render();
    } else if (act === 'edit-thumb') {
      urlEditTarget = card;
      $('#card-thumb-file').click();
    } else if (act === 'edit-icon') {
      urlEditTarget = card;
      $('#card-icon-file').click();
    }
    return;
  }
});

// 双击网页卡片（封面/简介/网址任意位置）-> 直接进入卡片内编辑并聚焦简介
$('#cards').addEventListener('dblclick', (e) => {
  if (e.target.closest('[data-act]') || e.target.closest('input, textarea, button') ||
      e.target.closest('.conn-handle, .resize-handle, .crop-overlay')) return;
  const fileEl = e.target.closest('.card.t-file');
  if (fileEl) {
    const fcard = state.cards.find((c) => c.id === fileEl.dataset.id);
    if (fcard) openFileCard(fcard);
    return;
  }
  const cardEl = e.target.closest('.card.t-url');
  if (!cardEl || cardEl.classList.contains('editing')) return;
  const card = state.cards.find((c) => c.id === cardEl.dataset.id);
  if (!card) return;
  urlEditingId = card.id;
  render();
  const el = document.querySelector(`.card[data-id="${card.id}"] .card-edit-desc`);
  if (el) {
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }
});

// ---------- 图片裁剪 ----------
let crop = null;

function startCrop(card, cardEl) {
  if (crop) exitCrop();
  const imgEl = cardEl.querySelector('.card-img');
  if (!imgEl) return;
  cardEl.classList.add('cropping');
  const overlay = document.createElement('div');
  overlay.className = 'crop-overlay';
  overlay.innerHTML = `
    <div class="crop-box">
      <div class="crop-handle h-nw"></div><div class="crop-handle h-ne"></div>
      <div class="crop-handle h-sw"></div><div class="crop-handle h-se"></div>
    </div>`;
  cardEl.appendChild(overlay);
  const box = overlay.querySelector('.crop-box');
  const aw = cardEl.clientWidth, ah = cardEl.clientHeight;
  const bw = Math.max(60, Math.round(aw * 0.8)), bh = Math.max(40, Math.round(ah * 0.7));
  box.style.left = Math.round((aw - bw) / 2) + 'px';
  box.style.top = Math.round((ah - bh) / 2) + 'px';
  box.style.width = bw + 'px';
  box.style.height = bh + 'px';
  const tbar = document.createElement('div');
  tbar.className = 'crop-float-toolbar';
  tbar.innerHTML = `
    <span class="crop-float-hint">拖拽移动 · 拉角落调整</span>
    <span class="crop-float-sep"></span>
    <button type="button" data-crop="cancel">${CROP_CANCEL_ICON}<span>取消</span></button>
    <button type="button" class="crop-apply" data-crop="apply">${CROP_APPLY_ICON}<span>应用裁剪</span></button>`;
  document.body.appendChild(tbar);
  tbar.addEventListener('click', (e) => {
    const b = e.target.closest('[data-crop]');
    if (!b) return;
    if (b.dataset.crop === 'apply') applyCrop(); else exitCrop();
  });
  crop = { card, cardEl, overlay, box, toolbar: tbar, mode: null };
  overlay.addEventListener('pointerdown', cropDown);
  overlay.addEventListener('pointermove', cropMove);
  overlay.addEventListener('pointerup', cropUp);
}

function cropBoxRect() {
  const b = crop.box;
  return { x: b.offsetLeft, y: b.offsetTop, w: b.offsetWidth, h: b.offsetHeight };
}

function setCropBox(r) {
  const maxW = crop.cardEl.clientWidth, maxH = crop.cardEl.clientHeight;
  const MIN = 36;
  r.w = Math.max(MIN, Math.min(maxW - r.x, r.w));
  r.h = Math.max(MIN, Math.min(maxH - r.y, r.h));
  r.x = Math.max(0, Math.min(maxW - r.w, r.x));
  r.y = Math.max(0, Math.min(maxH - r.h, r.y));
  const b = crop.box;
  b.style.left = Math.round(r.x) + 'px';
  b.style.top = Math.round(r.y) + 'px';
  b.style.width = Math.round(r.w) + 'px';
  b.style.height = Math.round(r.h) + 'px';
}

function cropDown(e) {
  if (e.button !== 0 || !crop) return;
  const handle = e.target.closest('.crop-handle');
  const toolbar = e.target.closest('.crop-toolbar');
  const r = cropBoxRect();
  crop.start = { x: e.clientX, y: e.clientY, x0: r.x, y0: r.y, w: r.w, h: r.h };
  if (handle) {
    const cls = handle.className;
    crop.mode = 'resize';
    crop.corner = cls.includes('nw') ? 'nw' : cls.includes('se') ? 'se' : cls.includes('ne') ? 'ne' : 'sw';
    e.preventDefault();
  } else if (!toolbar) {
    crop.mode = 'move';
    e.preventDefault();
  }
  if (!toolbar) { try { crop.overlay.setPointerCapture(e.pointerId); } catch {} }
}

function cropMove(e) {
  if (!crop || !crop.mode) return;
  const s = crop.start;
  const k = state.view.s || 1;
  const dx = (e.clientX - s.x) / k, dy = (e.clientY - s.y) / k;
  if (crop.mode === 'move') {
    setCropBox({ x: s.x0 + dx, y: s.y0 + dy, w: s.w, h: s.h });
  } else {
    let x = s.x0, y = s.y0, w = s.w, h = s.h;
    const c = crop.corner;
    if (c.indexOf('e') > -1) w = s.w + dx; else { x = s.x0 + dx; w = s.w - dx; }
    if (c.indexOf('s') > -1) h = s.h + dy; else { y = s.y0 + dy; h = s.h - dy; }
    setCropBox({ x, y, w, h });
  }
}

function cropUp() { if (crop) crop.mode = null; }

function exitCrop() {
  if (!crop) return;
  crop.overlay.remove();
  if (crop.toolbar) crop.toolbar.remove();
  crop.cardEl.classList.remove('cropping');
  crop = null;
}

function cropImageDataUrl(imgEl, dataUrl, rect, ok, err) {
  const img = new Image();
  img.onload = () => {
    try {
      const dW = imgEl.clientWidth || rect.w, dH = imgEl.clientHeight || rect.h;
      const scale = Math.max(dW / img.naturalWidth, dH / img.naturalHeight);
      const sx = (img.naturalWidth - dW / scale) / 2 + rect.x / scale;
      const sy = (img.naturalHeight - dH / scale) / 2 + rect.y / scale;
      const cw = rect.w / scale, ch = rect.h / scale;
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(cw));
      canvas.height = Math.max(1, Math.round(ch));
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, sx, sy, cw, ch, 0, 0, canvas.width, canvas.height);
      const mime = dataUrl.indexOf('image/png') > -1 ? 'image/png' : 'image/jpeg';
      ok(canvas.toDataURL(mime, 0.92));
    } catch (e) { err(e); }
  };
  img.onerror = () => err(new Error('图片加载失败'));
  img.src = dataUrl;
}

async function applyCrop() {
  if (!crop) return;
  const { card, cardEl, box } = crop;
  const imgEl = cardEl.querySelector('.card-img');
  const rect = { x: box.offsetLeft, y: box.offsetTop, w: box.offsetWidth, h: box.offsetHeight };
  exitCrop();
  pushHistory();
  const fullUrl = await resolveMediaUrl(card.data.storageKey) || card.data.dataUrl;
  cropImageDataUrl(imgEl, fullUrl, rect, async (url) => {
    try {
      // 原图保留，在右侧生成一个新的裁剪图片节点
      const thumb = await downscaleDataUrl(url, 720);
      const storageKey = 'img:' + uid();
      const thumbKey = 'thumb:' + storageKey;
      const fullBlob = await makeImageBlob(url, 2400, 0.92);
      await saveMediaBlob(storageKey, fullBlob);
      await saveMediaBlob(thumbKey, dataUrlToBlob(thumb) || await makeImageBlob(thumb, 720, 0.9));
      mediaUrlCache.set(storageKey, URL.createObjectURL(fullBlob));
      const aspect = rect.w / rect.h;
      const h = card.h || 300;
      const w = Math.max(120, Math.round(h * aspect));
      const newCard = {
        id: uid(),
        type: 'image',
        x: card.x + card.w + 40,
        y: card.y,
        w, h,
        data: { name: (card.data.name || '图片') + '（裁剪）', storageKey, thumbKey, size: fullBlob.size, mimeType: 'image/jpeg' },
      };
      state.cards.push(newCard);
      render();
      selected = new Set([newCard.id]);
      updateSelectionUI();
      markDirty();
      toast('已生成裁剪图片');
    } catch (e) {
      toast('裁剪失败：' + (e && e.message ? e.message : e), true);
    }
  }, (e) => {
    toast('裁剪失败：' + (e && e.message ? e.message : e), true);
  });
}


// 双击连线删除
$('#lines').addEventListener('dblclick', (e) => {
  const line = e.target.closest('.conn');
  if (!line) return;
  pushHistory();
  state.connections = state.connections.filter((c) => c.id !== line.dataset.conn);
  render();
  markDirty();
});

// delete connection via hover button
$('#lines').addEventListener('click', (e) => {
  const del = e.target.closest('[data-del]');
  if (!del) return;
  pushHistory();
  state.connections = state.connections.filter((c) => c.id !== del.dataset.del);
  render();
  markDirty();
});

// 便签编辑
$('#cards').addEventListener('input', (e) => {
  if (e.target.classList.contains('card-note-input')) {
    const cardEl = e.target.closest('.card');
    const card = state.cards.find((c) => c.id === cardEl.dataset.id);
    if (card) {
      if (noteEditId !== card.id) { pushHistory(); noteEditId = card.id; }
      card.data.text = e.target.value;
      markDirty();
    }
  }
});
$('#cards').addEventListener('focusout', (e) => {
  if (e.target.classList && e.target.classList.contains('card-note-input')) noteEditId = null;
});

// ---------- 工具栏 ----------
// ＋素材：弹出菜单选择添加类型
$('#btn-add').addEventListener('click', (e) => {
  e.stopPropagation();
  $('#add-menu').classList.toggle('hidden');
});
$('#add-menu').addEventListener('click', (e) => {
  const item = e.target.closest('.add-item');
  if (!item) return;
  $('#add-menu').classList.add('hidden');
  const act = item.dataset.act;
  if (act === 'url') {
    $('#url-input').value = '';
    $('#url-modal').classList.remove('hidden');
    setTimeout(() => $('#url-input').focus(), 50);
  } else if (act === 'text') {
    const center = viewCenter();
    const off3 = slotN++ * 80;
    addCard({
      id: uid(), type: 'text',
      x: center.x - 150 + off3, y: center.y - 110 + off3,
      w: 300, h: 220,
      data: { text: '' },
    });
  } else {
    $('#file-input').accept = act === 'image' ? 'image/*' : act === 'audio' ? 'audio/*' : 'video/*';
    $('#file-input').click();
  }
});
$('#file-input').addEventListener('change', (e) => {
  for (const f of e.target.files) {
    if (f.type.startsWith('image/')) addImageFromFile(f);
    else if (f.type.startsWith('video/')) addVideoFromFile(f);
    else if (f.type.startsWith('audio/')) addAudioFromFile(f);
  }
  e.target.value = '';
});



// ---------- 画布背景 ----------
const BG_PRESETS = {
  default: { name: '默认', colors: ['#ffe9d6', '#fff3e0', '#ffe4e8'] },
  mint:    { name: '清新', colors: ['#d9f5e8', '#e9f6ff', '#f0f8e8'] },
  sunset:  { name: '暖阳', colors: ['#ffe9d6', '#fff3e0', '#ffe4e8'] },
  lilac:   { name: '雾紫', colors: ['#efe4ff', '#e8eaff', '#f6eaff'] },
  ocean:   { name: '海盐', colors: ['#dbefff', '#e2f4ff', '#eaf0ff'] },
  paper:   { name: '纸张', colors: ['#f6f4ee', '#faf8f2', '#efece4'] },
  night:   { name: '暗夜', colors: ['#262a40', '#1e2133', '#2c3048'] },
};

const TEX = (svg) => 'url("data:image/svg+xml,' + encodeURIComponent(svg) + '")';
const BG_TEXTURES = {
  none:  { name: '无',   image: 'none', size: 'auto' },
  dots:  { name: '网点', image: TEX("<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24'><circle cx='3' cy='3' r='1.4' fill='rgba(90,80,160,0.35)'/></svg>"), size: '24px 24px' },
  grid:  { name: '网格', image: TEX("<svg xmlns='http://www.w3.org/2000/svg' width='28' height='28'><path d='M28 0H0V28' fill='none' stroke='rgba(90,80,160,0.18)' stroke-width='1'/></svg>"), size: '28px 28px' },
  lines: { name: '斜纹', image: TEX("<svg xmlns='http://www.w3.org/2000/svg' width='26' height='26'><path d='M0 26L26 0' stroke='rgba(90,80,160,0.16)' stroke-width='1'/></svg>"), size: '26px 26px' },
  noise: { name: '噪点', image: TEX("<svg xmlns='http://www.w3.org/2000/svg' width='140' height='140'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix type='matrix' values='0 0 0 0 0.45 0 0 0 0 0.4 0 0 0 0 0.8 0 0 0 0.14 0'/></filter><rect width='140' height='140' filter='url(#n)'/></svg>"), size: '140px 140px' },
};

function currentBg() {
  const p = currentProject();
  return Object.assign(
    { id: 'default', color: null, texture: 'grid', image: null, texData: null },
    (p && p.bg) || {}
  );
}

function fileToBgDataUrl(file, maxDim, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      try {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        // 带透明通道的图片（如透明底纹理）必须导出 PNG，否则透明区域会被压成黑色
        let hasAlpha = false;
        try {
          const px = ctx.getImageData(0, 0, w, h).data;
          for (let i = 3; i < px.length; i += 4) {
            if (px[i] < 255) { hasAlpha = true; break; }
          }
        } catch {}
        resolve(hasAlpha ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', quality));
      } catch (e) {
        URL.revokeObjectURL(url);
        reject(e);
      }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片读取失败')); };
    img.src = url;
  });
}

function applyProjectBg() {
  const bg = currentBg();
  const root = document.documentElement.style;
  if (bg.id === 'custom' && bg.color) {
    root.setProperty('--bg1', bg.color);
    root.setProperty('--bg2', bg.color);
    root.setProperty('--bg3', bg.color);
  } else {
    const preset = BG_PRESETS[bg.id] || BG_PRESETS.default;
    root.setProperty('--bg1', preset.colors[0]);
    root.setProperty('--bg2', preset.colors[1]);
    root.setProperty('--bg3', preset.colors[2]);
  }
  root.setProperty('--bg-image', bg.image ? 'url("' + bg.image + '")' : 'none');
  root.setProperty('--bg-size', bg.image ? 'cover' : 'auto');
  let texImage = 'none', texSize = 'auto';
  if (bg.texture === 'custom' && bg.texData) {
    texImage = 'url("' + bg.texData + '")';
    texSize = 'auto';
  } else {
    const tex = BG_TEXTURES[bg.texture] || BG_TEXTURES.none;
    texImage = tex.image;
    texSize = tex.size;
  }
  root.setProperty('--texture-image', texImage);
  root.setProperty('--texture-size', texSize);
  updateBgMenuState();
}

function renderBgMenu() {
  const grid = $('#bg-grid');
  if (grid) {
    grid.innerHTML = Object.entries(BG_PRESETS).map(([id, p]) =>
      '<button class="bg-swatch" data-bg="' + id + '" title="' + p.name + '" style="background:linear-gradient(135deg,' + p.colors[0] + ',' + p.colors[1] + ',' + p.colors[2] + ')"></button>'
    ).join('');
  }
  const tgrid = $('#bg-textures');
  if (tgrid) {
    tgrid.innerHTML = Object.entries(BG_TEXTURES).map(([id, t]) => {
      const style = t.image === 'none'
        ? 'background:#f2f0fa'
        : 'background-image:' + t.image + ';background-size:' + t.size + ';background-color:#f2f0fa';
      return '<button class="bg-swatch tex-swatch" data-tex="' + id + '" title="' + t.name + '" style="' + style + '"></button>';
    }).join('');
  }
}

function updateBgMenuState() {
  const bg = currentBg();
  const grid = $('#bg-grid');
  if (grid) grid.querySelectorAll('.bg-swatch').forEach((b) => b.classList.toggle('active', b.dataset.bg === bg.id));
  const tgrid = $('#bg-textures');
  if (tgrid) tgrid.querySelectorAll('.tex-swatch').forEach((b) => b.classList.toggle('active', b.dataset.tex === bg.texture));
  const custom = $('#bg-custom');
  if (custom) custom.value = bg.color || BG_PRESETS.default.colors[0];
  const imgThumb = $('#bg-image-thumb'), imgClear = $('#bg-clear-image'), imgPick = $('#bg-pick-image');
  if (imgThumb && imgPick) {
    const has = !!bg.image;
    imgThumb.classList.toggle('hidden', !has);
    if (has) imgThumb.style.backgroundImage = 'url("' + bg.image + '")';
    imgPick.textContent = has ? '更换' : '选择图片';
    if (imgClear) imgClear.classList.toggle('hidden', !has);
  }
  const texThumb = $('#bg-tex-thumb'), texClear = $('#bg-clear-tex'), texPick = $('#bg-pick-tex');
  if (texThumb && texPick) {
    const has = bg.texture === 'custom' && !!bg.texData;
    texThumb.classList.toggle('hidden', !has);
    if (has) texThumb.style.backgroundImage = 'url("' + bg.texData + '")';
    texPick.textContent = has ? '更换' : '选择纹理';
    if (texClear) texClear.classList.toggle('hidden', !has);
  }
}

function setCanvasBg(patch) {
  const p = currentProject();
  if (!p) return;
  p.bg = Object.assign(
    { id: 'default', color: null, texture: 'grid', image: null, texData: null },
    p.bg || {},
    patch
  );
  p.updatedAt = Date.now();
  applyProjectBg();
  markDirty();
}

$('#bg-grid').addEventListener('click', (e) => {
  const sw = e.target.closest('.bg-swatch');
  if (!sw) return;
  setCanvasBg({ id: sw.dataset.bg, color: null });
  $('#bg-menu').classList.add('hidden');
});
$('#bg-textures').addEventListener('click', (e) => {
  const sw = e.target.closest('.tex-swatch');
  if (!sw) return;
  setCanvasBg({ texture: sw.dataset.tex });
});
$('#bg-custom').addEventListener('input', (e) => {
  setCanvasBg({ id: 'custom', color: e.target.value });
});
$('#bg-pick-image').addEventListener('click', () => $('#bg-file-image').click());
$('#bg-file-image').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const dataUrl = await fileToBgDataUrl(f, 1600, 0.8);
    setCanvasBg({ image: dataUrl });
    toast('背景图片已设置');
  } catch (err) {
    toast('背景图片读取失败', true);
  }
});
$('#bg-clear-image').addEventListener('click', () => setCanvasBg({ image: null }));
$('#bg-pick-tex').addEventListener('click', () => $('#bg-file-tex').click());
$('#bg-file-tex').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const dataUrl = await fileToBgDataUrl(f, 256, 0.85);
    setCanvasBg({ texture: 'custom', texData: dataUrl });
    toast('自定义纹理已设置');
  } catch (err) {
    toast('自定义纹理读取失败', true);
  }
});
$('#bg-clear-tex').addEventListener('click', () => setCanvasBg({ texture: 'none', texData: null }));

// 更多菜单：撤销 / 重做 / 保存 / 导入 / 导出
$('#btn-more').addEventListener('click', (e) => {
  e.stopPropagation();
  $('#more-menu').classList.toggle('hidden');
});
$('#more-menu').addEventListener('click', (e) => {
  const item = e.target.closest('.add-item');
  if (!item || item.disabled) return;
  $('#more-menu').classList.add('hidden');
  const act = item.dataset.act;
  if (act === 'new-canvas') createProject();
  else if (act === 'rename-canvas') openRenameCanvas();
  else if (act === 'del-canvas') {
    const p = currentProject();
    if (!p) return;
    $('#canvas-del-title').textContent = p.title || '未命名';
    $('#canvas-del-modal').classList.remove('hidden');
  }
  else if (act === 'undo') undo();
  else if (act === 'redo') redo();
  else if (act === 'save') { save(); toast('已保存到本地'); }
  else if (act === 'import') $('#import-file').click();
  else if (act === 'export') exportCanvas().catch(() => {
    $('#loading-mask').classList.add('hidden');
    toast('导出失败', true);
  });
  else if (act === 'ai-canvas') aiSeeCanvas();
  else if (act === 'ai-config') openAiSettings();
  else if (act === 'bg') {
    renderBgMenu();
    updateBgMenuState();
    $('#bg-menu').classList.remove('hidden');
  }
  else if (act === 'onboard') showOnboarding();
  else if (act === 'contact') {
    navigator.clipboard.writeText('moment-1968').then(
      () => toast('微信号 moment-1968 已复制，微信搜索即可联系我'),
      () => toast('联系我 · 微信：moment-1968')
    );
  }
});

// AI 模型设置
function openAiSettings() {
  $('#ai-model-input').value = aiConfig.model || '';
  $('#ai-base-input').value = aiConfig.baseUrl || '';
  $('#ai-key-input').value = aiConfig.apiKey || '';
  $('#ai-test-status').textContent = '';
  $('#ai-test-status').classList.remove('ok');
  fetch(API_BASE + '/api/ai-config').then((r) => r.json()).then((j) => {
    if (!j || !j.ok) return;
    if (!aiConfig.baseUrl) $('#ai-base-input').placeholder = j.baseUrl || 'https://dashscope.aliyuncs.com/compatible-mode/v1';
    if (!aiConfig.model) $('#ai-model-input').placeholder = j.model || 'qwen3.5-omni-plus';
    $('#ai-test-status').textContent = j.hasKey ? '服务端已配置 Key，留空可复用' : '服务端未配置 Key，请在下方填写';
  }).catch(() => {});
  $('#ai-cfg-modal').classList.remove('hidden');
}
$('#ai-cfg-ok').addEventListener('click', () => {
  aiConfig = {
    baseUrl: $('#ai-base-input').value.trim(),
    apiKey: $('#ai-key-input').value.trim(),
    model: $('#ai-model-input').value.trim(),
  };
  saveAiConfig();
  $('#ai-cfg-modal').classList.add('hidden');
  toast('AI 模型设置已保存');
});
$('#ai-cfg-cancel').addEventListener('click', () => $('#ai-cfg-modal').classList.add('hidden'));
$('#ai-model-preset').addEventListener('change', () => {
  const v = $('#ai-model-preset').value;
  if (v) $('#ai-model-input').value = v;
});
$('#ai-test-btn').addEventListener('click', async () => {
  const status = $('#ai-test-status');
  status.classList.remove('ok');
  status.textContent = '测试中…';
  try {
    const res = await fetch(API_BASE + '/api/ai-test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseUrl: $('#ai-base-input').value.trim(),
        apiKey: $('#ai-key-input').value.trim(),
        model: $('#ai-model-input').value.trim(),
      }),
    });
    const j = await res.json();
    if (j.ok) { status.classList.add('ok'); status.textContent = '连接成功：' + (j.reply || 'OK'); }
    else status.textContent = '失败：' + (j.error || '未知错误');
  } catch (err) {
    status.textContent = '失败：' + err.message;
  }
});

// 导出 / 导入画布（导出会把视频、音频素材一并打包进 JSON）
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

function dataUrlToBlob(dataUrl) {
  const [head, b64] = String(dataUrl).split(',');
  const mime = (head.match(/data:([^;]+)/) || [])[1] || 'application/octet-stream';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

async function exportCanvas() {
  const projects = state.projects.map((p) => ({
    id: p.id, title: p.title,
    cards: (p.cards || []).map((c) => ({ ...c, data: c.data ? { ...c.data } : c.data })),
    connections: (p.connections || []).map((cn) => ({ ...cn })),
    view: p.view ? { ...p.view } : { x: 60, y: 60, s: 1 },
    bg: p.bg ? { ...p.bg } : undefined,
  }));
  const media = {};
  const mediaCards = projects.flatMap((p) => p.cards)
    .filter((c) => c.data && ((['video', 'audio', 'image'].includes(c.type) && c.data.storageKey) || (c.type === 'url' && c.data.thumbKey)));
  if (mediaCards.length) {
    $('#loading-mask').classList.remove('hidden');
    $('#loading-text').textContent = '正在打包素材…';
    try {
      for (const c of mediaCards) {
        const d = c.data || {};
        const k = d.storageKey;
        const tk = d.thumbKey;
        try {
          if (k && !media[k]) {
            const blob = await loadMediaBlob(k);
            if (blob) media[k] = await blobToDataUrl(blob);
          }
          if (tk && !media[tk]) {
            const tb = await loadMediaBlob(tk);
            if (tb) media[tk] = await blobToDataUrl(tb);
          }
        } catch { /* 单个素材读取失败不阻塞导出 */ }
      }
    } finally {
      $('#loading-mask').classList.add('hidden');
    }
  }
  const payload = {
    app: 'liuguang',
    version: 2,
    exportedAt: new Date().toISOString(),
    projects,
    ...(Object.keys(media).length ? { media } : {}),
  };
  const fileName = 'liuguang-' + new Date().toISOString().slice(0, 10) + (projects.length === 1 ? '-' + (projects[0].title || '画布') : '') + '.json';
  if (isDesktop()) {
    try {
      const res = await tauriInvoke('save_canvas_file', { name: fileName, content: JSON.stringify(payload) });
      if (res && res.ok) toast(res.message || '已导出画布');
      else toast((res && res.error) || '导出失败', true);
    } catch (err) {
      toast('导出失败：' + (err.message || err), true);
    }
    return;
  }
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000); // 等下载启动后再释放
  toast('已导出「' + fileName + '」到浏览器下载目录' + (Object.keys(media).length ? '（含素材）' : ''));
}
// 导入：选择文件 → 确认 → 追加到画布列表并打开
let pendingImport = null;

function sourceProjectsOf(data) {
  if (Array.isArray(data.projects) && data.projects.length) return data.projects;
  if (Array.isArray(data.cards)) return [{ title: '导入的画布', cards: data.cards, connections: data.connections, view: data.view }];
  return null;
}

$('#import-file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    const sourceProjects = sourceProjectsOf(data);
    if (!sourceProjects) throw new Error('不是有效的画布文件');
    pendingImport = data;
    const mediaKeys = new Set(Object.keys(data.media || {}));
    let cardTotal = 0, connTotal = 0, missingTotal = 0;
    for (const sp of sourceProjects) {
      if (!sp || !Array.isArray(sp.cards)) continue;
      cardTotal += sp.cards.length;
      connTotal += (sp.connections || []).length;
      missingTotal += sp.cards.filter((c) =>
        (c.type === 'video' || c.type === 'audio') && c.data && c.data.storageKey && !mediaKeys.has(c.data.storageKey)).length;
    }
    let html = `文件包含 <b>${sourceProjects.length}</b> 张画布，共 <b>${cardTotal}</b> 张卡片、<b>${connTotal}</b> 条连线。`;
    if (mediaKeys.size) html += '<br>已附带图片 / 视频 / 音频素材。';
    else if (missingTotal) html += `<br>其中 <b>${missingTotal}</b> 张视频 / 音频卡片未附带素材，导入后会显示占位。`;
    $('#import-summary').innerHTML = html;
    $('#import-modal').classList.remove('hidden');
  } catch (err) {
    toast('导入失败：' + err.message, true);
  }
});

$('#import-cancel').addEventListener('click', () => {
  pendingImport = null;
  $('#import-modal').classList.add('hidden');
});

$('#import-ok').addEventListener('click', async () => {
  const data = pendingImport;
  pendingImport = null;
  $('#import-modal').classList.add('hidden');
  if (!data) return;
  try {
    await applyImport(data);
  } catch (err) {
    toast('导入失败：' + err.message, true);
  }
});

const CARD_TYPES = ['url', 'image', 'video', 'audio', 'text', 'note', 'ai', 'file'];

async function applyImport(data) {
  // 先把附带素材写进 IndexedDB，再追加画布
  const mediaMap = data.media || {};
  for (const key of Object.keys(mediaMap)) {
    try {
      const raw = mediaMap[key];
      const dataUrl = typeof raw === 'string' ? raw : (raw.dataUrl || raw.src || '');
      if (!dataUrl) continue;
      const blob = dataUrlToBlob(dataUrl);
      await saveMediaBlob(key, blob);
      const old = mediaUrlCache.get(key);
      if (old) URL.revokeObjectURL(old);
      mediaUrlCache.set(key, URL.createObjectURL(blob));
    } catch { /* 单个素材失败不阻塞导入 */ }
  }
  const sourceProjects = sourceProjectsOf(data) || [];
  const addedIds = [];
  for (const sp of sourceProjects) {
    if (!sp || !Array.isArray(sp.cards)) continue;
    const cards = sp.cards.map((c) => ({
      id: String(c.id || uid()),
      type: CARD_TYPES.includes(c.type) ? c.type : 'text',
      x: Number(c.x) || 0,
      y: Number(c.y) || 0,
      w: Number(c.w) || 260,
      h: c.h != null ? Number(c.h) : undefined,
      data: c.data && typeof c.data === 'object' ? { ...c.data } : {},
    }));
    // 媒体不可用的视频 / 音频卡片标记为占位
    for (const c of cards) {
      const d = c.data;
      if (c.type !== 'video' && c.type !== 'audio') continue;
      if (d.storageKey) {
        if (mediaUrlCache.has(d.storageKey)) continue;
        try {
          if (!(await loadMediaBlob(d.storageKey))) { d.lost = true; delete d.storageKey; }
        } catch { d.lost = true; delete d.storageKey; }
      } else if (d.url && d.url.startsWith('blob:')) {
        d.url = null;
        d.lost = true;
      }
    }
    const pid = uid();
    const now = Date.now();
    state.projects.push({
      id: pid,
      title: (sp.title || '').trim() || '导入的画布',
      cards,
      connections: (sp.connections || [])
        .filter((cn) => cn && cn.from && cn.to)
        .map((cn) => ({ id: String(cn.id || uid()), from: String(cn.from), to: String(cn.to) })),
      view: sp.view && typeof sp.view === 'object' ? { ...sp.view } : { x: 60, y: 60, s: 1 },
      createdAt: now, updatedAt: now,
    });
    addedIds.push(pid);
  }
  if (!addedIds.length) throw new Error('文件中没有可导入的画布');
  // 导入文件里可能内嵌 base64 图片 / 网页封面，先搬进 IndexedDB 再保存，避免 localStorage 超限
  await migrateImageCardsToIDB();
  await migrateUrlCoversToIDB();
  updateCanvasSelect();
  markDirty();
  if (addedIds.length === 1) {
    switchProject(addedIds[0], true);
    toast('已导入画布「' + ((currentProject() || {}).title || '') + '」');
  } else {
    toast('已导入 ' + addedIds.length + ' 张画布');
  }
}

// ---------- 多画布工具栏 ----------
$('#canvas-select').addEventListener('change', (e) => switchProject(e.target.value));
// 双击画布名字直接重命名
function openRenameCanvas() {
  const p = currentProject();
  if (!p) return;
  $('#canvas-rename-input').value = p.title;
  $('#canvas-rename-modal').classList.remove('hidden');
  setTimeout(() => $('#canvas-rename-input').focus(), 50);
}
$('#canvas-select').addEventListener('dblclick', (e) => {
  e.preventDefault();
  openRenameCanvas();
});

$('#canvas-rename-cancel').addEventListener('click', () => $('#canvas-rename-modal').classList.add('hidden'));
$('#canvas-rename-ok').addEventListener('click', () => {
  const p = currentProject();
  if (p) renameProject(p.id, $('#canvas-rename-input').value);
  $('#canvas-rename-modal').classList.add('hidden');
});
$('#canvas-rename-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#canvas-rename-ok').click(); });

$('#canvas-del-cancel').addEventListener('click', () => $('#canvas-del-modal').classList.add('hidden'));
$('#canvas-del-ok').addEventListener('click', () => {
  const p = currentProject();
  $('#canvas-del-modal').classList.add('hidden');
  if (p) deleteProject(p.id);
});
// URL 弹窗（输入网址自动抓取添加；卡片上可直接编辑）
let urlEditingId = null;  // 正在卡片内编辑的网页卡片 id
let urlEditTarget = null; // 正在上传图片的网页卡片

$('#url-cancel').addEventListener('click', () => $('#url-modal').classList.add('hidden'));

async function submitUrl() {
  const url = $('#url-input').value.trim();
  if (!/^https?:\/\//i.test(url)) { toast('请输入以 http:// 或 https:// 开头的网址', true); return; }
  $('#url-modal').classList.add('hidden');
  await addUrl(url);
}
$('#url-ok').addEventListener('click', submitUrl);
$('#url-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitUrl(); });

// 卡片内编辑：上传图标 / 封面
function readImageFile(file, maxSize) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async () => {
      try { resolve(await downscaleDataUrl(reader.result, maxSize)); }
      catch (e) { reject(e); }
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
$('#card-icon-file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f || !f.type.startsWith('image/')) return;
  try {
    const dataUrl = await readImageFile(f, 256);
    if (urlEditTarget) { pushHistory(); urlEditTarget.data.icon = dataUrl; render(); markDirty(); }
  } catch { toast('读取图标失败', true); }
});
$('#card-thumb-file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f || !f.type.startsWith('image/')) return;
  try {
    const dataUrl = await readImageFile(f, 1600);
    if (urlEditTarget) {
      pushHistory();
      try { await setUrlCover(urlEditTarget, dataUrl, 1600); }
      catch { urlEditTarget.data.thumb = dataUrl; }
      render(); markDirty();
    }
  } catch { toast('读取封面失败', true); }
});

// 缩放按钮
$('#zoom-in').addEventListener('click', () => zoomAt(innerWidth / 2, innerHeight / 2, 1.25));
$('#zoom-out').addEventListener('click', () => zoomAt(innerWidth / 2, innerHeight / 2, 0.8));
$('#zoom-fit').addEventListener('click', () => { zoomFit(); saveSoon(); });

// 筛选（顶部「筛选」按钮弹出菜单）
const FILTER_NAMES = { all: '全部', url: '网页', image: '图片', video: '视频', text: '文字', audio: '音频' };
function setFilter(f) {
  document.body.dataset.filter = f;
  $$('#filter-menu .add-item').forEach((c) => c.classList.toggle('active', c.dataset.filter === f));
  $('#btn-filter').classList.toggle('has-filter', f !== 'all');
  $('#filter-label').textContent = f === 'all' ? '筛选' : '筛选 · ' + (FILTER_NAMES[f] || f);
}
$('#btn-filter').addEventListener('click', (e) => {
  e.stopPropagation();
  $('#filter-menu').classList.toggle('hidden');
});
$('#filter-menu').addEventListener('click', (e) => {
  const item = e.target.closest('.add-item');
  if (!item) return;
  setFilter(item.dataset.filter);
  $('#filter-menu').classList.add('hidden');
});
setFilter('all');

// 快捷键
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const open = document.querySelector('.modal-backdrop:not(.hidden)');
    if (open) open.classList.add('hidden');
  }
});

// 粘贴图片 / URL
document.addEventListener('paste', async (e) => {
  const items = e.clipboardData?.items || [];
  let handled = false;
  for (const item of items) {
    if (item.type.startsWith('image/') || item.type.startsWith('video/') || item.type.startsWith('audio/')) {
      const file = item.getAsFile();
      if (file) {
        if (item.type.startsWith('image/')) addImageFromFile(file);
        else if (item.type.startsWith('video/')) addVideoFromFile(file);
        else addAudioFromFile(file);
        handled = true;
      }
    }
  }
  const editingField = e.target && e.target.closest && e.target.closest('input, textarea, [contenteditable="true"]');
  if (!handled && !editingField) {
    const text = e.clipboardData.getData('text') || '';
    const trimmed = text.trim();
    if (/^https?:\/\/[^\s]+$/.test(trimmed)) {
      $('#url-input').value = trimmed;
      $('#url-modal').classList.remove('hidden');
      setTimeout(() => $('#url-input').focus(), 50);
      handled = true;
    } else if (trimmed) {
      addTextFromClipboard(text);
      handled = true;
    }
  }
  if (handled) e.preventDefault();
});

// 屏蔽卡片自身的原生拖拽（防止图片/文字被浏览器接管导致卡片拖不动）
document.addEventListener('dragstart', (e) => {
  if (e.target.closest && e.target.closest('.card')) e.preventDefault();
});

// 拖放素材：全局接收文件 / URL，带高亮反馈（桌面版需 dragDropEnabled:false 才走 HTML5 拖放）
function sniffFileKind(f) {
  if (f.type.startsWith('image/')) return 'image';
  if (f.type.startsWith('video/')) return 'video';
  if (f.type.startsWith('audio/')) return 'audio';
  const ext = (f.name || '').split('.').pop().toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg', 'ico', 'heic'].includes(ext)) return 'image';
  if (['mp4', 'webm', 'mov', 'm4v', 'mkv', 'avi', 'ogv'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac', 'opus', 'wma'].includes(ext)) return 'audio';
  if (['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'pdf'].includes(ext)) return 'file';
  return null;
}
function dropHasFiles(e) {
  return e.dataTransfer && Array.from(e.dataTransfer.types || []).some((t) => t === 'Files' || t === 'text/uri-list');
}
let dropDepth = 0;
document.addEventListener('dragenter', (e) => {
  if (!dropHasFiles(e)) return;
  e.preventDefault();
  dropDepth++;
  document.body.classList.add('drop-active');
});
document.addEventListener('dragover', (e) => {
  if (!dropHasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
document.addEventListener('dragleave', (e) => {
  if (!dropHasFiles(e)) return;
  dropDepth = Math.max(0, dropDepth - 1);
  if (dropDepth === 0) document.body.classList.remove('drop-active');
});
document.addEventListener('drop', (e) => {
  if (!dropHasFiles(e)) return;
  e.preventDefault();
  dropDepth = 0;
  document.body.classList.remove('drop-active');
  const files = Array.from(e.dataTransfer?.files || []);
  let added = 0;
  const unsupported = [];
  for (const f of files) {
    const kind = sniffFileKind(f);
    if (kind === 'image') { addImageFromFile(f); added++; }
    else if (kind === 'video') { addVideoFromFile(f); added++; }
    else if (kind === 'audio') { addAudioFromFile(f); added++; }
    else if (kind === 'file') { addFileFromFile(f); added++; }
    else unsupported.push(f.name || '未知文件');
  }
  const uri = e.dataTransfer?.getData('text/uri-list') || e.dataTransfer?.getData('text/plain') || '';
  const m = uri.match(/https?:\/\/[^\s]+/);
  if (m) { addUrl(m[0]); added++; }
  if (unsupported.length) toast('不支持的文件类型：' + unsupported.join('、'), true);
  else if (!added && files.length) toast('没有可添加的内容', true);
});

// 帮助弹层（顶部 ? 按钮）
function positionHelpPop() {
  const pop = $('#help-pop');
  if (pop.classList.contains('hidden')) return;
  const tb = document.querySelector('.toolbar').getBoundingClientRect();
  pop.style.top = Math.max(8, tb.bottom + 8) + 'px';
}
$('#btn-help').addEventListener('click', (e) => {
  e.stopPropagation();
  const pop = $('#help-pop');
  const willShow = pop.classList.contains('hidden');
  pop.classList.toggle('hidden');
  if (willShow) positionHelpPop();
});

window.addEventListener('resize', positionHelpPop);
document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('#help-pop') && !e.target.closest('#btn-help')) $('#help-pop').classList.add('hidden');
  if (!e.target.closest('#add-menu') && !e.target.closest('#btn-add')) $('#add-menu').classList.add('hidden');
  if (!e.target.closest('#filter-menu') && !e.target.closest('#btn-filter')) $('#filter-menu').classList.add('hidden');
  if (!e.target.closest('#more-menu') && !e.target.closest('#btn-more')) $('#more-menu').classList.add('hidden');
  if (!e.target.closest('#bg-menu')) $('#bg-menu').classList.add('hidden');
});
// ---------- 新手引导 ----------
const ONBOARD_KEY = 'luminous:onboarding:v1';
const obCur = (cls) => `<svg class="ob-cur ${cls}" viewBox="0 0 24 24"><path d="M5 3l14 8-6.5 1.5L16 19l-2.5 1.5L9.5 13 5 17z" fill="#fff" stroke="#3a3f58" stroke-width="1.3" stroke-linejoin="round"/></svg>`;
const ONBOARD_STEPS = [
  {
    title: '欢迎来到 流光',
    text: '一张<b>无限延伸</b>的灵感画布：把你看到的网页、图片、文字、视频、音频都放进来，随手整理、连线、回看。<br>所有素材都保存在<b>本机</b>，关掉页面也不会丢，随时可以导出分享。',
    scene: '<div class="ob-stage ob-welcome"><div class="ob-dots"></div><div class="ob-glow"></div><div class="ob-brand">Luminous</div><svg class="ob-line-svg" viewBox="0 0 480 250" fill="none"><path class="ob-line-path" d="M164 106 C 210 66, 250 140, 292 150"/></svg><div class="ob-card ob-w-img"><div class="ob-thumb"></div><div class="ob-txtline w70"></div></div><div class="ob-card ob-w-txt"><div class="ob-txtline w90"></div><div class="ob-txtline w80"></div><div class="ob-txtline w55"></div><span class="ob-pill">网页</span></div><div class="ob-card ob-w-audio"><div class="ob-abars"><i></i><i></i><i></i><i></i><i></i></div><div class="ob-txtline w60"></div></div></div>',
  },
  {
    title: '添加素材',
    text: '点顶栏「<b>＋素材</b>」选择 图片 / 文字 / 音频 / 视频 / 网页；也可以<b>直接把文件拖进画布</b>，或 Ctrl+V 粘贴截图 / 一段文字。<br>添加网页会自动抓取 logo、标题、简介和封面。',
    scene: '<div class="ob-stage ob-add"><div class="ob-dots"></div><div class="ob-topbar"><span class="ob-tb-brand">Luminous</span><button class="ob-addbtn">＋ 素材</button></div><div class="ob-menu"><div class="ob-menu-item">图片</div><div class="ob-menu-item">文字</div><div class="ob-menu-item">音频</div><div class="ob-menu-item">视频</div><div class="ob-menu-item">网页</div></div><div class="ob-card ob-newcard"><div class="ob-thumb"></div><div class="ob-txtline w70"></div></div>' + obCur('ob-cur-add') + '</div>',
  },
  {
    title: '移动与复制',
    text: '<b>左键拖动</b>卡片移动位置；按住 <b>Alt</b> 再拖出一张 = 复制一份。<br>拖动到画布边缘会自动平移，方便把素材摊开整理。',
    scene: '<div class="ob-stage ob-move"><div class="ob-dots"></div><div class="ob-card ob-mv-card"><div class="ob-thumb"></div><div class="ob-txtline w70"></div></div><div class="ob-card ob-mv-ghost"><div class="ob-thumb"></div><div class="ob-txtline w70"></div></div><div class="ob-keybadge ob-altbadge">Alt</div>' + obCur('ob-cur-mv') + '</div>',
  },
  {
    title: '连线',
    text: '从卡片<b>右侧的小圆点</b>拖到另一张卡片，建立关系线。<br>音频卡连线后会出现「上一首 / 下一首」按钮，按左右 / 上下顺序连续播放。',
    scene: '<div class="ob-stage ob-conn"><div class="ob-dots"></div><div class="ob-card ob-conn-a"><div class="ob-thumb"></div><div class="ob-txtline w70"></div></div><div class="ob-card ob-conn-b"><div class="ob-thumb"></div><div class="ob-txtline w70"></div></div><div class="ob-dot"></div><svg class="ob-conn-svg" viewBox="0 0 480 250" fill="none"><path class="ob-drag-line" d="M178 126 C 224 104, 258 140, 292 148"/><path class="ob-done-line" d="M178 126 C 224 104, 258 140, 292 148"/></svg>' + obCur('ob-cur-conn') + '</div>',
  },
  {
    title: '多选与批量',
    text: '按住 <b>Ctrl</b> 逐张点选，或拖出<b>框选</b>；选中后可整体移动、复制、删除、整组缩放。<br>右键卡片还有「删除 / 复制到画外」。',
    scene: '<div class="ob-stage ob-multi"><div class="ob-dots"></div><div class="ob-card ob-m1"><div class="ob-thumb"></div><div class="ob-txtline w70"></div></div><div class="ob-card ob-m2"><div class="ob-thumb"></div><div class="ob-txtline w70"></div></div><div class="ob-card ob-m3"><div class="ob-thumb"></div><div class="ob-txtline w70"></div></div><div class="ob-keybadge ob-ctrlbadge">Ctrl</div><div class="ob-selbar">已选 3 张 · 可移动 / 删除 / 复制</div>' + obCur('ob-cur-multi') + '</div>',
  },
  {
    title: '视图操作',
    text: '<b>滚轮缩放</b>（5%–500%），左键拖空白处<b>平移</b>；右下角<b>小地图</b>快速定位，点缩放率恢复 100%。<br>「适配画布」一键看到全部素材。',
    scene: '<div class="ob-stage ob-view"><div class="ob-dots"></div><div class="ob-window"><div class="ob-wcards"><div class="ob-card ob-v1"><div class="ob-thumb"></div><div class="ob-txtline w70"></div></div><div class="ob-card ob-v2"><div class="ob-thumb"></div><div class="ob-txtline w70"></div></div></div></div><div class="ob-zoomchip ob-z1">100%</div><div class="ob-zoomchip ob-z2">60%</div><div class="ob-zoomchip ob-z3">160%</div><div class="ob-minimap"><div class="ob-mm-card"></div><div class="ob-mm-card mm2"></div><div class="ob-mm-view"></div></div></div>',
  },
  {
    title: '编辑与 AI',
    text: '<b>双击文字卡</b>直接在卡片里输入，字号随卡片大小缩放。<br>图片卡点击浮现工具栏：<b>AI 分析</b>生成设计关键词、<b>裁剪</b>后自动开新节点；⋯ 菜单还有「AI 看画布」。',
    scene: '<div class="ob-stage ob-edit"><div class="ob-dots"></div><div class="ob-card ob-ed-txt"><div style="display:flex;align-items:center;gap:2px"><span class="ob-ed-line">双击编辑文字…</span><div class="ob-caret"></div></div><div class="ob-type-line"></div></div><div class="ob-card ob-ed-img"><div class="ob-thumb"></div><div class="ob-txtline w70"></div></div><div class="ob-toolbar"><span class="ob-tb-item">✂ 裁剪</span><span class="ob-tb-item">✨ AI 分析</span></div><div class="ob-cropframe"></div>' + obCur('ob-cur-edit') + '</div>',
  },
  {
    title: '数据与分享',
    text: '所有改动<b>自动保存</b>到本机浏览器，刷新、关掉都不丢。<br>⋯ → <b>导出</b>（JSON 含素材文件），发给别人即可<b>导入</b>打开，导入后自动成为新画布。',
    scene: '<div class="ob-stage ob-data"><div class="ob-dots"></div><div class="ob-card ob-d-card"><div class="ob-thumb"></div><div class="ob-txtline w70"></div></div><div class="ob-savechip">自动保存</div><div class="ob-folder"></div><div class="ob-file ob-export-file">canvas.json</div><div class="ob-file ob-import-file">canvas.json</div><div class="ob-card ob-d-newcard"><div class="ob-thumb"></div><div class="ob-txtline w70"></div></div>' + obCur('ob-cur-data') + '</div>',
  },
  {
    title: '快捷键',
    text: '常用快捷键一览，操作快一倍：<b>Ctrl+Z</b> 撤销 · <b>Ctrl+Y</b> 重做 · <b>Ctrl+S</b> 保存 · <b>Ctrl+O</b> 导入 · <b>Ctrl+E</b> 导出 · <b>Ctrl+N</b> 新建画布 · <b>Ctrl+V</b> 粘贴。',
    scene: '<div class="ob-stage ob-keys"><div class="ob-dots"></div><div class="ob-keyrow"><div class="ob-key" style="animation-delay:0s"><kbd>Ctrl</kbd><b>+</b><kbd>Z</kbd><span>撤销</span></div><div class="ob-key" style="animation-delay:1s"><kbd>Ctrl</kbd><b>+</b><kbd>Y</kbd><span>重做</span></div><div class="ob-key" style="animation-delay:2s"><kbd>Ctrl</kbd><b>+</b><kbd>S</kbd><span>保存</span></div><div class="ob-key" style="animation-delay:3s"><kbd>Ctrl</kbd><b>+</b><kbd>O</kbd><span>导入</span></div></div><div class="ob-keyrow"><div class="ob-key" style="animation-delay:4s"><kbd>Ctrl</kbd><b>+</b><kbd>E</kbd><span>导出</span></div><div class="ob-key" style="animation-delay:5s"><kbd>Ctrl</kbd><b>+</b><kbd>N</kbd><span>新建画布</span></div><div class="ob-key" style="animation-delay:6s"><kbd>Ctrl</kbd><b>+</b><kbd>V</kbd><span>粘贴</span></div><div class="ob-key" style="animation-delay:7s"><kbd>Alt</kbd><b>+</b><span>拖拽复制</span></div></div></div>',
  },
];
let onboardIdx = 0;
function renderOnboard() {
  const step = ONBOARD_STEPS[onboardIdx];
  $('#onboard-title').textContent = step.title;
  $('#onboard-text').innerHTML = step.text;
  $('#onboard-demo').innerHTML = step.scene;
  $('#onboard-next').textContent = onboardIdx === ONBOARD_STEPS.length - 1 ? '开始使用' : '下一步';
  $('#onboard-prev').disabled = onboardIdx === 0;
  $$('#onboard-dots .ob-dot').forEach((d, i) => d.classList.toggle('on', i === onboardIdx));
}
function goOnboard(i) {
  onboardIdx = Math.max(0, Math.min(ONBOARD_STEPS.length - 1, i));
  renderOnboard();
}
function showOnboarding() {
  goOnboard(0);
  $('#onboard').classList.remove('hidden');
}
function closeOnboarding() {
  $('#onboard').classList.add('hidden');
  try { if ($('#onboard-noauto').checked) localStorage.setItem(ONBOARD_KEY, '1'); } catch {}
}
$('#onboard-dots').innerHTML = ONBOARD_STEPS.map(() => '<div class="ob-dot"></div>').join('');
$('#onboard-prev').addEventListener('click', () => goOnboard(onboardIdx - 1));
$('#onboard-next').addEventListener('click', () => {
  if (onboardIdx < ONBOARD_STEPS.length - 1) goOnboard(onboardIdx + 1);
  else closeOnboarding();
});
$('#onboard-skip').addEventListener('click', closeOnboarding);
$('#onboard').addEventListener('pointerdown', (e) => { if (e.target.id === 'onboard') closeOnboarding(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#onboard').classList.contains('hidden')) closeOnboarding();
});
// ---------- 启动 ----------
const hasData = load();
// 一次性迁移：清理旧版「欢迎使用 流光 ✨」文字卡（新版已不再创建，历史画布里可能残留）
try {
  if (!localStorage.getItem('luminous:migrate:welcome-v1')) {
    let removedWelcome = 0;
    state.projects.forEach((p) => {
      p.cards = (p.cards || []).filter((c) => {
        if (c.type === 'text' && c.data && String(c.data.text || '').indexOf('欢迎使用 流光') === 0) { removedWelcome++; return false; }
        return true;
      });
    });
    if (removedWelcome) markDirty();
    localStorage.setItem('luminous:migrate:welcome-v1', '1');
  }
} catch (e) {}

if (!state.projects.length) {
  const pid = uid();
  state.projects.push({ id: pid, title: '画布 1', cards: [], connections: [], view: { x: 60, y: 60, s: 1 }, bg: { id: 'default', color: null }, createdAt: Date.now(), updatedAt: Date.now() });
  state.activeId = pid;
}
updateCanvasSelect();
applyProjectBg();
applyView();
render();
if (hasData) zoomFit();

// 首次使用自动弹出新手引导（可随时在 ⋯ 菜单重新查看）
try { if (!localStorage.getItem(ONBOARD_KEY)) setTimeout(showOnboarding, 500); } catch {}

// 兼容旧数据：刷新后 blob 临时链接失效的旧卡片重置为占位（新数据已存 IndexedDB，无需处理）
const lostMedia = state.cards.filter((c) => (c.type === 'video' || c.type === 'audio') && c.data.url && c.data.url.startsWith('blob:'));
if (lostMedia.length) {
  lostMedia.forEach((c) => { c.data.url = null; c.data.lost = true; });
  markDirty();
  setTimeout(() => toast('旧的大文件视频/音频已失效，请重新拖入'), 800);
}
// 启动时清理 IndexedDB 里已不被任何卡片引用的媒体文件
cleanupOrphanMedia();
// 启动时清理已不被任何卡片引用的文档副本
cleanupOrphanOfficeFiles();
// 迁移旧数据：把图片本体/缩略图与网页封面存入 IndexedDB，localStorage 只留元数据
migrateImageCardsToIDB();
migrateUrlCoversToIDB();

// 注入筛选 CSS
const style = document.createElement('style');
style.textContent = `
body[data-filter="url"] .card:not(.t-url){display:none}
body[data-filter="image"] .card:not(.t-image){display:none}
body[data-filter="video"] .card:not(.t-video){display:none}
body[data-filter="text"] .card:not(.t-text):not(.t-note){display:none}
body[data-filter="audio"] .card:not(.t-audio){display:none}
`;
document.head.appendChild(style);

// ---------- 演示模式（?demo=1 且画布为空时自动加入示例图片） ----------
if (new URLSearchParams(location.search).has('demo') && !hasData) {
  (async () => {
    try {
      const res = await fetch(API_BASE + '/demo-apple.jpg');
      const blob = await res.blob();
      const dataUrl = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = reject;
        fr.readAsDataURL(blob);
      });
      const small = await downscaleDataUrl(dataUrl);
      const center = viewCenter();
      addCard({
        id: uid(), type: 'image',
        x: center.x - 460, y: center.y - 120,
        w: 240, h: 300,
        data: { name: 'demo-apple.jpg', dataUrl: small },
      });
      zoomFit();
    } catch (e) {
      console.error('demo 素材加载失败', e);
    }
  })();
}

// ---------- 重置模式（?reset=1 清空并重新加载演示） ----------
if (new URLSearchParams(location.search).has('reset')) {
  try { localStorage.removeItem(STORE_KEY); } catch {}
  location.search = '?demo=1';
}













// ---------- 自测（?test=1 模拟拖拽连线） ----------
if (new URLSearchParams(location.search).has('test')) {
  setTimeout(() => {
    try {
      const q = new URLSearchParams(location.search);
      const iFrom = Number(q.get('from') || 0);
      const iTo = Number(q.get('to') || 1);
      const els = document.querySelectorAll('.card');
      if (els.length <= Math.max(iFrom, iTo)) return;
      const handle = els[iFrom].querySelector('.conn-handle');
      const target = els[iTo];
      const r1 = handle.getBoundingClientRect();
      const r2 = target.getBoundingClientRect();
      const ev = (type, x, y) => new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: 99, pointerType: 'mouse',
        clientX: x, clientY: y, button: 0, buttons: 1,
      });
      handle.dispatchEvent(ev('pointerdown', r1.left + r1.width / 2, r1.top + r1.height / 2));
      document.dispatchEvent(ev('pointermove', (r1.left + r2.left) / 2, (r1.top + r2.top) / 2));
      document.dispatchEvent(ev('pointerup', r2.left + r2.width / 2, r2.top + r2.height / 2));
      document.title = 'SELFTEST-OK:' + state.connections.length;
    } catch (e) {
      document.title = 'SELFTEST-ERR:' + e.message;
      console.error('selftest error', e);
    }
  }, 2500);
}
