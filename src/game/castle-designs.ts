import type { CastleBrick, CastleDesign } from './types'

export const BUILD_GRID_SIZE = 8
export const BUILD_LEVELS = 6
export const BRICK_BUDGET = 72
export const BRICK_SPACING_XZ = 1.42
export const BRICK_HEIGHT = 0.84
const BRICK_SIZE_XZ = 1.36
const BRICK_SIZE_Y = 0.82

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value))
const keyOf = (brick: CastleBrick): string => `${brick.x}:${brick.y}:${brick.z}`

export const normalizeCastleDesign = (design: CastleDesign): CastleDesign => {
  const seen = new Set<string>()
  const bricks = design.bricks
    .map((brick) => ({
      x: clamp(Math.round(brick.x), 0, BUILD_GRID_SIZE - 1),
      y: clamp(Math.round(brick.y), 0, BUILD_LEVELS - 1),
      z: clamp(Math.round(brick.z), 0, BUILD_GRID_SIZE - 1),
    }))
    .filter((brick) => {
      const key = keyOf(brick)
      if (seen.has(key)) {
        return false
      }
      seen.add(key)
      return true
    })
    .slice(0, BRICK_BUDGET)

  return {
    id: design.id,
    name: design.name.trim().slice(0, 32) || 'Unnamed Fortress',
    author: design.author.trim().slice(0, 18) || 'Commander',
    bricks,
  }
}

export const createStarterCastleDesign = (name: string, author = 'Commander'): CastleDesign => {
  const bricks: CastleBrick[] = []
  const add = (x: number, y: number, z: number) => bricks.push({ x, y, z })

  for (let y = 0; y <= 1; y += 1) {
    for (let x = 1; x <= 6; x += 1) {
      add(x, y, 1)
      add(x, y, 6)
    }
    for (let z = 2; z <= 5; z += 1) {
      add(1, y, z)
      add(6, y, z)
    }
  }

  const extraBricks: Array<[number, number, number]> = [
    [1, 2, 1],
    [6, 2, 1],
    [1, 2, 6],
    [6, 2, 6],
    [3, 2, 1],
    [4, 2, 1],
    [3, 2, 6],
    [4, 2, 6],
    [3, 2, 3],
    [4, 2, 3],
    [3, 2, 4],
    [4, 2, 4],
    [3, 2, 2],
    [4, 2, 2],
    [3, 2, 5],
    [4, 2, 5],
    [1, 3, 1],
    [6, 3, 1],
    [1, 3, 6],
    [6, 3, 6],
    [3, 3, 3],
    [4, 3, 3],
    [3, 3, 4],
    [4, 3, 4],
    [3, 4, 3],
    [4, 4, 3],
    [3, 4, 4],
    [4, 4, 4],
    [2, 4, 3],
    [5, 4, 3],
    [3, 4, 2],
    [4, 4, 2],
  ]

  extraBricks.forEach(([x, y, z]) => add(x, y, z))

  return normalizeCastleDesign({
    id: `starter-${name.toLowerCase().replace(/\s+/g, '-')}`,
    name,
    author,
    bricks,
  })
}

export const createEmptyCastleDesign = (name: string, author = 'Commander'): CastleDesign => ({
  id: `local-${Math.random().toString(36).slice(2, 10)}`,
  name,
  author,
  bricks: [],
})

const gridToWorldX = (x: number): number => (x - (BUILD_GRID_SIZE - 1) / 2) * BRICK_SPACING_XZ
const gridToWorldZ = (z: number): number => (z - (BUILD_GRID_SIZE - 1) / 2) * BRICK_SPACING_XZ
const layerToWorldY = (y: number): number => 0.35 + y * BRICK_HEIGHT

type Placement = {
  position: [number, number, number]
  size: [number, number, number]
  tint: string
}

export const designToPlacements = (design: CastleDesign): Placement[] => {
  const normalized = normalizeCastleDesign(design)
  const occupied = new Set(normalized.bricks.map((brick) => keyOf(brick)))

  const placements: Placement[] = normalized.bricks.map((brick) => {
    const hasCap = occupied.has(`${brick.x}:${brick.y + 1}:${brick.z}`)
    const tint = !hasCap ? '#d7d0c4' : brick.y === 0 ? '#a39483' : brick.y >= 3 ? '#c8c0b5' : '#b6aea2'

    return {
      position: [gridToWorldX(brick.x), layerToWorldY(brick.y), gridToWorldZ(brick.z)],
      size: [BRICK_SIZE_XZ, BRICK_SIZE_Y, BRICK_SIZE_XZ],
      tint,
    }
  })

  if (!placements.length) {
    placements.push({ position: [0, 0.39, 0], size: [2.7, 0.82, 2.7], tint: '#9c7b53' })
  }

  return placements
}

export const designBounds = (design: CastleDesign): { minX: number; maxX: number; minZ: number; maxZ: number } => {
  const normalized = normalizeCastleDesign(design)
  if (!normalized.bricks.length) {
    return { minX: 2, maxX: 5, minZ: 2, maxZ: 5 }
  }
  return normalized.bricks.reduce(
    (bounds, brick) => ({
      minX: Math.min(bounds.minX, brick.x),
      maxX: Math.max(bounds.maxX, brick.x),
      minZ: Math.min(bounds.minZ, brick.z),
      maxZ: Math.max(bounds.maxZ, brick.z),
    }),
    { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity },
  )
}

const columnHeight = (design: CastleDesign, x: number, z: number): number => {
  const normalized = normalizeCastleDesign(design)
  let maxY = -1

  for (let radius = 0; radius <= 2 && maxY < 0; radius += 1) {
    normalized.bricks.forEach((brick) => {
      const distance = Math.abs(brick.x - x) + Math.abs(brick.z - z)
      if (distance <= radius) {
        maxY = Math.max(maxY, brick.y)
      }
    })
  }

  if (maxY < 0) {
    return layerToWorldY(0) + 0.55
  }

  return layerToWorldY(maxY) + 0.55
}

export const designCannonAnchors = (design: CastleDesign): Array<[number, number, number]> => {
  const bounds = designBounds(design)
  const midX = Math.round((bounds.minX + bounds.maxX) * 0.5)

  return [
    [gridToWorldX(bounds.minX), columnHeight(design, bounds.minX, bounds.minZ) + 0.9, gridToWorldZ(bounds.minZ) - 0.2],
    [gridToWorldX(bounds.maxX), columnHeight(design, bounds.maxX, bounds.minZ) + 0.9, gridToWorldZ(bounds.minZ) - 0.2],
    [gridToWorldX(midX), columnHeight(design, midX, bounds.maxZ) + 0.55, gridToWorldZ(bounds.maxZ) + 0.2],
    [gridToWorldX(midX), columnHeight(design, midX, bounds.minZ) + 0.55, gridToWorldZ(bounds.minZ) - 0.2],
  ]
}

export const designCaptainAnchor = (design: CastleDesign): [number, number, number] => {
  const normalized = normalizeCastleDesign(design)
  const bounds = designBounds(normalized)
  const centerX = (bounds.minX + bounds.maxX) * 0.5
  const centerZ = (bounds.minZ + bounds.maxZ) * 0.5

  const best = normalized.bricks.reduce<CastleBrick | null>((candidate, brick) => {
    if (!candidate) {
      return brick
    }

    const candidateDistance = Math.hypot(candidate.x - centerX, candidate.z - centerZ)
    const brickDistance = Math.hypot(brick.x - centerX, brick.z - centerZ)

    if (brick.y !== candidate.y) {
      return brick.y > candidate.y ? brick : candidate
    }

    return brickDistance < candidateDistance ? brick : candidate
  }, null)

  if (!best) {
    return [0, layerToWorldY(0) + 0.7, 0]
  }

  return [gridToWorldX(best.x), columnHeight(design, best.x, best.z) + 0.7, gridToWorldZ(best.z)]
}