const $ = id => document.getElementById(id);
const labels = { systemName: '시스템명', url: 'URL', commonAccount: '공통계정', ip: 'IP', servicePort: '서비스포트', sshPort: 'SSH포트', serverAccount: '서버계정', externalAccess: '외부접근가능여부', notes: '비고', groupId: '그룹', components: '하위 정보', deleted: '삭제 상태' };
const componentTypes = { WAS: 'WAS', WEB: 'WEB', DB: 'DB', PROXY: 'Reverse Proxy', OTHER: '기타' };
const componentFields = ['name', 'url', 'ip', 'externalAccess', 'servicePort', 'sshPort', 'commonAccount', 'serverAccount', 'notes'];
let componentSequence = 0;
const accessLabels = { yes: '가능', no: '불가', unknown: '미확인' };
let sites = [];
let groups = [];
let editingGroup = null;
let deletingGroup = null;
const collapsedGroups = new Set();
const collapsedSystems = new Set();
let currentUser = null;
let registerMode = false;
let editing = null;
let deleting = null;
let histories = [];
let historyRequest = 0;
let listRequest = 0;
let toastTimer;
const revealed = new Set();

function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]); }
function formatActor(name, jobTitle) { return [name, jobTitle].filter(Boolean).join(' '); }
function componentLabel(type, field) { return type === 'DB' && field === 'commonAccount' ? 'DB계정' : type === 'DB' && field === 'servicePort' ? 'DB포트' : labels[field]; }
function componentUrl(site, component) { return ['WEB', 'PROXY'].includes(component.type) ? site.url : component.type === 'OTHER' ? component.url : ''; }
function formatDate(date, short = false) {
  return new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: short ? undefined : 'numeric', month: '2-digit', day: '2-digit', hour: short ? undefined : '2-digit', minute: short ? undefined : '2-digit', second: short ? undefined : '2-digit', hour12: false }).format(new Date(date));
}
function errorAt(id, message = '') { $(id).textContent = message; $(id).hidden = !message; }
function toast(message) { clearTimeout(toastTimer); $('toast').textContent = message; $('toast').hidden = false; toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4000); }
async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(path, { method, credentials: 'same-origin', headers: method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-Requested-With': 'dev-site-list' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && currentUser) { showAuth(); errorAt('auth-error', '로그인이 만료되었습니다. 다시 로그인해 주세요.'); }
    throw new Error(data.error ?? '요청에 실패했습니다.');
  }
  return data;
}
function showAuth() {
  currentUser = null; sites = []; groups = []; collapsedGroups.clear(); collapsedSystems.clear(); histories = []; revealed.clear(); listRequest++; historyRequest++;
  document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
  $('group-form').reset(); $('group-list').replaceChildren(); $('site-form').reset(); $('component-editors').replaceChildren(); $('history-content').replaceChildren(); $('active-rows').replaceChildren(); $('deleted-rows').replaceChildren();
  $('auth-form').reset(); $('app-view').hidden = true; $('auth-view').hidden = false; $('boot').hidden = true;
}
async function showApp(user) {
  currentUser = user; $('user-name').textContent = `${user.name}님`; $('user-avatar').textContent = user.name.slice(0, 1);
  $('user-account').textContent = `${user.username} · ${user.jobTitle}`;
  $('auth-form').reset(); errorAt('auth-error'); $('auth-view').hidden = true; $('boot').hidden = true; $('app-view').hidden = false;
  $('deleted-section').open = false; $('search').value = ''; $('access-filter').value = 'all';
  await loadSites();
}
async function loadSites() {
  const request = ++listRequest;
  $('refresh').disabled = true;
  try {
    const data = await api('/api/sites');
    if (request !== listRequest || !currentUser) return;
    sites = data.sites; groups = data.groups; revealed.clear(); errorAt('list-error'); render(); renderGroupList();
    $('last-loaded').textContent = `불러온 시간 ${formatDate(new Date())}`;
    return true;
  } catch (error) { if (request === listRequest) errorAt($('group-dialog').open ? 'group-error' : 'list-error', error.message || '목록을 불러오지 못했습니다. 새로고침해 주세요.'); }
  finally { $('refresh').disabled = false; }
}
function matches(site) {
  const query = $('search').value.trim().toLocaleLowerCase();
  const filter = $('access-filter').value;
  const values = [site.systemName, site.url, site.ip, site.notes, groupPath(site.groupId), ...(site.components ?? []).flatMap(component => [componentTypes[component.type], component.name, componentUrl(site, component), component.useSystemIp ? site.ip : component.ip, component.notes])];
  return (filter === 'all' || site.externalAccess === filter) && (!query || values.some(value => value.toLocaleLowerCase().includes(query)));
}
function secretCell(site, field, componentIndex = null) {
  const item = componentIndex === null ? site : site.components[componentIndex];
  const accountLabel = componentIndex !== null && item.type === 'DB' && field === 'commonAccount' ? '<span class="account-label">DB계정</span>' : '';
  if (!item[field]) return `${accountLabel}<span class="dash">—</span>`;
  const key = `${site.id}:${componentIndex ?? 'system'}:${field}`;
  const open = revealed.has(key);
  return `${accountLabel}${open ? `<span class="secret-value">${escapeHtml(item[field])}</span>` : ''}<button class="secret-button" data-action="secret" data-id="${site.id}" ${componentIndex === null ? '' : `data-component="${componentIndex}"`} data-field="${field}" aria-label="${escapeHtml(item.name ?? site.systemName)} ${componentLabel(item.type, field)} ${open ? '숨기기' : '보기'}" aria-pressed="${open}">${open ? '숨기기' : '•••••• 보기'}</button>`;
}
function componentRows(site, depth) {
  return (site.components ?? []).map((component, index) => {
    const value = key => escapeHtml(component[key]) || '<span class="dash">—</span>';
    const inherited = (key, same) => same ? `${escapeHtml(site[key]) || '미등록'}<span class="inherited-label">시스템과 동일</span>` : value(key);
    const url = componentUrl(site, component);
    const systemUrl = ['WEB', 'PROXY'].includes(component.type);
    return `<tr class="component-row"><td></td><td class="system-name"><span class="tree-indent" aria-hidden="true">${'　'.repeat(depth)}└ </span><span class="component-type">${componentTypes[component.type]}</span>${value('name')}</td><td>${url ? `<a class="url-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)} ↗</a>` : '<span class="dash">—</span>'}${systemUrl ? `<span class="inherited-label">${url ? '시스템과 동일' : '시스템 URL 미등록'}</span>` : ''}</td><td>${secretCell(site, 'commonAccount', index)}</td><td class="mono">${inherited('ip', component.useSystemIp)}</td><td class="mono">${value('servicePort')}</td><td class="mono">${inherited('sshPort', component.useSystemSshPort)}</td><td>${secretCell(site, 'serverAccount', index)}</td><td><span class="badge ${component.externalAccess}">${accessLabels[component.externalAccess]}</span></td><td class="notes">${value('notes')}</td><td>${site.deletedAt ? '' : `<div class="row-actions"><button data-action="edit-component" data-id="${site.id}" data-component="${index}">하위 정보 수정</button></div>`}</td></tr>`;
  }).join('');
}
function row(site, depth = 0) {
  const value = key => site[key] ? escapeHtml(site[key]) : '<span class="dash">—</span>';
  const url = site.url ? new URL(site.url) : null;
  const count = site.components?.length ?? 0;
  const filtering = Boolean($('search').value.trim()) || $('access-filter').value !== 'all';
  const open = filtering || !collapsedSystems.has(site.id);
  const controls = `<span class="component-controls">${count ? `<button class="component-toggle" data-action="toggle-components" data-id="${site.id}" aria-label="${escapeHtml(site.systemName)} 하위 정보 ${count}개 ${open ? '접기' : '펼치기'}" aria-expanded="${open}" ${filtering ? 'disabled title="검색·필터 적용 중에는 하위 정보를 자동으로 펼칩니다."' : ''}><span aria-hidden="true">${open ? '▾' : '▸'}</span> 하위 정보 ${count}개</button>` : '<span class="row-meta">하위 정보 없음</span>'}${site.deletedAt ? '' : `<button class="component-link" data-action="components" data-id="${site.id}">추가·수정</button>`}</span>`;
  return `<tr><td class="row-number"></td><td class="system-name">${depth ? `<span class="tree-indent" aria-hidden="true">${'　'.repeat(depth - 1)}└ </span>` : ''}${escapeHtml(site.systemName)}${controls}<span class="row-meta">${site.deletedAt ? `${escapeHtml(groupPath(site.groupId))} · 삭제 ` : ''}${formatDate(site.updatedAt, true)} · ${escapeHtml(formatActor(site.updatedBy, site.updatedByJobTitle))}</span></td><td>${url ? `<a class="url-link" href="${escapeHtml(site.url)}" target="_blank" rel="noopener noreferrer"><span class="protocol">${url.protocol}//</span>${escapeHtml(site.url.slice(url.protocol.length + 2))}<span class="url-arrow" aria-hidden="true">↗</span></a>` : '<span class="dash">—</span>'}</td><td>${secretCell(site, 'commonAccount')}</td><td class="mono">${value('ip')}</td><td class="mono">${value('servicePort')}</td><td class="mono">${value('sshPort')}</td><td>${secretCell(site, 'serverAccount')}</td><td><span class="badge ${site.externalAccess}">${accessLabels[site.externalAccess]}</span></td><td class="notes">${value('notes')}</td><td><div class="row-actions">${site.deletedAt ? `<button class="delete-button" data-action="permanent-delete" data-id="${site.id}">완전 삭제</button>` : `<button data-action="edit" data-id="${site.id}">수정</button><button class="delete-button" data-action="delete" data-id="${site.id}">삭제</button>`}<button class="history-button" data-action="history" data-id="${site.id}">기록보기 <span aria-hidden="true">↗</span></button></div></td></tr>${open ? componentRows(site, depth) : ''}`;
}
function render() {
  const active = sites.filter(site => !site.deletedAt);
  const deleted = sites.filter(site => site.deletedAt);
  const shown = active.filter(matches);
  const removed = deleted.filter(matches);
  $('active-count').textContent = active.length; $('external-count').textContent = active.filter(site => site.externalAccess === 'yes').length;
  $('deleted-count').textContent = deleted.length; $('deleted-summary-count').textContent = deleted.length; $('result-count').textContent = `${shown.length} / ${active.length}`;
  renderTree(shown, active.length);
  $('deleted-rows').innerHTML = removed.length ? removed.map(site => row(site)).join('') : `<tr><td colspan="11" class="empty-cell">${deleted.length ? '검색 조건에 맞는 삭제된 시스템이 없습니다.' : '삭제된 시스템이 없습니다.'}</td></tr>`;
  for (const id of ['active-rows', 'deleted-rows']) {
    $(id).querySelectorAll('.row-number').forEach((cell, index) => { cell.textContent = String(index + 1).padStart(2, '0'); });
  }
}
function groupPath(id) {
  const names = [];
  for (let group = groups.find(item => item.id === id); group; group = groups.find(item => item.id === group.parentId)) names.unshift(group.name);
  return names.join(' / ') || '미분류';
}
function orderedGroups(parentId = null, depth = 0) {
  return groups.filter(group => group.parentId === parentId).sort((a, b) => a.name.localeCompare(b.name, 'ko') || a.id - b.id).flatMap(group => [{ ...group, depth }, ...orderedGroups(group.id, depth + 1)]);
}
function groupOptions(emptyLabel, excludedId = null) {
  const excluded = new Set(excludedId ? [excludedId] : []);
  return `<option value="">${emptyLabel}</option>` + orderedGroups().map(group => {
    if (excluded.has(group.parentId)) excluded.add(group.id);
    return excluded.has(group.id) ? '' : `<option value="${group.id}">${escapeHtml(groupPath(group.id))}</option>`;
  }).join('');
}
function renderTree(shown, total) {
  const filtering = Boolean($('search').value.trim()) || $('access-filter').value !== 'all';
  function branch(group, depth) {
    const children = groups.filter(item => group.id !== null && item.parentId === group.id).sort((a, b) => a.name.localeCompare(b.name, 'ko') || a.id - b.id).map(child => branch(child, depth + 1));
    const members = shown.filter(site => site.groupId === group.id);
    const count = members.length + children.reduce((sum, child) => sum + child.count, 0);
    if (filtering && !count) return { count: 0, html: '' };
    const open = filtering || !collapsedGroups.has(group.id);
    const header = `<tr class="group-row"><td></td><td colspan="10"><button class="group-toggle" data-group-id="${group.id ?? ''}" aria-expanded="${open}" ${filtering ? 'disabled title="검색·필터 적용 중에는 일치하는 그룹을 자동으로 펼칩니다."' : ''}><span class="tree-indent" aria-hidden="true">${'　'.repeat(depth)}</span><span class="group-chevron" aria-hidden="true">${open ? '▾' : '▸'}</span><span class="group-label">${escapeHtml(group.name)}</span><span class="group-count">${count}개</span></button></td></tr>`;
    return { count, html: header + (open ? children.map(child => child.html).join('') + members.map(site => row(site, depth + 1)).join('') + (!count && !children.length ? '<tr><td></td><td colspan="10" class="empty-group">등록된 서버가 없습니다. 시스템 수정에서 이 그룹을 지정하세요.</td></tr>' : '') : '') };
  }
  const roots = groups.filter(group => group.parentId === null).sort((a, b) => a.name.localeCompare(b.name, 'ko') || a.id - b.id);
  let html = roots.map(group => branch(group, 0).html).join('');
  if (shown.some(site => site.groupId === null)) html += branch({ id: null, name: '미분류' }, 0).html;
  $('active-rows').innerHTML = html || `<tr><td colspan="11" class="empty-cell">${total ? '검색 조건에 맞는 시스템이 없습니다.' : '등록된 시스템이 없습니다. 첫 번째 시스템을 추가해 주세요.'}</td></tr>`;
  $('collapse-groups').disabled = filtering;
}
function renderGroupList() {
  $('group-list').innerHTML = orderedGroups().map(group => {
    const count = sites.filter(site => site.groupId === group.id).length;
    return `<li><span class="group-list-name"><span class="tree-indent" aria-hidden="true">${'　'.repeat(group.depth)}${group.depth ? '└ ' : ''}</span>${escapeHtml(group.name)}<small>직접 소속 ${count}개${sites.some(site => site.groupId === group.id && site.deletedAt) ? ' (삭제된 목록 포함)' : ''}</small></span><div class="row-actions"><button type="button" data-group-action="edit" data-id="${group.id}" aria-label="${escapeHtml(groupPath(group.id))} 수정">수정</button><button type="button" class="delete-button" data-group-action="delete" data-id="${group.id}" aria-label="${escapeHtml(groupPath(group.id))} 삭제">삭제</button></div></li>`;
  }).join('') || '<li class="muted">등록된 그룹이 없습니다. 아래에서 첫 그룹을 추가하세요.</li>';
}
function editGroup(group = null) {
  editingGroup = group; $('group-form').reset(); errorAt('group-error');
  $('group-editor-title').textContent = group ? '그룹 수정' : '그룹 추가';
  $('save-group').textContent = group ? '변경 저장' : '그룹 추가';
  $('group-name').value = group?.name ?? '';
  $('group-parent').innerHTML = groupOptions('최상위', group?.id);
  $('group-parent').value = group?.parentId ?? '';
}
function openEditor(site = null) {
  editing = site; $('site-form').reset(); errorAt('editor-error');
  $('editor-title').textContent = site ? '시스템 수정' : '시스템 추가';
  const data = site ?? { externalAccess: 'unknown' };
  $('groupId').innerHTML = groupOptions('미분류');
  for (const field of Object.keys(labels).filter(field => !['deleted', 'components'].includes(field))) $(field).value = data[field] ?? '';
  $('component-editors').replaceChildren();
  for (const component of data.components ?? []) addComponentEditor(component);
  $('components-empty').hidden = Boolean(data.components?.length);
  $('editor').showModal(); $('systemName').focus();
}
function addComponentEditor(component = null) {
  const item = component ?? { type: 'WAS', externalAccess: 'unknown', useSystemIp: true, useSystemSshPort: true };
  const id = `component-${++componentSequence}`;
  const card = document.createElement('details'); card.className = 'component-editor'; card.open = !component;
  card.dataset.savedUrl = item.url ?? '';
  card.innerHTML = `<summary><span class="component-summary"></span></summary><div class="form-grid"><div><label for="${id}-type">구분</label><select id="${id}-type" data-field="type">${Object.entries(componentTypes).map(([type, label]) => `<option value="${type}">${label}</option>`).join('')}</select></div>${componentFields.map(field => {
    const label = field === 'name' ? '항목명' : labels[field];
    const max = field === 'name' ? 100 : field === 'notes' ? 4000 : field === 'ip' ? 45 : 2000;
    const input = ['commonAccount', 'serverAccount', 'notes'].includes(field) ? `<textarea id="${id}-${field}" data-field="${field}" rows="2" maxlength="${max}" spellcheck="false"></textarea>` : field === 'externalAccess' ? `<select id="${id}-${field}" data-field="${field}">${Object.entries(accessLabels).map(([value, text]) => `<option value="${value}">${text}</option>`).join('')}</select>` : `<input id="${id}-${field}" data-field="${field}" type="${field === 'url' ? 'url' : 'text'}" maxlength="${max}" ${field === 'name' ? 'required placeholder="예: Tomcat, Nginx, PostgreSQL"' : ''}>`;
    const same = field === 'ip' ? 'useSystemIp' : field === 'sshPort' ? 'useSystemSshPort' : null;
    return `<div class="${['url', 'notes'].includes(field) ? 'full' : ''}"><label for="${id}-${field}">${label}${field === 'name' ? ' <span class="required">*</span>' : ''}</label>${input}${same ? `<label class="inherit-option"><input type="checkbox" data-field="${same}" aria-label="${label}: 시스템과 동일"> 시스템과 동일</label>` : ''}</div>${field === 'url' ? '<p class="component-url-note full muted" hidden></p>' : ''}`;
  }).join('')}</div><button type="button" class="text-button remove-component">하위 항목 삭제</button>`;
  for (const control of card.querySelectorAll('[data-field]')) {
    if (control.type === 'checkbox') control.checked = item[control.dataset.field] ?? false;
    else control.value = item[control.dataset.field] ?? '';
  }
  $('component-editors').append(card); $('components-empty').hidden = true;
  syncComponentEditor(card);
  return card;
}
function syncComponentEditor(card) {
  const control = field => card.querySelector(`[data-field="${field}"]`);
  const type = control('type').value;
  card.querySelector('.component-summary').textContent = `${componentTypes[type]} · ${control('name').value || '새 하위 항목'}`;
  control('name').placeholder = ({ WAS: '예: Tomcat, WildFly', WEB: '예: Nginx, Apache', DB: '예: PostgreSQL, MySQL', PROXY: '예: Traefik, HAProxy', OTHER: '예: Redis, 관리 도구' })[type];
  control('url').closest('div').hidden = type !== 'OTHER';
  control('url').disabled = type !== 'OTHER';
  const urlNote = card.querySelector('.component-url-note');
  urlNote.hidden = !['WEB', 'PROXY'].includes(type);
  urlNote.textContent = `접속 URL은 시스템과 동일합니다: ${$('url').value || '시스템 URL 미등록'}`;
  for (const field of ['commonAccount', 'servicePort']) card.querySelector(`label[for="${control(field).id}"]`).textContent = componentLabel(type, field);
  control('commonAccount').placeholder = type === 'DB' ? 'DB 사용자 / 비밀번호' : '아이디 / 비밀번호';
  for (const [field, same] of [['ip', 'useSystemIp'], ['sshPort', 'useSystemSshPort']]) {
    const input = control(field); const checked = control(same).checked;
    if (checked && !input.disabled) input.dataset.manualValue = input.value;
    if (checked) input.value = $(field).value;
    else if (input.disabled) input.value = input.dataset.manualValue ?? '';
    input.disabled = checked;
    input.placeholder = checked ? '시스템에 미등록' : '';
  }
}
function readComponents() {
  return [...$('component-editors').children].map(card => {
    const component = Object.fromEntries([...card.querySelectorAll('[data-field]')].map(control => [control.dataset.field, control.type === 'checkbox' ? control.checked : control.disabled ? '' : control.value]));
    if (component.type !== 'OTHER') component.url = card.dataset.savedUrl;
    return component;
  });
}
async function openHistory(site) {
  const request = ++historyRequest;
  histories = []; $('history-system').textContent = site.systemName; $('history-content').textContent = '기록을 불러오는 중입니다…'; $('history-dialog').showModal();
  try {
    const data = await api(`/api/sites/${site.id}/history`);
    if (request !== historyRequest || !$('history-dialog').open) return;
    histories = data.history; renderHistory();
  } catch (error) { if (request === historyRequest) $('history-content').textContent = error.message; }
}
function historyValue(field, value, reveal, snapshot) {
  if (field === 'components') return (value ?? []).map(component => {
    const details = componentFields.filter(key => key !== 'name').map(key => {
      const same = key === 'ip' && component.useSystemIp || key === 'sshPort' && component.useSystemSshPort;
      if (!same && !component[key]) return '';
      return `${componentLabel(component.type, key)}: ${same ? `시스템과 동일 (${escapeHtml(snapshot?.[key]) || '미등록'})` : historyValue(key, component[key], reveal, snapshot)}`;
    }).filter(Boolean).join('\n');
    return `${componentTypes[component.type]} · ${escapeHtml(component.name)}\n${details}`;
  }).join('\n\n') || '—';
  if (field === 'groupId') return escapeHtml(snapshot?.groupName ?? groupPath(value));
  if (value === null || value === undefined || value === '') return '—';
  if (field === 'deleted') return value ? '삭제됨' : '사용 중';
  if (field === 'externalAccess') return accessLabels[value];
  if (['commonAccount', 'serverAccount'].includes(field) && !reveal) return '•••••• (계정 정보)';
  return escapeHtml(value);
}
function renderHistory(reveal = false) {
  $('history-content').innerHTML = histories.map(event => {
    const changes = Object.keys(labels).filter(field => field === 'components' ? JSON.stringify(event.before?.components ?? []) !== JSON.stringify(event.after.components ?? []) : event.before ? (event.before[field] ?? null) !== (event.after[field] ?? null) : event.after[field] != null && event.after[field] !== '' && field !== 'deleted');
    return `<article class="history-item"><div class="history-head"><span class="action-badge ${event.action}">${({ create: '추가', update: '수정', delete: '삭제' })[event.action]}</span><strong>${escapeHtml(formatActor(event.actor, event.actorJobTitle))}</strong><time datetime="${event.changedAt}">${formatDate(event.changedAt)}</time></div><div class="change-list">${changes.map(field => `<div class="change-row"><span class="change-label">${labels[field]}</span><span class="change-value change-before">${historyValue(field, event.before?.[field], reveal, event.before)}</span><span class="change-arrow" aria-label="변경 후">→</span><span class="change-value change-after">${historyValue(field, event.after[field], reveal, event.after)}</span></div>`).join('')}</div><div class="backup-caption">${event.backupFile ? '변경 전 백업 완료' : '최초 데이터 등록'}</div></article>`;
  }).join('') || '<p class="muted">변경 기록이 없습니다.</p>';
  if (histories.some(event => [event.before, event.after].some(snapshot => snapshot && [snapshot, ...(snapshot.components ?? [])].some(item => item.commonAccount || item.serverAccount)))) {
    const button = document.createElement('button'); button.className = 'button secondary history-secret'; button.textContent = reveal ? '기록의 계정 정보 숨기기' : '기록의 계정 정보 보기'; button.setAttribute('aria-pressed', String(reveal)); button.addEventListener('click', () => renderHistory(!reveal)); $('history-content').append(button);
  }
}
function setAuthMode(register) {
  registerMode = register; errorAt('auth-error'); $('auth-form').reset();
  $('login-tab').classList.toggle('selected', !register); $('register-tab').classList.toggle('selected', register);
  $('login-tab').setAttribute('aria-pressed', String(!register)); $('register-tab').setAttribute('aria-pressed', String(register));
  $('auth-title').textContent = register ? '함께 사용할 계정을 만드세요' : '반가워요, 시작해 볼까요?';
  $('auth-description').textContent = register ? '아이디, 이름, 직급과 비밀번호를 입력해 주세요.' : '아이디와 비밀번호로 로그인해 주세요.';
  $('auth-submit').textContent = register ? '계정 만들고 시작하기 →' : '로그인 →'; $('password-confirm-wrap').hidden = !register; $('auth-confirm').required = register;
  $('register-details').hidden = !register; $('auth-name').required = register; $('auth-job-title').required = register;
  $('auth-password').autocomplete = register ? 'new-password' : 'current-password';
}
$('manage-groups').addEventListener('click', () => { renderGroupList(); editGroup(); $('group-dialog').showModal(); $('group-name').focus(); });
$('new-group').addEventListener('click', () => { editGroup(); $('group-name').focus(); });
$('refresh-groups').addEventListener('click', async () => { if (await loadSites()) editGroup(); });
$('group-dialog').addEventListener('close', () => { editingGroup = null; $('group-form').reset(); });
$('group-delete-dialog').addEventListener('close', () => { deletingGroup = null; });
$('group-list').addEventListener('click', event => {
  const button = event.target.closest('button[data-group-action]'); if (!button) return;
  const group = groups.find(item => item.id === Number(button.dataset.id)); if (!group) return;
  if (button.dataset.groupAction === 'edit') { editGroup(group); $('group-name').focus(); }
  else {
    deletingGroup = group; errorAt('group-delete-error'); $('group-delete-name').textContent = groupPath(group.id);
    $('group-delete-dialog').showModal(); $('group-delete-dialog').querySelector('.button[data-close]').focus();
  }
});
$('group-form').addEventListener('submit', async event => {
  event.preventDefault(); errorAt('group-error'); $('save-group').disabled = true;
  const item = editingGroup;
  const body = { name: $('group-name').value, parentId: $('group-parent').value ? Number($('group-parent').value) : null, ...(item ? { version: item.version } : {}) };
  try {
    const result = await api(item ? `/api/groups/${item.id}` : '/api/groups', { method: item ? 'PUT' : 'POST', body });
    toast(result.changed ? '그룹을 저장했습니다.' : '변경된 내용이 없습니다.'); if (await loadSites()) editGroup();
  } catch (error) { errorAt('group-error', error.message); }
  finally { $('save-group').disabled = false; }
});
$('confirm-group-delete').addEventListener('click', async () => {
  if (!deletingGroup) return;
  const item = deletingGroup; $('confirm-group-delete').disabled = true; errorAt('group-delete-error');
  try {
    await api(`/api/groups/${item.id}`, { method: 'DELETE', body: { version: item.version } });
    $('group-delete-dialog').close(); toast('그룹을 삭제했습니다.'); if (await loadSites()) editGroup();
  } catch (error) { errorAt('group-delete-error', error.message); }
  finally { $('confirm-group-delete').disabled = false; }
});
$('expand-groups').addEventListener('click', () => { collapsedGroups.clear(); collapsedSystems.clear(); render(); });
$('collapse-groups').addEventListener('click', () => { [...groups.map(group => group.id), null].forEach(id => collapsedGroups.add(id)); sites.forEach(site => collapsedSystems.add(site.id)); render(); });
$('active-rows').addEventListener('click', event => {
  const button = event.target.closest('button[data-group-id]'); if (!button) return;
  if ($('search').value.trim() || $('access-filter').value !== 'all') return;
  const id = button.dataset.groupId ? Number(button.dataset.groupId) : null;
  collapsedGroups.has(id) ? collapsedGroups.delete(id) : collapsedGroups.add(id); render();
  $('active-rows').querySelector(`button[data-group-id="${id ?? ''}"]`)?.focus();
});
$('login-tab').addEventListener('click', () => setAuthMode(false));
$('register-tab').addEventListener('click', () => setAuthMode(true));
$('auth-form').addEventListener('submit', async event => {
  event.preventDefault(); errorAt('auth-error');
  if (registerMode && $('auth-password').value !== $('auth-confirm').value) return errorAt('auth-error', '비밀번호 확인이 일치하지 않습니다.');
  $('auth-submit').disabled = true;
  const body = { username: $('auth-username').value, password: $('auth-password').value };
  if (registerMode) { body.name = $('auth-name').value; body.jobTitle = $('auth-job-title').value; }
  try { const result = await api(registerMode ? '/api/register' : '/api/login', { method: 'POST', body }); await showApp(result.user); }
  catch (error) { errorAt('auth-error', error.message || '서버에 연결할 수 없습니다.'); }
  finally { $('auth-submit').disabled = false; }
});
$('logout').addEventListener('click', async () => { try { await api('/api/logout', { method: 'POST', body: {} }); showAuth(); setAuthMode(false); } catch (error) { toast(error.message); } });
$('search').addEventListener('input', render); $('access-filter').addEventListener('change', render); $('refresh').addEventListener('click', loadSites); $('add-site').addEventListener('click', () => openEditor());
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => $(button.dataset.close).close()));
$('editor').addEventListener('close', () => { $('site-form').reset(); $('component-editors').replaceChildren(); editing = null; });
$('add-component').addEventListener('click', () => { addComponentEditor().querySelector('[data-field="name"]').focus(); });
$('component-editors').addEventListener('input', event => { const card = event.target.closest('.component-editor'); if (card) syncComponentEditor(card); });
$('component-editors').addEventListener('click', event => {
  const button = event.target.closest('.remove-component'); if (!button) return;
  button.closest('.component-editor').remove(); $('components-empty').hidden = Boolean($('component-editors').children.length); $('add-component').focus();
});
for (const field of ['url', 'ip', 'sshPort']) $(field).addEventListener('input', () => { for (const card of $('component-editors').children) syncComponentEditor(card); });
$('site-form').addEventListener('invalid', event => { const card = event.target.closest('.component-editor'); if (card) card.open = true; }, true);
$('delete-dialog').addEventListener('close', () => { deleting = null; });
$('history-dialog').addEventListener('close', () => { historyRequest++; histories = []; $('history-content').replaceChildren(); });
for (const id of ['active-rows', 'deleted-rows']) $(id).addEventListener('click', event => {
  const button = event.target.closest('button[data-action]'); if (!button) return;
  const site = sites.find(item => item.id === Number(button.dataset.id)); if (!site) return;
  if (button.dataset.action === 'toggle-components') {
    if ($('search').value.trim() || $('access-filter').value !== 'all') return;
    collapsedSystems.has(site.id) ? collapsedSystems.delete(site.id) : collapsedSystems.add(site.id); render();
    $(id).querySelector(`button[data-action="toggle-components"][data-id="${site.id}"]`)?.focus();
  }
  if (button.dataset.action === 'edit') openEditor(site);
  if (button.dataset.action === 'components') { openEditor(site); $('add-component').focus(); }
  if (button.dataset.action === 'edit-component') {
    openEditor(site); const card = $('component-editors').children[Number(button.dataset.component)]; card.open = true; card.querySelector('[data-field="name"]').focus();
  }
  if (button.dataset.action === 'history') openHistory(site);
  if (['delete', 'permanent-delete'].includes(button.dataset.action)) {
    deleting = site; errorAt('delete-error'); $('delete-name').textContent = site.systemName;
    $('delete-title').textContent = site.deletedAt ? '시스템을 완전 삭제할까요?' : '시스템을 삭제할까요?';
    $('delete-description').textContent = site.deletedAt ? '접속 정보와 변경 기록이 완전히 삭제되며, 목록에서 복구할 수 없습니다. 계속하시겠습니까?' : '목록 아래의 ‘삭제된 목록’으로 이동합니다. 접속 정보와 변경 기록은 보관됩니다.';
    $('confirm-delete').textContent = site.deletedAt ? '완전 삭제하기' : '삭제하기';
    $('delete-dialog').showModal(); $('delete-dialog').querySelector('.button[data-close]').focus();
  }
  if (button.dataset.action === 'secret') {
    const field = button.dataset.field; const componentIndex = button.dataset.component === undefined ? null : Number(button.dataset.component); const key = `${site.id}:${componentIndex ?? 'system'}:${field}`;
    revealed.has(key) ? revealed.delete(key) : revealed.add(key);
    const cell = button.parentElement; cell.innerHTML = secretCell(site, field, componentIndex); cell.querySelector('button').focus();
  }
});
$('site-form').addEventListener('submit', async event => {
  event.preventDefault(); errorAt('editor-error'); $('save-site').disabled = true;
  const item = editing;
  const data = Object.fromEntries(new FormData(event.target)); data.groupId = data.groupId ? Number(data.groupId) : null; if (item) data.version = item.version;
  data.components = readComponents();
  try {
    const result = await api(item ? `/api/sites/${item.id}` : '/api/sites', { method: item ? 'PUT' : 'POST', body: data });
    $('editor').close(); toast(result.changed ? '백업과 변경 기록을 저장했습니다.' : '변경된 내용이 없습니다.'); await loadSites();
  } catch (error) { errorAt('editor-error', error.message); }
  finally { $('save-site').disabled = false; }
});
$('confirm-delete').addEventListener('click', async () => {
  if (!deleting) return; $('confirm-delete').disabled = true; errorAt('delete-error');
  const item = deleting;
  try {
    await api(`/api/sites/${item.id}${item.deletedAt ? '/permanent' : ''}`, { method: 'DELETE', body: { version: item.version } });
    $('delete-dialog').close(); toast(item.deletedAt ? '서버 정보와 변경 기록이 완전히 삭제되었습니다.' : '삭제된 목록으로 이동했습니다. 변경 기록이 보관됩니다.'); await loadSites();
  }
  catch (error) { errorAt('delete-error', error.message); }
  finally { $('confirm-delete').disabled = false; }
});
api('/api/me').then(({ user }) => user ? showApp(user) : showAuth()).catch(() => { showAuth(); errorAt('auth-error', '서버에 연결할 수 없습니다. 연결을 확인한 뒤 다시 로그인해 주세요.'); });
