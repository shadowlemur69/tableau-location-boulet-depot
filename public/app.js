// =========================================================
// Tableau de Location - Frontend
// Communique avec le serveur via REST + SSE (sync temps réel)
// =========================================================

// __PORT_5000__ est remplacé par le proxy après déploiement.
// En local, le serveur sert le HTML lui-même → API = même origine (chaine vide).
const API = '__PORT_5000__'.startsWith('__') ? '' : '__PORT_5000__';

// ---------- ÉTAT ----------
let equipment = [];             // équipements actifs (non archivés)
let equipmentAll = [];          // + archivés (pour l'historique)
let rentals = [];
let currentWeekStart = getMonday(new Date());
let currentSession = null;
let authGroups = [];
let authUsers = [];
let historyFilteredList = [];
let historyRenderedCount = 0;

// Champs & limites (miroir du serveur)
const LIMITS = { name: 120, category: 80, code: 40, client: 120, phone: 40, note: 500 };
const MIN_DATE = '2000-01-01';
const MAX_DATE = '2099-12-31';
const HISTORY_PAGE_SIZE = 50;
const PERM_KEYS = ['admin', 'create_rental', 'create_equipment', 'undo_return', 'confirm_return'];

function allPermissionsEnabled() {
  return Object.fromEntries(PERM_KEYS.map((k) => [k, true]));
}

function hasPermission(permission) {
  if (!currentSession) return false;
  if (currentSession.is_admin) return true;
  return !!currentSession.permissions?.[permission];
}

function applySessionToUI() {
  const settingsBtn = document.getElementById('settingsBtn');
  const addRowBtn = document.getElementById('addRowBtn');
  if (settingsBtn) settingsBtn.hidden = !currentSession?.is_admin;
  if (addRowBtn) addRowBtn.hidden = !hasPermission('create_equipment');
}

async function loadSession() {
  try {
    const res = await fetch(API + '/api/auth/session', { credentials: 'same-origin' });
    if (res.status === 401) {
      window.location.href = '/login.html';
      return;
    }
    const body = await res.json();
    if (body.auth === false) {
      currentSession = {
        username: body.user || 'open-mode',
        full_name: body.user || 'Open Mode',
        is_admin: true,
        permissions: allPermissionsEnabled()
      };
    } else {
      currentSession = {
        username: body.user,
        full_name: body.full_name,
        group_name: body.group_name,
        group_full_name: body.group_full_name,
        is_admin: !!body.is_admin,
        permissions: body.permissions || {}
      };
    }
    applySessionToUI();
  } catch (_) {
    window.location.href = '/login.html';
  }
}

// ---------- UTILITAIRES DATE ----------
function getMonday(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(d.setDate(diff));
  monday.setHours(0, 0, 0, 0);
  return monday;
}
function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}
function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}
function toISODate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
function parseISODate(str) {
  if (!str || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return null;
  const [y, m, d] = str.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return isNaN(dt) ? null : dt;
}
function rentalEffectiveEndDate(rental) {
  const plannedEnd = parseISODate(rental.end_date);
  if (!plannedEnd) return null;
  if (!rental.returned_at) return plannedEnd;
  return startOfDay(new Date(rental.returned_at));
}
function rentalEffectiveStartDate(rental) {
  const pickedUp = rentalPickupDate(rental);
  if (pickedUp) return pickedUp;
  return parseISODate(rental.start_date);
}
function rentalPickupDate(rental) {
  if (!rental?.picked_up_at) return null;
  return startOfDay(new Date(rental.picked_up_at));
}
function rentalStatus(rental, today = startOfDay(new Date())) {
  if (rental.returned_at) return 'returned';
  const plannedStart = parseISODate(rental.start_date);
  const plannedEnd = parseISODate(rental.end_date);
  const pickedUp = rentalPickupDate(rental);
  if (!pickedUp && plannedStart && plannedStart < today) return 'late';
  if (pickedUp && plannedEnd && plannedEnd < today) return 'late';
  return 'active';
}
function fmtDateShort(date) {
  return date.toLocaleDateString('fr-CA', { day: 'numeric', month: 'short' });
}
function fmtDateFull(date) {
  return date.toLocaleDateString('fr-CA', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}
function daysBetween(a, b) {
  const oneDay = 24 * 60 * 60 * 1000;
  return Math.round((b - a) / oneDay);
}
function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}
const DAY_NAMES = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];

// ---------- API HTTP ----------
async function apiFetch(url, opts = {}) {
  const res = await fetch(API + url, {
    ...opts,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
  if (res.status === 401) {
    window.location.href = '/login.html';
    throw new Error('Connexion requise');
  }
  const bodyText = await res.text();
  let body = null;
  try { body = bodyText ? JSON.parse(bodyText) : {}; } catch { body = { error: bodyText }; }
  if (!res.ok) {
    const err = new Error(body.message || body.error || 'Erreur serveur');
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

async function loadAll() {
  try {
    const [eqList, eqAll, rentList] = await Promise.all([
      apiFetch('/api/equipment'),
      apiFetch('/api/equipment?include_archived=1'),
      apiFetch('/api/rentals')
    ]);
    equipment = eqList;
    equipmentAll = eqAll;
    rentals = rentList;
    render();
  } catch (e) {
    toast('Erreur de chargement : ' + e.message, 'error');
  }
}

// ---------- SSE (temps réel) ----------
let eventSource = null;
let sseFailStart = null;

function connectSSE() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource(API + '/api/events');

  eventSource.onopen = () => {
    setConnStatus('online', 'En ligne · synchronisé');
    sseFailStart = null;
  };
  eventSource.onerror = () => {
    if (!sseFailStart) sseFailStart = Date.now();
    const secs = Math.floor((Date.now() - sseFailStart) / 1000);
    setConnStatus('offline', `Hors ligne · reconnexion (${secs}s)…`);
    // Recharger les données quand on revient en ligne (après 10s+ de déconnexion)
    if (secs > 10) {
      // fetch en arrière-plan pour éviter le décalage
      loadAll();
    }
  };

  eventSource.addEventListener('equipment:changed', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.action === 'deleted') {
      // legacy — plus utilisé, remplacé par archived
      equipment = equipment.filter(x => x.id !== msg.id);
      equipmentAll = equipmentAll.filter(x => x.id !== msg.id);
    } else if (msg.action === 'archived') {
      equipment = equipment.filter(x => x.id !== msg.item.id);
      const idx = equipmentAll.findIndex(x => x.id === msg.item.id);
      if (idx >= 0) equipmentAll[idx] = msg.item;
      else equipmentAll.push(msg.item);
    } else if (msg.action === 'restored') {
      if (!equipment.find(x => x.id === msg.item.id)) equipment.push(msg.item);
      const idx = equipmentAll.findIndex(x => x.id === msg.item.id);
      if (idx >= 0) equipmentAll[idx] = msg.item;
    } else if (msg.action === 'created') {
      if (!equipment.find(x => x.id === msg.item.id)) equipment.push(msg.item);
      if (!equipmentAll.find(x => x.id === msg.item.id)) equipmentAll.push(msg.item);
    } else if (msg.action === 'updated') {
      const idx = equipment.findIndex(x => x.id === msg.item.id);
      if (idx >= 0) equipment[idx] = msg.item;
      const idxAll = equipmentAll.findIndex(x => x.id === msg.item.id);
      if (idxAll >= 0) equipmentAll[idxAll] = msg.item;
    }
    render();
  });

  eventSource.addEventListener('rentals:changed', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.action === 'deleted') {
      rentals = rentals.filter(r => r.id !== msg.id);
    } else if (msg.action === 'created') {
      if (!rentals.find(r => r.id === msg.item.id)) rentals.push(msg.item);
    } else if (msg.action === 'updated') {
      const idx = rentals.findIndex(r => r.id === msg.item.id);
      if (idx >= 0) rentals[idx] = msg.item;
    }
    render();
  });
}

function setConnStatus(state, text) {
  const el = document.getElementById('connStatus');
  el.className = 'conn-status ' + state;
  el.querySelector('.conn-text').textContent = text;
}

// ---------- RENDU ----------
function render() {
  renderHeader();
  renderBody();
  updateWeekLabel();
  renderStats();
}

function renderStats() {
  const today = new Date(); today.setHours(0,0,0,0);
  const weekEnd = addDays(currentWeekStart, 6);

  const active = rentals.filter(r => rentalStatus(r, today) === 'active').length;
  const late = rentals.filter(r => rentalStatus(r, today) === 'late').length;
  const thisWeek = rentals.filter(r => {
    const s = parseISODate(r.start_date);
    const e = rentalEffectiveEndDate(r);
    if (!s || !e) return false;
    return !(e < currentWeekStart || s > weekEnd);
  }).length;

  document.getElementById('statActive').textContent = active;
  document.getElementById('statLate').textContent = late;
  document.getElementById('statWeek').textContent = thisWeek;
  document.getElementById('statEquip').textContent = equipment.length;
}

function updateWeekLabel() {
  const end = addDays(currentWeekStart, 6);
  document.getElementById('weekLabel').textContent =
    `${fmtDateShort(currentWeekStart)} → ${fmtDateShort(end)} ${end.getFullYear()}`;
}

function renderHeader() {
  const headerRow = document.getElementById('headerRow');
  while (headerRow.children.length > 1) headerRow.removeChild(headerRow.lastChild);
  const today = new Date();
  for (let i = 0; i < 7; i++) {
    const day = addDays(currentWeekStart, i);
    const th = document.createElement('th');
    th.className = 'day-header';
    if (isSameDay(day, today)) th.classList.add('is-today');
    th.innerHTML = `<span class="day-name">${DAY_NAMES[i]}</span>
                    <span class="day-date">${fmtDateShort(day)}</span>`;
    headerRow.appendChild(th);
  }
}

function renderBody() {
  const body = document.getElementById('boardBody');
  body.innerHTML = '';
  const empty = document.getElementById('emptyState');
  if (equipment.length === 0) {
    empty.hidden = false;
    document.getElementById('board').style.display = 'none';
    return;
  }
  empty.hidden = true;
  document.getElementById('board').style.display = '';

  const today = new Date();
  const weekEnd = addDays(currentWeekStart, 6);

  for (const eq of equipment) {
    const tr = document.createElement('tr');
    const equipTd = document.createElement('td');
    equipTd.className = 'equip-cell';
    equipTd.title = hasPermission('create_equipment')
      ? 'Cliquer pour modifier l\'équipement'
      : 'Vous n\'avez pas la permission de modifier les équipements';
    let metaHtml = '';
    if (eq.category || eq.code) {
      const parts = [];
      if (eq.category) parts.push(`<span class="meta-tag">${escapeHtml(eq.category)}</span>`);
      if (eq.code) parts.push(`<span class="meta-code">${escapeHtml(eq.code)}</span>`);
      metaHtml = `<div class="equip-meta">${parts.join('')}</div>`;
    }
    equipTd.innerHTML = `
      <div class="equip-name">${escapeHtml(eq.name)}</div>
      ${metaHtml}
    `;
    equipTd.addEventListener('click', () => {
      if (!hasPermission('create_equipment')) {
        toast('Vous n\'avez pas la permission de modifier les équipements.', 'error');
        return;
      }
      openRowModal(eq);
    });
    tr.appendChild(equipTd);

    for (let i = 0; i < 7; i++) {
      const day = addDays(currentWeekStart, i);
      const td = document.createElement('td');
      td.className = 'day-cell';
      if (isSameDay(day, today)) td.classList.add('is-today');

      const rentalsStartingHere = rentals.filter(r => {
        if (r.equipment_id !== eq.id) return false;
        const s = rentalEffectiveStartDate(r);
        const e = rentalEffectiveEndDate(r);
        if (!s || !e) return false;
        const firstVisible = s < currentWeekStart ? currentWeekStart : s;
        if (e < currentWeekStart || s > weekEnd) return false;
        return isSameDay(firstVisible, day);
      });
      const rentalsEndingHere = rentals.filter(r => {
        if (r.equipment_id !== eq.id) return false;
        const s = rentalEffectiveStartDate(r);
        const e = rentalEffectiveEndDate(r);
        if (!s || !e) return false;
        const lastVisible = e > weekEnd ? weekEnd : e;
        if (e < currentWeekStart || s > weekEnd) return false;
        return isSameDay(lastVisible, day);
      });

      if (rentalsStartingHere.length && rentalsEndingHere.length) {
        td.innerHTML = '';
      } else if (rentalsEndingHere.length) {
        td.innerHTML = '<span class="add-hint add-hint-right">+</span>';
      } else if (rentalsStartingHere.length) {
        td.innerHTML = '<span class="add-hint add-hint-left">+</span>';
      } else {
        td.innerHTML = '<span class="add-hint">+</span>';
      }

      for (const r of rentalsStartingHere) {
        td.appendChild(buildPostit(r, day, weekEnd));
      }

      td.addEventListener('click', (e) => {
        if (e.target.closest('.postit')) return;
        if (!hasPermission('create_rental')) {
          toast('Vous n\'avez pas la permission de créer des locations.', 'error');
          return;
        }
        openPostitModal(null, eq.id, toISODate(day));
      });

      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
}

function buildPostit(rental, dayStart, weekEnd) {
  const s = rentalEffectiveStartDate(rental);
  const e = parseISODate(rental.end_date);
  const effectiveEnd = rentalEffectiveEndDate(rental);
  const firstVisible = s < currentWeekStart ? currentWeekStart : s;
  const lastVisible = effectiveEnd > weekEnd ? weekEnd : effectiveEnd;
  const visibleDays = daysBetween(firstVisible, lastVisible) + 1;
  const leftOffset = s < currentWeekStart ? 0 : 0.5;
  const rightOffset = effectiveEnd > weekEnd ? 0 : 0.5;
  const span = Math.max(0.5, visibleDays - leftOffset - rightOffset);

  const el = document.createElement('div');
  el.className = 'postit ' + (rental.color || 'yellow');

  const today = new Date(); today.setHours(0,0,0,0);
  if (rentalStatus(rental, today) === 'late') el.classList.add('late');
  if (rental.returned_at) el.classList.add('returned');

  el.style.left = `calc(${leftOffset * 100}% + 4px)`;
  el.style.width = `calc(${span * 100}% - 8px)`;

  const startFmt = fmtDateShort(s);
  const endFmt = fmtDateShort(effectiveEnd);
  const nbDays = daysBetween(s, effectiveEnd) + 1;
  const pickedBadge = rental.picked_up_at && !rental.returned_at
    ? '<span class="postit-picked-badge">LOUÉ</span>'
    : '';

  el.innerHTML = `
    ${pickedBadge}
    <span class="client-name">${escapeHtml(rental.client)}</span>
    <span class="dates">${startFmt} → ${endFmt} · ${nbDays}j</span>
    ${rental.note ? `<span class="note-preview">${escapeHtml(rental.note)}</span>` : ''}
  `;
  el.addEventListener('click', (ev) => {
    ev.stopPropagation();
    openPostitModal(rental);
  });
  return el;
}

// =========================================================
// MODAL: ÉQUIPEMENT
// =========================================================
let rowModalDirty = false;
let rowModalOriginal = null;

function openRowModal(eq = null) {
  if (!hasPermission('create_equipment')) {
    toast('Vous n\'avez pas la permission de gérer les équipements.', 'error');
    return;
  }
  const modal = document.getElementById('rowModal');
  document.getElementById('rowTitle').textContent = eq ? 'Modifier l\'équipement' : 'Nouvel équipement';
  document.getElementById('rowId').value = eq?.id || '';
  document.getElementById('rowName').value = eq?.name || '';
  document.getElementById('rowCategory').value = eq?.category || '';
  document.getElementById('rowCode').value = eq?.code || '';
  document.getElementById('deleteRowBtn').hidden = !eq;

  // Bouton "Archiver" texte adaptatif
  const delBtn = document.getElementById('deleteRowBtn');
  if (eq) {
    const activeCount = rentals.filter(r => r.equipment_id === eq.id && !r.returned_at).length;
    delBtn.textContent = activeCount > 0 ? `Archiver (${activeCount} en cours)` : 'Archiver';
    delBtn.title = 'L\'équipement disparaît du tableau, mais l\'historique reste intact.';
  }

  rowModalOriginal = JSON.stringify({
    name: eq?.name || '', category: eq?.category || '', code: eq?.code || ''
  });
  rowModalDirty = false;
  modal.hidden = false;
  setTimeout(() => document.getElementById('rowName').focus(), 50);
}

['rowName','rowCategory','rowCode'].forEach(id => {
  document.getElementById(id).addEventListener('input', () => {
    const current = JSON.stringify({
      name: document.getElementById('rowName').value,
      category: document.getElementById('rowCategory').value,
      code: document.getElementById('rowCode').value
    });
    rowModalDirty = current !== rowModalOriginal;
  });
});

document.getElementById('rowForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!hasPermission('create_equipment')) return toast('Permission insuffisante.', 'error');
  const submitBtn = e.target.querySelector('button[type="submit"]');
  if (submitBtn.disabled) return;
  submitBtn.disabled = true;

  const id = document.getElementById('rowId').value;
  const name = document.getElementById('rowName').value.trim();
  const category = document.getElementById('rowCategory').value.trim();
  const code = document.getElementById('rowCode').value.trim();

  // Validation client
  if (!name) {
    toast('Le nom de l\'équipement est requis.', 'error');
    submitBtn.disabled = false;
    return;
  }
  if (name.length > LIMITS.name || category.length > LIMITS.category || code.length > LIMITS.code) {
    toast('Un ou plusieurs champs dépassent la longueur maximale.', 'error');
    submitBtn.disabled = false;
    return;
  }

  try {
    if (id) {
      await apiFetch('/api/equipment/' + id, { method: 'PUT', body: JSON.stringify({ name, category, code }) });
      toast('Équipement modifié', 'success');
    } else {
      await apiFetch('/api/equipment', { method: 'POST', body: JSON.stringify({ name, category, code }) });
      toast('Équipement ajouté', 'success');
    }
    rowModalDirty = false;
    closeModal('rowModal');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    submitBtn.disabled = false;
  }
});

document.getElementById('deleteRowBtn').addEventListener('click', async () => {
  if (!hasPermission('create_equipment')) return toast('Permission insuffisante.', 'error');
  const id = document.getElementById('rowId').value;
  if (!id) return;
  const eq = equipment.find(x => x.id === id);
  if (!eq) return;

  const activeCount = rentals.filter(r => r.equipment_id === id && !r.returned_at).length;
  const historyCount = rentals.filter(r => r.equipment_id === id).length;

  const title = activeCount > 0
    ? `Archiver "${eq.name}" ?`
    : `Archiver "${eq.name}" ?`;
  const body = activeCount > 0
    ? `Attention : cet équipement a ${activeCount} location(s) en cours. Ces locations seront conservées et l'équipement disparaîtra du tableau. Vous pourrez le restaurer plus tard depuis l'historique.`
    : `L'équipement sera retiré du tableau. ${historyCount > 0 ? `L'historique (${historyCount} location(s)) est conservé intact.` : ''} Vous pourrez le restaurer plus tard.`;

  const ok = await confirmDialog({ title, body, action: 'Archiver', danger: activeCount > 0 });
  if (!ok) return;

  const btn = document.getElementById('deleteRowBtn');
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    const url = `/api/equipment/${id}${activeCount > 0 ? '?force=1' : ''}`;
    await apiFetch(url, { method: 'DELETE' });
    toast('Équipement archivé — l\'historique est conservé.', 'success');
    rowModalDirty = false;
    closeModal('rowModal');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

// =========================================================
// MODAL: LOCATION (post-it)
// =========================================================
let postitModalDirty = false;
let postitModalOriginal = null;
let postitCurrentRental = null;

function updateRentalDateLabels(rental) {
  const startLabel = document.getElementById('rentalStartLabel');
  const endLabel = document.getElementById('rentalEndLabel');
  const startMeta = document.getElementById('rentalStartMeta');
  const endMeta = document.getElementById('rentalEndMeta');

  startMeta.textContent = '';
  endMeta.textContent = '';

  if (!rental) {
    startLabel.textContent = 'Date de début prévue';
    endLabel.textContent = 'Date de retour prévue';
    return;
  }

  const pickedUpAt = rentalPickupDate(rental);
  const returnedAt = rental.returned_at ? startOfDay(new Date(rental.returned_at)) : null;

  if (!pickedUpAt) {
    startLabel.textContent = 'Date de début prévue';
    endLabel.textContent = 'Date de retour prévue';
    return;
  }

  startLabel.textContent = 'Date de début';

  if (!returnedAt) {
    endLabel.textContent = 'Date de retour prévue';
    return;
  }

  endLabel.textContent = 'Date de retour';
}

function openPostitModal(rental = null, equipmentId = null, defaultDate = null) {
  const modal = document.getElementById('postitModal');
  const eqId = rental ? rental.equipment_id : equipmentId;
  const eq = equipmentAll.find(x => x.id === eqId);

  document.getElementById('postitTitle').textContent = rental ? 'Modifier la location' : 'Nouvelle location';
  document.getElementById('rentalId').value = rental?.id || '';
  document.getElementById('rentalVersion').value = rental?.version ?? '';
  document.getElementById('rentalEquipmentId').value = eqId || '';

  // Info équipement (avec état archivé)
  let equipInfo = eq ? `📦 ${eq.name}${eq.code ? ' · ' + eq.code : ''}` : '(équipement supprimé)';
  if (eq?.archived_at) equipInfo += ' · Archivé';
  document.getElementById('postitEquipInfo').textContent = equipInfo;
  const returnInfo = document.getElementById('returnConfirmedInfo');
  if (rental?.returned_at) {
    returnInfo.hidden = false;
    returnInfo.textContent = `Date de retour confirmée : ${new Date(rental.returned_at).toLocaleDateString('fr-CA', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}`;
  } else {
    returnInfo.hidden = true;
    returnInfo.textContent = '';
  }

  document.getElementById('rentalClient').value = rental?.client || '';
  document.getElementById('rentalPhone').value = rental?.phone || '';
  const displayStart = rental?.picked_up_at
    ? toISODate(startOfDay(new Date(rental.picked_up_at)))
    : (rental?.start_date || defaultDate || toISODate(new Date()));
  const displayEnd = rental?.returned_at
    ? toISODate(startOfDay(new Date(rental.returned_at)))
    : (rental?.end_date || defaultDate || toISODate(new Date()));
  document.getElementById('rentalStart').value = displayStart;
  document.getElementById('rentalEnd').value = displayEnd;
  document.getElementById('rentalNote').value = rental?.note || '';
  document.getElementById('rentalColor').value = rental?.color || 'yellow';
  updateRentalDateLabels(rental);

  const deleteBtn = document.getElementById('deleteRentalBtn');
  deleteBtn.hidden = !rental || !hasPermission('create_rental') || !!rental?.picked_up_at || !!rental?.returned_at;

  const pickupBtn = document.getElementById('pickupRentalBtn');
  const returnBtn = document.getElementById('returnRentalBtn');

  if (!rental) {
    pickupBtn.hidden = true;
    returnBtn.hidden = true;
  } else if (!rental.picked_up_at) {
    if (hasPermission('confirm_return')) {
      pickupBtn.hidden = false;
      pickupBtn.textContent = '✓ Loué';
      pickupBtn.dataset.action = 'pickup';
      returnBtn.hidden = true;
    } else {
      pickupBtn.hidden = true;
      returnBtn.hidden = true;
    }
  } else if (rental.returned_at) {
    pickupBtn.hidden = true;
    if (hasPermission('undo_return')) {
      returnBtn.hidden = false;
      returnBtn.textContent = '↺ Annuler le retour';
      returnBtn.dataset.action = 'unreturn';
    } else {
      returnBtn.hidden = true;
    }
  } else {
    if (hasPermission('confirm_return')) {
      pickupBtn.hidden = false;
      pickupBtn.textContent = '↺ Annuler Loué';
      pickupBtn.dataset.action = 'unpickup';
    } else {
      pickupBtn.hidden = true;
    }
    if (hasPermission('confirm_return')) {
      returnBtn.hidden = false;
      returnBtn.textContent = '✓ Marquer retourné';
      returnBtn.dataset.action = 'return';
    } else {
      returnBtn.hidden = true;
    }
  }

  // Bloquer la création si l'équipement est archivé
  const submitBtn = document.getElementById('postitSubmit');
  if (!hasPermission('create_rental')) {
    submitBtn.disabled = true;
    submitBtn.title = 'Permission insuffisante.';
  } else if (!rental && eq?.archived_at) {
    submitBtn.disabled = true;
    submitBtn.title = 'Équipement archivé : restaurez-le d\'abord.';
  } else {
    submitBtn.disabled = false;
    submitBtn.title = '';
  }

  postitCurrentRental = rental;
  postitModalOriginal = snapshotPostit();
  postitModalDirty = false;
  modal.hidden = false;
  setTimeout(() => document.getElementById('rentalClient').focus(), 50);
}

function openReturnDateDialog({
  defaultDate = toISODate(new Date()),
  title = 'Confirmer la date de retour',
  body = 'Choisissez la date effective de retour.',
  label = 'Date de retour',
  minDate = MIN_DATE,
  maxDate = MAX_DATE
} = {}) {
  return new Promise(resolve => {
    const modal = document.getElementById('returnModal');
    const dateInput = document.getElementById('returnDateInput');
    const titleEl = document.getElementById('returnTitle');
    const bodyEl = document.getElementById('returnBody');
    const labelEl = document.getElementById('returnDateLabel');
    const okBtn = document.getElementById('returnOk');
    const cancelBtn = document.getElementById('returnCancel');

    titleEl.textContent = title;
    bodyEl.textContent = body;
    labelEl.textContent = label;
    dateInput.min = minDate;
    dateInput.max = maxDate;
    dateInput.value = defaultDate;

    const cleanup = () => {
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      modal.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey);
      modal.hidden = true;
    };
    const onOk = () => {
      const selected = dateInput.value;
      if (!selected) return;
      cleanup();
      resolve(selected);
    };
    const onCancel = () => {
      cleanup();
      resolve(null);
    };
    const onBackdrop = (e) => { if (e.target === modal) onCancel(); };
    const onKey = (e) => {
      if (e.key === 'Escape') onCancel();
      if (e.key === 'Enter' && document.activeElement === dateInput) onOk();
    };

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    modal.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey);

    modal.hidden = false;
    setTimeout(() => dateInput.focus(), 50);
  });
}

function snapshotPostit() {
  return JSON.stringify({
    client: document.getElementById('rentalClient').value,
    phone: document.getElementById('rentalPhone').value,
    start_date: document.getElementById('rentalStart').value,
    end_date: document.getElementById('rentalEnd').value,
    note: document.getElementById('rentalNote').value,
    color: document.getElementById('rentalColor').value
  });
}

['rentalClient','rentalPhone','rentalStart','rentalEnd','rentalNote','rentalColor'].forEach(id => {
  document.getElementById(id).addEventListener('input', () => {
    postitModalDirty = snapshotPostit() !== postitModalOriginal;
  });
});

// Auto-ajuster end_date si l'utilisateur met une date de début plus tardive
document.getElementById('rentalStart').addEventListener('change', () => {
  const start = document.getElementById('rentalStart').value;
  const end = document.getElementById('rentalEnd').value;
  if (start && end && end < start) {
    document.getElementById('rentalEnd').value = start;
    postitModalDirty = snapshotPostit() !== postitModalOriginal;
  }
});

document.getElementById('postitForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!hasPermission('create_rental')) return toast('Permission insuffisante.', 'error');
  const submitBtn = document.getElementById('postitSubmit');
  if (submitBtn.disabled) return;

  const id = document.getElementById('rentalId').value;
  const version = document.getElementById('rentalVersion').value;
  const equipment_id = document.getElementById('rentalEquipmentId').value;
  const client = document.getElementById('rentalClient').value.trim();
  const phone = document.getElementById('rentalPhone').value.trim();
  const start_date = document.getElementById('rentalStart').value;
  const end_date = document.getElementById('rentalEnd').value;
  const note = document.getElementById('rentalNote').value.trim();
  const color = document.getElementById('rentalColor').value;

  // Validation client
  if (!client) return toast('Le nom du client est requis.', 'error');
  if (client.length > LIMITS.client) return toast(`Nom du client trop long (max ${LIMITS.client} caractères).`, 'error');
  if (phone.length > LIMITS.phone) return toast(`Téléphone trop long (max ${LIMITS.phone} caractères).`, 'error');
  if (note.length > LIMITS.note) return toast(`Note trop longue (max ${LIMITS.note} caractères).`, 'error');
  if (!start_date || !end_date) return toast('Les dates sont requises.', 'error');
  if (start_date < MIN_DATE || start_date > MAX_DATE || end_date < MIN_DATE || end_date > MAX_DATE) {
    return toast('Les dates doivent être entre 2000 et 2099.', 'error');
  }
  if (end_date < start_date) return toast('La date de retour doit être identique ou après la date de début.', 'error');

  // Avertissement date passée (mais on autorise — pour saisir des locations rétroactives)
  const today = new Date(); today.setHours(0,0,0,0);
  const startDt = parseISODate(start_date);
  if (!id && startDt && daysBetween(startDt, today) > 365) {
    const ok = await confirmDialog({
      title: 'Date très ancienne',
      body: `La date de début (${start_date}) est il y a plus d'un an. Êtes-vous sûr ?`,
      action: 'Oui, continuer'
    });
    if (!ok) return;
  }

  const payload = { equipment_id, client, phone, start_date, end_date, note, color };
  if (id && version) payload.version = parseInt(version, 10);

  submitBtn.disabled = true;
  try {
    await submitRental(id, payload);
    postitModalDirty = false;
    closeModal('postitModal');
  } catch (err) {
    if (err.status === 409 && err.body?.error === 'conflict') {
      const c = err.body.conflict;
      const ok = await confirmDialog({
        title: 'Conflit de réservation',
        body: `Cet équipement est déjà réservé par ${c.client} du ${c.start_date} au ${c.end_date}. Créer quand même la location ?`,
        action: 'Créer quand même',
        danger: true
      });
      if (ok) {
        try {
          await submitRental(id, payload, true);
          postitModalDirty = false;
          closeModal('postitModal');
        } catch (err2) {
          toast(err2.message, 'error');
        }
      }
    } else if (err.status === 409 && err.body?.error === 'version_mismatch') {
      toast('Un autre utilisateur a modifié cette location entre-temps. Le formulaire va se rafraîchir.', 'error');
      setTimeout(() => {
        closeModal('postitModal');
        loadAll();
      }, 1500);
    } else {
      toast(err.message, 'error');
    }
  } finally {
    submitBtn.disabled = false;
  }
});

async function submitRental(id, payload, force = false) {
  const suffix = force ? '?force=1' : '';
  if (id) {
    await apiFetch('/api/rentals/' + id + suffix, { method: 'PUT', body: JSON.stringify(payload) });
    toast('Location modifiée', 'success');
  } else {
    await apiFetch('/api/rentals' + suffix, { method: 'POST', body: JSON.stringify(payload) });
    toast('Location ajoutée', 'success');
  }
}

document.getElementById('deleteRentalBtn').addEventListener('click', async () => {
  if (!hasPermission('create_rental')) return toast('Permission insuffisante.', 'error');
  const btn = document.getElementById('deleteRentalBtn');
  if (btn.disabled) return;
  const id = document.getElementById('rentalId').value;
  if (!id) return;
  const rental = rentals.find(r => r.id === id);
  if (rental?.picked_up_at || rental?.returned_at) {
    toast('Une location marquée Loué ou Retournée ne peut pas être supprimée.', 'error');
    return;
  }
  const ok = await confirmDialog({
    title: 'Supprimer cette location ?',
    body: `${rental?.client ? `Location de ${rental.client}. ` : ''}Elle disparaîtra aussi de l'historique. Pour conserver la trace, marquez-la plutôt "retournée".`,
    action: 'Supprimer',
    danger: true
  });
  if (!ok) return;
  btn.disabled = true;
  try {
    await apiFetch('/api/rentals/' + id, { method: 'DELETE' });
    toast('Location supprimée', 'success');
    postitModalDirty = false;
    closeModal('postitModal');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('pickupRentalBtn').addEventListener('click', async () => {
  const btn = document.getElementById('pickupRentalBtn');
  if (btn.disabled) return;
  const id = document.getElementById('rentalId').value;
  if (!id) return;
  if (!hasPermission('confirm_return')) return toast('Permission insuffisante.', 'error');
  const action = btn.dataset.action || 'pickup';
  btn.disabled = true;
  try {
    if (action === 'pickup') {
      const pickedUpAt = await openReturnDateDialog({
        defaultDate: toISODate(new Date()),
        title: 'Confirmer la date de récupération',
        body: 'Choisissez la date réelle où le client a récupéré l\'équipement.',
        label: 'Date de récupération',
        minDate: MIN_DATE,
        maxDate: MAX_DATE
      });
      if (!pickedUpAt) return;
      await apiFetch('/api/rentals/' + id + '/pickup', {
        method: 'POST',
        body: JSON.stringify({ picked_up_at: pickedUpAt })
      });
      toast('Location marquée Loué ✓', 'success');
    } else {
      await apiFetch('/api/rentals/' + id + '/unpickup', { method: 'POST' });
      toast('État Loué annulé', 'success');
    }
    postitModalDirty = false;
    closeModal('postitModal');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('returnRentalBtn').addEventListener('click', async () => {
  const btn = document.getElementById('returnRentalBtn');
  if (btn.disabled) return;
  const id = document.getElementById('rentalId').value;
  if (!id) return;
  const action = btn.dataset.action;
  if (action === 'return' && !hasPermission('confirm_return')) return toast('Permission insuffisante.', 'error');
  if (action === 'unreturn' && !hasPermission('undo_return')) return toast('Permission insuffisante.', 'error');
  btn.disabled = true;
  try {
    if (action === 'return') {
      const rental = rentals.find((r) => r.id === id);
      const pickupDate = rental?.picked_up_at ? toISODate(startOfDay(new Date(rental.picked_up_at))) : '';
      const minReturnDate = pickupDate || document.getElementById('rentalStart').value || MIN_DATE;
      const defaultReturnDate = toISODate(new Date()) < minReturnDate ? minReturnDate : toISODate(new Date());
      const returnedAt = await openReturnDateDialog({
        defaultDate: defaultReturnDate,
        minDate: minReturnDate,
        maxDate: MAX_DATE
      });
      if (!returnedAt) return;
      const startDate = pickupDate || document.getElementById('rentalStart').value;
      if (startDate && returnedAt < startDate) {
        toast('La date de retour ne peut pas être avant la date de début.', 'error');
        return;
      }
      await apiFetch('/api/rentals/' + id + '/return', {
        method: 'POST',
        body: JSON.stringify({ returned_at: returnedAt })
      });
      toast('Marqué comme retourné ✓', 'success');
    } else {
      await apiFetch('/api/rentals/' + id + '/unreturn', { method: 'POST' });
      toast('Retour annulé — location réactivée', 'success');
    }
    postitModalDirty = false;
    closeModal('postitModal');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

// =========================================================
// HISTORIQUE
// =========================================================
function openHistoryModalWithFilter(filter = 'all') {
  const filterSelect = document.getElementById('historyFilter');
  const searchInput = document.getElementById('historySearch');
  filterSelect.value = filter;
  searchInput.value = '';
  document.getElementById('historyModal').hidden = false;
  renderHistory();
}

document.getElementById('historyBtn').addEventListener('click', () => {
  openHistoryModalWithFilter('all');
});

document.querySelectorAll('.stat-card[data-history-filter]').forEach(card => {
  card.addEventListener('click', () => {
    openHistoryModalWithFilter(card.dataset.historyFilter || 'all');
  });
  card.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    openHistoryModalWithFilter(card.dataset.historyFilter || 'all');
  });
});

function renderGroupsList() {
  const el = document.getElementById('groupsList');
  if (!authGroups.length) {
    el.innerHTML = '<div class="history-empty">Aucun groupe</div>';
    return;
  }
  el.innerHTML = authGroups.map((g) => {
    const perms = Object.entries(g.permissions || {})
      .filter(([, v]) => !!v)
      .map(([k]) => `<span class="perm-chip">${escapeHtml(k)}</span>`)
      .join('') || '<span class="perm-chip">aucune permission</span>';
    return `
      <div class="settings-item">
        <div class="settings-item-title">${escapeHtml(g.full_name)} <span class="mini-badge">${escapeHtml(g.name)}</span></div>
        <div class="settings-item-sub">${perms}</div>
        <div class="settings-item-actions">
          <button type="button" class="btn btn-outline btn-edit edit-group-btn" data-id="${escapeHtml(g.id)}">Modifier</button>
        </div>
      </div>
    `;
  }).join('');

  el.querySelectorAll('.edit-group-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const g = authGroups.find((x) => x.id === btn.dataset.id);
      if (!g) return;
      document.getElementById('groupEditId').value = g.id;
      document.getElementById('groupName').value = g.name;
      document.getElementById('groupFullName').value = g.full_name;
      document.getElementById('permAdmin').checked = !!g.permissions?.admin;
      document.getElementById('permCreateRental').checked = !!g.permissions?.create_rental;
      document.getElementById('permCreateEquipment').checked = !!g.permissions?.create_equipment;
      document.getElementById('permUndoReturn').checked = !!g.permissions?.undo_return;
      document.getElementById('permConfirmReturn').checked = !!g.permissions?.confirm_return;
      document.getElementById('groupSubmitBtn').textContent = 'Enregistrer groupe';
      document.getElementById('cancelGroupEdit').hidden = false;
      document.getElementById('groupName').focus();
    });
  });
}

function renderUsersList() {
  const el = document.getElementById('usersList');
  if (!authUsers.length) {
    el.innerHTML = '<div class="history-empty">Aucun utilisateur</div>';
    return;
  }
  el.innerHTML = authUsers.map((u) => `
    <div class="settings-item">
      <div class="settings-item-title">${escapeHtml(u.full_name)} <span class="mini-badge">${escapeHtml(u.username)}</span></div>
      <div class="settings-item-sub">Groupe: ${escapeHtml(u.group_full_name || u.group_name)}${u.active ? '' : ' · Inactif'}</div>
      <div class="settings-item-actions">
        <button type="button" class="btn btn-outline btn-edit edit-user-btn" data-id="${escapeHtml(u.id)}">Modifier</button>
      </div>
    </div>
  `).join('');

  el.querySelectorAll('.edit-user-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const u = authUsers.find((x) => x.id === btn.dataset.id);
      if (!u) return;
      document.getElementById('userEditId').value = u.id;
      document.getElementById('newUsername').value = u.username;
      document.getElementById('newFullName').value = u.full_name;
      document.getElementById('newUserGroup').value = u.group_id;
      document.getElementById('newPassword').value = '';
      document.getElementById('newPassword').placeholder = 'Laisser vide pour conserver';
      document.getElementById('newPassword').required = false;
      document.getElementById('userSubmitBtn').textContent = 'Enregistrer utilisateur';
      document.getElementById('cancelUserEdit').hidden = false;
      document.getElementById('newUsername').focus();
    });
  });
}

function resetGroupFormMode() {
  document.getElementById('groupForm').reset();
  document.getElementById('groupEditId').value = '';
  document.getElementById('groupSubmitBtn').textContent = 'Créer groupe';
  document.getElementById('cancelGroupEdit').hidden = true;
}

function resetUserFormMode() {
  document.getElementById('userForm').reset();
  document.getElementById('userEditId').value = '';
  document.getElementById('newPassword').placeholder = 'Minimum 8 caractères';
  document.getElementById('newPassword').required = true;
  document.getElementById('userSubmitBtn').textContent = 'Créer utilisateur';
  document.getElementById('cancelUserEdit').hidden = true;
}

function renderUserGroupOptions() {
  const select = document.getElementById('newUserGroup');
  select.innerHTML = authGroups.map((g) => `<option value="${escapeHtml(g.id)}">${escapeHtml(g.full_name)} (${escapeHtml(g.name)})</option>`).join('');
}

async function loadAdminSettingsData() {
  const [groups, users] = await Promise.all([
    apiFetch('/api/admin/groups'),
    apiFetch('/api/admin/users')
  ]);
  authGroups = groups;
  authUsers = users;
  renderGroupsList();
  renderUsersList();
  renderUserGroupOptions();
}

document.getElementById('settingsBtn').addEventListener('click', async (e) => {
  e.stopPropagation();
  if (!currentSession?.is_admin) return;
  const settingsModal = document.getElementById('settingsModal');
  setTimeout(() => {
    settingsModal.hidden = false;
    settingsModal.dataset.ignoreBackdropUntil = String(Date.now() + 250);
  }, 0);
  try {
    await loadAdminSettingsData();
  } catch (err) {
    toast(err.message, 'error');
  }
});

document.getElementById('permAdmin').addEventListener('change', (e) => {
  const checked = e.target.checked;
  ['permCreateRental', 'permCreateEquipment', 'permUndoReturn', 'permConfirmReturn'].forEach((id) => {
    const cb = document.getElementById(id);
    cb.checked = checked || cb.checked;
  });
});

document.getElementById('groupForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const editId = document.getElementById('groupEditId').value;
    const isEdit = !!editId;
    await apiFetch(isEdit ? `/api/admin/groups/${editId}` : '/api/admin/groups', {
      method: isEdit ? 'PUT' : 'POST',
      body: JSON.stringify({
        name: document.getElementById('groupName').value.trim(),
        full_name: document.getElementById('groupFullName').value.trim(),
        permissions: {
          admin: document.getElementById('permAdmin').checked,
          create_rental: document.getElementById('permCreateRental').checked,
          create_equipment: document.getElementById('permCreateEquipment').checked,
          undo_return: document.getElementById('permUndoReturn').checked,
          confirm_return: document.getElementById('permConfirmReturn').checked
        }
      })
    });
    resetGroupFormMode();
    await loadAdminSettingsData();
    toast(isEdit ? 'Groupe modifié' : 'Groupe créé', 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
});

document.getElementById('userForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const editId = document.getElementById('userEditId').value;
    const isEdit = !!editId;
    await apiFetch(isEdit ? `/api/admin/users/${editId}` : '/api/admin/users', {
      method: isEdit ? 'PUT' : 'POST',
      body: JSON.stringify({
        username: document.getElementById('newUsername').value.trim(),
        password: document.getElementById('newPassword').value,
        full_name: document.getElementById('newFullName').value.trim(),
        group_id: document.getElementById('newUserGroup').value
      })
    });
    resetUserFormMode();
    await loadAdminSettingsData();
    toast(isEdit ? 'Utilisateur modifié' : 'Utilisateur créé', 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
});

document.getElementById('cancelGroupEdit').addEventListener('click', () => {
  resetGroupFormMode();
});

document.getElementById('cancelUserEdit').addEventListener('click', () => {
  resetUserFormMode();
});

document.getElementById('logoutBtn').addEventListener('click', async () => {
  try {
    await fetch(API + '/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
  } catch (_) {}
  window.location.href = '/login.html';
});
document.getElementById('historySearch').addEventListener('input', renderHistory);
document.getElementById('historyFilter').addEventListener('change', renderHistory);
document.getElementById('historyList').addEventListener('scroll', () => {
  const container = document.getElementById('historyList');
  if (document.getElementById('historyModal').hidden) return;
  if (historyRenderedCount >= historyFilteredList.length) return;
  if (container.scrollTop + container.clientHeight >= container.scrollHeight - 120) {
    renderHistoryChunk(false);
  }
});

function renderHistory() {
  const q = document.getElementById('historySearch').value.toLowerCase().trim();
  const filter = document.getElementById('historyFilter').value;
  const today = new Date(); today.setHours(0,0,0,0);

  // Section équipements archivés (si filter = archived)
  const archivedContainer = document.getElementById('archivedList');

  if (filter === 'archived_equipment') {
    document.getElementById('historyList').hidden = true;
    archivedContainer.hidden = false;
    renderArchivedEquipment(q);
    return;
  }
  document.getElementById('historyList').hidden = false;
  archivedContainer.hidden = true;

  let list = rentals.map(r => {
    const eq = equipmentAll.find(x => x.id === r.equipment_id);
    const eqName = eq ? eq.name : (r.equipment_name_snapshot || '(équipement supprimé)');
    const eqArchived = !!eq?.archived_at;
    const status = rentalStatus(r, today);
    return { ...r, eqName, eqArchived, status };
  });

  if (filter !== 'all') list = list.filter(r => r.status === filter);
  if (q) {
    list = list.filter(r =>
      r.client.toLowerCase().includes(q) ||
      r.eqName.toLowerCase().includes(q) ||
      (r.note || '').toLowerCase().includes(q) ||
      (r.phone || '').toLowerCase().includes(q)
    );
  }

  list.sort((a, b) => b.start_date.localeCompare(a.start_date));

  const stats = {
    total: rentals.length,
    active: rentals.filter(r => rentalStatus(r, today) === 'active').length,
    late: rentals.filter(r => rentalStatus(r, today) === 'late').length,
    returned: rentals.filter(r => r.returned_at).length,
    archivedEq: equipmentAll.filter(e => e.archived_at).length
  };
  document.getElementById('historyStats').innerHTML = `
    <span class="stat-chip">Total : ${stats.total}</span>
    <span class="stat-chip" style="color:var(--accent-dark)">En cours : ${stats.active}</span>
    <span class="stat-chip" style="color:var(--danger)">En retard : ${stats.late}</span>
    <span class="stat-chip" style="color:var(--ink-soft)">Retournées : ${stats.returned}</span>
    <span class="stat-chip" style="color:var(--ink-soft)">Éq. archivés : ${stats.archivedEq}</span>
  `;

  const container = document.getElementById('historyList');
  historyFilteredList = list;
  historyRenderedCount = 0;
  renderHistoryChunk(true);
}

function buildHistoryItemHtml(r) {
  const start = parseISODate(r.start_date);
  const end = parseISODate(r.end_date);
  const nbDays = daysBetween(start, end) + 1;
  const statusLabel = r.status === 'active' ? 'En cours' : r.status === 'late' ? 'En retard' : 'Retournée';
  const returnedInfo = r.returned_at ? ` · Retourné le ${new Date(r.returned_at).toLocaleDateString('fr-CA')}` : '';
  const createdByInfo = r.created_by ? `Créée par ${escapeHtml(r.created_by)}` : '';
  const returnedByInfo = r.returned_by ? `Retour confirmé par ${escapeHtml(r.returned_by)}` : '';
  const auditLine = (createdByInfo || returnedByInfo)
    ? `<br>👤 ${createdByInfo}${createdByInfo && returnedByInfo ? ' · ' : ''}${returnedByInfo}`
    : '';
  const archivedBadge = r.eqArchived ? ' <span class="mini-badge">équipement archivé</span>' : '';
  return `
    <div class="history-item ${r.status}" data-id="${r.id}">
      <div>
        <div class="item-title">${escapeHtml(r.client)} — ${escapeHtml(r.eqName)}${archivedBadge}</div>
        <div class="item-details">
          📅 ${fmtDateFull(start)} → ${fmtDateFull(end)} (${nbDays}j)${returnedInfo}
          ${auditLine}
          ${r.phone ? ` · 📞 ${escapeHtml(r.phone)}` : ''}
          ${r.note ? `<br>📝 ${escapeHtml(r.note)}` : ''}
        </div>
      </div>
      <span class="item-status status-${r.status}">${statusLabel}</span>
    </div>
  `;
}

function wireHistoryItemClicks(container) {
  container.querySelectorAll('.history-item').forEach((el) => {
    if (el.dataset.bound === '1') return;
    el.dataset.bound = '1';
    el.addEventListener('click', () => {
      const rental = rentals.find((r) => r.id === el.dataset.id);
      if (rental) {
        closeModal('historyModal');
        openPostitModal(rental);
      }
    });
  });
}

function renderHistoryChunk(reset = false) {
  const container = document.getElementById('historyList');
  if (reset) {
    container.innerHTML = '';
    container.scrollTop = 0;
    historyRenderedCount = 0;
  }

  if (historyFilteredList.length === 0) {
    container.innerHTML = '<div class="history-empty">Aucun résultat</div>';
    return;
  }

  const chunk = historyFilteredList.slice(historyRenderedCount, historyRenderedCount + HISTORY_PAGE_SIZE);
  if (chunk.length > 0) {
    container.insertAdjacentHTML('beforeend', chunk.map(buildHistoryItemHtml).join(''));
    historyRenderedCount += chunk.length;
    wireHistoryItemClicks(container);
  }

  const existingMore = container.querySelector('.history-load-more-wrap');
  if (existingMore) existingMore.remove();
  if (historyRenderedCount < historyFilteredList.length) {
    const remaining = historyFilteredList.length - historyRenderedCount;
    container.insertAdjacentHTML('beforeend', `
      <div class="history-load-more-wrap">
        <button type="button" class="btn btn-outline btn-sm history-load-more-btn">Afficher plus (${remaining})</button>
      </div>
    `);
    const moreBtn = container.querySelector('.history-load-more-btn');
    if (moreBtn) {
      moreBtn.addEventListener('click', () => renderHistoryChunk(false));
    }
  }
}

function renderArchivedEquipment(q) {
  const archived = equipmentAll.filter(e => e.archived_at);
  const filtered = q
    ? archived.filter(e => e.name.toLowerCase().includes(q) || (e.code || '').toLowerCase().includes(q))
    : archived;

  const c = document.getElementById('archivedList');
  if (filtered.length === 0) {
    c.innerHTML = '<div class="history-empty">Aucun équipement archivé</div>';
    return;
  }

  c.innerHTML = filtered.map(e => {
    const count = rentals.filter(r => r.equipment_id === e.id).length;
    return `
      <div class="history-item" data-id="${e.id}">
        <div>
          <div class="item-title">${escapeHtml(e.name)}${e.code ? ` · ${escapeHtml(e.code)}` : ''}</div>
          <div class="item-details">
            ${count} location(s) dans l'historique · Archivé le ${new Date(e.archived_at).toLocaleDateString('fr-CA')}
          </div>
        </div>
        ${hasPermission('create_equipment') ? `<button class="btn btn-outline btn-sm restore-btn" data-id="${e.id}">Restaurer</button>` : ''}
      </div>
    `;
  }).join('');

  c.querySelectorAll('.restore-btn').forEach(btn => {
    btn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const id = btn.dataset.id;
      btn.disabled = true;
      try {
        await apiFetch(`/api/equipment/${id}/restore`, { method: 'POST' });
        toast('Équipement restauré', 'success');
        renderHistory();
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        btn.disabled = false;
      }
    });
  });
}

// =========================================================
// NAVIGATION
// =========================================================
document.getElementById('prevWeek').addEventListener('click', () => {
  currentWeekStart = addDays(currentWeekStart, -7);
  render();
});
document.getElementById('nextWeek').addEventListener('click', () => {
  currentWeekStart = addDays(currentWeekStart, 7);
  render();
});
document.getElementById('todayBtn').addEventListener('click', () => {
  currentWeekStart = getMonday(new Date());
  render();
});
document.getElementById('addRowBtn').addEventListener('click', () => {
  if (!hasPermission('create_equipment')) {
    toast('Vous n\'avez pas la permission de créer des équipements.', 'error');
    return;
  }
  openRowModal(null);
});

// =========================================================
// MODAL HELPERS — fermeture protégée
// =========================================================
document.querySelectorAll('[data-close]').forEach(el => {
  el.addEventListener('click', async (e) => {
    const modal = e.target.closest('.modal');
    if (!modal) return;
    if (await confirmDiscardIfDirty(modal)) modal.hidden = true;
  });
});

// Fermer sur clic explicite du backdrop.
document.querySelectorAll('.modal-backdrop').forEach(backdrop => {
  backdrop.addEventListener('click', async (e) => {
    const modal = e.target.closest('.modal');
    if (!modal) return;
    const ignoreUntil = Number(modal.dataset.ignoreBackdropUntil || '0');
    if (Date.now() < ignoreUntil) return;
    if (await confirmDiscardIfDirty(modal)) modal.hidden = true;
  });
});

function closeModal(id) { document.getElementById(id).hidden = true; }

document.addEventListener('keydown', async (e) => {
  if (e.key === 'Escape') {
    const openModals = document.querySelectorAll('.modal:not([hidden])');
    for (const m of openModals) {
      if (await confirmDiscardIfDirty(m)) m.hidden = true;
    }
  }
});

async function confirmDiscardIfDirty(modal) {
  if (modal.id === 'rowModal' && rowModalDirty) {
    return await confirmDialog({
      title: 'Abandonner les modifications ?',
      body: 'Les changements non enregistrés seront perdus.',
      action: 'Abandonner',
      danger: true
    });
  }
  if (modal.id === 'postitModal' && postitModalDirty) {
    return await confirmDialog({
      title: 'Abandonner les modifications ?',
      body: 'Les changements non enregistrés seront perdus.',
      action: 'Abandonner',
      danger: true
    });
  }
  return true;
}

// =========================================================
// TOAST
// =========================================================
let toastTimer;
function toast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast ' + type;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

// =========================================================
// CONFIRM DIALOG (remplace confirm() natif)
// =========================================================
function confirmDialog({ title, body, action = 'Confirmer', cancelText = 'Annuler', danger = false } = {}) {
  return new Promise(resolve => {
    const modal = document.getElementById('confirmModal');
    document.getElementById('confirmTitle').textContent = title || 'Confirmer';
    document.getElementById('confirmBody').textContent = body || '';
    const okBtn = document.getElementById('confirmOk');
    const cancelBtn = document.getElementById('confirmCancel');
    okBtn.textContent = action;
    okBtn.className = 'btn ' + (danger ? 'btn-danger' : 'btn-primary');
    cancelBtn.textContent = cancelText;

    const cleanup = () => {
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      modal.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey);
      modal.hidden = true;
    };
    const onOk = () => { cleanup(); resolve(true); };
    const onCancel = () => { cleanup(); resolve(false); };
    const onBackdrop = (e) => { if (e.target === modal) onCancel(); };
    const onKey = (e) => {
      if (e.key === 'Escape') onCancel();
      if (e.key === 'Enter') onOk();
    };

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    modal.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey);

    modal.hidden = false;
    setTimeout(() => cancelBtn.focus(), 50);
  });
}

// =========================================================
// UTILS
// =========================================================
function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Empêcher la fermeture accidentelle de l'onglet quand un formulaire est modifié
window.addEventListener('beforeunload', (e) => {
  if (rowModalDirty || postitModalDirty) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// =========================================================
// Messages de validation en français (HTML5)
// =========================================================
function wireFrenchValidation() {
  const messages = {
    valueMissing: 'Ce champ est requis.',
    typeMismatch: 'Format invalide.',
    badInput: 'Valeur invalide.',
    rangeUnderflow: 'Valeur trop petite.',
    rangeOverflow: 'Valeur trop grande.',
    tooShort: 'Texte trop court.',
    tooLong: 'Texte trop long.',
    patternMismatch: 'Format invalide.'
  };
  document.querySelectorAll('input, textarea, select').forEach(el => {
    el.addEventListener('invalid', () => {
      const v = el.validity;
      for (const key in messages) {
        if (v[key]) { el.setCustomValidity(messages[key]); return; }
      }
      el.setCustomValidity('');
    });
    el.addEventListener('input', () => el.setCustomValidity(''));
    el.addEventListener('change', () => el.setCustomValidity(''));
  });
}

// =========================================================
// INIT
// =========================================================
const settingsBtnInit = document.getElementById('settingsBtn');
if (settingsBtnInit) settingsBtnInit.hidden = true;
const addRowBtnInit = document.getElementById('addRowBtn');
if (addRowBtnInit) addRowBtnInit.hidden = true;

loadSession().then(() => {
  loadAll().then(() => { connectSSE(); wireFrenchValidation(); });
});
