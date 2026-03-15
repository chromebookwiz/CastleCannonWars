import type {
  CreateRoomResponse,
  GameSnapshot,
  JoinRoomResponse,
  LocalMatchRequest,
  OnlineRoomState,
  OnlineSession,
} from './types'

type JsonValue = Record<string, unknown>

const requestJson = async <T>(input: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(input, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })

  const payload = (await response.json().catch(() => ({}))) as JsonValue
  if (!response.ok) {
    throw new Error(typeof payload.message === 'string' ? payload.message : 'Request failed.')
  }

  return payload as T
}

export const createOnlineRoom = async (
  request: LocalMatchRequest & { displayName: string },
): Promise<CreateRoomResponse> =>
  requestJson<CreateRoomResponse>('/api/rooms/create', {
    method: 'POST',
    body: JSON.stringify(request),
  })

export const fetchOnlineRoom = async (roomCode: string): Promise<OnlineRoomState> =>
  requestJson<OnlineRoomState>(`/api/rooms/${roomCode}`)

export const joinOnlineRoom = async (roomCode: string, displayName: string): Promise<JoinRoomResponse> =>
  requestJson<JoinRoomResponse>(`/api/rooms/${roomCode}`, {
    method: 'POST',
    body: JSON.stringify({ action: 'join', displayName }),
  })

export const startOnlineBattle = async (session: OnlineSession, snapshot: GameSnapshot): Promise<OnlineRoomState> =>
  requestJson<OnlineRoomState>(`/api/rooms/${session.roomCode}`, {
    method: 'POST',
    body: JSON.stringify({ action: 'start', playerToken: session.playerToken, snapshot }),
  })

export const commitOnlineSnapshot = async (
  session: OnlineSession,
  snapshot: GameSnapshot,
): Promise<OnlineRoomState> =>
  requestJson<OnlineRoomState>(`/api/rooms/${session.roomCode}`, {
    method: 'POST',
    body: JSON.stringify({ action: 'commit-turn', playerToken: session.playerToken, snapshot }),
  })