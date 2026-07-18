# Event Day Runbook

## Pre-game
- Verify HTTPS hosting for web app.
- Test on at least one iPhone Safari and one Android Chrome device.
- Run `npm test` and `npm run sim`.

## Game-start checklist
- All players join room code.
- Everyone taps `Enable Audio` once.
- Organizer starts game and verifies state sync.

## During game
- Monitor location staleness and reconnect events.
- If a player disconnects, ask them to reopen and rejoin.

## Post-game
- Export event logs for replay/debugging.
- Capture issues and decide if native escalation is needed.
