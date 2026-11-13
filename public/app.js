const $ = id => document.getElementById(id);
const labels = { systemName: '시스템명', url: 'URL', commonAccount: '공통계정', ip: 'IP', servicePort: '서비스포트', sshPort: 'SSH포트', serverAccount: '서버계정', externalAccess: '외부접근가능여부', notes: '비고', groupId: '그룹', components: '하위 정보', deleted: '삭제 상태', position: '그룹 내 순서' };
const componentTypes = { WAS: 'WAS', WEB: 'WEB', DB: 'DB', PROXY: 'Reverse Proxy', OTHER: '기타' };
const componentFields = ['name', 'url', 'ip', 'externalAccess', 'servicePort', 'sshPort', 'commonAccount', 'serverAccount', 'notes'];
let componentSequence = 0;
const accessLabels = { yes: '가능', no: '불가', unknown: '미확인' };
let sites = [];
let groups = [];
let editingGroup = null;
let deletingGroup = null;
const collapsedGroups = new Set();
const expandedComponents = new Set();
let directoryScope = { type: 'all' };
let selectedSiteId = null;
let currentUser = null;
let registerMode = false;
let editing = null;
let deleting = null;
let restoring = null;
let histories = [];
let historyRequest = 0;
let listRequest = 0;
let toastTimer;
let draggingSite = null;
let draggingGroup = null;
let movingTree = false;
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
  currentUser = null; sites = []; groups = []; collapsedGroups.clear(); expandedComponents.clear(); directoryScope = { type: 'all' }; selectedSiteId = null; histories = []; revealed.clear(); listRequest++; historyRequest++;
  document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
  $('group-form').reset(); $('group-list').replaceChildren(); $('site-form').reset(); $('component-editors').replaceChildren(); $('history-content').replaceChildren(); $('system-list').replaceChildren(); $('system-detail').replaceChildren(); $('group-tree').replaceChildren();
  draggingSite = null; draggingGroup = null; $('group-root-drop').hidden = true; $('profile-form').reset();
  $('auth-form').reset(); $('app-view').hidden = true; $('auth-view').hidden = false; $('boot').hidden = true;
}
function renderUser(user) {
  currentUser = user; $('user-name').textContent = `${user.name}님`; $('user-avatar').textContent = user.name.slice(0, 1);
  $('user-account').textContent = `${user.username} · ${user.jobTitle}`;
}
async function showApp(user) {
  renderUser(user);
  $('auth-form').reset(); errorAt('auth-error'); $('auth-view').hidden = true; $('boot').hidden = true; $('app-view').hidden = false;
  $('search').value = ''; $('access-filter').value = 'all';
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
  if (!item[field]) return '<span class="dash">미등록</span>';
  const key = `${site.id}:${componentIndex ?? 'system'}:${field}`;
  const open = revealed.has(key);
  return `${open ? `<span class="secret-value">${escapeHtml(item[field])}</span>` : ''}<button class="secret-button" data-action="secret" data-id="${site.id}" ${componentIndex === null ? '' : `data-component="${componentIndex}"`} data-field="${field}" aria-label="${escapeHtml(item.name ?? site.systemName)} ${componentLabel(item.type, field)} ${open ? '숨기기' : '보기'}" aria-pressed="${open}">${open ? '숨기기' : '•••••• 보기'}</button>`;
}
function scopeIncludes(site) {
  if (directoryScope.type === 'system') return site.id === directoryScope.id;
  if (directoryScope.type !== 'group') return true;
  if (site.groupId === directoryScope.id) return true;
  for (let group = groups.find(item => item.id === site.groupId); group; group = groups.find(item => item.id === group.parentId)) {
    if (group.id === directoryScope.id) return true;
  }
  return false;
}
function isFiltering() { return Boolean($('search').value.trim()) || $('access-filter').value !== 'all'; }
function compareSiteOrder(a, b) { return (a.treeOrder ?? a.id) - (b.treeOrder ?? b.id) || a.id - b.id; }
function render() {
  const previousSelection = selectedSiteId;
  const active = sites.filter(site => !site.deletedAt);
  const deleted = sites.filter(site => site.deletedAt);
  if (directoryScope.type === 'group' && directoryScope.id !== null && !groups.some(group => group.id === directoryScope.id) || directoryScope.type === 'system' && !active.some(site => site.id === directoryScope.id)) directoryScope = { type: 'all' };
  const removed = directoryScope.type === 'deleted';
  const source = removed ? deleted : active;
  const order = new Map(orderedGroups().map((group, index) => [group.id, index]));
  const shown = source.filter(site => scopeIncludes(site) && matches(site)).sort((a, b) => (order.get(a.groupId) ?? groups.length) - (order.get(b.groupId) ?? groups.length) || compareSiteOrder(a, b));
  if (!shown.some(site => site.id === selectedSiteId)) { selectedSiteId = shown[0]?.id ?? null; revealed.clear(); }
  $('active-count').textContent = active.length; $('external-count').textContent = active.filter(site => site.externalAccess === 'yes').length;
  $('deleted-count').textContent = deleted.length; $('deleted-summary-count').textContent = deleted.length; $('navigation-total').textContent = active.length;
  $('browse-all').setAttribute('aria-current', String(directoryScope.type === 'all')); $('browse-deleted').setAttribute('aria-current', String(removed));
  const title = removed ? '삭제된 시스템' : directoryScope.type === 'group' ? groupPath(directoryScope.id) : directoryScope.type === 'system' ? active.find(site => site.id === directoryScope.id).systemName : '전체 시스템';
  $('list-title').textContent = title;
  $('add-group-site').hidden = directoryScope.type !== 'group';
  $('list-description').textContent = removed ? '보관된 정보와 변경 기록을 확인하세요.' : directoryScope.type === 'group' ? '선택한 그룹과 하위 그룹의 시스템입니다.' : directoryScope.type === 'system' ? '트리에서 선택한 시스템입니다.' : '시스템을 선택하면 상세 정보를 확인할 수 있습니다.';
  $('result-count').textContent = `${shown.length}개`;
  $('system-list').innerHTML = shown.map((site, index) => `<button type="button" class="system-list-item" data-select-site="${site.id}" aria-pressed="${site.id === selectedSiteId}"><span class="list-item-heading"><span class="list-number">${String(index + 1).padStart(2, '0')}</span><strong>${escapeHtml(site.systemName)}</strong><span class="list-selection-arrow" aria-hidden="true">›</span></span><span class="list-group-path">${escapeHtml(groupPath(site.groupId))}</span><span class="list-address mono">${escapeHtml(site.ip) || 'IP 미등록'}<span>SSH ${escapeHtml(site.sshPort) || '—'}</span></span><span class="list-url">${escapeHtml(site.url) || 'URL 미등록'}</span><span class="list-item-footer"><span>하위 정보 ${site.components?.length ?? 0}개</span><span class="badge ${site.externalAccess}">${accessLabels[site.externalAccess]}</span></span></button>`).join('') || `<p class="explorer-empty">${isFiltering() ? '검색 조건에 맞는 시스템이 없습니다.' : removed ? '삭제된 시스템이 없습니다.' : '등록된 시스템이 없습니다. 시스템 추가에서 이 그룹을 지정할 수 있습니다.'}</p>`;
  renderTree(active.filter(matches)); renderDetails(sites.find(site => site.id === selectedSiteId));
  if (previousSelection !== selectedSiteId) $('system-detail').scrollTop = 0;
}
function detailField(label, content, full = false) { return `<div class="detail-field${full ? ' detail-full' : ''}"><dt>${label}</dt><dd>${content}</dd></div>`; }
function detailUrl(url) { return url ? `<a class="url-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)} <span aria-hidden="true">↗</span></a>` : '<span class="dash">미등록</span>'; }
function renderDetails(site) {
  if (!site) { $('system-detail').innerHTML = '<div class="detail-empty"><span aria-hidden="true">☷</span><h2>시스템 상세 정보</h2><p>가운데 목록에서 시스템을 선택해 주세요.</p></div>'; return; }
  const value = key => escapeHtml(site[key]) || '<span class="dash">미등록</span>';
  const components = site.components ?? [];
  $('system-detail').innerHTML = `<div class="detail-heading"><span class="eyebrow">SYSTEM DETAILS</span><p class="detail-path">${escapeHtml(groupPath(site.groupId))}</p><h2>${escapeHtml(site.systemName)}</h2><div class="detail-status"><span class="badge ${site.externalAccess}">외부접근 ${accessLabels[site.externalAccess]}</span>${site.deletedAt ? '<span class="deleted-label">삭제된 시스템</span>' : ''}</div><p class="row-meta">${site.deletedAt ? '삭제' : '최근 변경'} ${formatDate(site.updatedAt)}<br>${escapeHtml(formatActor(site.updatedBy, site.updatedByJobTitle))}</p><div class="detail-actions">${site.deletedAt ? `<button class="button primary" data-action="restore" data-id="${site.id}">복구</button><button class="button danger" data-action="permanent-delete" data-id="${site.id}">완전 삭제</button>` : `<button class="button secondary" data-action="edit" data-id="${site.id}">시스템 수정</button><button class="text-button delete-button" data-action="delete" data-id="${site.id}">삭제</button>`}<button class="button secondary" data-action="history" data-id="${site.id}">변경 기록</button></div></div><section class="detail-section" aria-label="시스템 접속 정보"><h3>접속 정보</h3><dl class="detail-grid">${detailField('URL', detailUrl(site.url), true)}${['ip', 'servicePort', 'sshPort'].map(key => detailField(labels[key], `<span class="mono">${value(key)}</span>`)).join('')}${detailField('외부접근가능여부', accessLabels[site.externalAccess])}${detailField('공통계정', secretCell(site, 'commonAccount'))}${detailField('서버계정', secretCell(site, 'serverAccount'))}${detailField('비고', `<span class="detail-notes">${value('notes')}</span>`, true)}</dl></section><section class="detail-section" aria-label="시스템 하위 정보"><div class="detail-section-heading"><h3>하위 정보 <span class="count-badge">${components.length}</span></h3>${site.deletedAt ? '' : `<button class="text-button" data-action="components" data-id="${site.id}">추가·수정</button>`}</div>${components.length ? `<div class="component-detail-actions"><button class="text-button" data-action="expand-components" data-id="${site.id}">모두 펼치기</button><button class="text-button" data-action="collapse-components" data-id="${site.id}" ${isFiltering() ? 'disabled title="검색·필터 적용 중에는 하위 정보를 자동으로 펼칩니다."' : ''}>모두 접기</button></div>` : '<p class="muted">등록된 하위 항목이 없습니다.</p>'}${components.map((component, index) => {
    const key = `${site.id}:${index}`;
    const inherited = (field, same) => same ? `${value(field)}<span class="inherited-label">시스템과 동일</span>` : escapeHtml(component[field]) || '<span class="dash">미등록</span>';
    const hasUrl = ['WEB', 'PROXY', 'OTHER'].includes(component.type);
    return `<details class="component-detail" data-component-key="${key}" ${isFiltering() || expandedComponents.has(key) ? 'open' : ''}><summary><span class="component-detail-chevron" aria-hidden="true"></span><span class="component-type">${componentTypes[component.type]}</span><span class="component-detail-name">${escapeHtml(component.name)}</span></summary><dl class="detail-grid">${hasUrl ? detailField('URL', detailUrl(componentUrl(site, component)) + (component.type !== 'OTHER' ? '<span class="inherited-label">시스템과 동일</span>' : ''), true) : ''}${detailField('IP', `<span class="mono">${inherited('ip', component.useSystemIp)}</span>`)}${detailField(componentLabel(component.type, 'servicePort'), `<span class="mono">${escapeHtml(component.servicePort) || '미등록'}</span>`)}${detailField('SSH포트', `<span class="mono">${inherited('sshPort', component.useSystemSshPort)}</span>`)}${detailField('외부접근가능여부', accessLabels[component.externalAccess])}${detailField(componentLabel(component.type, 'commonAccount'), secretCell(site, 'commonAccount', index))}${detailField('서버계정', secretCell(site, 'serverAccount', index))}${detailField('비고', `<span class="detail-notes">${escapeHtml(component.notes) || '미등록'}</span>`, true)}</dl>${site.deletedAt ? '' : `<button class="text-button component-edit-link" data-action="edit-component" data-id="${site.id}" data-component="${index}">하위 정보 수정</button>`}</details>`;
  }).join('')}</section>`;
}
function groupPath(id) {
  const names = [];
  for (let group = groups.find(item => item.id === id); group; group = groups.find(item => item.id === group.parentId)) names.unshift(group.name);
  return names.join(' / ') || (id ? '삭제된 그룹' : '미분류');
}
function compareGroupOrder(a, b) { return (a.treeOrder ?? Infinity) - (b.treeOrder ?? Infinity) || a.name.localeCompare(b.name, 'ko') || a.id - b.id; }
function orderedGroups(parentId = null, depth = 0) {
  return groups.filter(group => group.parentId === parentId).sort(compareGroupOrder).flatMap(group => [{ ...group, depth }, ...orderedGroups(group.id, depth + 1)]);
}
function groupOptions(emptyLabel, excludedId = null) {
  const excluded = new Set(excludedId ? [excludedId] : []);
  return `<option value="">${emptyLabel}</option>` + orderedGroups().map(group => {
    if (excluded.has(group.parentId)) excluded.add(group.id);
    return excluded.has(group.id) ? '' : `<option value="${group.id}">${escapeHtml(groupPath(group.id))}</option>`;
  }).join('');
}
function renderTree(shown) {
  const filtering = isFiltering();
  function branch(group, depth) {
    const children = groups.filter(item => group.id !== null && item.parentId === group.id).sort(compareGroupOrder).map(child => branch(child, depth + 1));
    const members = shown.filter(site => site.groupId === group.id).sort(compareSiteOrder);
    const count = members.length + children.reduce((sum, child) => sum + child.count, 0);
    if (filtering && !count) return { count: 0, html: '' };
    const open = filtering || !collapsedGroups.has(group.id);
    return { count, html: `<li class="navigation-group ${depth ? 'nested-group' : 'root-group'}"><div class="navigation-group-heading"><button class="navigation-chevron" data-nav="toggle" data-id="${group.id ?? ''}" aria-label="${escapeHtml(group.name)} ${open ? '접기' : '펼치기'}" aria-expanded="${open}" ${filtering ? 'disabled' : ''}>${open ? '▾' : '▸'}</button><button class="navigation-label" ${group.id === null ? '' : 'draggable="true" title="위·아래에 놓아 순서 변경, 가운데에 놓아 하위 그룹으로 이동 · Alt+↑/↓"'} data-nav="group" data-id="${group.id ?? ''}" aria-current="${directoryScope.type === 'group' && directoryScope.id === group.id}"><span>${escapeHtml(group.name)}</span><small>${count}</small></button></div>${open ? `<ul>${children.map(child => child.html).join('')}${members.map(site => `<li><button class="navigation-system" draggable="true" title="드래그하여 이동 · Alt+↑/↓로 순서 변경" data-nav="system" data-id="${site.id}" aria-current="${directoryScope.type === 'system' && directoryScope.id === site.id}"><span class="navigation-system-dot" aria-hidden="true"></span><span>${escapeHtml(site.systemName)}</span></button></li>`).join('')}${!count && !children.length ? '<li class="navigation-empty">등록된 시스템 없음</li>' : ''}</ul>` : ''}</li>` };
  }
  const roots = groups.filter(group => group.parentId === null).sort(compareGroupOrder);
  let html = roots.map(group => branch(group, 0).html).join('');
  html += branch({ id: null, name: '미분류' }, 0).html;
  $('group-tree').innerHTML = html || '<li class="navigation-empty">표시할 그룹이 없습니다.</li>';
  $('collapse-groups').disabled = filtering;
}
function renderGroupList() {
  $('group-list').innerHTML = orderedGroups().map(group => {
    const count = sites.filter(site => site.groupId === group.id && !site.deletedAt).length;
    return `<li><span class="group-list-name"><span class="tree-indent" aria-hidden="true">${'　'.repeat(group.depth)}${group.depth ? '└ ' : ''}</span>${escapeHtml(group.name)}<small>활성 서버 ${count}개 · 직접 소속</small></span><div class="row-actions"><button type="button" data-group-action="edit" data-id="${group.id}" aria-label="${escapeHtml(groupPath(group.id))} 수정">수정</button><button type="button" class="delete-button" data-group-action="delete" data-id="${group.id}" aria-label="${escapeHtml(groupPath(group.id))} 삭제">삭제</button></div></li>`;
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
  const data = site ?? { externalAccess: 'unknown', groupId: directoryScope.type === 'group' ? directoryScope.id : sites.find(item => item.id === selectedSiteId)?.groupId ?? null };
  $('groupId').innerHTML = groupOptions('미분류');
  for (const field of Object.keys(labels).filter(field => !['deleted', 'components', 'position'].includes(field))) $(field).value = data[field] ?? '';
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
    return `<article class="history-item"><div class="history-head"><span class="action-badge ${event.action}">${({ create: '추가', update: '수정', delete: '삭제', move: '이동', restore: '복구' })[event.action]}</span><strong>${escapeHtml(formatActor(event.actor, event.actorJobTitle))}</strong><time datetime="${event.changedAt}">${formatDate(event.changedAt)}</time></div><div class="change-list">${changes.map(field => `<div class="change-row"><span class="change-label">${labels[field]}</span><span class="change-value change-before">${historyValue(field, event.before?.[field], reveal, event.before)}</span><span class="change-arrow" aria-label="변경 후">→</span><span class="change-value change-after">${historyValue(field, event.after[field], reveal, event.after)}</span></div>`).join('')}</div><div class="backup-caption">${event.backupFile ? '변경 전 백업 완료' : '최초 데이터 등록'}</div></article>`;
  }).join('') || '<p class="muted">변경 기록이 없습니다.</p>';
  if (histories.some(event => [event.before, event.after].some(snapshot => snapshot && [snapshot, ...(snapshot.components ?? [])].some(item => item.commonAccount || item.serverAccount)))) {
    const button = document.createElement('button'); button.className = 'button secondary history-secret'; button.textContent = reveal ? '기록의 계정 정보 숨기기' : '기록의 계정 정보 보기'; button.setAttribute('aria-pressed', String(reveal)); button.addEventListener('click', () => renderHistory(!reveal)); $('history-content').append(button);
  }
}
function setAuthMode(register) {
  registerMode = register; errorAt('auth-error'); $('auth-form').reset();
  $('login-tab').classList.toggle('selected', !register); $('register-tab').classList.toggle('selected', register);
  $('login-tab').setAttribute('aria-pressed', String(!register)); $('register-tab').setAttribute('aria-pressed', String(register));
  $('auth-title').hidden = !register;
  $('auth-description').hidden = !register;
  $('auth-submit').textContent = register ? '계정 만들고 시작하기 →' : '로그인 →'; $('password-confirm-wrap').hidden = !register; $('auth-confirm').required = register;
  $('register-details').hidden = !register; $('auth-name').required = register; $('auth-job-title').required = register;
  $('auth-password').autocomplete = register ? 'new-password' : 'current-password';
}
function clearDropTarget() {
  $('directory-navigation').querySelectorAll('[data-drop-position]').forEach(element => element.removeAttribute('data-drop-position'));
}
function treeDropTarget(event) {
  if (draggingGroup) {
    if (event.target.closest('#group-root-drop')) return { element: $('group-root-drop'), parentId: null };
    const heading = event.target.closest('.navigation-group-heading');
    const button = heading?.querySelector('[data-nav="group"]');
    const target = groups.find(group => group.id === Number(button?.dataset.id));
    if (!target || target.id === draggingGroup.id) return null;
    const bounds = heading.getBoundingClientRect();
    const position = (event.clientY - bounds.top) / bounds.height;
    const placement = position < .25 ? 'before' : position > .75 ? 'after' : 'inside';
    const parentId = placement === 'inside' ? target.id : target.parentId;
    for (let parent = groups.find(group => group.id === parentId); parent; parent = groups.find(group => group.id === parent.parentId)) {
      if (parent.id === draggingGroup.id) return null;
    }
    return { element: heading, parentId, targetId: placement === 'inside' ? null : target.id, targetVersion: target.version, placement };
  }
  const system = event.target.closest('[data-nav="system"]');
  if (system) {
    const target = sites.find(site => site.id === Number(system.dataset.id));
    if (!target || target.id === draggingSite?.id) return null;
    const bounds = system.getBoundingClientRect();
    return { element: system, groupId: target.groupId, targetId: target.id, targetVersion: target.version, placement: event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after' };
  }
  const group = event.target.closest('.navigation-group-heading')?.querySelector('[data-nav="group"]');
  return group ? { element: group.closest('.navigation-group-heading'), groupId: group.dataset.id ? Number(group.dataset.id) : null } : null;
}
async function moveSystem(site, target) {
  if (movingTree) return;
  movingTree = true; $('group-tree').setAttribute('aria-busy', 'true');
  try {
    const { site: moved, changed } = await api(`/api/sites/${site.id}/move`, { method: 'PUT', body: { version: site.version, groupId: target.groupId, targetId: target.targetId ?? null, targetVersion: target.targetVersion, placement: target.placement } });
    if (!currentUser) return;
    directoryScope = { type: 'group', id: moved.groupId }; selectedSiteId = moved.id;
    collapsedGroups.delete(moved.groupId);
    for (let group = groups.find(item => item.id === moved.groupId); group; group = groups.find(item => item.id === group.parentId)) collapsedGroups.delete(group.id);
    await loadSites();
    $('group-tree').querySelector(`[data-nav="system"][data-id="${moved.id}"]`)?.focus();
    toast(changed ? '시스템을 이동하고 변경 기록을 저장했습니다.' : '이미 같은 위치에 있습니다.');
  } catch (error) {
    if (currentUser) await loadSites();
    toast(error.message);
  } finally { movingTree = false; $('group-tree').removeAttribute('aria-busy'); }
}
async function moveGroup(group, target) {
  if (movingTree) return;
  movingTree = true; $('group-tree').setAttribute('aria-busy', 'true');
  try {
    const result = await api(`/api/groups/${group.id}/move`, { method: 'PUT', body: { version: group.version, parentId: target.parentId, parentVersion: groups.find(item => item.id === target.parentId)?.version, targetId: target.targetId ?? null, targetVersion: target.targetVersion, placement: target.placement } });
    if (!currentUser) return;
    directoryScope = { type: 'group', id: result.group.id }; selectedSiteId = null;
    if (await loadSites()) {
      for (let parent = groups.find(item => item.id === result.group.id); parent; parent = groups.find(item => item.id === parent.parentId)) collapsedGroups.delete(parent.id);
      render();
      $('group-tree').querySelector(`[data-nav="group"][data-id="${result.group.id}"]`)?.focus();
    }
    toast(result.changed ? '그룹의 순서와 위치를 저장했습니다.' : '이미 같은 위치에 있습니다.');
  } catch (error) {
    if (currentUser) await loadSites();
    toast(error.message);
  } finally { movingTree = false; $('group-tree').removeAttribute('aria-busy'); }
}
$('directory-navigation').addEventListener('dragstart', event => {
  const button = event.target.closest('[draggable="true"]');
  if (!button || movingTree) { event.preventDefault(); return; }
  draggingGroup = button.dataset.nav === 'group' ? groups.find(group => group.id === Number(button.dataset.id)) : null;
  draggingSite = button.dataset.nav === 'system' ? sites.find(site => site.id === Number(button.dataset.id)) : null;
  $('group-root-drop').hidden = !draggingGroup;
  event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', `${button.dataset.nav}:${button.dataset.id}`);
  button.classList.add('dragging');
});
$('directory-navigation').addEventListener('dragover', event => {
  if ((!draggingSite && !draggingGroup) || movingTree) return;
  clearDropTarget();
  const target = treeDropTarget(event); if (!target) return;
  event.preventDefault(); event.dataTransfer.dropEffect = 'move';
  target.element.dataset.dropPosition = target.placement === 'inside' ? 'group' : target.placement ?? 'group';
});
$('directory-navigation').addEventListener('dragleave', event => { if (!$('directory-navigation').contains(event.relatedTarget)) clearDropTarget(); });
$('directory-navigation').addEventListener('drop', event => {
  if ((!draggingSite && !draggingGroup) || movingTree) return;
  const target = treeDropTarget(event); const site = draggingSite; const group = draggingGroup;
  event.preventDefault(); clearDropTarget(); draggingSite = null; draggingGroup = null; $('group-root-drop').hidden = true;
  if (target) group ? moveGroup(group, target) : moveSystem(site, target);
});
$('directory-navigation').addEventListener('dragend', () => {
  draggingSite = null; draggingGroup = null; $('group-root-drop').hidden = true; clearDropTarget();
  $('group-tree').querySelectorAll('.dragging').forEach(element => element.classList.remove('dragging'));
});
$('directory-navigation').addEventListener('keydown', event => {
  if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
  const groupButton = event.target.closest('[data-nav="group"][draggable="true"]');
  if (groupButton) {
    event.preventDefault();
    const group = groups.find(item => item.id === Number(groupButton.dataset.id));
    const siblings = groups.filter(item => item.parentId === group.parentId).sort(compareGroupOrder);
    const target = siblings[siblings.findIndex(item => item.id === group.id) + (event.key === 'ArrowUp' ? -1 : 1)];
    if (target) moveGroup(group, { parentId: target.parentId, targetId: target.id, targetVersion: target.version, placement: event.key === 'ArrowUp' ? 'before' : 'after' });
    return;
  }
  const button = event.target.closest('[data-nav="system"]'); if (!button) return;
  event.preventDefault();
  const site = sites.find(item => item.id === Number(button.dataset.id));
  const members = sites.filter(item => !item.deletedAt && item.groupId === site.groupId).sort(compareSiteOrder);
  const target = members[members.findIndex(item => item.id === site.id) + (event.key === 'ArrowUp' ? -1 : 1)];
  if (target) moveSystem(site, { groupId: target.groupId, targetId: target.id, targetVersion: target.version, placement: event.key === 'ArrowUp' ? 'before' : 'after' });
});
$('edit-profile').addEventListener('click', () => {
  errorAt('profile-error'); $('profile-username').value = currentUser.username;
  $('profile-name').value = currentUser.name; $('profile-job-title').value = currentUser.jobTitle;
  $('profile-dialog').showModal(); $('profile-name').focus();
});
$('profile-form').addEventListener('submit', async event => {
  event.preventDefault(); errorAt('profile-error'); $('save-profile').disabled = true;
  try {
    const result = await api('/api/me', { method: 'PUT', body: { name: $('profile-name').value, jobTitle: $('profile-job-title').value } });
    if (!currentUser) return;
    renderUser(result.user); $('profile-dialog').close(); await loadSites();
    toast(result.changed ? '계정 정보를 변경했습니다.' : '변경된 내용이 없습니다.');
  } catch (error) { errorAt('profile-error', error.message); }
  finally { $('save-profile').disabled = false; }
});
$('add-group-site').addEventListener('click', () => openEditor());
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
    $('group-delete-dialog').close(); toast('그룹과 하위 그룹을 삭제했습니다.'); if (await loadSites()) editGroup();
  } catch (error) { errorAt('group-delete-error', error.message); }
  finally { $('confirm-group-delete').disabled = false; }
});
$('expand-groups').addEventListener('click', () => { collapsedGroups.clear(); renderTree(sites.filter(site => !site.deletedAt && matches(site))); });
$('collapse-groups').addEventListener('click', () => { [...groups.map(group => group.id), null].forEach(id => collapsedGroups.add(id)); renderTree(sites.filter(site => !site.deletedAt && matches(site))); });
$('directory-navigation').addEventListener('click', event => {
  const button = event.target.closest('button[data-nav]'); if (!button) return;
  const type = button.dataset.nav;
  const id = button.dataset.id ? Number(button.dataset.id) : null;
  if (type === 'toggle') {
    if (isFiltering()) return;
    collapsedGroups.has(id) ? collapsedGroups.delete(id) : collapsedGroups.add(id);
    renderTree(sites.filter(site => !site.deletedAt && matches(site)));
    $('group-tree').querySelector(`button[data-nav="toggle"][data-id="${id ?? ''}"]`)?.focus();
    return;
  }
  directoryScope = { type, id }; selectedSiteId = type === 'system' ? id : null; revealed.clear(); render(); $('system-detail').scrollTop = 0;
  $('directory-navigation').querySelector(type === 'group' || type === 'system' ? `button[data-nav="${type}"][data-id="${id ?? ''}"]` : `button[data-nav="${type}"]`)?.focus();
});
$('system-list').addEventListener('click', event => {
  const button = event.target.closest('button[data-select-site]'); if (!button) return;
  selectedSiteId = Number(button.dataset.selectSite); revealed.clear(); render(); $('system-detail').scrollTop = 0;
  $('system-list').querySelector(`button[data-select-site="${selectedSiteId}"]`)?.focus();
  if (matchMedia('(max-width:850px)').matches) $('system-detail').scrollIntoView({ block: 'start' });
});
$('system-detail').addEventListener('toggle', event => {
  const card = event.target;
  if (!card.matches('.component-detail') || !card.isConnected || isFiltering()) return;
  card.open ? expandedComponents.add(card.dataset.componentKey) : expandedComponents.delete(card.dataset.componentKey);
}, true);
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
$('restore-dialog').addEventListener('close', () => { restoring = null; });
$('history-dialog').addEventListener('close', () => { historyRequest++; histories = []; $('history-content').replaceChildren(); });
$('system-detail').addEventListener('click', event => {
  const button = event.target.closest('button[data-action]'); if (!button) return;
  const site = sites.find(item => item.id === Number(button.dataset.id)); if (!site) return;
  if (['expand-components', 'collapse-components'].includes(button.dataset.action)) {
    if (button.dataset.action === 'collapse-components' && isFiltering()) return;
    (site.components ?? []).forEach((component, index) => {
      const key = `${site.id}:${index}`;
      button.dataset.action === 'expand-components' ? expandedComponents.add(key) : expandedComponents.delete(key);
    });
    renderDetails(site); $('system-detail').querySelector(`button[data-action="${button.dataset.action}"]`)?.focus();
  }
  if (button.dataset.action === 'edit') openEditor(site);
  if (button.dataset.action === 'components') { openEditor(site); $('add-component').focus(); }
  if (button.dataset.action === 'edit-component') {
    openEditor(site); const card = $('component-editors').children[Number(button.dataset.component)]; card.open = true; card.querySelector('[data-field="name"]').focus();
  }
  if (button.dataset.action === 'history') openHistory(site);
  if (button.dataset.action === 'restore') {
    restoring = site; errorAt('restore-error'); $('restore-name').textContent = site.systemName;
    $('restore-description').textContent = !site.groupId || groups.some(group => group.id === site.groupId)
      ? `‘${groupPath(site.groupId)}’에 복구합니다. 그룹이 삭제된 경우 필요한 상위 그룹과 함께 복구합니다.`
      : '삭제된 그룹과 필요한 상위 그룹을 함께 복구한 뒤 시스템을 복구합니다. 같은 위치에 같은 이름의 그룹이 있으면 해당 그룹을 사용합니다.';
    $('restore-dialog').showModal(); $('confirm-restore').focus();
  }
  if (['delete', 'permanent-delete'].includes(button.dataset.action)) {
    deleting = site; errorAt('delete-error'); $('delete-name').textContent = site.systemName;
    $('delete-title').textContent = site.deletedAt ? '시스템을 완전 삭제할까요?' : '시스템을 삭제할까요?';
    $('delete-description').textContent = site.deletedAt ? '접속 정보와 변경 기록이 완전히 삭제되며, 목록에서 복구할 수 없습니다. 계속하시겠습니까?' : '좌측의 ‘삭제된 시스템’으로 이동합니다. 접속 정보와 변경 기록은 보관됩니다.';
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
    selectedSiteId = result.site.id; directoryScope = { type: 'group', id: result.site.groupId }; $('search').value = ''; $('access-filter').value = 'all';
    $('editor').close(); toast(result.changed ? '백업과 변경 기록을 저장했습니다.' : '변경된 내용이 없습니다.'); await loadSites();
  } catch (error) { errorAt('editor-error', error.message); }
  finally { $('save-site').disabled = false; }
});
$('confirm-restore').addEventListener('click', async () => {
  if (!restoring) return; $('confirm-restore').disabled = true; errorAt('restore-error');
  const item = restoring;
  try {
    const result = await api(`/api/sites/${item.id}/restore`, { method: 'POST', body: { version: item.version } });
    selectedSiteId = result.site.id; directoryScope = { type: 'group', id: result.site.groupId }; $('search').value = ''; $('access-filter').value = 'all';
    $('restore-dialog').close();
    toast(result.groupRestored ? `그룹도 함께 복구했습니다. ‘${result.groupName}’에 시스템을 복구했습니다.` : `‘${result.groupName}’에 시스템을 복구했습니다.`);
    await loadSites();
  } catch (error) { errorAt('restore-error', error.message); }
  finally { $('confirm-restore').disabled = false; }
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
