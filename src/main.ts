import './style.css'

import {
  BRICK_BUDGET,
  BUILD_GRID_SIZE,
  BUILD_LEVELS,
  createStarterCastleDesign,
  normalizeCastleDesign,
} from './game/castle-designs'
import { defaultSlotsForPreset, expectedSlotsForPreset, presetLabel } from './game/config'
import {
  commitOnlineSnapshot,
  createOnlineRoom,
  fetchOnlineRoom,
  fetchSharedCastles,
  joinOnlineRoom,
  publishCastleDesign,
  startOnlineBattle,
} from './game/network'
import type { CastleDesign, GameSnapshot, MatchPreset, OnlineRoomState, OnlineSession, SharedCastleDesign, SlotOption } from './game/types'

type GameController = {
  initialize(): Promise<void>
  startLocalMatch(request: { preset: MatchPreset; slots: SlotOption[]; castleDesigns?: CastleDesign[] }): Promise<boolean>
  startHostedOnlineMatch(request: {
    preset: MatchPreset
    seats: OnlineRoomState['seats']
    session: OnlineSession
    commitSnapshot: (snapshot: GameSnapshot) => Promise<void>
  }): Promise<GameSnapshot | null>
  applyOnlineSnapshot(
    snapshot: GameSnapshot,
    session: OnlineSession,
    commitSnapshot: (snapshot: GameSnapshot) => Promise<void>,
  ): Promise<void>
}

const app = document.querySelector<HTMLDivElement>('#app')!

app.innerHTML = `
  <div class="shell">
    <div id="scene-root" class="scene-root"></div>

    <div class="topbar glass-panel">
      <div>
        <p class="eyebrow">Stone castles. Black powder. Last fortress standing.</p>
        <h1>Castle Cannon Wars</h1>
      </div>
      <p class="topbar-copy">
        Battle from stock fortresses, build your own with a brick budget, or publish designs into the shared castles archive.
      </p>
    </div>

    <aside class="hud glass-panel">
      <div>
        <p class="hud-label">Active commander</p>
        <h2 id="hud-player">No match started</h2>
      </div>
      <div class="hud-grid">
        <div>
          <p class="hud-label">Mode</p>
          <p id="hud-mode">Lobby</p>
        </div>
        <div>
          <p class="hud-label">Turn</p>
          <p id="hud-turn">-</p>
        </div>
        <div>
          <p class="hud-label">Selected cannon</p>
          <p id="hud-cannon">-</p>
        </div>
        <div>
          <p class="hud-label">Castle height</p>
          <p id="hud-height">-</p>
        </div>
      </div>
      <div>
        <p class="hud-label">Powder charge</p>
        <div class="meter"><div id="charge-fill" class="meter-fill"></div></div>
        <p id="hud-charge">0%</p>
      </div>
      <div>
        <p class="hud-label">Ammo stack</p>
        <p id="hud-ammo">-</p>
      </div>
      <div class="control-row">
        <button id="prev-cannon" class="action-button" type="button">Prev cannon</button>
        <button id="next-cannon" class="action-button" type="button">Next cannon</button>
      </div>
      <div class="control-row">
        <button id="load-cannon" class="action-button" type="button">Load ball</button>
        <button id="fire-cannon" class="action-button action-button--danger" type="button">Fire</button>
      </div>
      <button id="charge-button" class="action-button action-button--charge" type="button">Hold to charge</button>

      <div class="control-hints">
        <p>Aim: A / D and W / S</p>
        <p>Charge: hold Space or button</p>
        <p>Load: R, Fire: F, Swap cannon: Q / E</p>
      </div>
    </aside>

    <section id="message-bar" class="message-bar glass-panel">Select a lobby mode to begin.</section>

    <section id="lobby-overlay" class="overlay">
      <div class="overlay-card lobby-card">
        <div>
          <p class="eyebrow">Battle control</p>
          <h2>Set the siege</h2>
          <p class="overlay-copy">
            Battle with stock layouts, draft custom fortresses in builder mode, or pull published designs from the shared castles archive.
          </p>
        </div>

        <div class="tab-strip" id="tab-strip">
          <button class="preset-button is-active" data-tab="battle" type="button">Battle</button>
          <button class="preset-button" data-tab="builder" type="button">Create A Castle</button>
          <button class="preset-button" data-tab="castles" type="button">Castles</button>
        </div>

        <section id="battle-tab" class="tab-panel">
          <div class="mode-toggle" id="mode-toggle">
            <button class="preset-button is-active" data-mode="local" type="button">Local + AI</button>
            <button class="preset-button" data-mode="online" type="button">Online Room</button>
          </div>

          <div class="preset-grid" id="preset-grid">
            <button class="preset-button is-active" data-preset="duel" type="button">1v1</button>
            <button class="preset-button" data-preset="trio" type="button">1v1v1</button>
            <button class="preset-button" data-preset="quad" type="button">1v1v1v1</button>
            <button class="preset-button" data-preset="teams" type="button">2v2</button>
          </div>

          <div id="slot-list" class="slot-list"></div>

          <section id="online-panel" class="online-panel is-hidden">
            <div class="online-grid">
              <label class="field">
                <span>Display name</span>
                <input id="display-name" class="text-input" maxlength="18" value="Commander" />
              </label>
              <label class="field">
                <span>Room code</span>
                <input id="room-code" class="text-input" maxlength="8" placeholder="ABCD" />
              </label>
            </div>

            <div class="online-actions">
              <button id="create-room" class="action-button action-button--primary" type="button">Create room</button>
              <button id="join-room" class="action-button" type="button">Join room</button>
              <button id="start-online-match" class="action-button action-button--primary is-hidden" type="button">Start online battle</button>
            </div>

            <div id="room-panel" class="room-panel is-hidden"></div>
          </section>

          <div class="overlay-actions" id="local-actions">
            <button id="start-match" class="action-button action-button--primary" type="button">Start local battle</button>
          </div>
        </section>

        <section id="builder-tab" class="tab-panel is-hidden">
          <div class="builder-toolbar">
            <div class="player-toggle" id="builder-player-toggle"></div>
            <div class="layer-toggle" id="builder-layer-toggle"></div>
          </div>

          <div class="builder-layout">
            <div class="builder-left">
              <div class="field">
                <span>Castle name</span>
                <input id="builder-design-name" class="text-input" maxlength="32" value="North Keep" />
              </div>

              <div class="builder-stats glass-inset">
                <p><strong id="builder-brick-count">0</strong> / 56 bricks placed</p>
                <p id="builder-layer-label">Editing layer 1</p>
                <p>Each side gets one fortress and exactly four cannons mounted automatically from the finished shape.</p>
              </div>

              <label class="field">
                <span>Opponent</span>
                <select id="builder-opponent" class="text-input">
                  <option value="human">Human</option>
                  <option value="ai" selected>AI</option>
                </select>
              </label>

              <div class="builder-actions">
                <button id="builder-clear" class="action-button" type="button">Clear layer</button>
                <button id="builder-reset" class="action-button" type="button">Reset castle</button>
                <button id="builder-start" class="action-button action-button--primary" type="button">Start custom duel</button>
                <button id="builder-publish" class="action-button" type="button">Publish active castle</button>
              </div>
            </div>

            <div class="builder-right">
              <div class="builder-grid" id="builder-grid"></div>
            </div>
          </div>
        </section>

        <section id="castles-tab" class="tab-panel is-hidden">
          <div class="castle-tab-actions">
            <button id="refresh-castles" class="action-button" type="button">Refresh archive</button>
          </div>
          <div id="shared-castles-list" class="shared-castles-list"></div>
        </section>
      </div>
    </section>

    <section id="winner-overlay" class="overlay is-hidden">
      <div class="overlay-card winner-card">
        <p class="eyebrow">Battle concluded</p>
        <h2 id="winner-title">Winner</h2>
        <p id="winner-copy" class="overlay-copy"></p>
        <button id="restart-match" class="action-button action-button--primary" type="button">Return to lobby</button>
      </div>
    </section>
  </div>
`

const slotList = document.querySelector<HTMLDivElement>('#slot-list')!
const presetButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-preset]'))
const modeButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-mode]'))
const tabButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-tab]'))
const lobbyOverlay = document.querySelector<HTMLElement>('#lobby-overlay')!
const localActions = document.querySelector<HTMLElement>('#local-actions')!
const onlinePanel = document.querySelector<HTMLElement>('#online-panel')!
const roomPanel = document.querySelector<HTMLElement>('#room-panel')!
const displayNameInput = document.querySelector<HTMLInputElement>('#display-name')!
const roomCodeInput = document.querySelector<HTMLInputElement>('#room-code')!
const startOnlineButton = document.querySelector<HTMLButtonElement>('#start-online-match')!
const messageBar = document.querySelector<HTMLElement>('#message-bar')!
const battleTab = document.querySelector<HTMLElement>('#battle-tab')!
const builderTab = document.querySelector<HTMLElement>('#builder-tab')!
const castlesTab = document.querySelector<HTMLElement>('#castles-tab')!
const builderPlayerToggle = document.querySelector<HTMLDivElement>('#builder-player-toggle')!
const builderLayerToggle = document.querySelector<HTMLDivElement>('#builder-layer-toggle')!
const builderGrid = document.querySelector<HTMLDivElement>('#builder-grid')!
const builderDesignNameInput = document.querySelector<HTMLInputElement>('#builder-design-name')!
const builderBrickCount = document.querySelector<HTMLElement>('#builder-brick-count')!
const builderLayerLabel = document.querySelector<HTMLElement>('#builder-layer-label')!
const builderOpponentSelect = document.querySelector<HTMLSelectElement>('#builder-opponent')!
const sharedCastlesList = document.querySelector<HTMLDivElement>('#shared-castles-list')!

let selectedPreset: MatchPreset = 'duel'
let onlineSession: OnlineSession | null = null
let currentRoom: OnlineRoomState | null = null
let appliedRoomVersion = 0
let roomPollHandle = 0
let game: GameController | null = null
let activeBuilderPlayer = 0
let activeBuilderLayer = 0
let sharedCastles: SharedCastleDesign[] = []

const builderDesigns: [CastleDesign, CastleDesign] = [
  createStarterCastleDesign('North Keep', 'Commander'),
  createStarterCastleDesign('South Bastion', 'Commander'),
]

const ensureGame = async (): Promise<GameController> => {
  if (game) {
    return game
  }

  messageBar.textContent = 'Loading battlefield engine...'
  const { GameApp } = await import('./game/game')
  const instance = new GameApp({
    sceneRoot: document.querySelector<HTMLDivElement>('#scene-root')!,
    messageBar,
    hudPlayer: document.querySelector<HTMLElement>('#hud-player')!,
    hudMode: document.querySelector<HTMLElement>('#hud-mode')!,
    hudTurn: document.querySelector<HTMLElement>('#hud-turn')!,
    hudCannon: document.querySelector<HTMLElement>('#hud-cannon')!,
    hudHeight: document.querySelector<HTMLElement>('#hud-height')!,
    hudCharge: document.querySelector<HTMLElement>('#hud-charge')!,
    hudAmmo: document.querySelector<HTMLElement>('#hud-ammo')!,
    chargeFill: document.querySelector<HTMLElement>('#charge-fill')!,
    prevButton: document.querySelector<HTMLButtonElement>('#prev-cannon')!,
    nextButton: document.querySelector<HTMLButtonElement>('#next-cannon')!,
    loadButton: document.querySelector<HTMLButtonElement>('#load-cannon')!,
    fireButton: document.querySelector<HTMLButtonElement>('#fire-cannon')!,
    chargeButton: document.querySelector<HTMLButtonElement>('#charge-button')!,
    winnerOverlay: document.querySelector<HTMLElement>('#winner-overlay')!,
    winnerTitle: document.querySelector<HTMLElement>('#winner-title')!,
    winnerCopy: document.querySelector<HTMLElement>('#winner-copy')!,
  })
  await instance.initialize()
  game = instance
  messageBar.textContent = 'Battlefield engine ready.'
  return instance
}

const renderSlots = (preset: MatchPreset) => {
  const defaults = defaultSlotsForPreset(preset)
  const expected = expectedSlotsForPreset(preset)

  slotList.innerHTML = defaults
    .map((value, index) => {
      const team = preset === 'teams' ? (index % 2 === 0 ? 'Red team' : 'Blue team') : 'Free-for-all'
      const mustBeOpen = index < expected
      return `
        <label class="slot-row ${value === 'closed' ? 'is-muted' : ''}">
          <span>
            <strong>Slot ${index + 1}</strong>
            <small>${team}</small>
          </span>
          <select data-slot-index="${index}">
            <option value="human" ${value === 'human' ? 'selected' : ''}>Human</option>
            <option value="ai" ${value === 'ai' ? 'selected' : ''}>AI</option>
            <option value="closed" ${value === 'closed' ? 'selected' : ''} ${mustBeOpen ? 'disabled' : ''}>Closed</option>
          </select>
        </label>
      `
    })
    .join('')
}

const readSlots = (): SlotOption[] => Array.from(slotList.querySelectorAll<HTMLSelectElement>('select')).map((select) => select.value as SlotOption)

const setBattleMode = (mode: 'local' | 'online') => {
  modeButtons.forEach((button) => button.classList.toggle('is-active', button.dataset.mode === mode))
  const isOnline = mode === 'online'
  onlinePanel.classList.toggle('is-hidden', !isOnline)
  localActions.classList.toggle('is-hidden', isOnline)
}

const setTab = (tab: 'battle' | 'builder' | 'castles') => {
  tabButtons.forEach((button) => button.classList.toggle('is-active', button.dataset.tab === tab))
  battleTab.classList.toggle('is-hidden', tab !== 'battle')
  builderTab.classList.toggle('is-hidden', tab !== 'builder')
  castlesTab.classList.toggle('is-hidden', tab !== 'castles')

  if (tab === 'castles') {
    void loadSharedCastles()
  }
}

const currentBuilderDesign = (): CastleDesign => builderDesigns[activeBuilderPlayer]

const setBuilderDesign = (design: CastleDesign) => {
  builderDesigns[activeBuilderPlayer] = normalizeCastleDesign(design)
}

const brickKey = (x: number, y: number, z: number): string => `${x}:${y}:${z}`

const renderBuilderControls = () => {
  builderPlayerToggle.innerHTML = [0, 1]
    .map(
      (playerIndex) => `
        <button class="preset-button ${playerIndex === activeBuilderPlayer ? 'is-active' : ''}" data-builder-player="${playerIndex}" type="button">
          Player ${playerIndex + 1}
        </button>
      `,
    )
    .join('')

  builderLayerToggle.innerHTML = Array.from({ length: BUILD_LEVELS }, (_, index) => index)
    .map(
      (layer) => `
        <button class="preset-button ${layer === activeBuilderLayer ? 'is-active' : ''}" data-builder-layer="${layer}" type="button">
          L${layer + 1}
        </button>
      `,
    )
    .join('')

  builderPlayerToggle.querySelectorAll<HTMLButtonElement>('[data-builder-player]').forEach((button) => {
    button.addEventListener('click', () => {
      activeBuilderPlayer = Number(button.dataset.builderPlayer)
      builderDesignNameInput.value = currentBuilderDesign().name
      renderBuilder()
    })
  })

  builderLayerToggle.querySelectorAll<HTMLButtonElement>('[data-builder-layer]').forEach((button) => {
    button.addEventListener('click', () => {
      activeBuilderLayer = Number(button.dataset.builderLayer)
      renderBuilder()
    })
  })
}

const renderBuilderGrid = () => {
  const design = currentBuilderDesign()
  const brickSet = new Set(design.bricks.map((brick) => brickKey(brick.x, brick.y, brick.z)))

  builderGrid.innerHTML = Array.from({ length: BUILD_GRID_SIZE * BUILD_GRID_SIZE }, (_, index) => {
    const x = index % BUILD_GRID_SIZE
    const z = BUILD_GRID_SIZE - 1 - Math.floor(index / BUILD_GRID_SIZE)
    const filled = brickSet.has(brickKey(x, activeBuilderLayer, z))
    return `<button class="builder-cell ${filled ? 'is-filled' : ''}" data-x="${x}" data-z="${z}" type="button">${filled ? '■' : ''}</button>`
  }).join('')

  builderGrid.querySelectorAll<HTMLButtonElement>('.builder-cell').forEach((button) => {
    button.addEventListener('click', () => {
      const x = Number(button.dataset.x)
      const z = Number(button.dataset.z)
      toggleBrickAt(x, activeBuilderLayer, z)
    })
  })
}

const renderBuilder = () => {
  renderBuilderControls()
  renderBuilderGrid()
  builderBrickCount.textContent = String(currentBuilderDesign().bricks.length)
  builderLayerLabel.textContent = `Editing layer ${activeBuilderLayer + 1}`
  builderDesignNameInput.value = currentBuilderDesign().name
}

const toggleBrickAt = (x: number, y: number, z: number) => {
  const design = currentBuilderDesign()
  const key = brickKey(x, y, z)
  const existing = design.bricks.findIndex((brick) => brickKey(brick.x, brick.y, brick.z) === key)

  if (existing >= 0) {
    setBuilderDesign({ ...design, bricks: design.bricks.filter((_, index) => index !== existing) })
    renderBuilder()
    return
  }

  if (design.bricks.length >= BRICK_BUDGET) {
    messageBar.textContent = 'Brick budget reached. Remove a brick before placing another.'
    return
  }

  setBuilderDesign({ ...design, bricks: [...design.bricks, { x, y, z }] })
  renderBuilder()
}

const renderSharedCastles = () => {
  if (!sharedCastles.length) {
    sharedCastlesList.innerHTML = '<div class="room-panel"><p class="room-copy">No public castle designs yet. Publish one from Create A Castle.</p></div>'
    return
  }

  sharedCastlesList.innerHTML = sharedCastles
    .map(
      (castle) => `
        <article class="castle-card">
          <div>
            <p class="hud-label">${castle.author}</p>
            <h3>${castle.name}</h3>
            <p class="room-copy">${castle.brickCount} bricks</p>
          </div>
          <div class="castle-card-actions">
            <button class="action-button" data-use-castle="${castle.id}" data-target-player="0" type="button">Use for P1</button>
            <button class="action-button" data-use-castle="${castle.id}" data-target-player="1" type="button">Use for P2</button>
          </div>
        </article>
      `,
    )
    .join('')

  sharedCastlesList.querySelectorAll<HTMLButtonElement>('[data-use-castle]').forEach((button) => {
    button.addEventListener('click', () => {
      const castle = sharedCastles.find((candidate) => candidate.id === button.dataset.useCastle)
      if (!castle) {
        return
      }
      const targetPlayer = Number(button.dataset.targetPlayer)
      builderDesigns[targetPlayer] = normalizeCastleDesign(castle)
      activeBuilderPlayer = targetPlayer
      builderDesignNameInput.value = builderDesigns[targetPlayer].name
      setTab('builder')
      renderBuilder()
      messageBar.textContent = `${castle.name} assigned to Player ${targetPlayer + 1}.`
    })
  })
}

const loadSharedCastles = async () => {
  const response = await fetchSharedCastles()
  sharedCastles = response.castles
  renderSharedCastles()
}

const renderRoomPanel = (room: OnlineRoomState | null) => {
  if (!room) {
    roomPanel.classList.add('is-hidden')
    startOnlineButton.classList.add('is-hidden')
    return
  }

  roomPanel.classList.remove('is-hidden')
  const localPlayerId = onlineSession?.playerId
  roomPanel.innerHTML = `
    <div class="room-header">
      <div>
        <p class="hud-label">Room</p>
        <h3>${room.roomCode}</h3>
      </div>
      <div>
        <p class="hud-label">Status</p>
        <p>${room.phase === 'lobby' ? 'Awaiting start' : room.phase === 'game-over' ? 'Battle complete' : 'Battle live'}</p>
      </div>
      <div>
        <p class="hud-label">Preset</p>
        <p>${presetLabel(room.preset)}</p>
      </div>
    </div>
    <div class="room-seat-list">
      ${room.seats
        .map(
          (seat) => `
            <article class="room-seat ${seat.playerId === localPlayerId ? 'is-local' : ''}">
              <strong>${seat.name}</strong>
              <small>${seat.controller === 'ai' ? 'AI captain' : seat.claimed ? 'Connected commander' : 'Open human seat'}</small>
            </article>
          `,
        )
        .join('')}
    </div>
    <p class="room-copy">${room.message ?? 'Room synchronized.'}</p>
  `

  startOnlineButton.classList.toggle('is-hidden', !(onlineSession?.isHost && room.phase === 'lobby'))
}

const commitSnapshot = async (snapshot: GameSnapshot) => {
  if (!onlineSession) {
    return
  }
  currentRoom = await commitOnlineSnapshot(onlineSession, snapshot)
  appliedRoomVersion = currentRoom.version
  renderRoomPanel(currentRoom)
}

const applyRoomSnapshot = async (room: OnlineRoomState) => {
  if (!onlineSession || !room.snapshot || room.version === appliedRoomVersion) {
    return
  }
  const controller = await ensureGame()
  await controller.applyOnlineSnapshot(room.snapshot, onlineSession, commitSnapshot)
  appliedRoomVersion = room.version
  if (room.phase !== 'lobby') {
    lobbyOverlay.classList.add('is-hidden')
  }
}

const syncRoom = async () => {
  if (!onlineSession) {
    return
  }
  currentRoom = await fetchOnlineRoom(onlineSession.roomCode)
  renderRoomPanel(currentRoom)
  await applyRoomSnapshot(currentRoom)
}

const startRoomPolling = () => {
  window.clearInterval(roomPollHandle)
  roomPollHandle = window.setInterval(() => {
    void syncRoom().catch((error) => {
      messageBar.textContent = error instanceof Error ? error.message : 'Room sync failed.'
    })
  }, 2000)
}

renderSlots(selectedPreset)
renderBuilder()
renderSharedCastles()
setBattleMode('local')
setTab('battle')

builderDesignNameInput.addEventListener('input', () => {
  const design = currentBuilderDesign()
  setBuilderDesign({ ...design, name: builderDesignNameInput.value })
})

tabButtons.forEach((button) => {
  button.addEventListener('click', () => {
    setTab(button.dataset.tab as 'battle' | 'builder' | 'castles')
  })
})

presetButtons.forEach((button) => {
  button.addEventListener('click', () => {
    selectedPreset = button.dataset.preset as MatchPreset
    presetButtons.forEach((item) => item.classList.toggle('is-active', item === button))
    renderSlots(selectedPreset)
  })
})

modeButtons.forEach((button) => {
  button.addEventListener('click', () => {
    setBattleMode(button.dataset.mode as 'local' | 'online')
  })
})

document.querySelector<HTMLButtonElement>('#builder-clear')!.addEventListener('click', () => {
  const design = currentBuilderDesign()
  setBuilderDesign({ ...design, bricks: design.bricks.filter((brick) => brick.y !== activeBuilderLayer) })
  renderBuilder()
})

document.querySelector<HTMLButtonElement>('#builder-reset')!.addEventListener('click', () => {
  builderDesigns[activeBuilderPlayer] = createStarterCastleDesign(activeBuilderPlayer === 0 ? 'North Keep' : 'South Bastion', displayNameInput.value.trim() || 'Commander')
  builderDesignNameInput.value = builderDesigns[activeBuilderPlayer].name
  renderBuilder()
})

document.querySelector<HTMLButtonElement>('#builder-publish')!.addEventListener('click', async () => {
  const design = normalizeCastleDesign({ ...currentBuilderDesign(), author: displayNameInput.value.trim() || 'Commander' })
  if (!design.bricks.length) {
    messageBar.textContent = 'Place some bricks before publishing a castle design.'
    return
  }
  const response = await publishCastleDesign(design)
  messageBar.textContent = `${response.castle.name} published to the shared castles tab.`
  await loadSharedCastles()
  setTab('castles')
})

document.querySelector<HTMLButtonElement>('#builder-start')!.addEventListener('click', async () => {
  const controller = await ensureGame()
  builderDesigns[0] = normalizeCastleDesign({ ...builderDesigns[0], name: builderDesigns[0].name || 'North Keep', author: displayNameInput.value.trim() || 'Commander' })
  builderDesigns[1] = normalizeCastleDesign({ ...builderDesigns[1], name: builderDesigns[1].name || 'South Bastion', author: builderDesigns[1].author || 'Commander' })
  const ok = await controller.startLocalMatch({
    preset: 'duel',
    slots: ['human', builderOpponentSelect.value as SlotOption, 'closed', 'closed'],
    castleDesigns: builderDesigns,
  })
  if (ok) {
    lobbyOverlay.classList.add('is-hidden')
    messageBar.textContent = 'Custom duel started from builder mode.'
  }
})

document.querySelector<HTMLButtonElement>('#refresh-castles')!.addEventListener('click', () => {
  void loadSharedCastles().then(() => {
    messageBar.textContent = 'Shared castles refreshed.'
  })
})

document.querySelector<HTMLButtonElement>('#start-match')!.addEventListener('click', async () => {
  const controller = await ensureGame()
  const ok = await controller.startLocalMatch({ preset: selectedPreset, slots: readSlots() })
  if (ok) {
    lobbyOverlay.classList.add('is-hidden')
  }
})

document.querySelector<HTMLButtonElement>('#create-room')!.addEventListener('click', async () => {
  const displayName = displayNameInput.value.trim() || 'Commander'
  const response = await createOnlineRoom({ preset: selectedPreset, slots: readSlots(), displayName })
  onlineSession = { roomCode: response.room.roomCode, playerToken: response.playerToken, playerId: response.playerId, isHost: true, displayName }
  currentRoom = response.room
  appliedRoomVersion = response.room.version
  roomCodeInput.value = response.room.roomCode
  renderRoomPanel(currentRoom)
  startRoomPolling()
  messageBar.textContent = `Room ${response.room.roomCode} created. Share the code and start when ready.`
})

document.querySelector<HTMLButtonElement>('#join-room')!.addEventListener('click', async () => {
  const displayName = displayNameInput.value.trim() || 'Commander'
  const roomCode = roomCodeInput.value.trim().toUpperCase()
  if (!roomCode) {
    messageBar.textContent = 'Enter a room code first.'
    return
  }
  const response = await joinOnlineRoom(roomCode, displayName)
  onlineSession = { roomCode: response.room.roomCode, playerToken: response.playerToken, playerId: response.playerId, isHost: false, displayName }
  currentRoom = response.room
  appliedRoomVersion = response.room.version
  renderRoomPanel(currentRoom)
  startRoomPolling()
  await syncRoom()
})

startOnlineButton.addEventListener('click', async () => {
  if (!onlineSession || !currentRoom) {
    return
  }
  const controller = await ensureGame()
  const snapshot = await controller.startHostedOnlineMatch({ preset: currentRoom.preset, seats: currentRoom.seats, session: onlineSession, commitSnapshot })
  if (!snapshot) {
    return
  }
  currentRoom = await startOnlineBattle(onlineSession, snapshot)
  appliedRoomVersion = currentRoom.version
  renderRoomPanel(currentRoom)
  lobbyOverlay.classList.add('is-hidden')
})

document.querySelector<HTMLButtonElement>('#restart-match')!.addEventListener('click', () => {
  window.location.reload()
})
