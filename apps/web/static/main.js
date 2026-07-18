const wsUrl = getWebSocketUrl();
const ws = new WebSocket(wsUrl);
const myId = `ply${Math.floor(Math.random() * 999999)}`;
let roomId = "";
let me = null;
let currentState = null;
let myMarker = null;
const markers = new Map();
let rallyMarker = null;
let revealMarkers = [];
const missionMarkers = new Map();
let debriefMarker = null;
let holdTimer = null;

const logEl = document.getElementById("log");
const statusEl = document.getElementById("status");
const missionBtn = document.getElementById("mission-hold");
const missionPicker = document.getElementById("mission-picker");

const map = L.map("map").setView([48.8566, 2.3522], 14);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(map);

ws.onopen = () => (statusEl.textContent = "Connected");
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.type === "state_sync") {
    currentState = msg.state;
    me = currentState.players[myId] || null;
    renderState(msg.startEligibility.reason);
  } else if (msg.type === "reveal_positions") {
    revealMarkers.forEach((m) => map.removeLayer(m));
    revealMarkers = msg.positions.map((p) => L.circleMarker([p.lat, p.lng], { radius: 10, color: "yellow" }).addTo(map));
    setTimeout(() => {
      revealMarkers.forEach((m) => map.removeLayer(m));
      revealMarkers = [];
    }, 20000);
  } else if (msg.type === "sound_event" && msg.sound === "noise_ping") {
    playLoudNoise();
  } else if (msg.type === "error") {
    append(`Error: ${msg.message}`);
  }
};

document.getElementById("join").onclick = () => {
  roomId = document.getElementById("room").value.trim().toUpperCase();
  const name = document.getElementById("name").value.trim() || "Player";
  ws.send(JSON.stringify({ type: "join_room", roomId, playerId: myId, name }));
};

document.getElementById("create").onclick = () => {
  roomId = document.getElementById("room").value.trim().toUpperCase();
  const name = document.getElementById("name").value.trim() || "Organizer";
  const fugitiveSelection = document.getElementById("fugitive-selection").value;
  ws.send(JSON.stringify({ type: "create_room", roomId, playerId: myId, name, settings: { fugitiveSelection, minPlayersToStart: 6 } }));
};

document.getElementById("ready").onclick = () => {
  if (!roomId || !me) return;
  ws.send(JSON.stringify({ type: "set_ready", roomId, playerId: myId, ready: !me.ready }));
};

document.getElementById("start-launch").onclick = () => ws.send(JSON.stringify({ type: "start_game", roomId, by: myId }));
document.getElementById("start-chase").onclick = () => ws.send(JSON.stringify({ type: "start_chase", roomId, by: myId }));
document.getElementById("select-fugitive").onclick = () => {
  const fugitiveId = document.getElementById("fugitive-picker").value;
  if (fugitiveId) ws.send(JSON.stringify({ type: "select_fugitive", roomId, by: myId, fugitiveId }));
};
document.getElementById("decoy").onclick = () => ws.send(JSON.stringify({ type: "use_decoy_reveal", roomId, by: myId }));
document.getElementById("noise").onclick = () => ws.send(JSON.stringify({ type: "cop_noise_ping", roomId, by: myId }));
document.getElementById("arrest").onclick = () => ws.send(JSON.stringify({ type: "attempt_arrest", roomId, by: myId }));

missionBtn.onmousedown = () => {
  if (!roomId || !me || currentState?.fugitiveId !== myId) return;
  const missionId = missionPicker.value;
  if (!missionId) return;
  ws.send(JSON.stringify({ type: "start_mission_hold", roomId, by: myId, missionId }));
  const start = Date.now();
  missionBtn.textContent = "Holding... 30s";
  holdTimer = setInterval(() => {
    const elapsed = Math.floor((Date.now() - start) / 1000);
    missionBtn.textContent = `Holding... ${Math.max(0, 30 - elapsed)}s`;
    if (elapsed >= 30) {
      clearInterval(holdTimer);
      holdTimer = null;
      ws.send(JSON.stringify({ type: "complete_mission_hold", roomId, by: myId, missionId }));
      missionBtn.textContent = "Hold Mission (30s)";
    }
  }, 1000);
};

missionBtn.onmouseup = cancelHold;
missionBtn.onmouseleave = cancelHold;

function cancelHold() {
  if (!holdTimer || !roomId || !me || currentState?.fugitiveId !== myId) return;
  const missionId = missionPicker.value;
  clearInterval(holdTimer);
  holdTimer = null;
  missionBtn.textContent = "Hold Mission (30s)";
  ws.send(JSON.stringify({ type: "cancel_mission_hold", roomId, by: myId, missionId }));
}

if (navigator.geolocation) {
  navigator.geolocation.watchPosition((pos) => {
    const location = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracyM: pos.coords.accuracy, ts: Date.now() };
    if (!myMarker) {
      myMarker = L.circleMarker([location.lat, location.lng], { radius: 8, color: "cyan" }).addTo(map);
      map.setView([location.lat, location.lng], 15);
    } else myMarker.setLatLng([location.lat, location.lng]);
    if (roomId) ws.send(JSON.stringify({ type: "location_update", roomId, playerId: myId, location }));
  }, () => {}, { enableHighAccuracy: true, maximumAge: 3000 });
}

function renderState(reason) {
  if (!currentState || !me) return;
  const debrief = currentState.debriefPoint
    ? ` | debrief:${currentState.debriefPoint.lat.toFixed(5)},${currentState.debriefPoint.lng.toFixed(5)}`
    : "";
  statusEl.textContent = `${currentState.phase} | ${reason} | role:${me.role}${currentState.fugitiveId === myId ? "(fugitive)" : ""} | winner:${currentState.winner ?? "-"} | arrests:${me.arrestAttemptsUsed}/2${debrief}`;

  const picker = document.getElementById("fugitive-picker");
  picker.innerHTML = "";
  Object.values(currentState.players).forEach((p) => {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = `${p.name} (${p.id})`;
    picker.appendChild(opt);
  });

  missionPicker.innerHTML = "";
  currentState.missions.filter((m) => !m.completed).forEach((m) => {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.id;
    missionPicker.appendChild(opt);
  });

  for (const [id, p] of Object.entries(currentState.players)) {
    if (!p.lastLocation) continue;
    const isFugitive = id === currentState.fugitiveId;
    if (me.id !== currentState.fugitiveId && isFugitive && currentState.phase === "active") continue;
    if (!markers.has(id)) markers.set(id, L.marker([p.lastLocation.lat, p.lastLocation.lng]).addTo(map));
    else markers.get(id).setLatLng([p.lastLocation.lat, p.lastLocation.lng]);
  }

  const rp = currentState.rallyPoints[myId];
  if (rp) {
    if (!rallyMarker) rallyMarker = L.circle([rp.lat, rp.lng], { radius: 40, color: "green" }).addTo(map);
    else rallyMarker.setLatLng([rp.lat, rp.lng]);
  }

  for (const marker of missionMarkers.values()) map.removeLayer(marker);
  missionMarkers.clear();
  if (currentState.fugitiveId === myId) {
    currentState.missions.forEach((m) => {
      if (m.completed) return;
      const mk = L.circle([m.point.lat, m.point.lng], { radius: 15, color: "purple" }).addTo(map);
      missionMarkers.set(m.id, mk);
    });
  }

  if (currentState.debriefPoint) {
    const p = currentState.debriefPoint;
    if (!debriefMarker) {
      debriefMarker = L.marker([p.lat, p.lng]).addTo(map).bindPopup("Debrief meeting point");
    } else {
      debriefMarker.setLatLng([p.lat, p.lng]);
    }
  }

  append(`phase=${currentState.phase} tick=${currentState.tick} missions=${currentState.missions.filter((m) => m.completed).length}/3`);
}

function append(line) {
  logEl.textContent += `\n${line}`;
  logEl.scrollTop = logEl.scrollHeight;
}

function playLoudNoise() {
  const ac = new AudioContext();
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = "square";
  osc.frequency.value = 1200;
  gain.gain.value = 0.8;
  osc.connect(gain);
  gain.connect(ac.destination);
  osc.start();
  setTimeout(() => {
    osc.stop();
    ac.close();
  }, 1800);
}

function getWebSocketUrl() {
  const configWs = window.__SANCHASE_CONFIG__?.wsUrl;
  if (configWs) return configWs;

  const params = new URLSearchParams(window.location.search);
  const explicitWs = params.get("ws");
  if (explicitWs) return explicitWs;

  const isHttps = window.location.protocol === "https:";
  const wsProtocol = isHttps ? "wss" : "ws";
  const host = window.location.hostname;
  return `${wsProtocol}://${host}:8787/ws`;
}
