import { createInitialState, applyAction, tickState } from "../../shared/src/index.js";

const players = Number(process.env.SIM_PLAYERS ?? 12);
const ticks = Number(process.env.SIM_TICKS ?? 120);

const state = createInitialState("sim-room", ticks);
state.phase = "active";
for (let i = 0; i < players; i += 1) {
  state.players[`p${i}`] = {
    id: `p${i}`,
    name: `Player ${i}`,
    role: i === 0 ? "organizer" : "hunter",
    connected: true,
    lastLocation: null,
    cooldowns: { sonar_ping: 0, jam: 0, fake_clue: 0 }
  };
}

for (let t = 0; t < ticks; t += 1) {
  tickState(state);
  if (t % 10 === 0) {
    applyAction(state, {
      roomId: state.roomId,
      actorId: "p1",
      action: "sonar_ping",
      ts: Date.now()
    });
  }
}

// eslint-disable-next-line no-console
console.log(JSON.stringify({ players, ticks, phase: state.phase, events: state.eventLog.length }, null, 2));
