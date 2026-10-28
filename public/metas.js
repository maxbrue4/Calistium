(() => {
  'use strict';
  const NUM_DAYS = 31;
  const NUM_HABITS = 8;
  const COLORS = ['#64ffda', '#4fc3f7', '#818cf8', '#c084fc', '#fbbf24', '#fb7185', '#34d399', '#38bdf8'];
  const COLOR_NAMES = Array.from({ length: NUM_HABITS }, (_, i) => `Meta ${i + 1} sin nombrar`);
  const userId = localStorage.getItem('calistium_user_id');
  const STORAGE_KEY = userId ? `metas_state:${userId}` : 'metas_state';
  const legacyState = localStorage.getItem('metas_state');
  const freshState = () => ({
    mes: '',
    metas: Array(NUM_HABITS).fill(''),
    cells: Array.from({ length: NUM_DAYS }, () => Array(NUM_HABITS).fill(false)),
    notas: ''
  });
  function normalizeState(value) {
    const base = freshState();
    if (!value || typeof value !== 'object') return base;
    base.mes = typeof value.mes === 'string' ? value.mes : '';
    base.notas = typeof value.notas === 'string' ? value.notas : '';
    base.metas = base.metas.map((_, i) => typeof value.metas?.[i] === 'string' ? value.metas[i] : '');
    base.cells = base.cells.map((row, d) => row.map((_, h) => Boolean(value.cells?.[d]?.[h])));
    return base;
  }
  function loadState() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) return normalizeState(JSON.parse(saved));
      if (legacyState) {
        const migrated = normalizeState(JSON.parse(legacyState));
        localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
        if (STORAGE_KEY !== 'metas_state') localStorage.removeItem('metas_state');
        return migrated;
      }
    } catch (error) {
      console.warn('No se pudieron recuperar las metas guardadas:', error);
    }
    return freshState();
  }
  let state = loadState();
  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (error) {
      console.warn('No se pudieron guardar las metas:', error);
      const indicator = document.querySelector('.save-indicator');
      if (indicator) indicator.lastChild.textContent = ' No se pudo guardar; revisá el espacio del navegador';
    }
  }

  const canvas = document.getElementById('tracker');
  const ctx = canvas.getContext('2d');
  const tooltip = document.getElementById('tooltip');
  const W = 560, H = 560, cx = W / 2, cy = H / 2;
  const R_INNER = 78, R_OUTER = 258;
  const ringW = (R_OUTER - R_INNER) / NUM_HABITS;
  const GAP_START = Math.PI * 0.92;
  const GAP_END = Math.PI * 1.08;
  const TOTAL_ARC = 2 * Math.PI - (GAP_END - GAP_START);
  const sliceAngle = TOTAL_ARC / NUM_DAYS;
  const EMPTY_COLOR = '#20283b';

  function dayAngleStart(d) { return GAP_END + d * sliceAngle; }
  function dayAngleEnd(d) { return GAP_END + (d + 1) * sliceAngle; }
  function buildMetas() {
    const list = document.getElementById('metas-list');
    list.replaceChildren();
    for (let i = 0; i < NUM_HABITS; i++) {
      const row = document.createElement('div');
      row.className = 'meta-row';
      const dot = document.createElement('span');
      dot.className = 'meta-color';
      dot.style.background = COLORS[i];
      dot.style.boxShadow = `0 0 10px ${COLORS[i]}35`;
      const number = document.createElement('span');
      number.className = 'meta-number';
      number.textContent = String(i + 1).padStart(2, '0');
      const input = document.createElement('input');
      input.className = 'meta-input';
      input.type = 'text';
      input.maxLength = 70;
      input.placeholder = `Ej. Leer 20 minutos`;
      input.setAttribute('aria-label', `Meta ${i + 1}`);
      input.value = state.metas[i];
      input.addEventListener('input', () => {
        state.metas[i] = input.value;
        buildLegend();
        save();
      });
      row.append(dot, number, input);
      list.appendChild(row);
    }
  }
  function buildLegend() {
    const legend = document.getElementById('legend');
    legend.replaceChildren();
    for (let i = 0; i < NUM_HABITS; i++) {
      const item = document.createElement('div');
      item.className = 'legend-item';
      const dot = document.createElement('span');
      dot.className = 'legend-dot';
      dot.style.background = COLORS[i];
      const name = document.createElement('span');
      name.textContent = state.metas[i].trim() || COLOR_NAMES[i];
      item.append(dot, name);
      legend.appendChild(item);
    }
  }

  function drawTracker() {
    ctx.clearRect(0, 0, W, H);
    for (let d = 0; d < NUM_DAYS; d++) {
      const a1 = dayAngleStart(d), a2 = dayAngleEnd(d);
      for (let h = 0; h < NUM_HABITS; h++) {
        const r1 = R_INNER + h * ringW, r2 = r1 + ringW;
        ctx.beginPath();
        ctx.arc(cx, cy, r2, a1, a2);
        ctx.arc(cx, cy, r1, a2, a1, true);
        ctx.closePath();
        ctx.fillStyle = state.cells[d][h] ? COLORS[h] : EMPTY_COLOR;
        ctx.fill();
        ctx.strokeStyle = state.cells[d][h] ? 'rgba(5,12,29,.48)' : 'rgba(148,163,184,.19)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      const labelR = R_OUTER + 14;
      const midAngle = (a1 + a2) / 2;
      const lx = cx + labelR * Math.cos(midAngle), ly = cy + labelR * Math.sin(midAngle);
      ctx.fillStyle = '#8c9bb3';
      ctx.font = '600 10px Inter, Segoe UI, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(d + 1), lx, ly);
    }
    ctx.beginPath();
    ctx.arc(cx, cy, R_INNER - 8, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(11,15,31,.86)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(100,255,218,.16)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#64ffda';
    ctx.font = '800 11px Inter, Segoe UI, sans-serif';
    ctx.fillText('CALISTIUM', cx, cy - 9);
    ctx.fillStyle = '#9caec5';
    ctx.font = '500 9px Inter, Segoe UI, sans-serif';
    ctx.fillText('UN DÍA A LA VEZ', cx, cy + 10);
  }

  function cellAt(mx, my) {
    const dx = mx - cx, dy = my - cy;
    const dist = Math.hypot(dx, dy);
    if (dist < R_INNER || dist > R_OUTER + 5) return null;
    let angle = Math.atan2(dy, dx);
    if (angle < 0) angle += 2 * Math.PI;
    let rel = angle - GAP_END;
    if (rel < 0) rel += 2 * Math.PI;
    if (rel > TOTAL_ARC) return null;
    const d = Math.floor(rel / sliceAngle);
    const h = Math.floor((dist - R_INNER) / ringW);
    if (d < 0 || d >= NUM_DAYS || h < 0 || h >= NUM_HABITS) return null;
    return { d, h };
  }
  function pointerPosition(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: (event.clientX - rect.left) * W / rect.width, y: (event.clientY - rect.top) * H / rect.height, rect };
  }
  function showTooltip(event, cell) {
    if (!cell) { tooltip.style.display = 'none'; canvas.style.cursor = 'default'; return; }
    const { d, h } = cell;
    const name = state.metas[h].trim() || `Meta ${h + 1}`;
    tooltip.textContent = `Día ${d + 1} · ${name} · ${state.cells[d][h] ? 'cumplida' : 'pendiente'}`;
    const { x, y, rect } = pointerPosition(event);
    const cssScaleX = rect.width / W, cssScaleY = rect.height / H;
    tooltip.style.left = `${Math.max(0, Math.min(rect.width - 180, x * cssScaleX + 8))}px`;
    tooltip.style.top = `${Math.max(0, Math.min(rect.height - 40, y * cssScaleY + 8))}px`;
    tooltip.style.display = 'block';
    canvas.style.cursor = 'pointer';
  }

  document.getElementById('mes-input').value = state.mes;
  document.getElementById('mes-input').addEventListener('input', event => { state.mes = event.target.value; save(); });
  document.getElementById('notas').value = state.notas;
  document.getElementById('notas').addEventListener('input', event => { state.notas = event.target.value; save(); });
  canvas.addEventListener('click', event => {
    const pos = pointerPosition(event);
    const cell = cellAt(pos.x, pos.y);
    if (!cell) return;
    state.cells[cell.d][cell.h] = !state.cells[cell.d][cell.h];
    save();
    drawTracker();
    showTooltip(event, cell);
  });
  canvas.addEventListener('mousemove', event => showTooltip(event, cellAt(pointerPosition(event).x, pointerPosition(event).y)));
  canvas.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });
  canvas.addEventListener('touchstart', () => { tooltip.style.display = 'none'; }, { passive: true });
  document.getElementById('reset-btn').addEventListener('click', () => {
    if (!confirm('¿Querés borrar las marcas de los 31 días? Tus nombres de metas, el mes y las notas se van a conservar.')) return;
    state.cells = Array.from({ length: NUM_DAYS }, () => Array(NUM_HABITS).fill(false));
    save();
    drawTracker();
    tooltip.style.display = 'none';
  });
  buildMetas();
  buildLegend();
  drawTracker();
})();
