# Castle Cannon Wars Structure

## Core Pitch

Castle Cannon Wars is a turn-based Three.js destruction game played in a 3D arena. Each player commands a stone castle with four manually operated cannons and a captain standing on the battlements. The last surviving castle, or last surviving team in 2v2, wins.

## Match Formats

- `1v1`: 2 castles, free-for-all.
- `1v1v1`: 3 castles, free-for-all.
- `1v1v1v1`: 4 castles, free-for-all.
- `2v2`: 4 castles, team victory condition.

The deployable build uses a local lobby that supports human-controlled turns on the same device and AI-controlled opponents.

## Scene Layout

- Circular battlefield with a stable ground plane.
- Symmetrical spawn points arranged around the arena.
- Each spawn contains a fully modeled stone castle assembled from individual rigid bodies.
- Each castle includes:
  - Outer stone curtain walls.
  - Corner towers.
  - Central keep.
  - Four cannon positions.
  - A captain character standing on the structure.

## Castle Blueprint

Each castle is constructed from repeated stone blocks so the whole structure can collapse under physics.

- Outer walls form the main square defensive ring.
- Four corner towers are taller than the walls and built as stacked stone columns.
- The central keep raises the silhouette and gives the captain a clear standing point.
- Battlements create a readable castle top line and make height loss obvious during destruction.

## Cannon Placement

Each castle always has exactly four cannons:

- 2 tower cannons mounted on forward towers.
- 2 wall cannons mounted in the middle of opposite walls.

Each cannon also has:

- A nearby stack of cannonballs.
- A loaded or unloaded state.
- Independent aim angles.
- A powder charge value chosen by the player.

## Turn Flow

1. Active player selects one of the four cannons.
2. Player aims horizontally and vertically.
3. Player manually loads a cannonball from that cannon's stack.
4. Player holds charge to decide how much gunpowder to use.
5. Player fires.
6. Physics resolve until debris settles.
7. The turn passes to the next living player or team member.

## Win And Elimination Rules

- A castle is eliminated when its standing height drops below the configured threshold.
- Standing height is measured from the highest surviving cluster of stones rather than a single stray block.
- Free-for-all matches end when only one player remains.
- Team matches end when only one team still has any standing castle.

## AI Behavior

- AI selects a living enemy target.
- AI picks an available cannon.
- AI computes a rough firing solution based on distance and height.
- AI loads, charges, and fires in a single automated action.

## Technical Structure

### Front End

- Vite for build and deployment.
- TypeScript for game logic.
- CSS-driven overlay UI and HUD.

### Rendering

- Three.js scene, lights, shadows, meshes, and camera.
- A dedicated scene mount inside the main app shell.

### Physics

- Rapier 3D for rigid bodies and projectile collisions.
- Individual rigid bodies for stone blocks.
- Dynamic cannonballs fired as physics projectiles.

### Main Systems

- `Lobby UI`: preset selection, human or AI slot assignment, start flow.
- `GameApp`: scene setup, input, turn loop, AI turns, win detection.
- `Castle Builder`: procedural placement of stones, towers, keep, cannons, captain, and ball stacks.
- `HUD`: active player, cannon state, charge meter, controls, event log.

## Deployment

- Static hosting friendly.
- Build output produced through Vite.
- Local hot-seat and AI battles work without a backend.
- Online rooms use Vercel serverless APIs with KV or Redis-backed room state.
- The current online sync model is turn-based snapshot replication instead of realtime websocket simulation.