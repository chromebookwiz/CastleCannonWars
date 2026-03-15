import type { CastleBrick, CastleDesign } from './types'

export const BUILD_GRID_SIZE = 8
export const BUILD_LEVELS = 6
export const BRICK_BUDGET = 72
export const BRICK_SPACING_XZ = 1.18
export const BRICK_HEIGHT = 0.72

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

  for (let x = 1; x <= 6; x += 1) {
    add(x, 0, 1)
    add(x, 0, 6)
  }
  for (let z = 2; z <= 5; z += 1) {
    add(1, 0, z)
    add(6, 0, z)
  }
  for (let x = 2; x <= 5; x += 1) {
    add(x, 1, 1)
    add(x, 1, 6)
  }
  for (let z = 2; z <= 5; z += 1) {
    add(1, 1, z)
    add(6, 1, z)
  }
  ;[
    [1, 2, 1],
    [6, 2, 1],
    [1, 2, 6],
    [6, 2, 6],
    [1, 3, 1],
    [6, 3, 1],
    [1, 3, 6],
    [6, 3, 6],
    [3, 2, 3],
    [4, 2, 3],
    [3, 2, 4],
    [4, 2, 4],
    [3, 3, 3],
    [4, 3, 3],
    [3, 3, 4],
    [4, 3, 4],
    [3, 4, 3],
    [4, 4, 3],
    [3, 4, 4],
    [4, 4, 4],
  ].forEach(([x, y, z]) => add(x, y, z))

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
  const byLayer = new Map<number, CastleBrick[]>()
  normalized.bricks.forEach((brick) => {
    const list = byLayer.get(brick.y) ?? []
    list.push(brick)
    byLayer.set(brick.y, list)
  })

  const placements: Placement[] = []

  byLayer.forEach((layerBricks, y) => {
    const rows = new Map<number, number[]>()
    layerBricks.forEach((brick) => {
      const row = rows.get(brick.z) ?? []
      row.push(brick.x)
      rows.set(brick.z, row)
    })

    rows.forEach((xs, z) => {
      xs.sort((left, right) => left - right)
      let start = xs[0]
      let previous = xs[0]

      const pushRun = (runStart: number, runEnd: number) => {
        const centerX = (gridToWorldX(runStart) + gridToWorldX(runEnd)) * 0.5
        const width = BRICK_SPACING_XZ * (runEnd - runStart) + 1.02
        placements.push({
          position: [centerX, layerToWorldY(y), gridToWorldZ(z)],
          size: [width, 0.7, 1.02],
          tint: y >= 3 ? '#cdc7bc' : '#b9b4ad',
        })
      }

      for (let index = 1; index <= xs.length; index += 1) {
        const value = xs[index]
        if (value === previous + 1) {
          previous = value
          continue
        }
        pushRun(start, previous)
        start = value
        previous = value
      }
    })
  })

  if (!placements.length) {
    placements.push({ position: [0, 0.35, 0], size: [2.4, 0.7, 2.4], tint: '#9c7b53' })
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
  let maxY = 0
  normalized.bricks.forEach((brick) => {
    if (brick.x === x && brick.z === z) {
      maxY = Math.max(maxY, brick.y)
    }
  })
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
  const bounds = designBounds(design)
  const centerX = Math.round((bounds.minX + bounds.maxX) * 0.5)
  const centerZ = Math.round((bounds.minZ + bounds.maxZ) * 0.5)
  return [gridToWorldX(centerX), columnHeight(design, centerX, centerZ) + 0.7, gridToWorldZ(centerZ)]
}