const wsUrl = getWebSocketUrl();
const SESSION_KEY = "sanchase_session";
const STALE_SYNC_MS = 4000;
const HEARTBEAT_MS = 20_000;

let ws = null;
let reconnectTimer = null;
let reconnectAttempt = 0;
let reconnectingToastShown = false;
let lastStateSyncAt = 0;

function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveSession(partial) {
  const prev = loadSession() ?? {};
  localStorage.setItem(SESSION_KEY, JSON.stringify({ ...prev, ...partial, playerId: myId }));
}

const savedSession = loadSession();
const myId = savedSession?.playerId ?? `ply${Math.floor(Math.random() * 999999)}`;
const devMode = isDevMode();

let reconnectToken = savedSession?.reconnectToken ?? "";
let pendingReconnect = false;

let roomId = "";
let me = null;
let currentState = null;
let map = null;
let mapReady = false;
let myMarker = null;
let accuracyCircle = null;
let localFilteredLocation = null;
let lastGpsWarningAt = 0;
const markers = new Map();
let rallyMarker = null;
let rallyFlagMarker = null;
let revealMarkers = [];
const missionMarkers = new Map();
let debriefMarker = null;
let boundaryMaskLayer = null;
let boundaryBorderLayer = null;
let holdTimer = null;
let holdMissionId = null;
let simLocation = null;
let devSimLocked = false;
let audioCtx = null;
let audioUnlocked = false;
let noiseAlarmTimeouts = [];
let pendingMissionResult = null;
let lastRenderedPhase = null;
let startOverlayTimer = null;
let playAreaAssessment = null;
let playAreaRadius = null;
let radiusSliderDragging = false;
let setupCenterMarker = null;
let setupMapClickBound = false;
let setupCenterSynced = false;
let setupConfirmPending = false;
let lastLocationSentAt = 0;
let lastLocationSent = null;
let lastClientPhase = null;
let lastSetupViewKey = null;
let lastPlayAreaBoundaryKey = null;
let mapResizeTimer = null;
let stickyMissionId = null;
let lastGameActionsPhase = null;
let lastStartEligibility = { ok: false, reason: "" };
let playerView = { copRadars: [], radarDetections: [], radarRangeM: 75 };
const radarLayers = new Map();
const radarSpotMarkers = new Map();

const MISSION_HOLD_SEC = () => 30;
const MISSION_HIT_M = 15;
const MISSION_EXIT_M = 35;
const MAX_COP_SCAN_USES = 2;
const ARREST_FAIL_STILL_SEC = 10;
const OUTSIDE_GRACE_SEC = 20;
const GPS_GOOD_M = 35;
const GPS_WEAK_M = 55;
const GPS_MAX_SEND_M = 80;
const GPS_STALE_MS = 15_000;

function revealDisplayMs(state) {
  const radiusM = state?.playArea?.radiusM ?? playAreaRadius?.radiusM ?? 1320;
  return (radiusM < 120 ? 15 : 30) * 1000;
}

function arrestRecoveryLabel(me) {
  if (!me?.arrestPenaltyAnchor || me.arrestStillRemainingSec == null || me.arrestStillRemainingSec <= 0) return null;
  return `Arrêter (${me.arrestStillRemainingSec}s)`;
}

const $ = (id) => document.getElementById(id);

const screens = {
  entry: $("screen-entry"),
  lobby: $("screen-lobby"),
  game: $("screen-game")
};

function connectWebSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  ws = new WebSocket(wsUrl);
  ws.onopen = onWebSocketOpen;
  ws.onclose = onWebSocketClose;
  ws.onerror = onWebSocketError;
  ws.onmessage = handleWsMessage;
}

function onWebSocketOpen() {
  reconnectAttempt = 0;
  reconnectingToastShown = false;
  setConnection(true);
  attemptSessionReconnect();
  resyncAfterReconnect();
}

function onWebSocketClose() {
  setConnection(false);
  ws = null;
  scheduleReconnect();
}

function onWebSocketError() {
  setConnection(false);
}

function hasActiveSession() {
  const session = loadSession();
  return Boolean(session?.roomId && session?.reconnectToken);
}

function scheduleReconnect() {
  if (!hasActiveSession()) return;
  if (reconnectTimer) return;
  if (!reconnectingToastShown) {
    reconnectingToastShown = true;
    showToast("Reconnexion…");
  }
  const delay = Math.min(1000 * 2 ** reconnectAttempt, 12_000);
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWebSocket();
  }, delay);
}

function ensureWebSocketConnected() {
  if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) return;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnectAttempt = 0;
  connectWebSocket();
}

function wsSend(payload) {
  const data = typeof payload === "string" ? payload : JSON.stringify(payload);
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(data);
    return true;
  }
  if (hasActiveSession()) ensureWebSocketConnected();
  return false;
}

function resyncAfterReconnect() {
  if (!roomId || !currentState || currentState.phase === "lobby") return;
  void requestFreshLocation().then((loc) => {
    if (loc) sendLocationUpdate(loc, false, { force: true });
  });
  if (mapReady) scheduleMapResize();
}

function resumeFromBackground() {
  if (!hasActiveSession()) return;
  const stale = lastStateSyncAt > 0 && Date.now() - lastStateSyncAt > STALE_SYNC_MS;
  const dead = !ws || ws.readyState !== WebSocket.OPEN;
  if (dead || stale) {
    if (ws?.readyState === WebSocket.OPEN) ws.close();
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    reconnectAttempt = 0;
    connectWebSocket();
    return;
  }
  wsSend({ type: "heartbeat", roomId, playerId: myId });
  resyncAfterReconnect();
}

function handleWsMessage(ev) {
  const msg = JSON.parse(ev.data);
  if (msg.type === "state_sync") {
    lastStateSyncAt = Date.now();
    currentState = msg.state;
    playAreaAssessment = msg.playAreaAssessment ?? null;
    playAreaRadius = msg.playAreaRadius ?? null;
    me = currentState.players[myId] ?? null;
    if (me) {
      saveSession({ roomId: currentState.roomId, name: me.name, reconnectToken });
      if (pendingReconnect) {
        pendingReconnect = false;
        showToast("Reconnecté à la partie");
      }
    }
    if (pendingMissionResult && currentState.fugitiveId === myId) {
      const mission = currentState.missions.find((m) => m.id === pendingMissionResult.missionId);
      if (mission?.completed) {
        showMissionOverlay("success", "Mission accomplie !", mission.name);
        pendingMissionResult = null;
      }
    }
    lastStartEligibility = msg.startEligibility;
    playerView = msg.playerView ?? { copRadars: [], radarDetections: [], radarRangeM: playAreaRadius?.radiusM ? radarRangeForPlayArea(playAreaRadius.radiusM) : 75 };
    render(msg.startEligibility);
  } else if (msg.type === "reveal_positions") {
    ensureMap();
    unlockAudio();
    playRevealAlert();
    revealMarkers.forEach((m) => map.removeLayer(m));
    revealMarkers = msg.positions.map((p) =>
      L.marker([p.lat, p.lng], { icon: emojiIcon("🦸‍♀️"), zIndexOffset: 500 }).addTo(map)
    );
    showToast("Position du fugitif révélée !");
    setTimeout(() => {
      revealMarkers.forEach((m) => map.removeLayer(m));
      revealMarkers = [];
    }, revealDisplayMs(currentState));
  } else if (msg.type === "mission_completed") {
    showCopMissionPopup(msg.missionName, msg.completedCount, msg.totalCount);
  } else if (msg.type === "action_event") {
    showToast(msg.message);
  } else if (msg.type === "error") {
    const errMsg = msg.message.replace(/^Error:\s*/, "");
    setupConfirmPending = false;
    const isMissionError = /too far|trop loin|hold duration|mission hold|maintien|mission not available|mission hold not started/i.test(errMsg);
    if (isMissionError) {
      if (holdTimer) {
        clearInterval(holdTimer);
        holdTimer = null;
      }
      holdMissionId = null;
      if (pendingMissionResult) {
        showMissionOverlay("fail", "Mission échouée", "Trop loin de la cible");
        pendingMissionResult = null;
      }
      if (currentState?.phase !== "lobby") {
        renderGameActions(lastStartEligibility);
      }
    } else {
      showToast(errMsg);
    }
  } else if (msg.type === "session") {
    reconnectToken = msg.reconnectToken;
    saveSession({ reconnectToken, roomId, name: me?.name ?? savedSession?.name });
  } else if (msg.type === "room_closed") {
    leaveToEntryScreen(msg.reason);
  }
}

$("btn-join").onclick = () => {
  unlockAudio();
  roomId = $("room").value.trim().toUpperCase();
  const name = $("name").value.trim() || "Joueur";
  if (!roomId) return showToast("Entrez un code de salle");
  saveSession({ roomId, name });
  wsSend(JSON.stringify({
    type: "join_room",
    roomId,
    playerId: myId,
    name,
    ...(reconnectToken ? { reconnectToken } : {})
  }));
};

$("btn-create").onclick = () => {
  unlockAudio();
  roomId = $("room").value.trim().toUpperCase();
  const name = $("name").value.trim() || "Organisateur";
  if (!roomId) return showToast("Entrez un code de salle");
  saveSession({ roomId, name });
  const fugitiveSelection = $("fugitive-selection").value;
  const minPlayers = 2;
  wsSend(JSON.stringify({
    type: "create_room",
    roomId,
    playerId: myId,
    name,
    settings: { fugitiveSelection, minPlayersToStart: minPlayers }
  }));
};

$("btn-ready").onclick = () => {
  if (!roomId || !me) return;
  wsSend(JSON.stringify({ type: "set_ready", roomId, playerId: myId, ready: !me.ready }));
};

$("btn-select-fugitive").onclick = () => {
  const fugitiveId = $("fugitive-picker").value;
  if (fugitiveId) wsSend(JSON.stringify({ type: "select_fugitive", roomId, by: myId, fugitiveId }));
};

$("btn-start-launch")?.addEventListener("click", () => {
  if (!roomId || !me || me.role !== "organizer") return;
  const btn = $("btn-start-launch");
  if (btn?.disabled) {
    showToast(lastStartEligibility.reason || "Impossible de lancer la partie");
    return;
  }
  const existing = getSelfLocation();
  if (existing) sendLocationUpdate(existing, false, { force: true });
  wsSend(JSON.stringify({ type: "start_game", roomId, by: myId }));
  void requestFreshLocation().then((loc) => {
    if (loc) sendLocationUpdate(loc, false, { force: true });
  });
});

if (navigator.geolocation && !devMode) {
  navigator.geolocation.watchPosition(
    (pos) => {
      if (devMode && devSimLocked) return;
      const processed = processGpsReading({
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        speed: pos.coords.speed
      });
      if (processed) applyLocation(processed);
    },
    () => showToast("GPS indisponible — activez la localisation"),
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 }
  );
}

if (devMode) {
  $("dev-flyout")?.classList.remove("hidden");
  $("dev-lobby-panel")?.classList.remove("hidden");
  $("dev-flyout-toggle")?.addEventListener("click", () => {
    const flyout = $("dev-flyout");
    const panel = $("dev-panel");
    const toggle = $("dev-flyout-toggle");
    if (!flyout || !panel || !toggle) return;
    const open = !flyout.classList.contains("open");
    flyout.classList.toggle("open", open);
    panel.classList.toggle("hidden", !open);
    toggle.setAttribute("aria-expanded", String(open));
    toggle.textContent = open ? "▸" : "◂";
  });
  $("dev-lobby-loc")?.addEventListener("click", () => {
    const loc = simLocation ?? currentState?.playArea?.center ?? defaultSimLocation();
    sendSimLocation(loc.lat, loc.lng);
    showToast("Position test envoyée");
  });
  const enableRealGps = () => {
    devSimLocked = false;
    void requestFreshLocation().then((loc) => {
      if (loc) showToast("GPS réel réactivé");
      else showToast("GPS indisponible");
    });
  };
  $("dev-real-gps")?.addEventListener("click", enableRealGps);
  $("dev-real-gps-flyout")?.addEventListener("click", enableRealGps);
  $("dev-rally")?.addEventListener("click", () => teleportToRally());
  $("dev-mission")?.addEventListener("click", () => teleportToMission());
  $("dev-fugitive")?.addEventListener("click", () => teleportNearFugitive());
  $("dev-reveal")?.addEventListener("click", () => triggerDevReveal());
  const endDevGame = () => {
    if (!roomId) return;
    wsSend(JSON.stringify({ type: "dev_reset_room", roomId, by: myId }));
    showToast("Retour au lobby…");
  };
  $("dev-end-game")?.addEventListener("click", endDevGame);
  $("dev-end-game-lobby")?.addEventListener("click", endDevGame);
  setInterval(() => {
    if (roomId && !me?.lastLocation) {
      const loc = simLocation ?? currentState?.playArea?.center;
      if (loc?.lat != null) sendSimLocation(loc.lat, loc.lng);
    }
  }, 3000);
}

initOrganizerFlyout();

function resetLocalGameSession() {
  if (holdTimer) {
    clearInterval(holdTimer);
    holdTimer = null;
  }
  holdMissionId = null;
  pendingMissionResult = null;
  setupConfirmPending = false;
  setupCenterSynced = false;
  lastSetupViewKey = null;
  lastGameActionsPhase = null;
  stickyMissionId = null;
  lastRenderedPhase = null;
  stopLoudNoise();
  $("game-start-overlay")?.classList.add("hidden");
  $("game-over-overlay")?.classList.add("hidden");
  $("mission-overlay")?.classList.add("hidden");
  $("cop-mission-popup")?.classList.add("hidden");
  if (mapReady && map) {
    revealMarkers.forEach((m) => map.removeLayer(m));
    revealMarkers = [];
    clearRadarLayers();
    clearSetupMapLayers();
  }
}

function render(eligibility) {
  if (!currentState || !me) return;

  if (devMode && roomId && !me?.lastLocation) {
    const loc = simLocation ?? currentState?.playArea?.center;
    if (loc?.lat != null) sendSimLocation(loc.lat, loc.lng);
  }

  const phase = currentState.phase;
  const prevPhase = lastClientPhase;
  if (phase === "lobby" && prevPhase && prevPhase !== "lobby") {
    resetLocalGameSession();
  }
  if (phase === "setup" && prevPhase && prevPhase !== "setup" && prevPhase !== "lobby") {
    resetLocalGameSession();
    setupCenterSynced = false;
  }
  const structuralChanged = phase !== prevPhase || didStructureChange();
  lastClientPhase = phase;

  if (phase === "lobby") {
    showScreen("lobby");
    renderLobby(eligibility);
    updateOrganizerFlyout();
    return;
  }
  if (phase === "setup" && me.role !== "organizer") {
    showScreen("lobby");
    renderSetupWaiting();
    return;
  }

  showScreen("game");
  ensureMap();
  if (phase === "setup" && me.role === "organizer" && structuralChanged) {
    void requestFreshLocation();
  }

  if (structuralChanged) {
    renderGame(eligibility);
    scheduleMapResize();
    if (prevPhase !== phase) setTimeout(scheduleMapResize, 400);
  } else {
    renderGameLight(eligibility);
  }
  updateOrganizerFlyout();
}

function didStructureChange() {
  const s = currentState;
  const pa = s.playArea;
  const key = [
    s.phase,
    s.fugitiveId,
    pa?.center?.lat?.toFixed(5),
    pa?.center?.lng?.toFixed(5),
    pa?.radiusM,
    s.settings?.playAreaRadiusM,
    JSON.stringify(s.rallyPoints),
    JSON.stringify(s.missions?.map((m) => ({ id: m.id, c: m.completed }))),
    Object.values(s.players).map((p) => `${p.id}:${p.ready}:${p.reachedRally}`).join("|")
  ].join(";");
  if (key === didStructureChange._last) return false;
  didStructureChange._last = key;
  return true;
}

function renderGameLight(eligibility) {
  const phase = currentState.phase;
  const isFugitive = currentState.fugitiveId === myId;

  if (phase === "rally") {
    const { reached, total } = countRallyReached();
    const rallyProgressEl = $("rally-progress");
    rallyProgressEl.textContent = `${reached}/${total} joueur${total > 1 ? "s" : ""} en position`;
    if (currentState.playArea?.radiusM) {
      rallyProgressEl.textContent += ` · Zone ${formatRadiusM(currentState.playArea.radiusM)}`;
    }
  }

  if (phase === "active" && !isFugitive && isCopScanActive(currentState)) {
    const left = Math.max(0, currentState.copScanUntilTick - currentState.tick);
    $("cop-scan-alert").textContent = `⚠️ Scan fugitif actif — ${formatCountdown(left)} restantes`;
  }

  renderBoundaryAlert();
  renderRevealCountdown();
  renderGpsQuality();

  renderMapLayers();
  renderGameActions(eligibility);
}

function renderRevealCountdown() {
  const el = $("reveal-countdown");
  if (!el || !currentState) return;

  if (currentState.phase !== "active") {
    el.classList.add("hidden");
    el.classList.remove("active");
    return;
  }

  const tick = currentState.tick;
  const untilNext = Math.max(0, currentState.nextRevealTick - tick);
  const inRevealWindow = currentState.revealUntilTick > tick;
  const isFugitive = currentState.fugitiveId === myId;

  el.classList.remove("hidden");
  el.classList.toggle("active", inRevealWindow);

  if (inRevealWindow) {
    const revealLeft = Math.max(0, currentState.revealUntilTick - tick);
    el.textContent = isFugitive
      ? `⚠️ Position révélée — ${formatCountdown(revealLeft)}`
      : `📍 Fugitif visible — ${formatCountdown(revealLeft)}`;
  } else {
    el.textContent = `Prochaine révélation dans ${formatCountdown(untilNext)}`;
  }
}

function classifyGpsQuality(loc) {
  if (!loc) return "none";
  if (Date.now() - loc.ts > GPS_STALE_MS) return "stale";
  if (loc.accuracyM <= GPS_GOOD_M) return "good";
  if (loc.accuracyM <= GPS_WEAK_M) return "weak";
  return "poor";
}

function gpsQualityLabel(quality) {
  return {
    good: "GPS précis",
    weak: "GPS approximatif",
    poor: "GPS faible",
    stale: "GPS expiré",
    none: "GPS indisponible"
  }[quality];
}

function smoothGpsLocation(prev, raw) {
  if (!prev) return raw;
  const weight = Math.max(0.15, Math.min(0.6, 25 / raw.accuracyM));
  return {
    lat: prev.lat * (1 - weight) + raw.lat * weight,
    lng: prev.lng * (1 - weight) + raw.lng * weight,
    accuracyM: Math.min(raw.accuracyM, prev.accuracyM * 0.85 + raw.accuracyM * 0.15),
    ts: raw.ts
  };
}

function isImplausibleGpsJump(prev, next) {
  const dtSec = Math.max((next.ts - prev.ts) / 1000, 0.5);
  const dist = haversineMeters(prev.lat, prev.lng, next.lat, next.lng);
  const maxSpeed = next.speedMps != null && next.speedMps >= 0 ? Math.max(16, next.speedMps * 1.5) : 16;
  return dist / dtSec > maxSpeed && next.accuracyM > GPS_GOOD_M;
}

function warnGpsOnce(message) {
  const now = Date.now();
  if (now - lastGpsWarningAt < 8000) return;
  lastGpsWarningAt = now;
  showToast(message);
}

function processGpsReading(coords) {
  const raw = {
    lat: coords.latitude,
    lng: coords.longitude,
    accuracyM: Math.max(1, coords.accuracy ?? 999),
    ts: Date.now(),
    speedMps: coords.speed != null && coords.speed >= 0 ? coords.speed : null
  };

  if (raw.accuracyM > 120) {
    warnGpsOnce("Signal GPS trop faible");
    return null;
  }

  if (raw.accuracyM > GPS_MAX_SEND_M && localFilteredLocation) {
    warnGpsOnce("GPS faible — position précédente conservée");
    return null;
  }

  let next = smoothGpsLocation(localFilteredLocation, raw);
  if (localFilteredLocation && isImplausibleGpsJump(localFilteredLocation, next)) {
    warnGpsOnce("Saut GPS ignoré");
    return null;
  }

  localFilteredLocation = next;
  return next;
}

function gpsReadyForGameplay(loc = getSelfLocation()) {
  if (!loc) return { ok: false, reason: "GPS indisponible" };
  if (Date.now() - loc.ts > GPS_STALE_MS) return { ok: false, reason: "GPS expiré — attendez un nouveau fix" };
  if (loc.accuracyM > GPS_WEAK_M) return { ok: false, reason: "GPS trop imprécis" };
  return { ok: true, reason: "" };
}

function renderGpsQuality() {
  const el = $("gps-quality");
  if (!el || !currentState) return;

  const inGame = ["setup", "rally", "active"].includes(currentState.phase);
  if (!inGame) {
    el.classList.add("hidden");
    return;
  }

  const loc = getSelfLocation();
  const quality = classifyGpsQuality(loc);
  el.classList.remove("hidden", "good", "weak", "poor", "stale", "none");
  el.classList.add(quality);
  const meters = loc?.accuracyM ? ` ±${Math.round(loc.accuracyM)} m` : "";
  el.textContent = `${gpsQualityLabel(quality)}${quality === "good" || quality === "weak" ? meters : ""}`;
  el.title = loc
    ? `Précision estimée : ${Math.round(loc.accuracyM)} m`
    : "Activez la localisation précise dans les réglages du téléphone";
}

function renderSetupWaiting() {
  $("lobby-room-code").textContent = currentState.roomId;
  $("lobby-room-name").textContent = currentState.settings.roomName;
  $("player-count").textContent = String(Object.keys(currentState.players).length);

  $("organizer-panel").classList.add("hidden");
  $("btn-ready").classList.add("hidden");

  const statusEl = $("lobby-status");
  statusEl.textContent = "L'organisateur prépare le terrain de jeu";
  statusEl.className = "status-banner ok";

  const list = $("player-list");
  list.innerHTML = "";
  Object.values(currentState.players).forEach((p) => {
    const li = document.createElement("li");
    li.className = "player-item";
    const badges = [];
    if (p.role === "organizer") badges.push('<span class="badge badge-org">Hôte</span>');
    if (p.id === currentState.fugitiveId) badges.push('<span class="badge badge-fugitive">Fugitif</span>');
    badges.push(p.ready
      ? '<span class="badge badge-ready">Prêt</span>'
      : '<span class="badge badge-wait">En attente</span>');
    li.innerHTML = `
      <div>
        <div class="player-name">${escapeHtml(p.name)}</div>
        <div class="player-meta">${formatRoleDisplay(p, currentState.fugitiveId)}</div>
      </div>
      <div style="display:flex;gap:6px">${badges.join("")}</div>`;
    list.appendChild(li);
  });
}

function renderLobby(eligibility) {
  $("lobby-room-code").textContent = currentState.roomId;
  $("lobby-room-name").textContent = currentState.settings.roomName;
  $("player-count").textContent = String(Object.keys(currentState.players).length);

  const isOrganizer = me.role === "organizer";
  $("organizer-panel").classList.toggle("hidden", !isOrganizer);
  $("btn-start-launch").disabled = !eligibility.ok;
  $("btn-ready").classList.remove("hidden");

  const statusEl = $("lobby-status");
  statusEl.textContent = eligibility.reason;
  statusEl.className = `status-banner ${eligibility.ok ? "ok" : "warn"}`;

  $("btn-ready").textContent = me.ready ? "Annuler prêt" : "Je suis prêt";
  $("btn-ready").className = me.ready ? "btn btn-secondary" : "btn btn-success";

  const list = $("player-list");
  list.innerHTML = "";
  Object.values(currentState.players).forEach((p) => {
    const li = document.createElement("li");
    li.className = "player-item";
    const badges = [];
    if (p.role === "organizer") badges.push('<span class="badge badge-org">Hôte</span>');
    if (p.id === currentState.fugitiveId) badges.push('<span class="badge badge-fugitive">Fugitif</span>');
    badges.push(p.ready
      ? '<span class="badge badge-ready">Prêt</span>'
      : '<span class="badge badge-wait">En attente</span>');
    li.innerHTML = `
      <div>
        <div class="player-name">${escapeHtml(p.name)}</div>
        <div class="player-meta">${formatRoleDisplay(p, currentState.fugitiveId)}</div>
      </div>
      <div style="display:flex;gap:6px">${badges.join("")}</div>`;
    list.appendChild(li);
  });

  const picker = $("fugitive-picker");
  const previousPick = picker.value;
  picker.innerHTML = "";
  Object.values(currentState.players).forEach((p) => {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name;
    picker.appendChild(opt);
  });
  if (currentState.fugitiveId) {
    picker.value = currentState.fugitiveId;
  } else if (previousPick && currentState.players[previousPick]) {
    picker.value = previousPick;
  }

  const manualFugitive = currentState.settings.fugitiveSelection === "manual";
  $("fugitive-manual-panel")?.classList.toggle("hidden", !manualFugitive);
  $("btn-select-fugitive")?.classList.toggle("hidden", !manualFugitive);
  $("fugitive-random-hint")?.classList.toggle("hidden", manualFugitive);

  renderPlayAreaControls("lobby");
}

function renderGame(eligibility) {
  const phase = currentState.phase;
  if (phase !== "setup") {
    setupCenterSynced = false;
    setupConfirmPending = false;
    lastSetupViewKey = null;
  }
  const isFugitive = currentState.fugitiveId === myId;
  $("screen-game").classList.toggle("phase-setup", phase === "setup");
  $("screen-game").classList.toggle("role-fugitive", isFugitive);

  const pill = $("phase-pill");
  pill.textContent = phaseLabel(phase);
  pill.className = `phase-pill ${phase}`;

  $("role-label").textContent = formatRoleDisplay(me, currentState.fugitiveId, true);

  const setupBanner = $("setup-banner");
  setupBanner.classList.toggle("hidden", phase !== "setup");
  if (phase === "setup") {
    setupBanner.innerHTML = "<strong>Préparez le terrain de jeu</strong> — déplacez le centre, ajustez le rayon, puis validez.";
  }

  const rallyBanner = $("rally-banner");
  rallyBanner.classList.toggle("hidden", phase !== "rally");
  const rallyProgressEl = $("rally-progress");
  if (phase === "rally") {
    const { reached, total } = countRallyReached();
    rallyProgressEl.classList.remove("hidden");
    rallyProgressEl.textContent = `${reached}/${total} joueur${total > 1 ? "s" : ""} en position`;
    if (currentState.playArea?.radiusM) {
      rallyProgressEl.textContent += ` · Zone ${formatRadiusM(currentState.playArea.radiusM)}`;
    }
    if (currentState.rallyPoints[myId]) {
      const reachedSelf = me.reachedRally;
      rallyBanner.innerHTML = reachedSelf
        ? "<strong>Position de départ atteinte !</strong> En attente du lancement de la chasse."
        : "<strong>Allez à votre position de départ</strong> — rejoignez le cercle vert sur la carte.";
    }
  } else {
    rallyProgressEl.classList.add("hidden");
  }

  const copTracker = $("cop-mission-tracker");
  if (phase === "active" && !isFugitive) {
    const completed = currentState.missions.filter((m) => m.completed).length;
    const total = currentState.missions.length;
    copTracker.classList.remove("hidden");
    copTracker.classList.toggle("danger", completed >= 2);
    copTracker.textContent = `Objectifs fugitif accomplis : ${completed}/${total}`;
  } else {
    copTracker.classList.add("hidden");
  }

  const scanAlert = $("cop-scan-alert");
  if (phase === "active" && !isFugitive && isCopScanActive(currentState)) {
    const left = Math.max(0, currentState.copScanUntilTick - currentState.tick);
    scanAlert.classList.remove("hidden");
    scanAlert.textContent = `⚠️ Scan fugitif actif — ${formatCountdown(left)} restantes`;
  } else {
    scanAlert.classList.add("hidden");
  }

  renderMapLayers();
  renderBoundaryAlert();
  renderRevealCountdown();
  renderGpsQuality();
  renderGameActions(eligibility);
  renderPlayAreaAssessment();
  renderPlayAreaControls("game");
  renderGameStart();
  renderGameOver();
}

function formatRadiusM(m) {
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(2)} km`;
}

function formatAreaPerCop(km2) {
  if (km2 < 0.01) return `${Math.round(km2 * 1_000_000)} m²/flic`;
  return `${km2.toFixed(3)} km²/flic`;
}

function mapZoomForRadius(radiusM) {
  if (radiusM <= 30) return 18;
  if (radiusM <= 60) return 17;
  if (radiusM <= 120) return 16;
  return 15;
}

function renderPlayAreaAssessment() {
  const el = $("play-area-assessment");
  if (!el || !playAreaAssessment || currentState.phase === "lobby" || currentState.phase === "setup") {
    el?.classList.add("hidden");
    return;
  }

  const isOrganizer = me.role === "organizer";
  if (!devMode && !isOrganizer) {
    el.classList.add("hidden");
    return;
  }
  if (isMobileLayout()) {
    el.classList.add("hidden");
    return;
  }

  const a = playAreaAssessment;
  el.classList.remove("hidden", "too_small", "tight", "balanced", "large", "too_large");
  el.classList.add(a.verdict);

  const sizeLabel = a.isMicro
    ? `${a.diameterM} m de diamètre`
    : formatRadiusM(a.radiusM);
  const rangeLabel = a.isMicro
    ? `${Math.round(a.balancedMinM * 2)}–${Math.round(a.balancedMaxM * 2)} m`
    : `${formatRadiusM(a.balancedMinM)}–${formatRadiusM(a.balancedMaxM)}`;
  el.innerHTML = `
    <div class="assessment-title">Zone : ${a.verdictLabelFr} (${sizeLabel})</div>
    <div class="assessment-metrics">
      Traversée ~${a.walkCrossingMin} min à pied · ~${a.jogCrossingMin} min en courant<br>
      ${a.copCount} flic${a.copCount > 1 ? "s" : ""} · ${formatAreaPerCop(a.areaPerCopKm2)} · marge ${a.evasionMarginM} m<br>
      Plage équilibrée : ${rangeLabel}${a.isMicro ? "" : ` · cible ${formatRadiusM(a.recommendedRadiusM)}`}
    </div>
    <div class="assessment-hint">${escapeHtml(a.hintFr)}</div>`;
}

function renderPlayAreaControls(context) {
  const isOrganizer = me?.role === "organizer";
  const phase = currentState?.phase ?? "lobby";

  const lobbyEl = $("lobby-play-area-controls");
  const gameEl = $("game-play-area-controls");
  const setupEl = $("setup-play-area-controls");
  const devEl = $("dev-play-area-controls");
  const optionsEl = $("organizer-options");

  if (context === "lobby") {
    if (!lobbyEl || !isOrganizer || phase !== "lobby" || !playAreaRadius) {
      lobbyEl?.replaceChildren();
      return;
    }
    mountPlayAreaControls(lobbyEl, playAreaRadius, false);
    return;
  }

  const inGame = phase === "setup" || phase === "rally" || phase === "active";
  if (!isOrganizer || !inGame || !playAreaRadius) {
    optionsEl?.classList.add("hidden");
    setupEl?.classList.add("hidden");
    setupEl?.replaceChildren();
    devEl?.classList.add("hidden");
    gameEl?.replaceChildren();
    devEl?.replaceChildren();
    return;
  }

  if (phase === "setup" && !devMode) {
    optionsEl?.classList.add("hidden");
    setupEl?.classList.remove("hidden");
    devEl?.classList.add("hidden");
    devEl?.replaceChildren();
    gameEl?.replaceChildren();
    mountPlayAreaControls(setupEl, playAreaRadius, true);
    return;
  }

  setupEl?.classList.add("hidden");
  setupEl?.replaceChildren();

  if (devMode) {
    optionsEl?.classList.add("hidden");
    devEl?.classList.remove("hidden");
    mountPlayAreaControls(devEl, playAreaRadius, true);
    gameEl?.replaceChildren();
  } else {
    optionsEl?.classList.remove("hidden");
    devEl?.classList.add("hidden");
    devEl?.replaceChildren();
    mountPlayAreaControls(gameEl, playAreaRadius, false);
  }
}

function mountPlayAreaControls(container, info, compact) {
  if (!container || radiusSliderDragging) return;
  const cacheKey = `${info.currentM}:${info.isAuto}:${compact}`;
  if (container.dataset.controlsKey === cacheKey && container.querySelector('input[type="range"]')) return;
  container.dataset.controlsKey = cacheKey;
  const radiusLabel = formatRadiusM(info.currentM);
  const autoLabel = info.isAuto ? " (auto)" : "";
  container.innerHTML = `
    ${compact ? '<span class="dev-label">Zone</span>' : ""}
    <label>
      <span>Rayon de la zone · Ø ${Math.round(info.currentM * 2)} m</span>
      <span class="radius-value">${radiusLabel}${autoLabel}</span>
    </label>
    <div class="radius-slider-row">
      <button type="button" class="btn btn-secondary btn-sm radius-step" data-delta="-1" aria-label="Réduire le rayon">−</button>
      <input type="range" min="${info.minM}" max="${info.maxM}" step="${info.stepM}" value="${info.currentM}" />
      <button type="button" class="btn btn-secondary btn-sm radius-step" data-delta="1" aria-label="Augmenter le rayon">+</button>
    </div>
    <div class="play-area-presets">
      <button type="button" class="btn btn-secondary btn-sm preset-auto${info.isAuto ? " active" : ""}">Auto</button>
      <button type="button" class="btn btn-secondary btn-sm preset-hide-seek">Cache-cache</button>
      <button type="button" class="btn btn-secondary btn-sm preset-micro">Mini</button>
      <button type="button" class="btn btn-secondary btn-sm preset-balanced">Équilibrée</button>
    </div>`;

  const slider = container.querySelector('input[type="range"]');
  const valueEl = container.querySelector(".radius-value");

  slider.addEventListener("pointerdown", () => { radiusSliderDragging = true; });
  slider.addEventListener("pointerup", () => { radiusSliderDragging = false; });
  slider.addEventListener("input", () => {
    valueEl.textContent = formatRadiusM(Number(slider.value));
  });
  slider.addEventListener("change", () => {
    radiusSliderDragging = false;
    sendPlayAreaRadius(Number(slider.value));
  });

  container.querySelectorAll(".radius-step").forEach((btn) => {
    btn.addEventListener("click", () => {
      const delta = Number(btn.dataset.delta);
      const step = Number(slider.step) || info.stepM;
      const next = Math.min(info.maxM, Math.max(info.minM, Number(slider.value) + delta * step));
      slider.value = String(next);
      valueEl.textContent = `${formatRadiusM(next)}${autoLabel}`;
      radiusSliderDragging = false;
      sendPlayAreaRadius(next);
    });
  });

  container.querySelector(".preset-auto")?.addEventListener("click", () => sendPlayAreaRadius(null));
  container.querySelector(".preset-hide-seek")?.addEventListener("click", () => sendPlayAreaRadius(info.presets.hideSeekM));
  container.querySelector(".preset-micro")?.addEventListener("click", () => sendPlayAreaRadius(info.presets.microM));
  container.querySelector(".preset-balanced")?.addEventListener("click", () => sendPlayAreaRadius(info.presets.balancedM));

  if (compact) container.classList.add("play-area-controls-compact");
}

function sendPlayAreaRadius(radiusM) {
  if (!roomId || me?.role !== "organizer") return;
  wsSend(JSON.stringify({ type: "set_play_area_radius", roomId, by: myId, radiusM }));
}

function renderGameStart() {
  const overlay = $("game-start-overlay");
  if (!overlay) return;

  const phase = currentState.phase;
  if (phase === "finished") {
    overlay.classList.add("hidden");
    lastRenderedPhase = phase;
    return;
  }

  if (phase === "active" && lastRenderedPhase && lastRenderedPhase !== "active") {
    showGameStartOverlay();
  }
  lastRenderedPhase = phase;
}

function showGameStartOverlay() {
  const overlay = $("game-start-overlay");
  const isFugitive = currentState.fugitiveId === myId;

  overlay.classList.remove("hidden", "cops-win", "fugitive-win");
  overlay.classList.add(isFugitive ? "fugitive-win" : "cops-win");

  $("game-start-headline").textContent = "La chasse commence !";
  $("game-start-detail").textContent = isFugitive
    ? "Accomplissez vos 3 missions sans vous faire arrêter"
    : "Arrêtez le fugitif avant la fin du temps";
  $("game-start-outcome").textContent = isFugitive ? "Fuyez !" : "Attrapez-le !";

  clearTimeout(startOverlayTimer);
  startOverlayTimer = setTimeout(() => overlay.classList.add("hidden"), 4500);
}

function renderGameOver() {
  const overlay = $("game-over-overlay");
  if (!overlay) return;

  const phase = currentState.phase;
  if (phase !== "finished" || !currentState.winner) {
    overlay.classList.add("hidden");
    overlay.classList.remove("cops-win", "fugitive-win", "player-win", "player-lose");
    return;
  }

  $("game-start-overlay")?.classList.add("hidden");

  const isFugitive = currentState.fugitiveId === myId;
  const fugitiveEscaped = currentState.winner === "fugitive";
  const playerWon = (fugitiveEscaped && isFugitive) || (!fugitiveEscaped && !isFugitive);

  overlay.classList.remove("hidden", "cops-win", "fugitive-win", "player-win", "player-lose");
  overlay.classList.add(fugitiveEscaped ? "fugitive-win" : "cops-win");
  overlay.classList.add(playerWon ? "player-win" : "player-lose");

  const detailEl = $("game-over-detail");
  if (fugitiveEscaped) {
    $("game-over-headline").textContent = "Le fugitif s'est échappé";
    detailEl.textContent = "";
  } else if (currentState.endReason === "arrest" && currentState.arrestedById) {
    $("game-over-headline").textContent = "Fugitif arrêté";
    const copName = currentState.players[currentState.arrestedById]?.name ?? "Un flic";
    detailEl.textContent = `Par ${copName}`;
  } else if (currentState.endReason === "timeout") {
    $("game-over-headline").textContent = "Temps écoulé";
    detailEl.textContent = "Le fugitif n'a pas terminé à temps";
  } else if (currentState.endReason === "boundary") {
    $("game-over-headline").textContent = "Hors zone de jeu";
    detailEl.textContent = currentState.fugitiveId === myId
      ? "Le fugitif est resté trop longtemps hors zone"
      : "Le fugitif a été éliminé pour sortie de zone";
  } else {
    $("game-over-headline").textContent = "Les flics gagnent";
    detailEl.textContent = "";
  }
  $("game-over-outcome").textContent = playerWon ? "Victoire !" : "Défaite !";
}

function sendPlayAreaCenter(lat, lng) {
  if (devMode) {
    simLocation = { lat, lng, accuracyM: 5, ts: Date.now() };
  }
  if (!roomId || me?.role !== "organizer") return;
  wsSend(JSON.stringify({ type: "set_play_area_center", roomId, by: myId, lat, lng }));
}

function confirmSetupZone(btn) {
  if (setupConfirmPending || !roomId) return;
  setupConfirmPending = true;
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Validation…";
  }
  requestFreshLocation().then((loc) => {
    if (loc) {
      sendLocationUpdate(loc, false, { force: true });
      sendPlayAreaCenter(loc.lat, loc.lng);
    }
    wsSend(JSON.stringify({ type: "confirm_setup", roomId, by: myId }));
  });
}

function renderGameActions(eligibility) {
  const wrap = $("game-actions");
  const phase = currentState.phase;
  const isFugitive = currentState.fugitiveId === myId;
  const isOrganizer = me.role === "organizer";

  if (me.eliminated && (phase === "rally" || phase === "active")) {
    wrap.replaceChildren();
    wrap.classList.remove("hidden");
    wrap.appendChild(actionBtn("Éliminé — hors zone", "btn-secondary", null, true));
    syncActionBarLayout(wrap);
    return;
  }

  if (lastGameActionsPhase !== phase) {
    wrap.replaceChildren();
    lastGameActionsPhase = phase;
  }

  if (phase === "setup" && isOrganizer) {
    wrap.classList.remove("hidden");
    let confirmBtn = wrap.querySelector("[data-action=confirm-setup]");
    if (!confirmBtn) {
      wrap.replaceChildren();
      confirmBtn = actionBtn("Valider la zone", "btn-primary", () => confirmSetupZone(confirmBtn));
      confirmBtn.dataset.action = "confirm-setup";
      wrap.appendChild(confirmBtn);
      wrap.appendChild(actionBtn("Centrer sur moi", "btn-secondary", () => {
        const loc = me.lastLocation ?? getSelfLocation();
        if (loc) {
          sendPlayAreaCenter(loc.lat, loc.lng);
          lastSetupViewKey = null;
        } else showToast("Position GPS requise");
      }));
    }
    confirmBtn.disabled = setupConfirmPending;
    confirmBtn.textContent = setupConfirmPending ? "Validation…" : "Valider la zone";
    syncActionBarLayout(wrap);
    return;
  }

  if (phase === "active" && isFugitive) {
    renderFugitiveActions(wrap);
    syncActionBarLayout(wrap);
    return;
  }

  if (phase === "rally" && isOrganizer) {
    renderRallyOrganizerActions(wrap, eligibility);
    syncActionBarLayout(wrap);
    return;
  }

  if (phase === "active" && !isFugitive) {
    renderCopActions(wrap);
    syncActionBarLayout(wrap);
    return;
  }

  wrap.replaceChildren();
  wrap.classList.add("hidden");
  syncActionBarLayout(wrap);
}

function renderFugitiveActions(wrap) {
  const missionsLeft = currentState.missions.some((m) => !m.completed);
  if (!missionsLeft) {
    wrap.replaceChildren();
    wrap.classList.add("hidden");
    return;
  }
  wrap.classList.remove("hidden");

  let holdBtn = wrap.querySelector("#mission-hold");
  if (!holdBtn) {
    wrap.replaceChildren();
    holdBtn = actionBtn("Mission", "btn-primary", () => toggleMissionHold(), true);
    holdBtn.id = "mission-hold";
    wrap.appendChild(holdBtn);

    const scanBtn = actionBtn("Scan flics", "btn-secondary", () => {
      wsSend(JSON.stringify({ type: "use_cop_scan", roomId, by: myId }));
    });
    scanBtn.id = "cop-scan-btn";
    scanBtn.style.display = "none";
    wrap.appendChild(scanBtn);

    const decoyBtn = actionBtn("Leurre", "btn-secondary", () => {
      wsSend(JSON.stringify({ type: "use_decoy_reveal", roomId, by: myId }));
    });
    decoyBtn.id = "decoy-btn";
    wrap.appendChild(decoyBtn);
  }

  if (holdTimer || holdMissionId || pendingMissionResult) {
    syncMissionHoldButton(holdBtn);
    updateFugitivePowerButtons(wrap);
    return;
  }

  const mission = findMissionInRange();
  const gpsGate = gpsReadyForGameplay();
  holdBtn.disabled = !mission || !gpsGate.ok;
  if (!mission) {
    holdBtn.title = "Approchez-vous d'un objectif sur la carte";
  } else if (!gpsGate.ok) {
    holdBtn.title = gpsGate.reason;
  } else if ((me?.missionProximityStreak ?? 0) < 2) {
    holdBtn.title = "Restez sur l'objectif quelques secondes (GPS)";
  } else {
    holdBtn.title = "";
  }
  holdBtn.textContent = "Mission";
  holdBtn.className = "btn btn-primary";

  updateFugitivePowerButtons(wrap);
}

function syncMissionHoldButton(btn) {
  if (!btn) return;
  if (pendingMissionResult) {
    btn.disabled = true;
    btn.textContent = "Validation…";
    btn.className = "btn btn-primary";
    return;
  }
  if (holdTimer) {
    btn.disabled = false;
    btn.className = "btn btn-danger";
    return;
  }
  if (holdMissionId) {
    btn.disabled = true;
    btn.textContent = "Démarrage…";
    btn.className = "btn btn-danger";
  }
}

function updateFugitivePowerButtons(wrap) {
  const scanUsesLeft = MAX_COP_SCAN_USES - (me.copScanUses ?? 0);
  const scanActive = isCopScanActive(currentState);
  const scanBtn = wrap.querySelector("#cop-scan-btn");
  if (scanBtn) {
    const showScan = scanUsesLeft > 0 || scanActive;
    scanBtn.style.display = showScan ? "" : "none";
    if (showScan) {
      scanBtn.disabled = scanActive;
      scanBtn.textContent = scanActive
        ? `Scan actif — ${formatCountdown(currentState.copScanUntilTick - currentState.tick)}`
        : `Scan flics (${scanUsesLeft})`;
    }
  }

  const decoyBtn = wrap.querySelector("#decoy-btn");
  if (decoyBtn) {
    decoyBtn.disabled = !!me.usedDecoyPower;
    decoyBtn.textContent = me.usedDecoyPower ? "Leurre (utilisé)" : "Leurre";
  }
}

function renderCopActions(wrap) {
  wrap.classList.remove("hidden");

  let radarBtn = wrap.querySelector("#cop-radar-btn");
  if (!radarBtn) {
    wrap.replaceChildren();
    radarBtn = actionBtn("Poser radar", "btn-secondary", () => {
      const loc = getSelfLocation();
      if (!loc) return showToast("Position GPS requise");
      wsSend(JSON.stringify({ type: "deploy_cop_radar", roomId, by: myId }));
      showToast("Radar posé sur la carte");
    });
    radarBtn.id = "cop-radar-btn";
    wrap.appendChild(radarBtn);

    const arrestBtn = actionBtn("Arrêter", "btn-danger", () => {
      wsSend(JSON.stringify({ type: "attempt_arrest", roomId, by: myId }));
    });
    arrestBtn.id = "cop-arrest-btn";
    wrap.appendChild(arrestBtn);
  }

  radarBtn.disabled = !!me.usedRadar;
  radarBtn.textContent = me.usedRadar ? "Radar (posé)" : "Poser radar";
  radarBtn.title = me.usedRadar
    ? "Votre radar reste actif jusqu'à la fin de la partie"
    : `Place un radar fixe (portée ${Math.round(playerView.radarRangeM ?? 75)} m)`;

  const arrestBtn = wrap.querySelector("#cop-arrest-btn");
  if (arrestBtn) {
    const arrestLabel = arrestRecoveryLabel(me);
    if (arrestLabel) {
      arrestBtn.disabled = true;
      arrestBtn.textContent = arrestLabel;
      arrestBtn.className = "btn btn-danger";
    } else {
      arrestBtn.disabled = false;
      arrestBtn.textContent = "Arrêter";
      arrestBtn.className = "btn btn-danger";
    }
  }
}

function renderRallyOrganizerActions(wrap, eligibility) {
  wrap.classList.remove("hidden");
  let launchBtn = wrap.querySelector("#launch-chase-btn");
  if (!launchBtn) {
    wrap.replaceChildren();
    launchBtn = actionBtn("Lancer la chasse", "btn-primary", () => {
      wsSend(JSON.stringify({ type: "start_chase", roomId, by: myId }));
    }, !eligibility.ok);
    launchBtn.id = "launch-chase-btn";
    wrap.appendChild(launchBtn);
    const forceBtn = actionBtn("Forcer le lancement", "btn-secondary", () => {
      wsSend(JSON.stringify({ type: "start_chase", roomId, by: myId, force: true }));
    });
    forceBtn.id = "force-chase-btn";
    forceBtn.title = "Démarrer même si tous les joueurs ne sont pas en position";
    forceBtn.style.display = "none";
    wrap.appendChild(forceBtn);
  }

  launchBtn.disabled = !eligibility.ok;
  const forceBtn = wrap.querySelector("#force-chase-btn");
  if (forceBtn) forceBtn.style.display = eligibility.ok ? "none" : "";
}

function syncActionBarLayout(wrap) {
  const visible = wrap.childElementCount > 0 && !wrap.classList.contains("hidden");
  screens.game.classList.toggle("actions-visible", visible);
}

function isSelfOutsidePlayArea() {
  const loc = getSelfLocation();
  const area = currentState?.playArea;
  if (!loc || !area?.center?.lat) return false;
  return haversineMeters(loc.lat, loc.lng, area.center.lat, area.center.lng) > area.radiusM;
}

function renderBoundaryAlert() {
  const el = $("boundary-alert");
  const hud = $("game-hud");
  if (!el || !hud || !currentState || !me) return;

  const phase = currentState.phase;
  const inBoundaryPhase = phase === "rally" || phase === "active";
  if (!inBoundaryPhase) {
    el.classList.add("hidden");
    el.classList.remove("eliminated");
    hud.classList.remove("player-outside");
    return;
  }

  if (me.eliminated) {
    el.classList.remove("hidden");
    el.classList.add("eliminated");
    el.textContent = "Éliminé — vous étiez hors zone de jeu";
    hud.classList.remove("player-outside");
    return;
  }

  const remaining = me.outsideSinceTick != null
    ? Math.max(0, OUTSIDE_GRACE_SEC - (currentState.tick - me.outsideSinceTick))
    : null;
  const outside = remaining != null || isSelfOutsidePlayArea();

  if (!outside) {
    el.classList.add("hidden");
    hud.classList.remove("player-outside");
    return;
  }

  el.classList.remove("hidden", "eliminated");
  hud.classList.add("player-outside");
  if (remaining != null) {
    el.textContent = remaining > 0
      ? `⚠️ Hors zone — retournez en ${remaining} s ou élimination`
      : "⚠️ Hors zone — élimination imminente";
  } else {
    el.textContent = "⚠️ Hors zone — retournez dans la zone de jeu";
  }
}

function renderMapLayers() {
  if (!mapReady) return;

  renderPlayAreaBoundary();

  const phase = currentState.phase;
  if (phase === "setup") {
    renderSetupMapLayers();
    return;
  }
  clearSetupMapLayers();

  const isFugitive = currentState.fugitiveId === myId;
  const scanActive = isCopScanActive(currentState);

  if (me) {
    const selfLoc = getSelfLocation();
    if (selfLoc) {
      if (isFugitive) {
        myMarker = setEmojiMarker(myMarker, selfLoc.lat, selfLoc.lng, "🦸‍♀️", "", true);
      } else {
        myMarker = setEmojiMarker(myMarker, selfLoc.lat, selfLoc.lng, "👮", "", true);
      }
      renderAccuracyCircle(selfLoc);
    } else if (accuracyCircle) {
      map.removeLayer(accuracyCircle);
      accuracyCircle = null;
    }
  }

  const activeMarkerIds = new Set();
  for (const [id, p] of Object.entries(currentState.players)) {
    if (!p.lastLocation || id === myId || p.eliminated) continue;

    const isCop = id !== currentState.fugitiveId;
    const hideFromCops = id === currentState.fugitiveId && !isFugitive && (phase === "rally" || phase === "active");
    const hideFromFugitive = isFugitive && isCop && (phase === "rally" || (phase === "active" && !scanActive));

    if (hideFromCops || hideFromFugitive) continue;

    if (id === currentState.fugitiveId) {
      markers.set(id, setEmojiMarker(markers.get(id), p.lastLocation.lat, p.lastLocation.lng, "🦸‍♀️"));
    } else {
      markers.set(id, setEmojiMarker(markers.get(id), p.lastLocation.lat, p.lastLocation.lng, "👮", p.name, false, "cop-name"));
    }
    activeMarkerIds.add(id);
  }

  for (const id of [...markers.keys()]) {
    if (!activeMarkerIds.has(id)) {
      map.removeLayer(markers.get(id));
      markers.delete(id);
    }
  }

  const rp = currentState.rallyPoints[myId];
  const rallyHit = playAreaRadius?.rallyHitM ?? 40;
  if (rp && phase === "rally") {
    if (!rallyMarker) {
      rallyMarker = L.circle([rp.lat, rp.lng], {
        radius: rallyHit,
        color: me.reachedRally ? "#86efac" : "#22c55e",
        fillColor: me.reachedRally ? "#86efac" : "#22c55e",
        fillOpacity: me.reachedRally ? 0.35 : 0.2,
        weight: me.reachedRally ? 3 : 2
      }).addTo(map);
      rallyFlagMarker = L.marker([rp.lat, rp.lng], { icon: emojiIcon("📍"), zIndexOffset: 400 }).addTo(map);
      const areaR = currentState.playArea?.radiusM ?? 500;
      const areaCenter = currentState.playArea?.center;
      const viewTarget = areaCenter?.lat ? areaCenter : (getSelfLocation() ?? rp);
      map.setView([viewTarget.lat, viewTarget.lng], mapZoomForRadius(areaR));
    } else {
      rallyMarker.setLatLng([rp.lat, rp.lng]);
      rallyMarker.setRadius(rallyHit);
      rallyMarker.setStyle({
        color: me.reachedRally ? "#86efac" : "#22c55e",
        fillColor: me.reachedRally ? "#86efac" : "#22c55e",
        fillOpacity: me.reachedRally ? 0.35 : 0.2,
        weight: me.reachedRally ? 3 : 2
      });
      rallyFlagMarker?.setLatLng([rp.lat, rp.lng]);
    }
  } else {
    if (rallyMarker) { map.removeLayer(rallyMarker); rallyMarker = null; }
    if (rallyFlagMarker) { map.removeLayer(rallyFlagMarker); rallyFlagMarker = null; }
  }

  for (const marker of missionMarkers.values()) map.removeLayer(marker);
  missionMarkers.clear();
  if (isFugitive && phase === "active") {
    currentState.missions.forEach((m) => {
      if (m.completed || !m.point.lat) return;
      missionMarkers.set(m.id, L.marker([m.point.lat, m.point.lng], {
        icon: emojiIcon("🎯", m.name),
        zIndexOffset: 300
      }).addTo(map));
    });
  }

  if (currentState.debriefPoint?.lat) {
    const p = currentState.debriefPoint;
    if (!debriefMarker) {
      debriefMarker = L.marker([p.lat, p.lng], { icon: emojiIcon("🏁"), zIndexOffset: 200 }).addTo(map)
        .bindPopup("Point de debrief");
    } else {
      debriefMarker.setLatLng([p.lat, p.lng]);
    }
  }

  renderRadarLayers();
}

function radarRangeForPlayArea(radiusM) {
  if (radiusM >= 400) return 75;
  return Math.min(75, Math.max(12, Math.round(radiusM * 0.18)));
}

function clearRadarLayers() {
  for (const layers of radarLayers.values()) {
    map?.removeLayer(layers.circle);
    map?.removeLayer(layers.pin);
  }
  radarLayers.clear();
  for (const marker of radarSpotMarkers.values()) map?.removeLayer(marker);
  radarSpotMarkers.clear();
}

function renderRadarLayers() {
  if (!mapReady || !currentState) return;
  if (currentState.phase !== "active") {
    clearRadarLayers();
    return;
  }

  const radars = playerView?.copRadars ?? [];
  const detections = playerView?.radarDetections ?? [];
  const rangeM = playerView?.radarRangeM ?? radarRangeForPlayArea(currentState.playArea?.radiusM ?? 1320);
  const activeRadarIds = new Set();

  for (const radar of radars) {
    activeRadarIds.add(radar.id);
    let layers = radarLayers.get(radar.id);
    if (!layers) {
      const circle = L.circle([radar.point.lat, radar.point.lng], {
        radius: rangeM,
        color: "#38bdf8",
        fillColor: "#38bdf8",
        fillOpacity: 0.07,
        weight: 1.5,
        dashArray: "5 6"
      }).addTo(map);
      const pin = L.marker([radar.point.lat, radar.point.lng], {
        icon: emojiIcon("📡", "", false, "", true),
        zIndexOffset: 250
      }).addTo(map);
      layers = { circle, pin };
      radarLayers.set(radar.id, layers);
    } else {
      layers.circle.setLatLng([radar.point.lat, radar.point.lng]);
      layers.circle.setRadius(rangeM);
      layers.pin.setLatLng([radar.point.lat, radar.point.lng]);
    }
  }

  for (const [id, layers] of [...radarLayers.entries()]) {
    if (!activeRadarIds.has(id)) {
      map.removeLayer(layers.circle);
      map.removeLayer(layers.pin);
      radarLayers.delete(id);
    }
  }

  const activeSpotIds = new Set();
  for (const spot of detections) {
    activeSpotIds.add(spot.radarId);
    radarSpotMarkers.set(
      spot.radarId,
      setEmojiMarker(
        radarSpotMarkers.get(spot.radarId),
        spot.position.lat,
        spot.position.lng,
        "🦸‍♀️",
        "",
        false
      )
    );
  }

  for (const [id, marker] of [...radarSpotMarkers.entries()]) {
    if (!activeSpotIds.has(id)) {
      map.removeLayer(marker);
      radarSpotMarkers.delete(id);
    }
  }
}

function renderSetupMapLayers() {
  for (const id of [...markers.keys()]) {
    map.removeLayer(markers.get(id));
    markers.delete(id);
  }
  if (rallyMarker) { map.removeLayer(rallyMarker); rallyMarker = null; }
  if (rallyFlagMarker) { map.removeLayer(rallyFlagMarker); rallyFlagMarker = null; }

  const area = currentState.playArea;
  if (!area?.center?.lat) return;

  const { center } = area;
  const selfLoc = getSelfLocation();
  if (selfLoc) {
    myMarker = setEmojiMarker(myMarker, selfLoc.lat, selfLoc.lng, "👮", "", true);
  } else if (myMarker) {
    map.removeLayer(myMarker);
    myMarker = null;
  }

  if (!setupCenterMarker) {
    setupCenterMarker = L.marker([center.lat, center.lng], {
      icon: emojiIcon("📍"),
      draggable: true,
      zIndexOffset: 600
    }).addTo(map);
    setupCenterMarker.on("dragend", () => {
      const pos = setupCenterMarker.getLatLng();
      sendPlayAreaCenter(pos.lat, pos.lng);
    });
  } else {
    setupCenterMarker.setLatLng([center.lat, center.lng]);
  }

  if (!setupMapClickBound) {
    map.on("click", onSetupMapClick);
    setupMapClickBound = true;
  }

  const viewKey = `${center.lat.toFixed(5)},${center.lng.toFixed(5)},${area.radiusM}`;
  if (lastSetupViewKey !== viewKey) {
    map.setView([center.lat, center.lng], mapZoomForRadius(area.radiusM ?? 500), { animate: false });
    lastSetupViewKey = viewKey;
    scheduleMapResize();
  }
}

function scheduleMapResize() {
  if (!mapReady || !map) return;
  clearTimeout(mapResizeTimer);
  mapResizeTimer = setTimeout(() => {
    map?.invalidateSize({ animate: false });
  }, 120);
}

function refreshMapLayout() {
  scheduleMapResize();
}

function onSetupMapClick(ev) {
  if (currentState?.phase !== "setup" || me?.role !== "organizer") return;
  sendPlayAreaCenter(ev.latlng.lat, ev.latlng.lng);
}

function clearSetupMapLayers() {
  if (setupCenterMarker) {
    map?.removeLayer(setupCenterMarker);
    setupCenterMarker = null;
  }
  if (setupMapClickBound && map) {
    map.off("click", onSetupMapClick);
    setupMapClickBound = false;
  }
}

function ensureMap() {
  if (mapReady) return;
  map = L.map("map", { zoomControl: true, tap: true });
  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap &copy; CARTO"
  }).addTo(map);
  const initial = getSelfLocation() ?? currentState?.playArea?.center;
  map.setView(initial?.lat != null ? [initial.lat, initial.lng] : [48.8566, 2.3522], 14);
  mapReady = true;
  refreshMapLayout();
  map.on("zoomend moveend", () => {
    if (boundaryMaskLayer) applyHatchFill(boundaryMaskLayer);
  });

  if (!window.__sanchaseMapResizeBound) {
    window.__sanchaseMapResizeBound = true;
    window.addEventListener("resize", () => scheduleMapResize());
    window.addEventListener("orientationchange", () => setTimeout(scheduleMapResize, 300));
  }
}

function toggleMissionHold() {
  if (holdTimer) {
    cancelHold();
    return;
  }
  startMissionHold();
}

function startMissionHold() {
  if (!roomId || !me || currentState?.fugitiveId !== myId || holdTimer || holdMissionId || pendingMissionResult) return;
  const mission = findMissionInRange();
  if (!mission) return;
  const missionId = mission.id;
  holdMissionId = missionId;
  const btn = document.getElementById("mission-hold");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Démarrage…";
  }

  requestFreshLocation().then((loc) => {
    if (loc) sendLocationUpdate(loc, false, { force: true });
    if (!holdMissionId || holdMissionId !== missionId) return;
    const gate = gpsReadyForGameplay(loc ?? getSelfLocation());
    if (!gate.ok) {
      holdMissionId = null;
      if (btn) {
        btn.textContent = "Mission";
        btn.className = "btn btn-primary";
        btn.disabled = false;
      }
      showToast(gate.reason);
      renderGameActions(lastStartEligibility);
      return;
    }
    wsSend(JSON.stringify({ type: "start_mission_hold", roomId, by: myId, missionId }));
    const total = MISSION_HOLD_SEC();
    if (btn) {
      btn.disabled = false;
      btn.textContent = `Maintien… ${total}s (appuyer pour annuler)`;
      btn.className = "btn btn-danger";
    }
    const start = Date.now();
    holdTimer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - start) / 1000);
      const left = Math.max(0, total - elapsed);
      if (btn) btn.textContent = `Maintien… ${left}s (appuyer pour annuler)`;
      if (elapsed >= total) {
        clearInterval(holdTimer);
        holdTimer = null;
        finishMissionHold(missionId);
      }
    }, 200);
  });
}

function finishMissionHold(missionId) {
  const btn = document.getElementById("mission-hold");
  if (btn) {
    btn.textContent = "Validation…";
    btn.disabled = true;
  }
  if (holdTimer) {
    clearInterval(holdTimer);
    holdTimer = null;
  }
  holdMissionId = null;

  requestFreshLocation().then((loc) => {
    if (loc) sendLocationUpdate(loc, false, { force: true });
    const mission = currentState?.missions?.find((m) => m.id === missionId);
    if (!mission) {
      renderGameActions(lastStartEligibility);
      return;
    }

    pendingMissionResult = { missionId, missionName: mission.name };
    wsSend(JSON.stringify({
      type: "complete_mission_hold",
      roomId,
      by: myId,
      missionId
    }));
    renderGameActions(lastStartEligibility);
  });
}

function cancelHold() {
  if (!holdTimer) return;
  const missionId = holdMissionId ?? findMissionInRange()?.id;
  clearInterval(holdTimer);
  holdTimer = null;
  holdMissionId = null;
  const btn = document.getElementById("mission-hold");
  if (btn) {
    btn.textContent = "Mission";
    btn.className = "btn btn-primary";
  }
  if (missionId) wsSend(JSON.stringify({ type: "cancel_mission_hold", roomId, by: myId, missionId }));
  renderGameActions(lastStartEligibility);
}

function showScreen(name) {
  screens.entry.classList.toggle("hidden", name !== "entry");
  screens.lobby.classList.toggle("hidden", name !== "lobby");
  screens.game.classList.toggle("hidden", name !== "game");
  document.documentElement.classList.toggle("game-active", name === "game");
  if (name === "game") scheduleMapResize();
}

function initOrganizerFlyout() {
  $("organizer-flyout-toggle")?.addEventListener("click", () => {
    const flyout = $("organizer-flyout");
    const panel = $("organizer-flyout-panel");
    const toggle = $("organizer-flyout-toggle");
    if (!flyout || !panel || !toggle) return;
    const open = !flyout.classList.contains("open");
    flyout.classList.toggle("open", open);
    panel.classList.toggle("hidden", !open);
    toggle.setAttribute("aria-expanded", String(open));
    toggle.textContent = open ? "◂" : "▸";
  });
  $("organizer-reset-game")?.addEventListener("click", () => {
    if (!roomId || me?.role !== "organizer") return;
    if (!confirm("Recommencer à la sélection de la zone ? La manche en cours sera effacée.")) return;
    wsSend(JSON.stringify({ type: "organizer_reset_game", roomId, by: myId }));
  });
  $("organizer-quit-game")?.addEventListener("click", () => {
    if (!roomId || me?.role !== "organizer") return;
    if (!confirm("Quitter la partie et renvoyer tout le monde au menu principal ?")) return;
    wsSend(JSON.stringify({ type: "organizer_quit_game", roomId, by: myId }));
    leaveToEntryScreen("Partie terminée.");
  });
}

function updateOrganizerFlyout() {
  const flyout = $("organizer-flyout");
  if (!flyout) return;
  const show = me?.role === "organizer" && currentState && currentState.phase !== "lobby";
  flyout.classList.toggle("hidden", !show);
}

function leaveToEntryScreen(reason) {
  roomId = "";
  reconnectToken = "";
  currentState = null;
  me = null;
  playAreaAssessment = null;
  playAreaRadius = null;
  localStorage.removeItem(SESSION_KEY);
  resetLocalGameSession();
  $("organizer-flyout")?.classList.add("hidden");
  $("organizer-flyout")?.classList.remove("open");
  showScreen("entry");
  if (reason) showToast(reason);
}

function attemptSessionReconnect() {
  const session = loadSession();
  if (!session?.roomId || !session.reconnectToken) return;
  roomId = session.roomId;
  if (session.name && $("name")) $("name").value = session.name;
  if ($("room")) $("room").value = session.roomId;
  reconnectToken = session.reconnectToken;
  pendingReconnect = true;
  wsSend(JSON.stringify({
    type: "join_room",
    roomId: session.roomId,
    playerId: myId,
    name: session.name ?? "Joueur",
    reconnectToken: session.reconnectToken
  }));
}

function setConnection(online) {
  for (const id of ["conn-dot", "conn-dot-lobby"]) {
    const dot = $(id);
    if (dot) dot.classList.toggle("online", online);
  }
  const label = online ? "Connecté" : "Déconnecté";
  $("conn-label").textContent = label;
  const lobbyLabel = $("conn-label-lobby");
  if (lobbyLabel) lobbyLabel.textContent = label;
}

function showToast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.add("hidden"), 3500);
}

function actionBtn(label, cls, onClick, disabled = false) {
  const btn = document.createElement("button");
  btn.className = `btn ${cls}`;
  btn.textContent = label;
  btn.disabled = disabled;
  if (onClick) btn.onclick = onClick;
  return btn;
}

function phaseLabel(phase) {
  return { lobby: "Salon", setup: "Préparation", rally: "Rassemblement", active: "Chasse", finished: "Terminé" }[phase] ?? phase;
}

function formatRoleDisplay(player, fugitiveId, forSelf = false) {
  const isFugitive = player.id === fugitiveId;
  if (player.role === "organizer") {
    return isFugitive ? "Organisateur/Fugitif" : "Organisateur/Flic";
  }
  if (isFugitive) return forSelf ? "Vous êtes le fugitif" : "Fugitif";
  return "Flic";
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function isLocalDev() {
  const h = window.location.hostname;
  return h === "localhost" || h === "127.0.0.1" || h.startsWith("192.168.") || h.startsWith("10.");
}

function isMobileLayout() {
  return window.matchMedia("(max-width: 768px)").matches;
}

function isDevMode() {
  return window.__SANCHASE_CONFIG__?.devMode === true;
}

function defaultSimLocation() {
  const n = parseInt(myId.replace(/\D/g, ""), 10) || 0;
  const offset = (n % 20) * 0.0003;
  return { lat: 48.8566 + offset, lng: 2.3522 + offset, accuracyM: 5, ts: Date.now() };
}

function sendSimLocation(lat, lng) {
  devSimLocked = true;
  simLocation = { lat, lng, accuracyM: 5, ts: Date.now() };
  applyLocation(simLocation, { simulated: true });
  if (mapReady) map.setView([lat, lng], map.getZoom(), { animate: true });
}

function sendLocationUpdate(location, simulated = false, { force = false } = {}) {
  if (!roomId || ws?.readyState !== WebSocket.OPEN) return;
  const now = Date.now();
  if (!force && !simulated && lastLocationSent) {
    const elapsed = now - lastLocationSentAt;
    const moved = haversineMeters(lastLocationSent.lat, lastLocationSent.lng, location.lat, location.lng);
    if (elapsed < 5000 && moved < 12) return;
  }
  lastLocationSentAt = now;
  lastLocationSent = location;
  wsSend({
    type: "location_update",
    roomId,
    playerId: myId,
    location,
    simulated
  });
}

function applyLocation(location, { simulated = false, force = false } = {}) {
  if (devMode && devSimLocked && !simulated) return;
  if (!simulated) localFilteredLocation = location;
  if (me) me.lastLocation = location;
  if (devMode && !simulated && !devSimLocked) {
    simLocation = { ...location, ts: Date.now() };
  }
  sendLocationUpdate(location, simulated, { force });
}

function requestFreshLocation() {
  return new Promise((resolve) => {
    if (devMode && devSimLocked) {
      resolve(getSelfLocation());
      return;
    }
    if (!navigator.geolocation) {
      resolve(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const processed = processGpsReading({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          speed: pos.coords.speed
        });
        if (processed) {
          applyLocation(processed, { force: true });
          resolve(processed);
        } else {
          resolve(getSelfLocation());
        }
      },
      () => resolve(getSelfLocation()),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 12000 }
    );
  });
}

function syncSetupCenterToGps() {
  if (setupCenterSynced || currentState?.phase !== "setup" || me?.role !== "organizer") return;
  const loc = getSelfLocation();
  if (!loc?.lat) return;
  const center = currentState.playArea?.center;
  if (center?.lat) {
    const dist = haversineMeters(loc.lat, loc.lng, center.lat, center.lng);
    if (dist < 5) {
      setupCenterSynced = true;
      lastSetupViewKey = null;
      return;
    }
  }
  sendPlayAreaCenter(loc.lat, loc.lng);
  lastSetupViewKey = null;
  setupCenterSynced = true;
}

function getSelfLocation() {
  if (localFilteredLocation && Date.now() - localFilteredLocation.ts <= GPS_STALE_MS) {
    return localFilteredLocation;
  }
  if (me?.lastLocation) return me.lastLocation;
  if (devMode && simLocation) return simLocation;
  return null;
}

function renderAccuracyCircle(loc) {
  if (!mapReady || !loc?.accuracyM) return;
  const radius = Math.max(8, Math.min(loc.accuracyM, 120));
  const quality = classifyGpsQuality(loc);
  const color = quality === "good" ? "#22c55e" : quality === "weak" ? "#f59e0b" : "#ef4444";
  if (!accuracyCircle) {
    accuracyCircle = L.circle([loc.lat, loc.lng], {
      radius,
      color,
      weight: 1.5,
      fillColor: color,
      fillOpacity: 0.08,
      dashArray: "6 5",
      className: "accuracy-circle"
    }).addTo(map);
  } else {
    accuracyCircle.setLatLng([loc.lat, loc.lng]);
    accuracyCircle.setRadius(radius);
    accuracyCircle.setStyle({ color, fillColor: color });
  }
}

function teleportToRally() {
  const rp = currentState?.rallyPoints?.[myId];
  if (!rp?.lat) return showToast("Pas encore de position de départ");
  sendSimLocation(rp.lat, rp.lng);
  showToast("En position de départ");
}

function teleportToMission() {
  const mission = currentState?.missions?.find((m) => !m.completed && m.point?.lat);
  if (!mission) return showToast("Aucune mission disponible");
  sendSimLocation(mission.point.lat, mission.point.lng);
  showToast(`Sur place : ${mission.name || mission.id}`);
}

function countRallyReached() {
  const players = Object.values(currentState?.players ?? {});
  return {
    reached: players.filter((p) => p.reachedRally).length,
    total: players.length
  };
}

function missionReachRadiusM(loc) {
  return MISSION_HIT_M + Math.min(25, loc?.accuracyM ?? 20);
}

function isNearMission(loc, point) {
  if (!point?.lat || !loc) return false;
  return haversineMeters(loc.lat, loc.lng, point.lat, point.lng) <= missionReachRadiusM(loc);
}

function findMissionInRange() {
  const loc = getSelfLocation();
  if (!loc || !currentState) return null;

  if (stickyMissionId) {
    const sticky = currentState.missions.find((m) => m.id === stickyMissionId);
    if (sticky && !sticky.completed && sticky.point?.lat) {
      const dist = haversineMeters(loc.lat, loc.lng, sticky.point.lat, sticky.point.lng);
      const exitR = MISSION_EXIT_M + Math.min(20, loc.accuracyM ?? 15);
      if (dist <= exitR) return sticky;
      stickyMissionId = null;
    } else {
      stickyMissionId = null;
    }
  }

  let best = null;
  let bestDist = Infinity;
  const enterR = missionReachRadiusM(loc);
  for (const m of currentState.missions) {
    if (m.completed || !m.point?.lat) continue;
    const dist = haversineMeters(loc.lat, loc.lng, m.point.lat, m.point.lng);
    if (dist <= enterR && dist < bestDist) {
      best = m;
      bestDist = dist;
    }
  }
  if (best) stickyMissionId = best.id;
  return best;
}

function isCopScanActive(state) {
  return state?.phase === "active" && state.tick < state.copScanUntilTick;
}

function formatCountdown(totalSec) {
  const sec = Math.max(0, totalSec);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function emojiIcon(emoji, label = "", self = false, labelClass = "", compact = false) {
  const labelHtml = label
    ? `<div class="map-marker-label${labelClass ? ` ${labelClass}` : ""}">${escapeHtml(label)}</div>`
    : "";
  const pinClass = compact
    ? "map-marker-pin compact"
    : `map-marker-pin${self ? " self" : ""}`;
  return L.divIcon({
    className: "map-emoji-marker",
    html: `<div class="map-marker-wrap"><div class="${pinClass}">${emoji}</div>${labelHtml}</div>`,
    iconSize: compact ? [22, 22] : label ? [130, 52] : [36, 36],
    iconAnchor: compact ? [11, 11] : label ? [65, 22] : [18, 18]
  });
}

function setEmojiMarker(existing, lat, lng, emoji, label = "", self = false, labelClass = "") {
  if (existing && typeof existing.setIcon !== "function") {
    map.removeLayer(existing);
    existing = null;
  }
  const icon = emojiIcon(emoji, label, self, labelClass);
  if (!existing) {
    return L.marker([lat, lng], { icon, zIndexOffset: self ? 1000 : 0 }).addTo(map);
  }
  existing.setLatLng([lat, lng]);
  existing.setIcon(icon);
  return existing;
}

function setCopDotMarker(existing, lat, lng) {
  const color = "#38bdf8";
  if (existing && typeof existing.setIcon === "function") {
    map.removeLayer(existing);
    existing = null;
  }
  if (existing && typeof existing.setRadius === "function") {
    existing.setLatLng([lat, lng]);
    existing.setStyle({ color, fillColor: color });
    return existing;
  }
  if (existing) map.removeLayer(existing);
  return L.circleMarker([lat, lng], {
    radius: 7,
    color,
    fillColor: color,
    fillOpacity: 0.85,
    weight: 2
  }).addTo(map);
}

function renderPlayAreaBoundary() {
  const area = currentState?.playArea;
  const visible = area?.center?.lat && area.radiusM && currentState.phase !== "lobby";
  if (!visible) {
    lastPlayAreaBoundaryKey = null;
    removeBoundaryLayers();
    return;
  }

  const boundaryKey = `${area.center.lat.toFixed(5)},${area.center.lng.toFixed(5)},${area.radiusM}`;
  if (boundaryKey === lastPlayAreaBoundaryKey) return;
  lastPlayAreaBoundaryKey = boundaryKey;

  ensureMapHatchPattern();

  const { center, radiusM } = area;
  const latDelta = (radiusM * 2.8) / 111320;
  const lngDelta = latDelta / Math.max(Math.cos((center.lat * Math.PI) / 180), 0.2);
  const outerRing = [
    [center.lat - latDelta, center.lng - lngDelta],
    [center.lat - latDelta, center.lng + lngDelta],
    [center.lat + latDelta, center.lng + lngDelta],
    [center.lat + latDelta, center.lng - lngDelta]
  ];
  const innerRing = circleLatLngRing(center, radiusM).reverse();

  if (!boundaryMaskLayer) {
    boundaryMaskLayer = L.polygon([outerRing, innerRing], {
      stroke: false,
      fill: true,
      fillColor: "#0b0f14",
      fillOpacity: 0.72,
      interactive: false
    }).addTo(map);
    boundaryMaskLayer.bringToBack();
  } else {
    boundaryMaskLayer.setLatLngs([outerRing, innerRing]);
    boundaryMaskLayer.bringToBack();
  }
  applyHatchFill(boundaryMaskLayer);

  if (!boundaryBorderLayer) {
    boundaryBorderLayer = L.circle([center.lat, center.lng], {
      radius: radiusM,
      color: "#4ade80",
      weight: 2.5,
      opacity: 0.95,
      dashArray: "10 8",
      fill: false,
      interactive: false
    }).addTo(map);
  } else {
    boundaryBorderLayer.setLatLng([center.lat, center.lng]);
    boundaryBorderLayer.setRadius(radiusM);
  }
}

function removeBoundaryLayers() {
  if (boundaryMaskLayer) {
    map.removeLayer(boundaryMaskLayer);
    boundaryMaskLayer = null;
  }
  if (boundaryBorderLayer) {
    map.removeLayer(boundaryBorderLayer);
    boundaryBorderLayer = null;
  }
}

function ensureMapHatchPattern() {
  if (!map || map._sanchaseHatchReady) return;
  const svg = map.getPanes().overlayPane?.querySelector("svg");
  if (!svg) return;

  let defs = svg.querySelector("defs");
  if (!defs) {
    defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    svg.insertBefore(defs, svg.firstChild);
  }
  if (svg.querySelector("#sanchase-hatch")) {
    map._sanchaseHatchReady = true;
    return;
  }

  const pattern = document.createElementNS("http://www.w3.org/2000/svg", "pattern");
  pattern.setAttribute("id", "sanchase-hatch");
  pattern.setAttribute("width", "12");
  pattern.setAttribute("height", "12");
  pattern.setAttribute("patternUnits", "userSpaceOnUse");
  pattern.setAttribute("patternTransform", "rotate(45)");

  const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  bg.setAttribute("width", "12");
  bg.setAttribute("height", "12");
  bg.setAttribute("fill", "rgba(11, 15, 20, 0.82)");

  const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
  line.setAttribute("x1", "0");
  line.setAttribute("y1", "0");
  line.setAttribute("x2", "0");
  line.setAttribute("y2", "12");
  line.setAttribute("stroke", "#64748b");
  line.setAttribute("stroke-width", "2");

  pattern.appendChild(bg);
  pattern.appendChild(line);
  defs.appendChild(pattern);
  map._sanchaseHatchReady = true;
}

function applyHatchFill(layer) {
  requestAnimationFrame(() => {
    const path = layer.getElement?.();
    if (!path) return;
    path.setAttribute("fill", "url(#sanchase-hatch)");
    path.setAttribute("fill-opacity", "0.88");
  });
}

function circleLatLngRing(center, radiusM, steps = 64) {
  const ring = [];
  for (let i = 0; i < steps; i++) {
    const bearing = (2 * Math.PI * i) / steps;
    const p = offsetMetersClient(center, radiusM, bearing);
    ring.push([p.lat, p.lng]);
  }
  return ring;
}

function offsetMetersClient(origin, meters, bearingRad) {
  const dLat = (meters * Math.cos(bearingRad)) / 111320;
  const dLng = (meters * Math.sin(bearingRad)) / (111320 * Math.cos((origin.lat * Math.PI) / 180));
  return { lat: origin.lat + dLat, lng: origin.lng + dLng };
}

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function showMissionOverlay(kind, title, subtitle = "") {
  const overlay = $("mission-overlay");
  overlay.classList.remove("hidden", "success", "fail");
  overlay.classList.add(kind);
  $("mission-overlay-icon").textContent = kind === "success" ? "✓" : "✗";
  $("mission-overlay-title").textContent = title;
  $("mission-overlay-sub").textContent = subtitle;
  clearTimeout(showMissionOverlay._t);
  showMissionOverlay._t = setTimeout(() => overlay.classList.add("hidden"), 3200);
}

function showCopMissionPopup(missionName, completedCount, totalCount) {
  const popup = $("cop-mission-popup");
  popup.classList.remove("hidden");
  $("cop-mission-popup-title").textContent = missionName;
  $("cop-mission-popup-count").textContent = `${completedCount} objectif${completedCount > 1 ? "s" : ""} sur ${totalCount}`;
  clearTimeout(showCopMissionPopup._t);
  showCopMissionPopup._t = setTimeout(() => popup.classList.add("hidden"), 4500);
}

function teleportNearFugitive() {
  const fugId = currentState?.fugitiveId;
  const fug = fugId ? currentState?.players?.[fugId] : null;
  let target = fug?.lastLocation;
  if (!target?.lat && fugId && currentState?.rallyPoints?.[fugId]?.lat) {
    target = currentState.rallyPoints[fugId];
  }
  if (!target?.lat && currentState?.playArea?.center?.lat) {
    target = currentState.playArea.center;
  }
  if (!target?.lat) return showToast("Position du fugitif inconnue — essayez après le rassemblement");
  sendSimLocation(target.lat + 0.00035, target.lng + 0.00035);
  showToast("Près du fugitif");
}

function triggerDevReveal() {
  if (!roomId) return;
  wsSend(JSON.stringify({ type: "dev_trigger_reveal", roomId, by: myId }));
  showToast("Révélation déclenchée pour les flics");
}

function unlockAudio() {
  if (audioUnlocked) return;
  try {
    audioCtx = new AudioContext();
    if (audioCtx.state === "suspended") audioCtx.resume();
    audioUnlocked = true;
  } catch {
    // ignore
  }
}

function stopLoudNoise() {
  noiseAlarmTimeouts.forEach(clearTimeout);
  noiseAlarmTimeouts = [];
}

function playLoudNoise() {
  try {
    unlockAudio();
    if (!audioCtx) return;
    stopLoudNoise();

    const DURATION_MS = 10000;
    const BEEP_MS = 320;
    const GAP_MS = 180;
    const STEP_MS = BEEP_MS + GAP_MS;
    const freqs = [880, 1320];

    for (let t = 0; t < DURATION_MS; t += STEP_MS) {
      const freq = freqs[Math.floor(t / STEP_MS) % freqs.length];
      noiseAlarmTimeouts.push(setTimeout(() => playAlarmBeep(freq, BEEP_MS), t));
    }
  } catch {
    showToast("Activez le son dans les paramètres du navigateur");
  }
}

function playAlarmBeep(freq, durMs) {
  if (!audioCtx) return;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = "square";
  osc.frequency.value = freq;
  const start = audioCtx.currentTime;
  const end = start + durMs / 1000;
  gain.gain.setValueAtTime(0.001, start);
  gain.gain.exponentialRampToValueAtTime(0.85, start + 0.02);
  gain.gain.setValueAtTime(0.85, end - 0.04);
  gain.gain.exponentialRampToValueAtTime(0.001, end);
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start(start);
  osc.stop(end);
}

function playRevealAlert() {
  try {
    unlockAudio();
    if (!audioCtx) return;
    const playBeep = (freq, startMs, durMs) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.value = 0.65;
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      const t = audioCtx.currentTime + startMs / 1000;
      osc.start(t);
      osc.stop(t + durMs / 1000);
    };
    playBeep(660, 0, 180);
    playBeep(880, 220, 220);
    playBeep(1100, 480, 280);
  } catch {
    showToast("Activez le son dans les paramètres du navigateur");
  }
}

function getWebSocketUrl() {
  const configWs = window.__SANCHASE_CONFIG__?.wsUrl;
  if (configWs) return configWs;
  const explicitWs = new URLSearchParams(window.location.search).get("ws");
  if (explicitWs) return explicitWs;
  const wsProtocol = window.location.protocol === "https:" ? "wss" : "ws";
  const devWebPort = window.location.port;
  // HTTPS or standard ports: WebSocket is on same host at /ws (tunnel gateway).
  if (window.location.protocol === "https:" || devWebPort === "" || devWebPort === "80" || devWebPort === "443") {
    return `${wsProtocol}://${window.location.host}/ws`;
  }
  return `${wsProtocol}://${window.location.hostname}:8787/ws`;
}

// Default screen before joining
if (savedSession?.name && $("name")) $("name").value = savedSession.name;
if (savedSession?.roomId && $("room")) $("room").value = savedSession.roomId;
showScreen("entry");

connectWebSocket();

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") resumeFromBackground();
});

window.addEventListener("online", () => ensureWebSocketConnected());
window.addEventListener("pageshow", (ev) => {
  if (ev.persisted) resumeFromBackground();
});

setInterval(() => {
  if (!roomId || ws?.readyState !== WebSocket.OPEN) return;
  wsSend({ type: "heartbeat", roomId, playerId: myId });
}, HEARTBEAT_MS);
