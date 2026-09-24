# Anomaly Protocol — Zombies Parkour

A single self-contained HTML file: a Call of Duty Zombies-inspired first-person shooter
built with three.js, featuring a fast parkour movement system (double jump, wall-run,
wall-eject, auto-vault), round-based zombie AI, a points economy with wall-buys and
Pack-a-Punch, a 3-map linear campaign with an easter-egg storyline, and real
peer-to-peer co-op multiplayer over WebRTC (PeerJS) with an offline solo fallback.

Open `index.html` in a modern desktop browser (Chrome, Edge, Firefox). No build step,
no install — everything (including three.js and PeerJS) loads from CDN at runtime, and
all art and sound are generated procedurally in code.

## Controls

| Action | Key |
| --- | --- |
| Move | WASD |
| Look | Mouse (click to lock the pointer) |
| Sprint | Shift |
| Jump / Double Jump | Space (press again in mid-air) |
| Wall Run | Jump at a wall while airborne and hold toward it |
| Wall Eject | Space while wall-running |
| Vault | Just run at a low ledge — it's automatic |
| Fire | Left Click (hold for automatic weapons) |
| Reload | R |
| Interact / Buy / Revive | E |
| Switch Weapon | 1 / 2 |
| Pause | Esc |

Touch controls (virtual stick + buttons) appear automatically on phones/tablets, though
this is fundamentally a mouse-and-keyboard parkour shooter.

## The campaign

1. **The Abandoned Outpost** — an underground lab/facility. Restore the Main Power
   (1000 points, or fight off a forced mini-wave for free) to open the blast door, then
   wall-run across the hazard pit to reach the Escape Lift.
2. **Rooftop Spires** — a vertical cyber-gothic city. Collect 3 Energy Cores from high
   ledges (double-jump gaps and a wall-run climb) and deliver them to the Antenna Relay.
3. **The Anomaly Core** — floating platforms in a purple void. Reach the Monolith and
   survive a 3-minute holdout while it charges, then step through the extraction portal.

Round-based zombies scale continuously across all three maps: health is
`100 × 1.15^(round−1)`, and they go from a walk in round 1 to a full sprint by round 5.
Points: +10 per hit, +60 per kill, +100 for a headshot kill. Wall-buys, barricaded
doors, perk machines and Pack-a-Punch all cost from the same shared team pool in co-op.

## Multiplayer

Host or join a co-op room from the main menu (a 4-character room code, no account or
server setup required) — networking is real peer-to-peer WebRTC via PeerJS's public
signaling broker. The host is authoritative for zombies, rounds, the shared points pool,
and map/door/objective state; each player is authoritative for their own movement,
shooting and ammo. If no peer connection can be established (offline, or a restricted
network), the game automatically falls back to solo play.

**Note:** if you're viewing this inside an embedded preview (like a Claude Artifact),
the sandboxed frame's content-security policy blocks the WebSocket connection the
multiplayer signaling needs, so Host/Join will report they can't connect — Solo Play
still works fine there. For real co-op with a friend, download this file and open it
directly in a browser tab (or host it on any static file host / GitHub Pages).

Fan-made tribute; not affiliated with Activision or Call of Duty. All art and sound are
generated in code — no external asset files besides the two CDN libraries.
