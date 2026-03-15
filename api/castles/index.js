import { listSharedCastles, publishCastle } from '../_lib/castles.js'

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      res.status(200).json({ castles: await listSharedCastles() })
      return
    }

    if (req.method === 'POST') {
      const castle = await publishCastle(req.body)
      res.status(200).json({ castle })
      return
    }

    res.status(405).json({ message: 'Method not allowed.' })
  } catch (error) {
    res.status(400).json({ message: error instanceof Error ? error.message : 'Castle request failed.' })
  }
}