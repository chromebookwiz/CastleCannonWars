export type MatchPreset = 'duel' | 'trio' | 'quad' | 'teams'
export type SlotOption = 'human' | 'ai' | 'closed'
export type MatchMode = 'ffa' | 'teams'
export type RoomPhase = 'lobby' | 'playing' | 'settling' | 'game-over'

export type MatchParticipant = {
  id: number
  seatIndex: number
  name: string
  controller: 'human' | 'ai'
  team: number
  color: string
  alive: boolean
}

export type CastleBrick = {
  x: number
  y: number
  z: number
}

export type CastleDesign = {
  id: string
  name: string
  author: string
  bricks: CastleBrick[]
}

export type LocalMatchRequest = {
  preset: MatchPreset
  slots: SlotOption[]
  castleDesigns?: CastleDesign[]
}

export type OnlineSeat = {
  playerId: number
  seatIndex: number
  name: string
  controller: 'human' | 'ai'
  team: number
  color: string
  claimed: boolean
  isHost: boolean
}

export type StoneSnapshot = {
  position: [number, number, number]
  rotation: [number, number, number, number]
}

export type CannonSnapshot = {
  yawOffset: number
  pitch: number
  powder: number
  loaded: boolean
  ammoReserve: number
  recoil: number
}

export type CastleSnapshot = {
  playerId: number
  alive: boolean
  origin: [number, number, number]
  rotationY: number
  supportHeight: number
  stones: StoneSnapshot[]
  cannons: CannonSnapshot[]
}

export type GameSnapshot = {
  preset: MatchPreset
  matchMode: MatchMode
  phase: RoomPhase
  turnNumber: number
  currentPlayerIndex: number
  players: MatchParticipant[]
  castles: CastleSnapshot[]
  winnerTitle?: string
  winnerCopy?: string
  message?: string
}

export type OnlineRoomState = {
  roomCode: string
  preset: MatchPreset
  phase: RoomPhase
  hostPlayerId: number
  version: number
  seats: OnlineSeat[]
  snapshot?: GameSnapshot
  message?: string
  winnerTitle?: string
  winnerCopy?: string
}

export type CreateRoomResponse = {
  room: OnlineRoomState
  playerToken: string
  playerId: number
}

export type JoinRoomResponse = {
  room: OnlineRoomState
  playerToken: string
  playerId: number
}

export type OnlineSession = {
  roomCode: string
  playerToken: string
  playerId: number
  isHost: boolean
  displayName: string
}

export type SharedCastleDesign = CastleDesign & {
  createdAt: number
  brickCount: number
}

export type SharedCastleListResponse = {
  castles: SharedCastleDesign[]
}

export type PublishCastleDesignResponse = {
  castle: SharedCastleDesign
}