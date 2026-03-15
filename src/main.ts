import './style.css'
import { defaultSlotsForPreset, expectedSlotsForPreset, presetLabel } from './game/config'
import { GameApp } from './game/game'
import { commitOnlineSnapshot, createOnlineRoom, fetchOnlineRoom, joinOnlineRoom, startOnlineBattle } from './game/network'
import type { GameSnapshot, MatchPreset, OnlineRoomState, OnlineSession, SlotOption } from './game/types'

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
        Local skirmishes, AI captains, and Vercel-hosted online rooms with synchronized turn snapshots.
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
          <h2>Choose your theater</h2>
          <p class="overlay-copy">
            Host a local skirmish, spin up an online room, or join an existing room code before the cannons open up.
          </p>
        </div>

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
const lobbyOverlay = document.querySelector<HTMLElement>('#lobby-overlay')!
const localActions = document.querySelector<HTMLElement>('#local-actions')!
const onlinePanel = document.querySelector<HTMLElement>('#online-panel')!
const roomPanel = document.querySelector<HTMLElement>('#room-panel')!
const displayNameInput = document.querySelector<HTMLInputElement>('#display-name')!
const roomCodeInput = document.querySelector<HTMLInputElement>('#room-code')!
const startOnlineButton = document.querySelector<HTMLButtonElement>('#start-online-match')!
const messageBar = document.querySelector<HTMLElement>('#message-bar')!

let selectedPreset: MatchPreset = 'duel'
let onlineSession: OnlineSession | null = null
let currentRoom: OnlineRoomState | null = null
let appliedRoomVersion = 0
let roomPollHandle = 0

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

const setMode = (mode: 'local' | 'online') => {
  modeButtons.forEach((button) => button.classList.toggle('is-active', button.dataset.mode === mode))
  const isOnline = mode === 'online'
  onlinePanel.classList.toggle('is-hidden', !isOnline)
  localActions.classList.toggle('is-hidden', isOnline)
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
        <p>${room.phase === 'lobby' ? 'Awaiting start' : room.phase === 'playing' ? 'Battle live' : 'Battle complete'}</p>
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

const game = new GameApp({
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
  await game.applyOnlineSnapshot(room.snapshot, onlineSession, commitSnapshot)
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
setMode('local')

presetButtons.forEach((button) => {
  button.addEventListener('click', () => {
    selectedPreset = button.dataset.preset as MatchPreset
    presetButtons.forEach((item) => item.classList.toggle('is-active', item === button))
    renderSlots(selectedPreset)
  })
})

modeButtons.forEach((button) => {
  button.addEventListener('click', () => {
    setMode(button.dataset.mode as 'local' | 'online')
  })
})

document.querySelector<HTMLButtonElement>('#start-match')!.addEventListener('click', async () => {
  const ok = await game.startLocalMatch({ preset: selectedPreset, slots: readSlots() })
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
  const snapshot = await game.startHostedOnlineMatch({ preset: currentRoom.preset, seats: currentRoom.seats, session: onlineSession, commitSnapshot })
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

void game.initialize()