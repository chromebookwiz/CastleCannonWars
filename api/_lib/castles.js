import { kv } from '@vercel/kv'

const memoryStore = globalThis.__castleCannonWarsSharedCastles ?? []

if (!globalThis.__castleCannonWarsSharedCastles) {
  globalThis.__castleCannonWarsSharedCastles = memoryStore
}

const listKey = 'castle-cannon:shared-castles'

const hasKvConfig = () => Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN)

const readCastles = async () => {
  if (hasKvConfig()) {
    const castles = await kv.get(listKey)
    return Array.isArray(castles) ? castles : []
  }
  return memoryStore
}

const writeCastles = async (castles) => {
  if (hasKvConfig()) {
    await kv.set(listKey, castles, { ex: 60 * 60 * 24 * 30 })
    return
  }

  memoryStore.splice(0, memoryStore.length, ...castles)
}

const normalizeName = (value, maxLength, fallback) => {
  const normalized = String(value ?? '').trim().slice(0, maxLength)
  return normalized || fallback
}

const normalizeDesign = (design) => {
  const bricks = Array.isArray(design?.bricks)
    ? design.bricks
        .map((brick) => ({
          x: Math.max(0, Math.min(7, Math.round(Number(brick?.x) || 0))),
          y: Math.max(0, Math.min(5, Math.round(Number(brick?.y) || 0))),
          z: Math.max(0, Math.min(7, Math.round(Number(brick?.z) || 0))),
        }))
        .filter((brick, index, list) => list.findIndex((candidate) => `${candidate.x}:${candidate.y}:${candidate.z}` === `${brick.x}:${brick.y}:${brick.z}`) === index)
        .slice(0, 72)
    : []

  return {
    id: `castle-${Math.random().toString(36).slice(2, 10)}`,
    name: normalizeName(design?.name, 32, 'Unnamed Fortress'),
    author: normalizeName(design?.author, 18, 'Commander'),
    bricks,
  }
}

export const listSharedCastles = async () => {
  const castles = await readCastles()
  return castles.sort((left, right) => right.createdAt - left.createdAt).slice(0, 24)
}

export const publishCastle = async (input) => {
  const design = normalizeDesign(input)
  const castles = await readCastles()
  const castle = {
    ...design,
    createdAt: Date.now(),
    brickCount: design.bricks.length,
  }
  castles.unshift(castle)
  await writeCastles(castles.slice(0, 64))
  return castle
}