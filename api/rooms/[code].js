import { commitTurn, getRoom, joinRoom, sanitizeRoom, startRoomMatch } from '../_lib/rooms.js'

export default async function handler(req, res) {
  const roomCode = String(req.query.code ?? '').toUpperCase()
  if (!roomCode) {
    res.status(400).json({ message: 'Room code is required.' })
    return
  }

  try {
    if (req.method === 'GET') {
      const room = await getRoom(roomCode)
      res.status(200).json(sanitizeRoom(room))
      return
    }

    if (req.method !== 'POST') {
      res.status(405).json({ message: 'Method not allowed.' })
      return
    }

    const { action, displayName, playerToken, snapshot } = req.body ?? {}
    if (action === 'join') {
      if (!displayName) {
        res.status(400).json({ message: 'displayName is required.' })
        return
      }
      res.status(200).json(await joinRoom(roomCode, displayName))
      return
    }

    if (action === 'start') {
      res.status(200).json(await startRoomMatch(roomCode, playerToken, snapshot))
      return
    }

    if (action === 'commit-turn') {
      res.status(200).json(await commitTurn(roomCode, playerToken, snapshot))
      return
    }

    res.status(400).json({ message: 'Unknown room action.' })
  } catch (error) {
    res.status(400).json({ message: error instanceof Error ? error.message : 'Room operation failed.' })
  }
}