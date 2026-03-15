import { createRoom } from '../_lib/rooms.js'

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ message: 'Method not allowed.' })
    return
  }

  try {
    const { preset, slots, displayName } = req.body ?? {}
    if (!preset || !Array.isArray(slots) || !displayName) {
      res.status(400).json({ message: 'preset, slots, and displayName are required.' })
      return
    }

    const response = await createRoom({ preset, slots, displayName })
    res.status(200).json(response)
  } catch (error) {
    res.status(400).json({ message: error instanceof Error ? error.message : 'Unable to create room.' })
  }
}