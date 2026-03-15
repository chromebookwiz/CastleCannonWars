import { kv } from '@vercel/kv'

const memoryStore = globalThis.__castleCannonWarsRooms ?? new Map()

if (!globalThis.__castleCannonWarsRooms) {
  globalThis.__castleCannonWarsRooms = memoryStore
}

const PLAYER_COLORS = ['#d1495b', '#edae49', '#00798c', '#30638e']

const expectedSlotsForPreset = (preset) => {
  if (preset === 'duel') {
    return 2
  }
  if (preset === 'trio') {
    return 3
  }
  return 4
}

const hasKvConfig = () => Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN)

const roomKey = (roomCode) => `castle-cannon-room:${roomCode}`

const writeRoom = async (room) => {
  const payload = JSON.stringify(room)
  if (hasKvConfig()) {
    await kv.set(roomKey(room.roomCode), payload, { ex: 60 * 60 * 12 })
    return
  }

  memoryStore.set(room.roomCode, payload)
}

const readRoom = async (roomCode) => {
  const raw = hasKvConfig() ? await kv.get(roomKey(roomCode)) : memoryStore.get(roomCode)
  if (!raw) {
    return null
  }
  return typeof raw === 'string' ? JSON.parse(raw) : raw
}

const buildSeats = (preset, slots, displayName) => {
  const expectedSlots = expectedSlotsForPreset(preset)
  let playerId = 0

  return slots.slice(0, expectedSlots).flatMap((slot, seatIndex) => {
    if (slot === 'closed') {
      return []
    }

    const seat = {
      playerId,
      seatIndex,
      name: slot === 'human' && playerId === 0 ? displayName : slot === 'ai' ? `Iron Captain ${playerId + 1}` : `Commander ${playerId + 1}`,
      controller: slot === 'human' ? 'human' : 'ai',
      team: preset === 'teams' ? seatIndex % 2 : playerId,
      color: PLAYER_COLORS[playerId],
      claimed: slot === 'ai' || playerId === 0,
      isHost: playerId === 0,
    }

    playerId += 1
    return [seat]
  })
}

const createToken = () => Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
const createRoomCode = () => Math.random().toString(36).slice(2, 6).toUpperCase()

const normalizeDisplayName = (displayName) => {
  const normalized = String(displayName ?? '').trim().slice(0, 18)
  return normalized || 'Commander'
}

export const createRoom = async ({ preset, slots, displayName }) => {
  const safeDisplayName = normalizeDisplayName(displayName)
  let roomCode = createRoomCode()
  let attempts = 0

  while ((await readRoom(roomCode)) && attempts < 24) {
    roomCode = createRoomCode()
    attempts += 1
  }

  if (await readRoom(roomCode)) {
    throw new Error('Unable to allocate a unique room code right now.')
  }

  const seats = buildSeats(preset, slots, safeDisplayName)
  if (seats.length < 2) {
    throw new Error('At least two active seats are required.')
  }

  const hostSeat = seats[0]
  const hostToken = createToken()
  const room = {
    roomCode,
    preset,
    phase: 'lobby',
    hostPlayerId: hostSeat.playerId,
    hostToken,
    version: 1,
    seats,
    snapshot: undefined,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    message: `${safeDisplayName} created room ${roomCode}.`,
    playerTokens: {
      [hostSeat.playerId]: hostToken,
    },
  }

  await writeRoom(room)
  return {
    room: sanitizeRoom(room),
    playerToken: hostToken,
    playerId: hostSeat.playerId,
  }
}

export const sanitizeRoom = (room) => ({
  roomCode: room.roomCode,
  preset: room.preset,
  phase: room.phase,
  hostPlayerId: room.hostPlayerId,
  version: room.version,
  seats: room.seats,
  snapshot: room.snapshot,
  message: room.message,
  winnerTitle: room.winnerTitle,
  winnerCopy: room.winnerCopy,
})

export const getRoom = async (roomCode) => {
  const room = await readRoom(roomCode.toUpperCase())
  if (!room) {
    throw new Error('Room not found.')
  }
  return room
}

export const joinRoom = async (roomCode, displayName) => {
  const room = await getRoom(roomCode)
  const seat = room.seats.find((candidate) => candidate.controller === 'human' && !candidate.claimed)
  if (!seat) {
    throw new Error('No open human seats remain in this room.')
  }

  const safeDisplayName = normalizeDisplayName(displayName)
  const playerToken = createToken()
  seat.claimed = true
  seat.name = safeDisplayName
  room.playerTokens[seat.playerId] = playerToken
  room.updatedAt = Date.now()
  room.version += 1
  room.message = `${safeDisplayName} joined room ${room.roomCode}.`
  await writeRoom(room)

  return {
    room: sanitizeRoom(room),
    playerToken,
    playerId: seat.playerId,
  }
}

const assertHost = (room, playerToken) => {
  if (room.hostToken !== playerToken) {
    throw new Error('Only the host can perform that action.')
  }
}

const assertPlayer = (room, playerToken) => {
  const matched = Object.entries(room.playerTokens).find(([, token]) => token === playerToken)
  if (!matched) {
    throw new Error('Invalid player token.')
  }
  return Number(matched[0])
}

export const startRoomMatch = async (roomCode, playerToken, snapshot) => {
  const room = await getRoom(roomCode)
  assertHost(room, playerToken)
  room.phase = snapshot.phase
  room.snapshot = snapshot
  room.version += 1
  room.updatedAt = Date.now()
  room.message = snapshot.message ?? 'The battle has begun.'
  await writeRoom(room)
  return sanitizeRoom(room)
}

export const commitTurn = async (roomCode, playerToken, snapshot) => {
  const room = await getRoom(roomCode)
  assertPlayer(room, playerToken)
  room.phase = snapshot.phase
  room.snapshot = snapshot
  room.version += 1
  room.updatedAt = Date.now()
  room.message = snapshot.message ?? room.message
  room.winnerTitle = snapshot.winnerTitle
  room.winnerCopy = snapshot.winnerCopy
  await writeRoom(room)
  return sanitizeRoom(room)
}