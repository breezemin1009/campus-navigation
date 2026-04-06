let classrooms = [];
let buildings = [];
let facilities = [];

async function loadData() {
  const [classRes, buildRes, facilityRes] = await Promise.all([
    fetch('/api/classrooms'),
    fetch('/api/buildings'),
    fetch('/api/facilities')
  ]);

  if (!classRes.ok || !buildRes.ok || !facilityRes.ok) {
    throw new Error('데이터 파일을 불러오지 못했습니다.');
  }

  classrooms = await classRes.json();
  buildings = await buildRes.json();
  facilities = await facilityRes.json();
}

async function initApp() {
  await loadData();

  const buildingMap = Object.fromEntries(buildings.map((b) => [b.building, {
    building: b.building,
    lat: Number(b.lat),
    lng: Number(b.lng)
  }]));

  const roomsByBuilding = classrooms.reduce((acc, room) => {
    (acc[room.building] ||= []).push(room);
    return acc;
  }, {});

  const facilitiesByBuilding = facilities.reduce((acc, facility) => {
    (acc[facility.building] ||= []).push(facility);
    return acc;
  }, {});

  Object.values(roomsByBuilding).forEach((list) => list.sort((a, b) => String(a.room_code).localeCompare(String(b.room_code), 'ko')));
  Object.values(facilitiesByBuilding).forEach((list) => list.sort((a, b) => {
    const floorA = Number.isFinite(Number(a.floor)) ? Number(a.floor) : Number.MAX_SAFE_INTEGER;
    const floorB = Number.isFinite(Number(b.floor)) ? Number(b.floor) : Number.MAX_SAFE_INTEGER;
    if (floorA !== floorB) return floorA - floorB;
    return String(a.name).localeCompare(String(b.name), 'ko');
  }));

  const facilityCategories = [...new Set(facilities.map((f) => f.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ko'));

  let map;
  let routeLine;
  let currentMarker;
  let clickedMarker;
  let startSelection = null;
  let endSelection = null;
  let currentLocation = null;
  let activeFilter = 'all';

  const buildingMarkers = new Map();
  const facilityMarkers = [];
  const currentSearchResults = [];

  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  }

  function prettyCapacity(value) {
    if (value === '' || value == null || Number.isNaN(Number(value))) return '정보 없음';
    return `${Number(value)}명`;
  }

  function prettyFloor(value) {
    if (value === '' || value == null) return '층수 정보 없음';
    return `${value}층`;
  }

  function categoryClass(category) {
    const safe = String(category || 'default').toLowerCase().replace(/[^a-z0-9가-힣]+/g, '-');
    return `category-${safe}`;
  }

  function getFacilityColor(category) {
    const palette = {
      '편의점': '#10b981',
      '카페': '#f59e0b',
      '식당': '#ef4444',
      '은행': '#06b6d4',
      '문구점': '#8b5cf6',
      '기념품 판매점': '#ec4899',
      '미용실': '#f97316',
      '인쇄/복사': '#6366f1'
    };
    return palette[category] || '#14b8a6';
  }

  function selectionLabel(sel) {
    if (!sel) return '선택되지 않음';
    if (sel.kind === 'current') return '현재 위치';
    if (sel.kind === 'custom') return sel.name || '선택 지점';
    if (sel.kind === 'facility') return `${sel.name} (${sel.building})`;
    if (sel.kind === 'room') return `${sel.room_name} (${sel.room_code})`;
    return sel.building;
  }

  function selectionDesc(sel) {
    if (!sel) return '검색 결과, 건물 마커, 지도 클릭으로 설정할 수 있습니다.';
    if (sel.kind === 'current') return '브라우저 위치 정보를 이용한 현재 위치입니다.';
    if (sel.kind === 'custom') return `지도에서 직접 지정한 위치 · ${sel.lat.toFixed(6)}, ${sel.lng.toFixed(6)}`;
    if (sel.kind === 'facility') return `${sel.building} · ${prettyFloor(sel.floor)} · ${sel.category || '편의시설'} 기준 안내`;
    if (sel.kind === 'room') return `${sel.building} · ${prettyFloor(sel.floor)} · 건물 기준 경로 안내`;
    return `${sel.building} · 등록 강의실 ${(roomsByBuilding[sel.building] || []).length}개 · 편의시설 ${(facilitiesByBuilding[sel.building] || []).length}개`;
  }

  function updateSelectionUI() {
    document.getElementById('startName').textContent = selectionLabel(startSelection);
    document.getElementById('startDesc').textContent = selectionDesc(startSelection);
    document.getElementById('endName').textContent = selectionLabel(endSelection);
    document.getElementById('endDesc').textContent = selectionDesc(endSelection);
    updateRouteBadge();
  }

  function updateRouteBadge(text) {
    document.getElementById('routeBadge').textContent = text || (
      startSelection && endSelection
        ? `${selectionLabel(startSelection)} → ${selectionLabel(endSelection)}`
        : '출발지와 목적지를 선택하면 도보 경로를 계산합니다.'
    );
  }

  function getLatLng(sel) {
    if (!sel || sel.lat == null || sel.lng == null) return null;
    return [Number(sel.lat), Number(sel.lng)];
  }

  function formatDistance(meters) {
    if (!isFinite(meters)) return '-';
    return meters >= 1000 ? `${(meters / 1000).toFixed(2)}km` : `${Math.round(meters)}m`;
  }

  function formatApproxMinutes(minutes) {
    if (!isFinite(minutes)) return '-';
    return `약 ${Math.max(1, Math.round(minutes))}분`;
  }

  function setRouteSummary(title = '경로 미선택', meters = null, minutes = null) {
    document.getElementById('routeTitle').textContent = title;
    document.getElementById('routeDistance').textContent = meters == null ? '-' : formatDistance(meters);
    document.getElementById('routeDuration').textContent = minutes == null ? '-' : formatApproxMinutes(minutes);
  }

  function buildSelectionFromBuilding(buildingName) {
    const b = buildingMap[buildingName];
    if (!b) return null;
    return { kind: 'building', building: b.building, lat: b.lat, lng: b.lng };
  }

  function buildSelectionFromRoom(room) {
    const b = buildingMap[room.building];
    if (!b) return null;
    return {
      kind: 'room',
      building: room.building,
      lat: b.lat,
      lng: b.lng,
      room_name: room.room_name,
      room_code: room.room_code,
      room_type: room.room_type,
      floor: room.floor
    };
  }

  function buildSelectionFromFacility(facility) {
    const b = buildingMap[facility.building];
    if (!b) return null;
    return {
      kind: 'facility',
      building: facility.building,
      lat: Number(facility.lat ?? b.lat),
      lng: Number(facility.lng ?? b.lng),
      name: facility.name,
      category: facility.category,
      floor: facility.floor
    };
  }

  function showBuildingDetail(buildingName) {
    const rooms = roomsByBuilding[buildingName] || [];
    const buildingFacilities = facilitiesByBuilding[buildingName] || [];
    const panel = document.getElementById('detailPanel');
    const coord = buildingMap[buildingName];

    panel.innerHTML = `
      <div class="detail-title">${escapeHtml(buildingName)}</div>
      <div class="detail-sub">등록 강의실 ${rooms.length}개 · 편의시설 ${buildingFacilities.length}개 · 좌표 ${coord ? `${coord.lat.toFixed(6)}, ${coord.lng.toFixed(6)}` : '정보 없음'}</div>
      <div class="btn-row detail-actions">
        <button class="btn secondary detail-select" data-target="start" data-building="${escapeHtml(buildingName)}">출발지로 선택</button>
        <button class="btn danger detail-select" data-target="end" data-building="${escapeHtml(buildingName)}">목적지로 선택</button>
      </div>
      <section class="detail-section">
        <div class="section-title">편의시설</div>
        <div class="facility-list">
          ${buildingFacilities.length ? buildingFacilities.map((facility, idx) => `
            <div class="facility-item">
              <div class="room-top">
                <div>
                  <div class="room-name">${escapeHtml(facility.name)}</div>
                  <div class="room-code">${escapeHtml(facility.category || '편의시설')}</div>
                </div>
                <span class="chip ${categoryClass(facility.category)}">${escapeHtml(prettyFloor(facility.floor))}</span>
              </div>
              <div class="room-meta">
                <span>${escapeHtml(facility.building)}</span>
                <span>${escapeHtml(facility.category || '편의시설')}</span>
              </div>
              <div class="btn-row compact-row">
                <button class="btn ghost facility-select" data-building="${escapeHtml(facility.building)}" data-index="${idx}" data-target="start">출발지</button>
                <button class="btn ghost facility-select" data-building="${escapeHtml(facility.building)}" data-index="${idx}" data-target="end">목적지</button>
              </div>
            </div>
          `).join('') : '<div class="empty">등록된 편의시설 정보가 없습니다.</div>'}
        </div>
      </section>
      <section class="detail-section">
        <div class="section-title">강의실</div>
        <div class="room-list">
          ${rooms.length ? rooms.map((room) => `
            <div class="room-item">
              <div class="room-top">
                <div>
                  <div class="room-name">${escapeHtml(room.room_name)}</div>
                  <div class="room-code">${escapeHtml(room.room_code)}</div>
                </div>
                <span class="chip">${escapeHtml(prettyFloor(room.floor))}</span>
              </div>
              <div class="room-meta">
                <span>${escapeHtml(room.room_type || '정보 없음')}</span>
                <span>수용인원 ${escapeHtml(prettyCapacity(room.capacity))}</span>
              </div>
            </div>
          `).join('') : '<div class="empty">등록된 강의실 정보가 없습니다.</div>'}
        </div>
      </section>
    `;

    panel.querySelectorAll('.detail-select').forEach((button) => {
      button.addEventListener('click', () => {
        setSelection(button.dataset.target, buildSelectionFromBuilding(button.dataset.building));
      });
    });

    panel.querySelectorAll('.facility-select').forEach((button) => {
      button.addEventListener('click', () => {
        const list = facilitiesByBuilding[button.dataset.building] || [];
        const facility = list[Number(button.dataset.index)];
        setSelection(button.dataset.target, buildSelectionFromFacility(facility));
      });
    });
  }

  function showFacilityDetail(facility) {
    if (!facility) return;
    showBuildingDetail(facility.building);
  }

  function setSelection(target, selection) {
    if (!selection) return;
    if (target === 'start') startSelection = selection;
    else endSelection = selection;
    updateSelectionUI();
    if (selection.kind === 'facility') showFacilityDetail(selection);
    else if (selection.building) showBuildingDetail(selection.building);
    drawRoute();
  }

  window.selectSearchItem = function (idx, target) {
    const item = currentSearchResults[idx];
    if (!item) return;
    setSelection(target, item.selection);
    if (item.selection?.building) {
      const marker = buildingMarkers.get(item.selection.building);
      if (marker) {
        map.flyTo(marker.getLatLng(), 18, { duration: 0.7 });
      }
    }
  };

  function createBuildingPopup(buildingName) {
    const wrap = document.createElement('div');
    const roomCount = (roomsByBuilding[buildingName] || []).length;
    const facilityCount = (facilitiesByBuilding[buildingName] || []).length;
    wrap.innerHTML = `
      <div class="popup-title">${escapeHtml(buildingName)}</div>
      <div class="popup-sub">강의실 ${roomCount}개 · 편의시설 ${facilityCount}개</div>
      <div class="popup-actions">
        <button class="popup-btn start">출발지</button>
        <button class="popup-btn end">목적지</button>
      </div>
    `;
    wrap.querySelector('.popup-btn.start').addEventListener('click', () => setSelection('start', buildSelectionFromBuilding(buildingName)));
    wrap.querySelector('.popup-btn.end').addEventListener('click', () => setSelection('end', buildSelectionFromBuilding(buildingName)));
    return wrap;
  }

  function createFacilityPopup(facility) {
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div class="popup-title">${escapeHtml(facility.name)}</div>
      <div class="popup-sub">${escapeHtml(facility.building)} · ${escapeHtml(facility.category || '편의시설')} · ${escapeHtml(prettyFloor(facility.floor))}</div>
      <div class="popup-actions">
        <button class="popup-btn start">출발지</button>
        <button class="popup-btn end">목적지</button>
      </div>
    `;
    wrap.querySelector('.popup-btn.start').addEventListener('click', () => setSelection('start', buildSelectionFromFacility(facility)));
    wrap.querySelector('.popup-btn.end').addEventListener('click', () => setSelection('end', buildSelectionFromFacility(facility)));
    return wrap;
  }

  function createCustomPopup(lat, lng) {
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div class="popup-title">선택한 지점</div>
      <div class="popup-sub">${lat.toFixed(6)}, ${lng.toFixed(6)}</div>
      <div class="popup-actions">
        <button class="popup-btn start">출발지</button>
        <button class="popup-btn end">목적지</button>
      </div>
    `;
    wrap.querySelector('.popup-btn.start').addEventListener('click', () => setSelection('start', { kind: 'custom', name: '선택 지점', lat, lng }));
    wrap.querySelector('.popup-btn.end').addEventListener('click', () => setSelection('end', { kind: 'custom', name: '선택 지점', lat, lng }));
    return wrap;
  }

  function getColorIcon(color, size = 16) {
    return L.divIcon({
      className: 'custom-div-icon',
      html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};border:3px solid white;box-shadow:0 6px 14px rgba(15,23,42,.18)"></div>`,
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2]
    });
  }

  async function drawRoute() {
    if (routeLine) {
      map.removeLayer(routeLine);
      routeLine = null;
    }
    if (!(startSelection && endSelection)) {
      setRouteSummary();
      updateRouteBadge();
      return;
    }

    const from = getLatLng(startSelection);
    const to = getLatLng(endSelection);
    if (!from || !to) return;

    const title = `${selectionLabel(startSelection)} → ${selectionLabel(endSelection)}`;
    updateRouteBadge(title);

    const fallbackMeters = map.distance(from, to) * 1.25;
    const fallbackMinutes = fallbackMeters / 75;

    try {
      const url = `https://router.project-osrm.org/route/v1/foot/${from[1]},${from[0]};${to[1]},${to[0]}?overview=full&geometries=geojson`;
      const res = await fetch(url);
      const data = await res.json();
      const route = data.routes?.[0];
      if (!route) throw new Error('no route');
      const adjustedMeters = Number(route.distance || 0) * 1.25;
      const adjustedMinutes = adjustedMeters / 75;
      routeLine = L.geoJSON(route.geometry, {
        style: { color: '#2563eb', weight: 6, opacity: 0.88, lineJoin: 'round' }
      }).addTo(map);
      map.fitBounds(routeLine.getBounds(), { padding: [40, 40] });
      setRouteSummary(title, adjustedMeters, adjustedMinutes);
    } catch (error) {
      routeLine = L.polyline([from, to], {
        color: '#2563eb',
        weight: 5,
        opacity: 0.7,
        dashArray: '10, 8'
      }).addTo(map);
      map.fitBounds(routeLine.getBounds(), { padding: [40, 40] });
      setRouteSummary(title, fallbackMeters, fallbackMinutes);
    }
  }

  function moveToSelection(sel) {
    if (!sel) return;
    const latlng = getLatLng(sel);
    if (!latlng) return;
    map.flyTo(latlng, 18, { duration: 0.8 });
  }

  function normalizeSearchText(text) {
    return String(text || '').toLowerCase().replace(/[\s-]+/g, '');
  }

  function scoreMatch(text, query) {
    if (!query) return 0;
    const value = String(text || '').toLowerCase();
    const normalizedValue = normalizeSearchText(text);
    const normalizedQuery = normalizeSearchText(query);
    if (value === query || normalizedValue === normalizedQuery) return 100;
    if (value.startsWith(query) || normalizedValue.startsWith(normalizedQuery)) return 75;
    if (value.includes(query) || normalizedValue.includes(normalizedQuery)) return 50;
    return 0;
  }

  function renderSearchResults(keyword = '') {
    currentSearchResults.length = 0;
    const q = keyword.trim().toLowerCase();
    const container = document.getElementById('searchResults');

    let results = [];

    if (q) {
      for (const building of buildings) {
        const score = scoreMatch(building.building, q);
        if (score > 0) {
          results.push({
            rank: score + 20,
            type: 'building',
            title: building.building,
            meta: ['건물', `강의실 ${(roomsByBuilding[building.building] || []).length}개`, `편의시설 ${(facilitiesByBuilding[building.building] || []).length}개`],
            selection: buildSelectionFromBuilding(building.building)
          });
        }
      }

      for (const room of classrooms) {
        const score = Math.max(
          scoreMatch(room.room_name, q),
          scoreMatch(room.room_code, q),
          scoreMatch(`${room.building} ${room.room_name}`, q),
          scoreMatch(room.room_type, q)
        );
        if (score > 0) {
          results.push({
            rank: score + 10,
            type: 'room',
            title: room.room_name,
            meta: [room.building, room.room_code, room.room_type || '정보 없음', prettyFloor(room.floor)],
            selection: buildSelectionFromRoom(room)
          });
        }
      }

      for (const facility of facilities) {
        const score = Math.max(
          scoreMatch(facility.name, q),
          scoreMatch(facility.category, q),
          scoreMatch(`${facility.building} ${facility.name}`, q)
        );
        if (score > 0) {
          results.push({
            rank: score,
            type: 'facility',
            title: facility.name,
            meta: [facility.category || '편의시설', facility.building, prettyFloor(facility.floor)],
            selection: buildSelectionFromFacility(facility)
          });
        }
      }
    } else {
      results = [
        ...buildings.slice(0, 6).map((b) => ({
          rank: 1,
          type: 'building',
          title: b.building,
          meta: ['건물', `강의실 ${(roomsByBuilding[b.building] || []).length}개`, `편의시설 ${(facilitiesByBuilding[b.building] || []).length}개`],
          selection: buildSelectionFromBuilding(b.building)
        })),
        ...classrooms.slice(0, 8).map((room) => ({
          rank: 1,
          type: 'room',
          title: room.room_name,
          meta: [room.building, room.room_code, room.room_type || '정보 없음', prettyFloor(room.floor)],
          selection: buildSelectionFromRoom(room)
        })),
        ...facilities.slice(0, 6).map((facility) => ({
          rank: 1,
          type: 'facility',
          title: facility.name,
          meta: [facility.category || '편의시설', facility.building, prettyFloor(facility.floor)],
          selection: buildSelectionFromFacility(facility)
        }))
      ];
    }

    if (activeFilter !== 'all') {
      results = results.filter((item) => {
        if (activeFilter === 'building') return item.type === 'building';
        if (activeFilter === 'room') return item.type === 'room';
        if (activeFilter === 'facility') return item.type === 'facility';
        return item.type === 'facility' && item.meta[0] === activeFilter;
      });
    }

    const deduped = [];
    const seen = new Set();
    results.sort((a, b) => b.rank - a.rank || a.title.localeCompare(b.title, 'ko'));
    for (const item of results) {
      if (!item.selection) continue;
      const key = `${item.type}-${item.title}-${item.selection.room_code || item.selection.name || item.selection.building}`;
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(item);
      }
      if (deduped.length >= 24) break;
    }

    currentSearchResults.push(...deduped);

    if (!deduped.length) {
      container.innerHTML = '<div class="empty">검색 결과가 없습니다.</div>';
      return;
    }

    container.innerHTML = deduped.map((item, idx) => `
      <div class="result-item result-${item.type}">
        <div class="result-head">
          <div class="result-title">${escapeHtml(item.title)}</div>
          <span class="result-type type-${item.type}">${item.type === 'building' ? '건물' : item.type === 'room' ? '강의실' : '편의시설'}</span>
        </div>
        <div class="result-meta">${item.meta.map((m, metaIdx) => `<span class="chip ${item.type === 'facility' && metaIdx === 0 ? categoryClass(m) : ''}">${escapeHtml(m)}</span>`).join('')}</div>
        <div class="btn-row">
          <button class="btn secondary" onclick="window.selectSearchItem(${idx}, 'start')">출발지로 선택</button>
          <button class="btn danger" onclick="window.selectSearchItem(${idx}, 'end')">목적지로 선택</button>
        </div>
      </div>
    `).join('');
  }

  function renderQuickFilters() {
    const container = document.getElementById('quickFilters');
    const baseFilters = [
      { key: 'all', label: '전체' },
      { key: 'building', label: '건물' },
      { key: 'room', label: '강의실' },
      { key: 'facility', label: '편의시설' }
    ];
    const categoryFilters = facilityCategories.map((category) => ({ key: category, label: category }));
    const filters = [...baseFilters, ...categoryFilters];

    container.innerHTML = filters.map((filter) => `
      <button class="filter-chip ${activeFilter === filter.key ? 'active' : ''}" data-filter="${escapeHtml(filter.key)}">${escapeHtml(filter.label)}</button>
    `).join('');

    container.querySelectorAll('.filter-chip').forEach((button) => {
      button.addEventListener('click', () => {
        activeFilter = button.dataset.filter;
        renderQuickFilters();
        renderSearchResults(document.getElementById('searchInput').value);
        updateFacilityMarkerVisibility();
      });
    });
  }

  function updateSummary() {
    document.getElementById('buildingCount').textContent = buildings.length;
    document.getElementById('classroomCount').textContent = classrooms.length;
    document.getElementById('facilityCount').textContent = facilities.length;
  }

  function updateFacilityMarkerVisibility() {
    facilityMarkers.forEach(({ marker, facility }) => {
      const categoryVisible = activeFilter === 'all' || activeFilter === 'facility' || activeFilter === facility.category;
      const shouldShow = categoryVisible;
      if (shouldShow && !map.hasLayer(marker)) marker.addTo(map);
      if (!shouldShow && map.hasLayer(marker)) map.removeLayer(marker);
    });
  }

  function initMap() {
    const center = [35.8623, 129.1939];
    map = L.map('map', { zoomControl: true }).setView(center, 17);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 20,
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);

    buildings.forEach((b) => {
      const marker = L.marker([b.lat, b.lng], { icon: getColorIcon('#2563eb', 16) }).addTo(map);
      marker.bindPopup(createBuildingPopup(b.building), { maxWidth: 260 });
      marker.on('click', () => showBuildingDetail(b.building));
      buildingMarkers.set(b.building, marker);
    });

    facilities.filter((facility) => facility.has_coordinates).forEach((facility) => {
      const marker = L.circleMarker([facility.lat, facility.lng], {
        radius: 7,
        weight: 3,
        color: '#ffffff',
        fillColor: getFacilityColor(facility.category),
        fillOpacity: 0.95
      }).addTo(map);
      marker.bindPopup(createFacilityPopup(facility), { maxWidth: 260 });
      marker.on('click', () => showFacilityDetail(facility));
      facilityMarkers.push({ marker, facility });
    });

    map.on('click', (e) => {
      const { lat, lng } = e.latlng;
      if (clickedMarker) map.removeLayer(clickedMarker);
      clickedMarker = L.marker([lat, lng], { icon: getColorIcon('#8b5cf6', 16) }).addTo(map);
      clickedMarker.bindPopup(createCustomPopup(lat, lng), { maxWidth: 260 }).openPopup();
    });
  }

  async function locateMe(useAsStart = false) {
    if (!navigator.geolocation) {
      alert('이 브라우저에서는 위치 정보를 지원하지 않습니다.');
      return;
    }
    navigator.geolocation.getCurrentPosition((pos) => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      currentLocation = { kind: 'current', name: '현재 위치', lat, lng };
      if (currentMarker) map.removeLayer(currentMarker);
      currentMarker = L.marker([lat, lng], { icon: getColorIcon('#10b981', 18) }).addTo(map).bindPopup('현재 위치').openPopup();
      map.flyTo([lat, lng], 18, { duration: 0.8 });
      if (useAsStart) setSelection('start', currentLocation);
    }, () => {
      alert('현재 위치를 가져오지 못했습니다. 브라우저 위치 권한을 확인해 주세요.');
    }, { enableHighAccuracy: true, timeout: 8000 });
  }

  function bindUI() {
    document.getElementById('searchInput').addEventListener('input', (e) => renderSearchResults(e.target.value));
    document.getElementById('locateBtn').addEventListener('click', () => locateMe(false));
    document.getElementById('useCurrentAsStartBtn').addEventListener('click', () => locateMe(true));
    document.getElementById('clearRouteBtn').addEventListener('click', () => {
      startSelection = null;
      endSelection = null;
      updateSelectionUI();
      if (routeLine) {
        map.removeLayer(routeLine);
        routeLine = null;
      }
      setRouteSummary();
      updateRouteBadge();
    });
    document.getElementById('focusSelectedBtn').addEventListener('click', () => {
      if (endSelection) moveToSelection(endSelection);
      else if (startSelection) moveToSelection(startSelection);
    });
    document.getElementById('swapBtn').addEventListener('click', () => {
      const temp = startSelection;
      startSelection = endSelection;
      endSelection = temp;
      updateSelectionUI();
      drawRoute();
    });
  }

  initMap();
  bindUI();
  updateSummary();
  renderQuickFilters();
  renderSearchResults('');
  updateSelectionUI();
  setRouteSummary();
}

initApp().catch((err) => {
  console.error(err);
  const routeBadge = document.getElementById('routeBadge');
  if (routeBadge) {
    routeBadge.textContent = '데이터를 불러오지 못했습니다. app.py와 CSV 파일 위치를 확인하세요.';
  }
});
