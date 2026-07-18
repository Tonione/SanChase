const players = Number(process.env.SIM_PLAYERS ?? 12);
const ticks = Number(process.env.SIM_TICKS ?? 120);

const state = {
  phase: "active",
  tick: 0,
  eventLog: [],
  players: Object.fromEntries(
    Array.from({ length: players }, (_, i) => [
      `ply${i}`,
      { cooldowns: { sonar_ping: 0 } }
    ])
  )
};

for (let t = 0; t < ticks; t += 1) {
  state.tick += 1;
  if (t % 30 === 0) {
    const p = state.players.ply1;
    if (p.cooldowns.sonar_ping <= state.tick) {
      p.cooldowns.sonar_ping = state.tick + 30;
      state.eventLog.push(`${Date.now()}:action:sonar_ping:by:ply1`);
    }
  }
}

console.log(JSON.stringify({ players, ticks, phase: state.phase, events: state.eventLog.length }, null, 2));
