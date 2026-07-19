const wsUrl = getWebSocketUrl();
const ws = new WebSocket(wsUrl);
const myId = `ply${Math.floor(Math.random() * 999999)}`;
const devMode = isDevMode();

let roomId = "";
let me = null;
let currentState = null;
let map = null;
let mapReady = false;
let myMarker = null;
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
let simLocation = defaultSimLocation();
let mapClickBound = false;
let audioCtx = null;
let audioUnlocked = false;
let pendingMissionResult = null;
let lastRenderedPhase = null;
let startOverlayTimer = null;
let playAreaAssessment = null;
let playAreaRadius = null;
let radiusSliderDragging = false;
let setupCenterMarker = null;
let setupMapClickBound = false;

const MISSION_HOLD_SEC = () => (devMode ? 5 : 30);
const MISSION_HIT_M = 15;
const MAX_COP_SCAN_USES = 2;
const ARREST_FAIL_STILL_SEC = 10;

function revealDisplayMs(state) {
  const radiusM = state?.playArea?.radiusM ?? playAreaRadius?.radiusM ?? 1320;
  return (radiusM < 120 ? 15 : 30) * 1000;
}

function arrestRecoveryLabel(me, tick) {
  if (!me?.arrestPenaltyAnchor) return null;
  if (me.arrestStillSinceTick === null) return "Restez immobile…";
  const remaining = Math.max(0, ARREST_FAIL_STILL_SEC - (tick - me.arrestStillSinceTick));
  return remaining > 0 ? `Immobile… ${remaining} s` : null;
}

const $ = (id) => document.getElementById(id);

const screens = {
  entry: $("screen-entry"),
  lobby: $("screen-lobby"),
  game: $("screen-game")
};

ws.onopen = () => setConnection(true);
ws.onclose = () => setConnection(false);
ws.onerror = () => setConnection(false);

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.type === "state_sync") {
    currentState = msg.state;
    playAreaAssessment = msg.playAreaAssessment ?? null;
    playAreaRadius = msg.playAreaRadius ?? null;
    me = currentState.players[myId] ?? null;
    if (pendingMissionResult && currentState.fugitiveId === myId) {
      const mission = currentState.missions.find((m) => m.id === pendingMissionResult.missionId);
      if (mission?.completed) {
        showMissionOverlay("success", "Mission accomplie !", mission.name);
        pendingMissionResult = null;
      }
    }
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
  } else if (msg.type === "sound_event" && msg.sound === "noise_ping") {
    unlockAudio();
    playLoudNoise();
    showToast("Signal sonore des flics !");
  } else if (msg.type === "mission_completed") {
    showCopMissionPopup(msg.missionName, msg.completedCount, msg.totalCount);
  } else if (msg.type === "action_event") {
    showToast(msg.message);
  } else if (msg.type === "error") {
    const errMsg = msg.message.replace(/^Error:\s*/, "");
    if (pendingMissionResult && /too far|trop loin|hold duration|mission hold|maintien/i.test(errMsg)) {
      showMissionOverlay("fail", "Mission échouée", "Trop loin de la cible");
      pendingMissionResult = null;
    } else {
      showToast(errMsg);
    }
  }
};

$("btn-join").onclick = () => {
  unlockAudio();
  roomId = $("room").value.trim().toUpperCase();
  const name = $("name").value.trim() || "Joueur";
  if (!roomId) return showToast("Entrez un code de salle");
  ws.send(JSON.stringify({ type: "join_room", roomId, playerId: myId, name }));
};

$("btn-create").onclick = () => {
  unlockAudio();
  roomId = $("room").value.trim().toUpperCase();
  const name = $("name").value.trim() || "Organisateur";
  if (!roomId) return showToast("Entrez un code de salle");
  const fugitiveSelection = $("fugitive-selection").value;
  const minPlayers = devMode ? 2 : 6;
  ws.send(JSON.stringify({
    type: "create_room",
    roomId,
    playerId: myId,
    name,
    settings: { fugitiveSelection, minPlayersToStart: minPlayers }
  }));
};

$("btn-ready").onclick = () => {
  if (!roomId || !me) return;
  ws.send(JSON.stringify({ type: "set_ready", roomId, playerId: myId, ready: !me.ready }));
};

$("btn-select-fugitive").onclick = () => {
  const fugitiveId = $("fugitive-picker").value;
  if (fugitiveId) ws.send(JSON.stringify({ type: "select_fugitive", roomId, by: myId, fugitiveId }));
};

$("btn-start-launch").onclick = () => {
  ws.send(JSON.stringify({ type: "start_game", roomId, by: myId }));
};

if (devMode) {
  $("dev-lobby-panel")?.classList.remove("hidden");
  $("dev-panel")?.classList.remove("hidden");
  $("dev-lobby-loc")?.addEventListener("click", () => {
    sendSimLocation(simLocation.lat, simLocation.lng);
    showToast("Position test envoyée");
  });
  $("dev-rally")?.addEventListener("click", () => teleportToRally());
  $("dev-mission")?.addEventListener("click", () => teleportToMission());
  $("dev-fugitive")?.addEventListener("click", () => teleportNearFugitive());
  $("dev-reveal")?.addEventListener("click", () => triggerDevReveal());
  setInterval(() => {
    if (roomId) sendSimLocation(simLocation.lat, simLocation.lng);
  }, 3000);
} else if (navigator.geolocation) {
  navigator.geolocation.watchPosition(
    (pos) => {
      applyLocation({
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracyM: pos.coords.accuracy,
        ts: Date.now()
      });
    },
    () => showToast("GPS indisponible — activez la localisation"),
    { enableHighAccuracy: true, maximumAge: 3000 }
  );
}

function render(eligibility) {
  if (!currentState || !me) return;

  if (devMode && roomId && !me.lastLocation) {
    sendSimLocation(simLocation.lat, simLocation.lng);
  }

  const phase = currentState.phase;
  if (phase === "lobby") {
    showScreen("lobby");
    renderLobby(eligibility);
  } else if (phase === "setup" && me.role !== "organizer") {
    showScreen("lobby");
    renderSetupWaiting();
  } else {
    showScreen("game");
    ensureMap();
    renderGame(eligibility);
  }
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
  } else   if (previousPick && currentState.players[previousPick]) {
    picker.value = previousPick;
  }

  renderPlayAreaControls("lobby");
}

function renderGame(eligibility) {
  const phase = currentState.phase;
  const isFugitive = currentState.fugitiveId === myId;
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
  if (!el || !playAreaAssessment || currentState.phase === "lobby") {
    el?.classList.add("hidden");
    return;
  }

  const isOrganizer = me.role === "organizer";
  if (!devMode && !isOrganizer) {
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
    devEl?.classList.add("hidden");
    gameEl?.replaceChildren();
    devEl?.replaceChildren();
    return;
  }

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

  const radiusLabel = formatRadiusM(info.currentM);
  const autoLabel = info.isAuto ? " (auto)" : "";
  container.innerHTML = `
    ${compact ? '<span class="dev-label">Zone</span>' : ""}
    <label>
      <span>Rayon de la zone · Ø ${Math.round(info.currentM * 2)} m</span>
      <span class="radius-value">${radiusLabel}${autoLabel}</span>
    </label>
    <input type="range" min="${info.minM}" max="${info.maxM}" step="${info.stepM}" value="${info.currentM}" />
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

  container.querySelector(".preset-auto")?.addEventListener("click", () => sendPlayAreaRadius(null));
  container.querySelector(".preset-hide-seek")?.addEventListener("click", () => sendPlayAreaRadius(info.presets.hideSeekM));
  container.querySelector(".preset-micro")?.addEventListener("click", () => sendPlayAreaRadius(info.presets.microM));
  container.querySelector(".preset-balanced")?.addEventListener("click", () => sendPlayAreaRadius(info.presets.balancedM));

  if (compact) container.classList.add("play-area-controls-compact");
}

function sendPlayAreaRadius(radiusM) {
  if (!roomId || me?.role !== "organizer") return;
  ws.send(JSON.stringify({ type: "set_play_area_radius", roomId, by: myId, radiusM }));
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
  } else {
    $("game-over-headline").textContent = "Les flics gagnent";
    detailEl.textContent = "";
  }
  $("game-over-outcome").textContent = playerWon ? "Victoire !" : "Défaite !";
}

function sendPlayAreaCenter(lat, lng) {
  if (!roomId || me?.role !== "organizer") return;
  ws.send(JSON.stringify({ type: "set_play_area_center", roomId, by: myId, lat, lng }));
}

function renderGameActions(eligibility) {
  if (holdTimer) return;

  const wrap = $("game-actions");
  wrap.innerHTML = "";
  const phase = currentState.phase;
  const isFugitive = currentState.fugitiveId === myId;
  const isOrganizer = me.role === "organizer";

  if (phase === "setup" && isOrganizer) {
    wrap.appendChild(actionBtn("Valider la zone", "btn-primary", () => {
      ws.send(JSON.stringify({ type: "confirm_setup", roomId, by: myId }));
    }));
    wrap.appendChild(actionBtn("Centrer sur moi", "btn-secondary", () => {
      const loc = me.lastLocation ?? getSelfLocation();
      if (loc) sendPlayAreaCenter(loc.lat, loc.lng);
      else showToast("Position GPS requise");
    }));
  }

  if (phase === "rally" && isOrganizer) {
    wrap.appendChild(actionBtn("Lancer la chasse", "btn-primary", () => {
      ws.send(JSON.stringify({ type: "start_chase", roomId, by: myId }));
    }, !eligibility.ok));
    if (!eligibility.ok) {
      const forceBtn = actionBtn("Forcer le lancement", "btn-secondary", () => {
        ws.send(JSON.stringify({ type: "start_chase", roomId, by: myId, force: true }));
      });
      forceBtn.title = "Démarrer même si tous les joueurs ne sont pas en position";
      wrap.appendChild(forceBtn);
    }
  }

  if (phase === "active") {
    if (isFugitive) {
      const missionsLeft = currentState.missions.some((m) => !m.completed);
      if (missionsLeft) {
        const mission = findMissionInRange();
        const holdBtn = actionBtn("Démarrer la mission", "btn-primary", () => toggleMissionHold(), !mission);
        holdBtn.id = "mission-hold";
        if (!mission) holdBtn.title = "Approchez-vous d'un objectif sur la carte";
        wrap.appendChild(holdBtn);

        const scanUsesLeft = MAX_COP_SCAN_USES - (me.copScanUses ?? 0);
        const scanActive = isCopScanActive(currentState);
        if (scanUsesLeft > 0 || scanActive) {
          const scanLabel = scanActive
            ? `Scan actif — ${formatCountdown(currentState.copScanUntilTick - currentState.tick)}`
            : `Scanner les flics (${scanUsesLeft} restant${scanUsesLeft > 1 ? "s" : ""})`;
          wrap.appendChild(actionBtn(
            scanLabel,
            "btn-secondary",
            () => ws.send(JSON.stringify({ type: "use_cop_scan", roomId, by: myId })),
            scanActive
          ));
        }

        if (!me.usedDecoyPower) {
          wrap.appendChild(actionBtn("Leurre", "btn-secondary", () => {
            ws.send(JSON.stringify({ type: "use_decoy_reveal", roomId, by: myId }));
          }));
        }
      }
    } else {
      if (!me.usedNoisePing) {
        wrap.appendChild(actionBtn("Signal sonore", "btn-secondary", () => {
          unlockAudio();
          ws.send(JSON.stringify({ type: "cop_noise_ping", roomId, by: myId }));
          if (devMode) {
            playLoudNoise();
            showToast("Signal envoyé (le fugitif l'entend sur son appareil)");
          }
        }));
      }
      const arrestLabel = arrestRecoveryLabel(me, currentState.tick);
      if (arrestLabel) {
        wrap.appendChild(actionBtn(arrestLabel, "btn-danger", null, true));
      } else {
        wrap.appendChild(actionBtn("Arrêter", "btn-danger", () => {
          ws.send(JSON.stringify({ type: "attempt_arrest", roomId, by: myId }));
        }));
      }
    }
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
    }
  }

  const activeMarkerIds = new Set();
  for (const [id, p] of Object.entries(currentState.players)) {
    if (!p.lastLocation || id === myId) continue;

    const isCop = id !== currentState.fugitiveId;
    const hideFromCops = id === currentState.fugitiveId && !isFugitive && (phase === "rally" || phase === "active");
    const hideFromFugitive = isFugitive && isCop && (phase === "rally" || (phase === "active" && !scanActive));

    if (hideFromCops || hideFromFugitive) continue;

    if (id === currentState.fugitiveId) {
      markers.set(id, setEmojiMarker(markers.get(id), p.lastLocation.lat, p.lastLocation.lng, "🦸‍♀️"));
    } else {
      markers.set(id, setCopDotMarker(markers.get(id), p.lastLocation.lat, p.lastLocation.lng));
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
      map.setView([rp.lat, rp.lng], mapZoomForRadius(areaR));
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
}

function renderSetupMapLayers() {
  if (myMarker) { map.removeLayer(myMarker); myMarker = null; }
  for (const id of [...markers.keys()]) {
    map.removeLayer(markers.get(id));
    markers.delete(id);
  }
  if (rallyMarker) { map.removeLayer(rallyMarker); rallyMarker = null; }
  if (rallyFlagMarker) { map.removeLayer(rallyFlagMarker); rallyFlagMarker = null; }

  const area = currentState.playArea;
  if (!area?.center?.lat) return;

  const { center } = area;
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

  map.setView([center.lat, center.lng], mapZoomForRadius(area.radiusM ?? 500));
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
  if (mapReady) {
    setTimeout(() => map.invalidateSize(), 100);
    return;
  }
  map = L.map("map", { zoomControl: true });
  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap &copy; CARTO"
  }).addTo(map);
  map.setView([48.8566, 2.3522], 14);
  mapReady = true;
  map.on("zoomend moveend", () => {
    if (boundaryMaskLayer) applyHatchFill(boundaryMaskLayer);
  });

  if (devMode && !mapClickBound) {
    map.on("click", (e) => {
      if (currentState?.phase === "setup" && me?.role === "organizer") return;
      sendSimLocation(e.latlng.lat, e.latlng.lng);
      showToast(`Téléporté vers ${e.latlng.lat.toFixed(5)}, ${e.latlng.lng.toFixed(5)}`);
    });
    mapClickBound = true;
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
  if (!roomId || !me || currentState?.fugitiveId !== myId || holdTimer) return;
  const mission = findMissionInRange();
  if (!mission) return;
  const missionId = mission.id;
  holdMissionId = missionId;
  ws.send(JSON.stringify({ type: "start_mission_hold", roomId, by: myId, missionId }));
  const btn = document.getElementById("mission-hold");
  const total = MISSION_HOLD_SEC();
  if (btn) btn.textContent = `Maintien… ${total}s (appuyer pour annuler)`;
  if (btn) btn.className = "btn btn-danger";
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
}

function finishMissionHold(missionId) {
  const btn = document.getElementById("mission-hold");
  if (btn) {
    btn.textContent = "Démarrer la mission";
    btn.className = "btn btn-primary";
  }
  holdMissionId = null;

  const mission = currentState?.missions?.find((m) => m.id === missionId);
  const loc = getSelfLocation();
  if (!mission || !loc || !isNearMission(loc, mission.point)) {
    ws.send(JSON.stringify({ type: "cancel_mission_hold", roomId, by: myId, missionId }));
    showMissionOverlay("fail", "Mission échouée", "Trop loin de la cible");
    renderGameActions({ ok: false, reason: "" });
    return;
  }

  pendingMissionResult = { missionId, missionName: mission.name };
  ws.send(JSON.stringify({
    type: "complete_mission_hold",
    roomId,
    by: myId,
    missionId,
    ...(devMode ? { devShortHold: true } : {})
  }));
  renderGameActions({ ok: false, reason: "" });
}

function cancelHold() {
  if (!holdTimer) return;
  const missionId = holdMissionId ?? findMissionInRange()?.id;
  clearInterval(holdTimer);
  holdTimer = null;
  holdMissionId = null;
  const btn = document.getElementById("mission-hold");
  if (btn) {
    btn.textContent = "Démarrer la mission";
    btn.className = "btn btn-primary";
  }
  if (missionId) ws.send(JSON.stringify({ type: "cancel_mission_hold", roomId, by: myId, missionId }));
  renderGameActions({ ok: false, reason: "" });
}

function showScreen(name) {
  screens.entry.classList.toggle("hidden", name !== "entry");
  screens.lobby.classList.toggle("hidden", name !== "lobby");
  screens.game.classList.toggle("hidden", name !== "game");
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

function isDevMode() {
  if (new URLSearchParams(window.location.search).get("dev") === "0") return false;
  return isLocalDev() || new URLSearchParams(window.location.search).get("dev") === "1";
}

function defaultSimLocation() {
  const n = parseInt(myId.replace(/\D/g, ""), 10) || 0;
  const offset = (n % 20) * 0.0003;
  return { lat: 48.8566 + offset, lng: 2.3522 + offset, accuracyM: 5, ts: Date.now() };
}

function sendSimLocation(lat, lng) {
  simLocation = { lat, lng, accuracyM: 5, ts: Date.now() };
  applyLocation(simLocation);
  if (mapReady) map.setView([lat, lng], map.getZoom(), { animate: true });
  if (roomId) {
    ws.send(JSON.stringify({
      type: "location_update",
      roomId,
      playerId: myId,
      location: simLocation,
      simulated: true
    }));
  }
}

function applyLocation(location) {
  if (me) me.lastLocation = location;
  if (currentState && mapReady) renderMapLayers();
}

function getSelfLocation() {
  if (devMode && simLocation) return simLocation;
  return me?.lastLocation ?? null;
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

function isNearMission(loc, point) {
  if (!point?.lat) return false;
  return haversineMeters(loc.lat, loc.lng, point.lat, point.lng) <= MISSION_HIT_M;
}

function findMissionInRange() {
  const loc = getSelfLocation();
  if (!loc || !currentState) return null;
  let best = null;
  let bestDist = Infinity;
  for (const m of currentState.missions) {
    if (m.completed || !m.point?.lat) continue;
    const dist = haversineMeters(loc.lat, loc.lng, m.point.lat, m.point.lng);
    if (dist <= MISSION_HIT_M && dist < bestDist) {
      best = m;
      bestDist = dist;
    }
  }
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

function emojiIcon(emoji, label = "", self = false) {
  const labelHtml = label
    ? `<div class="map-marker-label">${escapeHtml(label)}</div>`
    : "";
  return L.divIcon({
    className: "map-emoji-marker",
    html: `<div class="map-marker-wrap"><div class="map-marker-pin${self ? " self" : ""}">${emoji}</div>${labelHtml}</div>`,
    iconSize: label ? [130, 52] : [36, 36],
    iconAnchor: label ? [65, 22] : [18, 18]
  });
}

function setEmojiMarker(existing, lat, lng, emoji, label = "", self = false) {
  if (existing && typeof existing.setIcon !== "function") {
    map.removeLayer(existing);
    existing = null;
  }
  const icon = emojiIcon(emoji, label, self);
  if (!existing) {
    return L.marker([lat, lng], { icon, zIndexOffset: self ? 1000 : 0 }).addTo(map);
  }
  existing.setLatLng([lat, lng]);
  existing.setIcon(icon);
  return existing;
}

function setCopDotMarker(existing, lat, lng) {
  const color = "#38bdf8";
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
    removeBoundaryLayers();
    return;
  }

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
  const fug = currentState?.players?.[currentState.fugitiveId];
  if (!fug?.lastLocation) return showToast("Position du fugitif inconnue");
  sendSimLocation(fug.lastLocation.lat, fug.lastLocation.lng);
  showToast("Près du fugitif");
}

function triggerDevReveal() {
  if (!roomId) return;
  ws.send(JSON.stringify({ type: "dev_trigger_reveal", roomId, by: myId }));
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

function playLoudNoise() {
  try {
    unlockAudio();
    if (!audioCtx) return;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "square";
    osc.frequency.value = 1200;
    gain.gain.value = 0.8;
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    setTimeout(() => osc.stop(), 1800);
  } catch {
    showToast("Activez le son dans les paramètres du navigateur");
  }
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
showScreen("entry");
