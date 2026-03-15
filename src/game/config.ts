import type { MatchParticipant, MatchPreset, OnlineSeat, SlotOption } from './types'

export const PLAYER_COLORS = ['#d1495b', '#edae49', '#00798c', '#30638e']
export const TEAM_LABELS = ['Red Team', 'Blue Team']
export const CASTLE_MIN_HEIGHT = 5.2

export const presetLabel = (preset: MatchPreset): string => {
  if (preset === 'duel') {
    return '1v1'
  }
  if (preset === 'trio') {
    return '1v1v1'
  }
  if (preset === 'quad') {
    return '1v1v1v1'
  }
  return '2v2'
}

export const expectedSlotsForPreset = (preset: MatchPreset): number => {
  if (preset === 'duel') {
    return 2
  }
  if (preset === 'trio') {
    return 3
  }
  return 4
}

export const defaultSlotsForPreset = (preset: MatchPreset): SlotOption[] => {
  if (preset === 'duel') {
    return ['human', 'ai', 'closed', 'closed']
  }
  if (preset === 'trio') {
    return ['human', 'ai', 'ai', 'closed']
  }
  if (preset === 'quad') {
    return ['human', 'ai', 'ai', 'ai']
  }
  return ['human', 'ai', 'human', 'ai']
}

export const buildParticipantsFromSlots = (preset: MatchPreset, slots: SlotOption[]): MatchParticipant[] => {
  const expectedSlots = expectedSlotsForPreset(preset)
  const activeSlots = slots.slice(0, expectedSlots)

  return activeSlots
    .map((slot, seatIndex) => ({ slot, seatIndex }))
    .filter(({ slot }) => slot !== 'closed')
    .map(({ slot, seatIndex }, id) => ({
      id,
      seatIndex,
      name: `Commander ${id + 1}`,
      controller: slot === 'human' ? 'human' : 'ai',
      team: preset === 'teams' ? seatIndex % 2 : id,
      color: PLAYER_COLORS[id],
      alive: true,
    }))
}

export const buildParticipantsFromSeats = (seats: OnlineSeat[]): MatchParticipant[] =>
  seats.map((seat) => ({
    id: seat.playerId,
    seatIndex: seat.seatIndex,
    name: seat.name,
    controller: seat.controller,
    team: seat.team,
    color: seat.color,
    alive: true,
  }))