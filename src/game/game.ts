import * as THREE from 'three'
import RAPIER from '@dimforge/rapier3d-compat'

import { BattleAudio } from './audio'
import {
  BUILD_GRID_SIZE,
  BRICK_SPACING_XZ,
  createStarterCastleDesign,
  designBounds,
  designCaptainAnchor,
  designCannonAnchors,
  designToPlacements,
} from './castle-designs'
import {
  buildParticipantsFromSeats,
  buildParticipantsFromSlots,
  CASTLE_COLLAPSE_COLUMN_RATIO,
  CASTLE_COLLAPSE_HEIGHT_RATIO,
  CASTLE_MIN_COLLAPSE_HEIGHT,
  TEAM_LABELS,
  presetLabel,
} from './config'
import { ParticleSystem } from './particle-system'
import type {
  CastleDesign,
  CannonSnapshot,
  GameSnapshot,
  LocalMatchRequest,
  MatchMode,
  MatchParticipant,
  MatchPreset,
  OnlineSeat,
  OnlineSession,
  RoomPhase,
} from './types'

type GameUIRefs = {
  sceneRoot: HTMLDivElement
  messageBar: HTMLElement
  hudPlayer: HTMLElement
  hudMode: HTMLElement
  hudTurn: HTMLElement
  hudCannon: HTMLElement
  hudHeight: HTMLElement
  hudCharge: HTMLElement
  hudAmmo: HTMLElement
  cannonPanel: HTMLElement
  chargeFill: HTMLElement
  prevButton: HTMLButtonElement
  nextButton: HTMLButtonElement
  loadButton: HTMLButtonElement
  fireButton: HTMLButtonElement
  chargeButton: HTMLButtonElement
  winnerOverlay: HTMLElement
  winnerTitle: HTMLElement
  winnerCopy: HTMLElement
}

type PlayerState = MatchParticipant & {
  castle?: CastleState
}

type StonePart = {
  body: RAPIER.RigidBody
  mesh: THREE.Mesh
  height: number
}

type ProjectileState = {
  body: RAPIER.RigidBody
  mesh: THREE.Mesh
  bornAt: number
  lastSpeed: number
  trailTimer: number
  impacted: boolean
}

type CannonState = {
  id: number
  root: THREE.Group
  yawPivot: THREE.Group
  pitchPivot: THREE.Group
  barrel: THREE.Mesh
  carriage: THREE.Mesh
  muzzle: THREE.Object3D
  loadedBall: THREE.Mesh
  reserveMeshes: THREE.Mesh[]
  anchor: THREE.Vector3
  baseYaw: number
  yawOffset: number
  pitch: number
  powder: number
  loaded: boolean
  ammoReserve: number
  recoil: number
}

type CaptainState = {
  root: THREE.Group
  leftArm: THREE.Group
  rightArm: THREE.Group
  leftLeg: THREE.Group
  rightLeg: THREE.Group
  homeY: number
  facing: number
  walkCycle: number
}

type CastleState = {
  player: PlayerState
  group: THREE.Group
  stones: StonePart[]
  cannons: CannonState[]
  captain?: CaptainState
  supportHeight: number
  collapseHeight: number
  minimumSupportColumns: number
  alive: boolean
  origin: THREE.Vector3
  rotationY: number
  spawnProtectionUntil: number
  walkBounds: { minX: number; maxX: number; minZ: number; maxZ: number }
}

type CastleSupportProfile = {
  averageHeight: number
  columnCount: number
}

type SyncBody = {
  body: RAPIER.RigidBody
  mesh: THREE.Object3D
}

type NetworkAdapter =
  | { kind: 'local' }
  | {
      kind: 'online'
      session: OnlineSession
      commitSnapshot: (snapshot: GameSnapshot) => Promise<void>
    }

type MatchSeed = {
  preset: MatchPreset
  participants: MatchParticipant[]
  castleDesigns?: CastleDesign[]
  currentPlayerIndex?: number
  turnNumber?: number
  phase?: RoomPhase
  matchMode?: MatchMode
}

type HostedOnlineMatchRequest = {
  preset: MatchPreset
  seats: OnlineSeat[]
  session: OnlineSession
  commitSnapshot: (snapshot: GameSnapshot) => Promise<void>
}

const MAX_POWDER = 100
const CHARGE_TIME_MS = 2300
const PROJECTILE_RADIUS = 0.42
const CANNON_INTERACT_DISTANCE = 3.5
const CAPTAIN_MOVE_SPEED = 5.5
const CASTLE_SPAWN_PROTECTION_MS = 2200
const SUPPORT_CLUSTER_NEIGHBORS: Array<[number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
]
const clamp = THREE.MathUtils.clamp
const degToRad = THREE.MathUtils.degToRad
const radToDeg = THREE.MathUtils.radToDeg
const WORLD_UP = new THREE.Vector3(0, 1, 0)
const DEFAULT_CASTLE_DESIGN = createStarterCastleDesign('Royal Bastion', 'Crown')

export class GameApp {
  private readonly ui: GameUIRefs
  private readonly audio = new BattleAudio()
  private renderer!: THREE.WebGLRenderer
  private scene!: THREE.Scene
  private camera!: THREE.PerspectiveCamera
  private clock = new THREE.Clock()
  private world!: RAPIER.World
  private rapierReady = false

  private phase: RoomPhase = 'lobby'
  private matchMode: MatchMode = 'ffa'
  private preset: MatchPreset = 'duel'
  private players: PlayerState[] = []
  private castles: CastleState[] = []
  private projectiles: ProjectileState[] = []
  private syncedBodies: SyncBody[] = []
  private keysDown = new Set<string>()
  private network: NetworkAdapter = { kind: 'local' }
  private castleDesigns = new Map<number, CastleDesign>()
  private particleSystem!: ParticleSystem

  private currentPlayerIndex = 0
  private selectedCannonIndex = 0
  private settleMinUntil = 0
  private settleMaxUntil = 0
  private turnNumber = 1
  private isCharging = false
  private chargeStart = 0
  private syncInFlight = false
  private commitQueued = false
  private aiPendingForPlayerId: number | null = null
  private aiDueAt = 0
  private lastActorId: number | null = null
  private lastActorWasAi = false
  private gameOverCommitDone = false

  private cameraYaw = degToRad(28)
  private cameraPitch = 0.46
  private cameraDistance = 9.5
  private cameraTarget = new THREE.Vector3()
  private dragging = false
  private lastPointer = new THREE.Vector2()
  private cameraShake = 0

  private readonly barrelMaterial = new THREE.MeshStandardMaterial({ color: '#202b35', metalness: 0.72, roughness: 0.3 })
  private readonly wheelMaterial = new THREE.MeshStandardMaterial({ color: '#6d4c41', roughness: 0.82 })
  private readonly shadowMaterial = new THREE.MeshStandardMaterial({ color: '#6b705c', roughness: 1 })
  private readonly ballMaterial = new THREE.MeshStandardMaterial({ color: '#2f2f2f', metalness: 0.35, roughness: 0.5 })
  private readonly boxGeometryCache = new Map<string, THREE.BoxGeometry>()
  private readonly stoneMaterialCache = new Map<string, THREE.MeshStandardMaterial>()

  constructor(ui: GameUIRefs) {
    this.ui = ui
  }

  async initialize(): Promise<void> {
    await RAPIER.init()
    this.rapierReady = true

    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color('#d9d0c4')
    this.scene.fog = new THREE.Fog('#d9d0c4', 55, 120)
    this.particleSystem = new ParticleSystem(this.scene, 640)

    this.camera = new THREE.PerspectiveCamera(58, 1, 0.1, 250)
    this.camera.position.set(8, 8, 10)

    this.renderer = new THREE.WebGLRenderer({ antialias: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.ui.sceneRoot.appendChild(this.renderer.domElement)

    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 })

    this.buildEnvironment()
    this.bindEvents()
    this.handleResize()
    this.clock.start()
    this.loop()
  }

  async startLocalMatch(request: LocalMatchRequest): Promise<boolean> {
    if (!this.rapierReady) {
      this.setMessage('Physics engine is still loading.')
      return false
    }

    const participants = buildParticipantsFromSlots(request.preset, request.slots)
    if (participants.length < 2) {
      this.setMessage('Open at least two active seats.')
      return false
    }

    this.network = { kind: 'local' }
    this.startFromSeed({ preset: request.preset, participants, castleDesigns: request.castleDesigns })
    return true
  }

  async startHostedOnlineMatch(request: HostedOnlineMatchRequest): Promise<GameSnapshot | null> {
    if (!this.rapierReady) {
      return null
    }

    const participants = buildParticipantsFromSeats(request.seats)
    this.network = {
      kind: 'online',
      session: request.session,
      commitSnapshot: request.commitSnapshot,
    }
    this.startFromSeed({ preset: request.preset, participants, castleDesigns: undefined })
    return this.exportSnapshot()
  }

  async applyOnlineSnapshot(
    snapshot: GameSnapshot,
    session: OnlineSession,
    commitSnapshot: (snapshot: GameSnapshot) => Promise<void>,
  ): Promise<void> {
    this.network = {
      kind: 'online',
      session,
      commitSnapshot,
    }

    this.clearMatchState()
    this.preset = snapshot.preset
    this.matchMode = snapshot.matchMode
    this.phase = snapshot.phase
    this.turnNumber = snapshot.turnNumber
    this.currentPlayerIndex = snapshot.currentPlayerIndex
    this.players = snapshot.players.map((player) => ({ ...player }))
    this.castleDesigns.clear()
    this.selectedCannonIndex = 0
    this.aiPendingForPlayerId = null
    this.aiDueAt = 0
    this.commitQueued = false
    this.syncInFlight = false
    this.lastActorId = null
    this.lastActorWasAi = false
    this.gameOverCommitDone = false

    snapshot.castles.forEach((castleSnapshot) => {
      const player = this.players.find((candidate) => candidate.id === castleSnapshot.playerId)
      if (!player) {
        return
      }

      const castle = this.createCastle(player, new THREE.Vector3(...castleSnapshot.origin), castleSnapshot.rotationY)
      player.castle = castle
      this.castles.push(castle)
      castle.alive = castleSnapshot.alive
      castle.supportHeight = castleSnapshot.supportHeight
      player.alive = castleSnapshot.alive

      castleSnapshot.stones.forEach((stoneSnapshot, index) => {
        const stone = castle.stones[index]
        if (!stone) {
          return
        }
        stone.body.setTranslation({ x: stoneSnapshot.position[0], y: stoneSnapshot.position[1], z: stoneSnapshot.position[2] }, true)
        stone.body.setRotation(
          { x: stoneSnapshot.rotation[0], y: stoneSnapshot.rotation[1], z: stoneSnapshot.rotation[2], w: stoneSnapshot.rotation[3] },
          true,
        )
      })

      castleSnapshot.cannons.forEach((cannonSnapshot, index) => {
        const cannon = castle.cannons[index]
        if (cannon) {
          this.applyCannonSnapshot(cannon, cannonSnapshot)
        }
      })

      if (!castle.alive) {
        this.dimCastle(castle)
      }
    })

    this.selectCannon(0)
    if (snapshot.phase === 'game-over') {
      this.ui.winnerTitle.textContent = snapshot.winnerTitle ?? 'Match over'
      this.ui.winnerCopy.textContent = snapshot.winnerCopy ?? ''
      this.ui.winnerOverlay.classList.remove('is-hidden')
    } else {
      this.ui.winnerOverlay.classList.add('is-hidden')
    }

    this.setMessage(snapshot.message ?? 'Room synchronized.')
    this.updateHud()
  }

  private startFromSeed(seed: MatchSeed): void {
    this.clearMatchState()
    this.preset = seed.preset
    this.matchMode = seed.matchMode ?? (seed.preset === 'teams' ? 'teams' : 'ffa')
    this.phase = seed.phase ?? 'playing'
    this.turnNumber = seed.turnNumber ?? 1
    this.currentPlayerIndex = seed.currentPlayerIndex ?? 0
    this.players = seed.participants.map((participant) => ({ ...participant }))
    this.castleDesigns = new Map((seed.castleDesigns ?? []).map((design, index) => [index, design]))
    this.selectedCannonIndex = 0
    this.aiPendingForPlayerId = null
    this.aiDueAt = 0
    this.commitQueued = false
    this.syncInFlight = false
    this.lastActorId = null
    this.lastActorWasAi = false
    this.gameOverCommitDone = false
    this.ui.winnerOverlay.classList.add('is-hidden')

    this.spawnCastles()
    this.focusCurrentCastle(true)
    this.selectCannon(0)
    this.setMessage(`${this.players[this.currentPlayerIndex].name} takes the first turn.`)
    this.updateHud()
  }

  private clearMatchState(): void {
    this.projectiles.forEach((projectile) => {
      this.scene.remove(projectile.mesh)
      this.world.removeRigidBody(projectile.body)
    })

    this.castles.forEach((castle) => {
      castle.stones.forEach((stone) => {
        this.scene.remove(stone.mesh)
        this.world.removeRigidBody(stone.body)
      })
      this.scene.remove(castle.group)
    })

    this.projectiles = []
    this.castles = []
    this.players = []
    this.syncedBodies = []
    this.castleDesigns.clear()
    this.isCharging = false
    this.settleMinUntil = 0
    this.settleMaxUntil = 0
    this.particleSystem?.clear()
  }

  private buildEnvironment(): void {
    const hemi = new THREE.HemisphereLight('#f7f0de', '#6b705c', 1.3)
    this.scene.add(hemi)

    const sun = new THREE.DirectionalLight('#fff3d4', 2.5)
    sun.position.set(18, 28, 12)
    sun.castShadow = true
    sun.shadow.mapSize.set(2048, 2048)
    sun.shadow.camera.near = 1
    sun.shadow.camera.far = 90
    sun.shadow.camera.left = -40
    sun.shadow.camera.right = 40
    sun.shadow.camera.top = 40
    sun.shadow.camera.bottom = -40
    this.scene.add(sun)

    const arena = new THREE.Mesh(
      new THREE.CylinderGeometry(34, 38, 1.5, 48),
      new THREE.MeshStandardMaterial({ color: '#9c7b53', roughness: 0.95 }),
    )
    arena.position.y = -0.8
    arena.receiveShadow = true
    this.scene.add(arena)

    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(35.5, 1.2, 18, 96),
      new THREE.MeshStandardMaterial({ color: '#7f5539', roughness: 0.9 }),
    )
    ring.rotation.x = Math.PI / 2
    ring.position.y = -0.18
    this.scene.add(ring)

    const water = new THREE.Mesh(
      new THREE.CircleGeometry(90, 48),
      new THREE.MeshStandardMaterial({ color: '#5a7d7c', transparent: true, opacity: 0.6, roughness: 0.6 }),
    )
    water.rotation.x = -Math.PI / 2
    water.position.y = -1.45
    this.scene.add(water)

    const groundBody = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -1.5, 0))
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(70, 0.5, 70).setFriction(1), groundBody)

    for (let index = 0; index < 12; index += 1) {
      const angle = (index / 12) * Math.PI * 2
      const mound = new THREE.Mesh(new THREE.ConeGeometry(3.5 + (index % 3) * 0.8, 4 + (index % 2), 6), this.shadowMaterial)
      mound.position.set(Math.cos(angle) * 46, 0.5, Math.sin(angle) * 46)
      mound.rotation.y = angle
      mound.castShadow = true
      mound.receiveShadow = true
      this.scene.add(mound)
    }
  }

  private spawnCastles(): void {
    const radius = this.players.length === 2 ? 29 : 32
    this.players.forEach((player, index) => {
      const angle = (index / this.players.length) * Math.PI * 2
      const origin = new THREE.Vector3(Math.cos(angle) * radius, 0, Math.sin(angle) * radius)
      const rotationY = angle + Math.PI / 2
      player.castle = this.createCastle(player, origin, rotationY, this.castleDesigns.get(player.id))
      this.castles.push(player.castle)
    })
  }

  private createCastle(player: PlayerState, origin: THREE.Vector3, rotationY: number, design?: CastleDesign): CastleState {
    const group = new THREE.Group()
    group.position.copy(origin)
    group.rotation.y = rotationY
    this.scene.add(group)

    const footprint = designBounds(design ?? DEFAULT_CASTLE_DESIGN)
    const padding = BRICK_SPACING_XZ * 0.8
    const walkMinX = (footprint.minX - 3.5) * BRICK_SPACING_XZ + padding
    const walkMaxX = (footprint.maxX - 3.5) * BRICK_SPACING_XZ - padding
    const walkMinZ = (footprint.minZ - 3.5) * BRICK_SPACING_XZ + padding
    const walkMaxZ = (footprint.maxZ - 3.5) * BRICK_SPACING_XZ - padding

    const castle: CastleState = {
      player,
      group,
      stones: [],
      cannons: [],
      supportHeight: 0,
      collapseHeight: CASTLE_MIN_COLLAPSE_HEIGHT,
      minimumSupportColumns: 1,
      alive: true,
      origin: origin.clone(),
      rotationY,
      spawnProtectionUntil: performance.now() + CASTLE_SPAWN_PROTECTION_MS,
      walkBounds: { minX: walkMinX, maxX: walkMaxX, minZ: walkMinZ, maxZ: walkMaxZ },
    }

    const placements = this.generateCastleBlueprint(design)
    this.createCastleFoundation(castle, placements)
    placements.forEach(({ position, size, tint }) => {
      const worldPosition = position.clone().applyAxisAngle(WORLD_UP, rotationY).add(origin)
      const isGrounded = position.y - size.y * 0.5 <= 0.05
      const body = this.world.createRigidBody(
        (isGrounded ? RAPIER.RigidBodyDesc.fixed() : RAPIER.RigidBodyDesc.dynamic())
          .setTranslation(worldPosition.x, worldPosition.y, worldPosition.z)
          .setLinearDamping(0.72)
          .setAngularDamping(1.18),
      )
      this.world.createCollider(
        RAPIER.ColliderDesc.cuboid(size.x * 0.5, size.y * 0.5, size.z * 0.5).setDensity(1.12).setFriction(1.05).setRestitution(0.01),
        body,
      )

      const mesh = new THREE.Mesh(this.getBoxGeometry(size), this.getStoneMaterial(tint))
      mesh.castShadow = true
      mesh.receiveShadow = true
      this.scene.add(mesh)

      castle.stones.push({ body, mesh, height: size.y })
      if (!isGrounded) {
        this.syncedBodies.push({ body, mesh })
      }
    })

    castle.captain = this.createCaptain(castle, design)
    castle.cannons = this.createCannons(castle, design)
    const initialSupport = this.updateCastleHeight(castle)
    castle.collapseHeight = Math.max(CASTLE_MIN_COLLAPSE_HEIGHT, initialSupport.averageHeight * CASTLE_COLLAPSE_HEIGHT_RATIO)
    castle.minimumSupportColumns = Math.max(1, Math.ceil(initialSupport.columnCount * CASTLE_COLLAPSE_COLUMN_RATIO))
    return castle
  }

  private createCastleFoundation(castle: CastleState, placements: Array<{ position: THREE.Vector3; size: THREE.Vector3; tint: string }>): void {
    const bounds = placements.reduce(
      (accumulator, placement) => ({
        minX: Math.min(accumulator.minX, placement.position.x - placement.size.x * 0.5),
        maxX: Math.max(accumulator.maxX, placement.position.x + placement.size.x * 0.5),
        minZ: Math.min(accumulator.minZ, placement.position.z - placement.size.z * 0.5),
        maxZ: Math.max(accumulator.maxZ, placement.position.z + placement.size.z * 0.5),
      }),
      { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity },
    )

    const size = new THREE.Vector3(bounds.maxX - bounds.minX + 2.2, 1.1, bounds.maxZ - bounds.minZ + 2.2)
    const localPosition = new THREE.Vector3((bounds.minX + bounds.maxX) * 0.5, -0.56, (bounds.minZ + bounds.maxZ) * 0.5)
    const mesh = new THREE.Mesh(this.getBoxGeometry(size), this.getStoneMaterial('#89745f'))
    mesh.position.copy(localPosition)
    mesh.receiveShadow = true
    castle.group.add(mesh)

    const worldPosition = localPosition.clone().applyAxisAngle(WORLD_UP, castle.rotationY).add(castle.origin)
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(worldPosition.x, worldPosition.y, worldPosition.z))
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(size.x * 0.5, size.y * 0.5, size.z * 0.5).setFriction(1.1).setRestitution(0), body)
  }

  private generateCastleBlueprint(design?: CastleDesign): Array<{ position: THREE.Vector3; size: THREE.Vector3; tint: string }> {
    const source = design ?? DEFAULT_CASTLE_DESIGN
    return designToPlacements(source).map((placement) => ({
      position: new THREE.Vector3(...placement.position),
      size: new THREE.Vector3(...placement.size),
      tint: placement.tint,
    }))
  }

  private createCaptain(castle: CastleState, design?: CastleDesign): CaptainState {
    const captain = new THREE.Group()
    const bodyMaterial = new THREE.MeshStandardMaterial({ color: castle.player.color, roughness: 0.78 })
    const clothMaterial = new THREE.MeshStandardMaterial({ color: '#2b2620', roughness: 0.9 })
    const skinMaterial = new THREE.MeshStandardMaterial({ color: '#f0d1b2', roughness: 0.8 })

    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.56, 0.2), bodyMaterial)
    torso.position.y = 0.52
    torso.castShadow = true

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.18, 14, 14), skinMaterial)
    head.position.y = 0.98
    head.castShadow = true

    const leftArm = new THREE.Group()
    leftArm.position.set(-0.26, 0.76, 0)
    const leftArmMesh = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.44, 0.12), clothMaterial)
    leftArmMesh.position.y = -0.22
    leftArmMesh.castShadow = true
    leftArm.add(leftArmMesh)

    const rightArm = new THREE.Group()
    rightArm.position.set(0.26, 0.76, 0)
    const rightArmMesh = leftArmMesh.clone()
    rightArmMesh.castShadow = true
    rightArm.add(rightArmMesh)

    const leftLeg = new THREE.Group()
    leftLeg.position.set(-0.1, 0.28, 0)
    const leftLegMesh = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.5, 0.13), clothMaterial)
    leftLegMesh.position.y = -0.25
    leftLegMesh.castShadow = true
    leftLeg.add(leftLegMesh)

    const rightLeg = new THREE.Group()
    rightLeg.position.set(0.1, 0.28, 0)
    const rightLegMesh = leftLegMesh.clone()
    rightLegMesh.castShadow = true
    rightLeg.add(rightLegMesh)

    const plume = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.28, 8), new THREE.MeshStandardMaterial({ color: '#d6a23d', roughness: 0.5 }))
    plume.position.y = 1.22
    plume.castShadow = true

    captain.add(torso, head, leftArm, rightArm, leftLeg, rightLeg, plume)
    const [x, y, z] = designCaptainAnchor(design ?? DEFAULT_CASTLE_DESIGN)
    captain.position.set(x, y, z)
    castle.group.add(captain)
    return {
      root: captain,
      leftArm,
      rightArm,
      leftLeg,
      rightLeg,
      homeY: y,
      facing: 0,
      walkCycle: 0,
    }
  }

  private createCannons(castle: CastleState, design?: CastleDesign): CannonState[] {
    const anchors = designCannonAnchors(design ?? DEFAULT_CASTLE_DESIGN)
    const mounts = [
      { anchor: new THREE.Vector3(...anchors[0]), aim: new THREE.Vector3(-0.25, 0, -1) },
      { anchor: new THREE.Vector3(...anchors[1]), aim: new THREE.Vector3(0.25, 0, -1) },
      { anchor: new THREE.Vector3(...anchors[2]), aim: new THREE.Vector3(0, 0, 1) },
      { anchor: new THREE.Vector3(...anchors[3]), aim: new THREE.Vector3(0, 0, -1) },
    ]

    return mounts.map((mount, index) => {
      const root = new THREE.Group()
      root.position.copy(mount.anchor)
      castle.group.add(root)

      const yawPivot = new THREE.Group()
      root.add(yawPivot)
      const pitchPivot = new THREE.Group()
      yawPivot.add(pitchPivot)

      const carriage = new THREE.Mesh(new THREE.BoxGeometry(1.02, 0.28, 1.02), this.wheelMaterial)
      carriage.position.y = -0.18
      carriage.castShadow = true
      pitchPivot.add(carriage)

      const wheelLeft = new THREE.Mesh(new THREE.TorusGeometry(0.26, 0.09, 10, 18), this.wheelMaterial)
      wheelLeft.rotation.y = Math.PI / 2
      wheelLeft.position.set(-0.4, -0.22, 0)
      wheelLeft.castShadow = true
      pitchPivot.add(wheelLeft)
      const wheelRight = wheelLeft.clone()
      wheelRight.position.x = 0.4
      pitchPivot.add(wheelRight)

      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.28, 1.82, 18), this.barrelMaterial.clone())
      barrel.rotation.x = Math.PI / 2
      barrel.position.set(0, 0.15, 0.62)
      barrel.castShadow = true
      pitchPivot.add(barrel)

      const muzzle = new THREE.Object3D()
      muzzle.position.set(0, 0.15, 1.48)
      pitchPivot.add(muzzle)

      const loadedBall = new THREE.Mesh(new THREE.SphereGeometry(0.15, 14, 14), this.ballMaterial)
      loadedBall.position.set(0, 0.15, 0.48)
      loadedBall.visible = false
      pitchPivot.add(loadedBall)

      const reserveMeshes: THREE.Mesh[] = []
      const stackBase = new THREE.Vector3(index < 2 ? -1.25 : 1.25, 0, index === 2 ? 1.22 : -1.22)
      const stackOffsets = [
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0.42, 0, 0),
        new THREE.Vector3(0, 0, 0.42),
        new THREE.Vector3(0.42, 0, 0.42),
        new THREE.Vector3(0.21, 0.4, 0.21),
        new THREE.Vector3(0.21, 0.8, 0.21),
      ]

      stackOffsets.forEach((offset) => {
        const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.18, 12, 12), this.ballMaterial)
        mesh.position.copy(stackBase.clone().add(offset))
        mesh.castShadow = true
        mesh.receiveShadow = true
        root.add(mesh)
        reserveMeshes.push(mesh)
      })

      const aim = mount.aim.clone().normalize()
      const cannon: CannonState = {
        id: index,
        root,
        yawPivot,
        pitchPivot,
        barrel,
        carriage,
        muzzle,
        loadedBall,
        reserveMeshes,
        anchor: mount.anchor.clone(),
        baseYaw: Math.atan2(aim.x, aim.z),
        yawOffset: 0,
        pitch: degToRad(18),
        powder: 0,
        loaded: false,
        ammoReserve: reserveMeshes.length,
        recoil: 0,
      }
      this.setCannonAmmoVisual(cannon)
      this.applyCannonPose(cannon)
      return cannon
    })
  }

  private bindEvents(): void {
    window.addEventListener('resize', this.handleResize)
    window.addEventListener('keydown', (event) => this.onKeyChange(event, true))
    window.addEventListener('keyup', (event) => this.onKeyChange(event, false))

    this.renderer.domElement.addEventListener('pointerdown', (event: PointerEvent) => {
      this.audio.unlock()
      this.dragging = true
      this.lastPointer.set(event.clientX, event.clientY)
    })

    window.addEventListener('pointermove', (event) => {
      if (!this.dragging) {
        return
      }
      const dx = event.clientX - this.lastPointer.x
      const dy = event.clientY - this.lastPointer.y
      this.lastPointer.set(event.clientX, event.clientY)
      this.cameraYaw -= dx * 0.006
      this.cameraPitch = clamp(this.cameraPitch + dy * 0.004, 0.2, 0.95)
    })

    window.addEventListener('pointerup', () => {
      this.dragging = false
    })

    this.renderer.domElement.addEventListener('wheel', (event: WheelEvent) => {
      this.cameraDistance = clamp(this.cameraDistance + event.deltaY * 0.01, 6.5, 15)
    })

    this.ui.prevButton.addEventListener('click', () => this.selectCannon(this.selectedCannonIndex - 1))
    this.ui.nextButton.addEventListener('click', () => this.selectCannon(this.selectedCannonIndex + 1))
    this.ui.loadButton.addEventListener('click', () => this.loadSelectedCannon())
    this.ui.fireButton.addEventListener('click', () => this.fireSelectedCannon())
    this.ui.chargeButton.addEventListener('pointerdown', () => this.beginCharge())
    this.ui.chargeButton.addEventListener('pointerup', () => this.endCharge())
    this.ui.chargeButton.addEventListener('pointerleave', () => this.endCharge())
    this.ui.chargeButton.addEventListener('pointercancel', () => this.endCharge())
  }

  private onKeyChange(event: KeyboardEvent, pressed: boolean): void {
    if (pressed) {
      this.audio.unlock()
    }

    if (event.code === 'Space') {
      event.preventDefault()
      if (pressed) {
        this.beginCharge()
      } else {
        this.endCharge()
      }
    }

    if (pressed && !event.repeat) {
      if (event.code === 'KeyQ') {
        this.selectCannon(this.selectedCannonIndex - 1)
      }
      if (event.code === 'KeyE') {
        this.selectCannon(this.selectedCannonIndex + 1)
      }
      if (event.code === 'KeyR') {
        this.loadSelectedCannon()
      }
      if (event.code === 'KeyF') {
        this.fireSelectedCannon()
      }
    }

    const tracked = ['KeyA', 'KeyD', 'KeyW', 'KeyS', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']
    if (tracked.includes(event.code)) {
      if (pressed) {
        this.keysDown.add(event.code)
      } else {
        this.keysDown.delete(event.code)
      }
    }
  }

  private readonly handleResize = (): void => {
    const width = this.ui.sceneRoot.clientWidth
    const height = this.ui.sceneRoot.clientHeight
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(width, height)
  }

  private loop = (): void => {
    const delta = Math.min(this.clock.getDelta(), 1 / 20)
    const now = performance.now()

    if (this.phase !== 'lobby') {
      this.world.step()
      this.syncBodies()
      this.updateCannons(delta)
      this.updateProjectiles(now, delta)
      this.updateParticles(delta)
      this.updateCastleHeights()
      this.checkVictory()
      this.updateHumanControls(delta)
      this.updateTurnState(now)
      this.updateHud()
    }

    this.updateCamera(delta)
    this.renderer.render(this.scene, this.camera)
    window.requestAnimationFrame(this.loop)
  }

  private syncBodies(): void {
    this.syncedBodies.forEach(({ body, mesh }) => {
      const translation = body.translation()
      const rotation = body.rotation()
      mesh.position.set(translation.x, translation.y, translation.z)
      mesh.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w)
    })
  }

  private updateCannons(delta: number): void {
    this.castles.forEach((castle) => {
      castle.cannons.forEach((cannon) => {
        cannon.recoil = Math.max(0, cannon.recoil - delta * 1.8)
        this.applyCannonPose(cannon)
      })
    })
  }

  private updateCamera(delta: number): void {
    const desiredTarget = this.getCameraTargetPosition()
    this.cameraTarget.lerp(desiredTarget, 1 - Math.pow(0.0001, delta))
    this.cameraShake = Math.max(0, this.cameraShake - delta * 1.8)

    const horizontal = Math.cos(this.cameraPitch) * this.cameraDistance
    const shakeOffset = new THREE.Vector3((Math.random() - 0.5) * this.cameraShake, Math.random() * this.cameraShake, (Math.random() - 0.5) * this.cameraShake)
    const desiredPosition = new THREE.Vector3(
      this.cameraTarget.x + Math.sin(this.cameraYaw) * horizontal,
      this.cameraTarget.y + Math.sin(this.cameraPitch) * this.cameraDistance + 1.5,
      this.cameraTarget.z + Math.cos(this.cameraYaw) * horizontal,
    ).add(shakeOffset)

    this.camera.position.lerp(desiredPosition, 1 - Math.pow(0.0001, delta))
    this.camera.lookAt(this.cameraTarget.x, this.cameraTarget.y + 0.8, this.cameraTarget.z)
  }

  private updateHumanControls(delta: number): void {
    const player = this.getCurrentPlayer()
    const castle = player?.castle
    const captain = castle?.captain
    if (!player || !castle || !captain || !this.canHumanControl(player)) {
      return
    }

    let moveX = 0
    let moveZ = 0
    if (this.keysDown.has('KeyA')) {
      moveX -= 1
    }
    if (this.keysDown.has('KeyD')) {
      moveX += 1
    }
    if (this.keysDown.has('KeyW')) {
      moveZ -= 1
    }
    if (this.keysDown.has('KeyS')) {
      moveZ += 1
    }

    const moveLength = Math.hypot(moveX, moveZ)
    if (moveLength > 0) {
      moveX /= moveLength
      moveZ /= moveLength
      captain.root.position.x = clamp(captain.root.position.x + moveX * CAPTAIN_MOVE_SPEED * delta, castle.walkBounds.minX, castle.walkBounds.maxX)
      captain.root.position.z = clamp(captain.root.position.z + moveZ * CAPTAIN_MOVE_SPEED * delta, castle.walkBounds.minZ, castle.walkBounds.maxZ)
      captain.facing = Math.atan2(moveX, moveZ)
      captain.root.rotation.y = captain.facing
      captain.walkCycle += delta * 10
    } else {
      captain.walkCycle += delta * 2
    }
    captain.root.position.y = captain.homeY
    this.updateCaptainPose(captain, moveLength > 0 ? 1 : 0)

    const cannon = this.getNearbyCannon(player)
    if (!cannon) {
      this.isCharging = false
      return
    }

    if (cannon.id !== this.selectedCannonIndex) {
      this.selectCannon(cannon.id)
    }

    if (this.keysDown.has('ArrowLeft')) {
      cannon.yawOffset += 0.95 * delta
    }
    if (this.keysDown.has('ArrowRight')) {
      cannon.yawOffset -= 0.95 * delta
    }
    if (this.keysDown.has('ArrowUp')) {
      cannon.pitch += 0.65 * delta
    }
    if (this.keysDown.has('ArrowDown')) {
      cannon.pitch -= 0.65 * delta
    }

    cannon.yawOffset = clamp(cannon.yawOffset, degToRad(-100), degToRad(100))
    cannon.pitch = clamp(cannon.pitch, degToRad(8), degToRad(52))
    if (this.isCharging) {
      const elapsed = performance.now() - this.chargeStart
      cannon.powder = clamp((elapsed / CHARGE_TIME_MS) * MAX_POWDER, 0, MAX_POWDER)
    }

    this.applyCannonPose(cannon)
  }

  private updateCaptainPose(captain: CaptainState, stride: number): void {
    const swing = Math.sin(captain.walkCycle) * 0.55 * stride
    captain.leftArm.rotation.x = swing
    captain.rightArm.rotation.x = -swing
    captain.leftLeg.rotation.x = -swing
    captain.rightLeg.rotation.x = swing
  }

  private getNearbyCannon(player?: PlayerState): CannonState | undefined {
    const castle = player?.castle
    const captain = castle?.captain
    if (!castle || !captain) {
      return undefined
    }

    let nearest: CannonState | undefined
    let nearestDistanceSq = Infinity
    castle.cannons.forEach((cannon) => {
      const distanceSq = cannon.root.position.distanceToSquared(captain.root.position)
      if (distanceSq < nearestDistanceSq) {
        nearest = cannon
        nearestDistanceSq = distanceSq
      }
    })

    return nearestDistanceSq <= CANNON_INTERACT_DISTANCE * CANNON_INTERACT_DISTANCE ? nearest : undefined
  }

  private getCameraTargetPosition(): THREE.Vector3 {
    const castle = this.getCurrentPlayer()?.castle
    const captain = castle?.captain
    if (captain) {
      return captain.root.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, 1, 0))
    }
    return castle?.origin.clone().add(new THREE.Vector3(0, 4, 0)) ?? new THREE.Vector3()
  }

  private updateTurnState(now: number): void {
    if (this.phase === 'settling') {
      const shouldAdvance = now >= this.settleMaxUntil || (now >= this.settleMinUntil && this.measurePhysicsMotion() < 0.28)
      if (shouldAdvance) {
        this.advanceTurn()
        if (this.shouldCommitLastAction()) {
          this.commitQueued = true
        }
      }
    }

    if (this.commitQueued && !this.syncInFlight) {
      void this.flushCommitQueue()
    }

    if (this.phase !== 'playing' || this.syncInFlight) {
      return
    }

    const player = this.getCurrentPlayer()
    if (!player || player.controller !== 'ai' || !this.shouldDriveAi(player)) {
      return
    }

    if (this.aiPendingForPlayerId !== player.id) {
      this.aiPendingForPlayerId = player.id
      this.aiDueAt = now + 900
      return
    }

    if (now >= this.aiDueAt) {
      this.executeAiTurn(player)
      this.aiPendingForPlayerId = null
      this.aiDueAt = 0
    }
  }

  private async flushCommitQueue(): Promise<void> {
    if (this.network.kind !== 'online') {
      this.commitQueued = false
      return
    }

    const snapshot = this.exportSnapshot()
    if (!snapshot) {
      this.commitQueued = false
      return
    }

    this.syncInFlight = true
    this.commitQueued = false
    try {
      await this.network.commitSnapshot(snapshot)
    } finally {
      this.syncInFlight = false
      if (this.commitQueued) {
        await this.flushCommitQueue()
      }
    }
  }

  private executeAiTurn(player: PlayerState): void {
    const castle = player.castle
    if (!castle) {
      return
    }
    const cannon = castle.cannons.find((candidate) => candidate.ammoReserve > 0 || candidate.loaded)
    if (!cannon) {
      this.advanceTurn()
      return
    }

    this.selectedCannonIndex = cannon.id
    this.aimAiShot(castle, cannon)
    this.loadCannon(cannon)
    cannon.powder = clamp(cannon.powder, 35, 95)
    this.applyCannonPose(cannon)
    this.fireSelectedCannon(true)
  }

  private aimAiShot(castle: CastleState, cannon: CannonState): void {
    const enemyCastles = this.castles.filter((candidate) => candidate.alive && candidate.player.team !== castle.player.team)
    if (!enemyCastles.length) {
      return
    }

    const target = enemyCastles.sort((left, right) => left.origin.distanceToSquared(castle.origin) - right.origin.distanceToSquared(castle.origin))[0]
    const localTarget = castle.group.worldToLocal(target.origin.clone())
    const vector = localTarget.sub(cannon.anchor)
    const horizontal = Math.sqrt(vector.x * vector.x + vector.z * vector.z)
    cannon.yawOffset = clamp(Math.atan2(vector.x, vector.z) - cannon.baseYaw, degToRad(-95), degToRad(95))
    cannon.pitch = clamp(Math.atan2(vector.y + horizontal * 0.28, horizontal), degToRad(12), degToRad(48))
    cannon.powder = clamp(horizontal * 5.1 + Math.max(vector.y, 0) * 7, 28, 100)
  }

  private updateProjectiles(now: number, delta: number): void {
    this.projectiles = this.projectiles.filter((projectile) => {
      const position = projectile.body.translation()
      const velocity = projectile.body.linvel()
      const speed = Math.sqrt(velocity.x * velocity.x + velocity.y * velocity.y + velocity.z * velocity.z)

      projectile.trailTimer -= delta
      if (projectile.trailTimer <= 0) {
        projectile.trailTimer = 0.05
        this.spawnParticleBurst(new THREE.Vector3(position.x, position.y, position.z), { count: 1, color: '#d7d3cd', scale: 0.1, life: 0.35, speed: 0.55, gravity: -0.1 })
      }

      if (!projectile.impacted && projectile.lastSpeed > 16 && speed < 8) {
        projectile.impacted = true
        this.spawnParticleBurst(new THREE.Vector3(position.x, position.y, position.z), { count: 8, color: '#edae49', scale: 0.11, life: 0.6, speed: 4.8, gravity: 5 })
        this.spawnParticleBurst(new THREE.Vector3(position.x, position.y, position.z), { count: 6, color: '#cab6a6', scale: 0.18, life: 0.75, speed: 2.2, gravity: 2.5 })
        this.audio.playImpact(0.9)
      }

      projectile.lastSpeed = speed
      const expired = now - projectile.bornAt > 12000 || position.y < -10 || Math.abs(position.x) > 90 || Math.abs(position.z) > 90
      if (expired) {
        this.scene.remove(projectile.mesh)
        this.world.removeRigidBody(projectile.body)
        this.removeSyncedBody(projectile.body)
        return false
      }
      return true
    })
  }

  private measurePhysicsMotion(): number {
    let maxMotion = 0

    this.projectiles.forEach((projectile) => {
      const velocity = projectile.body.linvel()
      const speed = Math.sqrt(velocity.x * velocity.x + velocity.y * velocity.y + velocity.z * velocity.z)
      if (speed > maxMotion) {
        maxMotion = speed
      }
    })

    this.castles.forEach((castle) => {
      if (!castle.alive) {
        return
      }

      castle.stones.forEach((stone) => {
        const velocity = stone.body.linvel()
        const angular = stone.body.angvel()
        const speed = Math.sqrt(velocity.x * velocity.x + velocity.y * velocity.y + velocity.z * velocity.z)
        const spin = Math.sqrt(angular.x * angular.x + angular.y * angular.y + angular.z * angular.z)
        const motion = Math.max(speed, spin * 0.5)
        if (motion > maxMotion) {
          maxMotion = motion
        }
      })
    })

    return maxMotion
  }

  private updateParticles(delta: number): void {
    this.particleSystem.update(delta)
  }

  private updateCastleHeights(): void {
    const now = performance.now()

    this.castles.forEach((castle) => {
      if (!castle.alive) {
        return
      }

      const support = this.updateCastleHeight(castle)
      if (now < castle.spawnProtectionUntil) {
        return
      }

      const lostHeight = support.averageHeight < castle.collapseHeight
      const lostFooting = support.columnCount < castle.minimumSupportColumns
      if (lostHeight || lostFooting) {
        castle.alive = false
        castle.player.alive = false
        this.dimCastle(castle)
        this.spawnParticleBurst(castle.origin.clone().add(new THREE.Vector3(0, 4, 0)), { count: 20, color: '#cfc9c1', scale: 0.22, life: 1.3, speed: 3, gravity: 2.2 })
        this.setMessage(`${castle.player.name} has been eliminated. Their fortress lost its main support cluster.`)
      }
    })
  }

  private updateCastleHeight(castle: CastleState): CastleSupportProfile {
    const support = this.measureCastleSupport(castle)
    castle.supportHeight = support.averageHeight
    return support
  }

  private measureCastleSupport(castle: CastleState): CastleSupportProfile {
    const footprintHeights = new Map<string, number>()

    castle.stones.forEach((stone) => {
      const position = stone.body.translation()
      const local = new THREE.Vector3(position.x, position.y, position.z).sub(castle.origin).applyAxisAngle(WORLD_UP, -castle.rotationY)
      if (Math.abs(local.x) > 13 || Math.abs(local.z) > 13) {
        return
      }
      const gridX = Math.round(local.x / BRICK_SPACING_XZ + (BUILD_GRID_SIZE - 1) * 0.5)
      const gridZ = Math.round(local.z / BRICK_SPACING_XZ + (BUILD_GRID_SIZE - 1) * 0.5)
      const key = `${gridX}:${gridZ}`
      const topY = position.y + stone.height * 0.5
      const current = footprintHeights.get(key) ?? 0
      if (topY > current) {
        footprintHeights.set(key, topY)
      }
    })

    if (!footprintHeights.size) {
      return { averageHeight: 0, columnCount: 0 }
    }

    const visited = new Set<string>()
    let best: CastleSupportProfile = { averageHeight: 0, columnCount: 0 }
    let bestScore = -Infinity

    footprintHeights.forEach((_, startKey) => {
      if (visited.has(startKey)) {
        return
      }

      const queue = [startKey]
      const heights: number[] = []
      visited.add(startKey)

      while (queue.length) {
        const key = queue.pop()!
        const height = footprintHeights.get(key)
        if (height !== undefined) {
          heights.push(height)
        }

        const [gridX, gridZ] = key.split(':').map(Number)
        SUPPORT_CLUSTER_NEIGHBORS.forEach(([dx, dz]) => {
          const neighborKey = `${gridX + dx}:${gridZ + dz}`
          if (!visited.has(neighborKey) && footprintHeights.has(neighborKey)) {
            visited.add(neighborKey)
            queue.push(neighborKey)
          }
        })
      }

      heights.sort((left, right) => right - left)
      const sampleSize = Math.max(1, Math.ceil(heights.length * 0.6))
      const averageHeight = heights.slice(0, sampleSize).reduce((sum, value) => sum + value, 0) / sampleSize
      const score = averageHeight + Math.min(heights.length, 10) * 0.22

      if (score > bestScore) {
        bestScore = score
        best = { averageHeight, columnCount: heights.length }
      }
    })

    return best
  }

  private checkVictory(): void {
    if (this.phase === 'game-over') {
      return
    }

    const alivePlayers = this.players.filter((player) => player.alive)
    if (this.matchMode === 'ffa') {
      if (alivePlayers.length <= 1) {
        const winner = alivePlayers[0]
        this.finishMatch(winner ? `${winner.name} wins` : 'No castle survived', winner ? 'Last fortress standing.' : 'All castles collapsed.')
      }
      return
    }

    const aliveTeams = Array.from(new Set(alivePlayers.map((player) => player.team)))
    if (aliveTeams.length <= 1) {
      const team = aliveTeams[0]
      this.finishMatch(team === undefined ? 'No team survived' : `${TEAM_LABELS[team]} wins`, 'The opposing side has no standing castle left.')
    }
  }

  private finishMatch(title: string, copy: string): void {
    this.phase = 'game-over'
    this.ui.winnerTitle.textContent = title
    this.ui.winnerCopy.textContent = copy
    this.ui.winnerOverlay.classList.remove('is-hidden')
    this.setMessage(title)

    if (!this.gameOverCommitDone && this.shouldCommitLastAction()) {
      this.gameOverCommitDone = true
      this.commitQueued = true
    }
  }

  private beginCharge(): void {
    const player = this.getCurrentPlayer()
    const cannon = this.getNearbyCannon(player)
    if (!player || !this.canHumanControl(player) || !cannon?.loaded) {
      return
    }
    this.isCharging = true
    this.chargeStart = performance.now() - (cannon.powder / MAX_POWDER) * CHARGE_TIME_MS
  }

  private endCharge(): void {
    this.isCharging = false
  }

  private loadSelectedCannon(): void {
    const player = this.getCurrentPlayer()
    if (!player || !this.canHumanControl(player) || this.phase !== 'playing') {
      return
    }
    const cannon = this.getNearbyCannon(player)
    if (cannon) {
      this.loadCannon(cannon)
      this.selectCannon(cannon.id)
    }
  }

  private loadCannon(cannon: CannonState): void {
    if (cannon.loaded) {
      this.setMessage('That cannon is already loaded.')
      return
    }
    if (cannon.ammoReserve <= 0) {
      this.setMessage('No cannonballs remain in this stack.')
      return
    }
    cannon.ammoReserve -= 1
    cannon.loaded = true
    cannon.loadedBall.visible = true
    cannon.powder = 0
    this.setCannonAmmoVisual(cannon)
    this.setMessage(`Cannon ${cannon.id + 1} loaded by hand.`)
  }

  private fireSelectedCannon(force = false): void {
    const player = this.getCurrentPlayer()
    const cannon = force ? this.getSelectedCannon() : this.getNearbyCannon(player)
    if (!player || !cannon || this.phase !== 'playing') {
      return
    }
    if (!force && !this.canHumanControl(player)) {
      return
    }
    if (!cannon.loaded) {
      this.setMessage('Load a cannonball before firing.')
      return
    }

    const muzzlePosition = new THREE.Vector3()
    const muzzleQuaternion = new THREE.Quaternion()
    cannon.muzzle.getWorldPosition(muzzlePosition)
    cannon.muzzle.getWorldQuaternion(muzzleQuaternion)
    const direction = new THREE.Vector3(0, 0, 1).applyQuaternion(muzzleQuaternion).normalize()
    const powderRatio = Math.max(cannon.powder, 18) / MAX_POWDER

    const projectileMesh = new THREE.Mesh(new THREE.SphereGeometry(PROJECTILE_RADIUS, 16, 16), this.ballMaterial)
    projectileMesh.castShadow = true
    projectileMesh.receiveShadow = true
    this.scene.add(projectileMesh)

    const projectileBody = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(muzzlePosition.x, muzzlePosition.y, muzzlePosition.z).setLinearDamping(0.02).setAngularDamping(0.02).setCcdEnabled(true),
    )
    this.world.createCollider(RAPIER.ColliderDesc.ball(PROJECTILE_RADIUS).setDensity(4.6).setRestitution(0.05).setFriction(0.55), projectileBody)

    const impulse = direction.multiplyScalar(50 + powderRatio * 72)
    projectileBody.applyImpulse({ x: impulse.x, y: impulse.y, z: impulse.z }, true)
    projectileBody.applyTorqueImpulse({ x: 0.1, y: 0.15, z: 0.1 }, true)

    this.syncedBodies.push({ body: projectileBody, mesh: projectileMesh })
    this.projectiles.push({ body: projectileBody, mesh: projectileMesh, bornAt: performance.now(), lastSpeed: impulse.length(), trailTimer: 0, impacted: false })

    cannon.loaded = false
    cannon.loadedBall.visible = false
    cannon.powder = 0
    cannon.recoil = 0.42
    this.setCannonAmmoVisual(cannon)
    this.applyCannonPose(cannon)
    this.isCharging = false
    this.phase = 'settling'
    const settleStart = performance.now()
    this.settleMinUntil = settleStart + 1800
    this.settleMaxUntil = settleStart + 6200
    this.lastActorId = player.id
    this.lastActorWasAi = player.controller === 'ai'
    this.cameraShake = Math.min(0.6, this.cameraShake + 0.34)
    this.spawnParticleBurst(muzzlePosition, { count: 11, color: '#d4cec5', scale: 0.22, life: 0.75, speed: 4, gravity: 0.8, align: direction })
    this.spawnParticleBurst(muzzlePosition, { count: 6, color: '#edae49', scale: 0.12, life: 0.32, speed: 5.4, gravity: 6, align: direction })
    this.audio.playShot(powderRatio)
    this.setMessage(`${player.name} fires cannon ${cannon.id + 1}.`)
  }

  private advanceTurn(): void {
    if (this.phase === 'game-over') {
      return
    }

    const alivePlayers = this.players.filter((player) => player.alive)
    if (alivePlayers.length <= 1) {
      this.checkVictory()
      return
    }

    let attempts = 0
    do {
      this.currentPlayerIndex = (this.currentPlayerIndex + 1) % this.players.length
      attempts += 1
    } while (!this.players[this.currentPlayerIndex].alive && attempts <= this.players.length)

    this.phase = 'playing'
    this.turnNumber += 1
    this.selectedCannonIndex = 0
    this.aiPendingForPlayerId = null
    this.aiDueAt = 0
    this.focusCurrentCastle()
    this.selectCannon(0)
    this.setMessage(`${this.players[this.currentPlayerIndex].name} is up.`)
  }

  private focusCurrentCastle(force = false): void {
    if (force) {
      this.cameraTarget.copy(this.getCameraTargetPosition())
    }
  }

  private selectCannon(index: number): void {
    const castle = this.getCurrentPlayer()?.castle
    if (!castle) {
      return
    }
    const length = castle.cannons.length
    this.selectedCannonIndex = ((index % length) + length) % length
    castle.cannons.forEach((cannon, cannonIndex) => {
      const material = cannon.barrel.material as THREE.MeshStandardMaterial
      material.color.set(cannonIndex === this.selectedCannonIndex ? '#ffb703' : '#202b35')
      material.emissive = new THREE.Color(cannonIndex === this.selectedCannonIndex ? '#56340d' : '#000000')
    })
  }

  private applyCannonPose(cannon: CannonState): void {
    cannon.yawPivot.rotation.y = cannon.baseYaw + cannon.yawOffset
    cannon.pitchPivot.rotation.x = -cannon.pitch
    cannon.pitchPivot.position.z = -cannon.recoil
    cannon.barrel.position.z = 0.75 - cannon.recoil * 0.25
    cannon.carriage.position.z = -cannon.recoil * 0.18
  }

  private applyCannonSnapshot(cannon: CannonState, snapshot: CannonSnapshot): void {
    cannon.yawOffset = snapshot.yawOffset
    cannon.pitch = snapshot.pitch
    cannon.powder = snapshot.powder
    cannon.loaded = snapshot.loaded
    cannon.ammoReserve = snapshot.ammoReserve
    cannon.recoil = snapshot.recoil
    cannon.loadedBall.visible = snapshot.loaded
    this.setCannonAmmoVisual(cannon)
    this.applyCannonPose(cannon)
  }

  private setCannonAmmoVisual(cannon: CannonState): void {
    cannon.reserveMeshes.forEach((mesh, index) => {
      mesh.visible = index < cannon.ammoReserve
    })
  }

  private dimCastle(castle: CastleState): void {
    castle.group.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        const material = child.material
        if (material instanceof THREE.MeshStandardMaterial) {
          child.material = material.clone()
          child.material.color.multiplyScalar(0.6)
        }
      }
    })
  }

  private canHumanControl(player: PlayerState): boolean {
    if (player.controller !== 'human' || this.phase !== 'playing' || this.syncInFlight) {
      return false
    }
    if (this.network.kind === 'local') {
      return true
    }
    return this.network.session.playerId === player.id
  }

  private shouldDriveAi(player: PlayerState): boolean {
    if (player.controller !== 'ai') {
      return false
    }
    if (this.network.kind === 'local') {
      return true
    }
    return this.network.session.isHost
  }

  private shouldCommitLastAction(): boolean {
    if (this.network.kind !== 'online' || this.lastActorId === null) {
      return false
    }
    return this.lastActorWasAi ? this.network.session.isHost : this.network.session.playerId === this.lastActorId
  }

  private removeSyncedBody(body: RAPIER.RigidBody): void {
    this.syncedBodies = this.syncedBodies.filter((entry) => entry.body !== body)
  }

  private spawnParticleBurst(origin: THREE.Vector3, options: { count: number; color: string; scale: number; life: number; speed: number; gravity: number; align?: THREE.Vector3 }): void {
    const color = new THREE.Color(options.color)
    const seeds = Array.from({ length: options.count }, () => {
      const direction = options.align
        ? options.align.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.8, (Math.random() - 0.3) * 0.6, (Math.random() - 0.5) * 0.8)).normalize()
        : new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.9, Math.random() - 0.5).normalize()

      return {
        origin: origin.clone(),
        direction,
        color,
        life: options.life * (0.75 + Math.random() * 0.4),
        speed: options.speed * (0.7 + Math.random() * 0.7),
        gravity: options.gravity,
      }
    })
    this.particleSystem.spawnBurst(seeds)
  }

  private getBoxGeometry(size: THREE.Vector3): THREE.BoxGeometry {
    const key = `${size.x.toFixed(2)}:${size.y.toFixed(2)}:${size.z.toFixed(2)}`
    const cached = this.boxGeometryCache.get(key)
    if (cached) {
      return cached
    }
    const geometry = new THREE.BoxGeometry(size.x, size.y, size.z)
    this.boxGeometryCache.set(key, geometry)
    return geometry
  }

  private getStoneMaterial(color: string): THREE.MeshStandardMaterial {
    const cached = this.stoneMaterialCache.get(color)
    if (cached) {
      return cached
    }
    const material = new THREE.MeshStandardMaterial({ color, roughness: 0.95 })
    this.stoneMaterialCache.set(color, material)
    return material
  }

  private getCurrentPlayer(): PlayerState | undefined {
    return this.players[this.currentPlayerIndex]
  }

  private getSelectedCannon(): CannonState | undefined {
    return this.getCurrentPlayer()?.castle?.cannons[this.selectedCannonIndex]
  }

  private updateHud(): void {
    const player = this.getCurrentPlayer()
    const activeHuman = Boolean(player && this.canHumanControl(player))
    const nearbyCannon = activeHuman ? this.getNearbyCannon(player) : undefined
    const cannon = nearbyCannon ?? this.getSelectedCannon()
    this.ui.hudPlayer.textContent = player ? `${player.name}${player.controller === 'ai' ? ' [AI]' : ''}` : 'No match started'
    this.ui.hudMode.textContent = this.phase === 'lobby' ? 'Lobby' : this.network.kind === 'online' ? `Online room ${this.network.session.roomCode}` : presetLabel(this.preset)
    this.ui.hudTurn.textContent = this.phase === 'lobby' ? '-' : `${this.turnNumber}`
    this.ui.hudCannon.textContent = nearbyCannon
      ? `#${nearbyCannon.id + 1} | yaw ${radToDeg(nearbyCannon.yawOffset).toFixed(0)}° | pitch ${radToDeg(nearbyCannon.pitch).toFixed(0)}°`
      : this.phase === 'lobby'
        ? '-'
        : 'Move beside a cannon to load and fire.'
    this.ui.hudHeight.textContent = player?.castle ? `${player.castle.supportHeight.toFixed(1)}m / ${player.castle.collapseHeight.toFixed(1)}m` : '-'
    this.ui.hudCharge.textContent = cannon ? `${Math.round(cannon.powder)}%` : '0%'
    this.ui.chargeFill.setAttribute('style', `width:${cannon ? cannon.powder : 0}%`)
    this.ui.hudAmmo.textContent = cannon ? `${cannon.ammoReserve} balls in stack${cannon.loaded ? ' + 1 loaded' : ''}` : '-'

    const nearCannon = Boolean(activeHuman && nearbyCannon && this.phase !== 'lobby')
    this.ui.cannonPanel.classList.toggle('is-hidden', !nearCannon)
    this.ui.prevButton.disabled = !nearCannon
    this.ui.nextButton.disabled = !nearCannon
    this.ui.loadButton.disabled = !nearCannon
    this.ui.fireButton.disabled = !nearCannon
    this.ui.chargeButton.disabled = !nearCannon || !cannon?.loaded
  }

  private setMessage(message: string): void {
    this.ui.messageBar.textContent = message
  }

  private exportSnapshot(): GameSnapshot | null {
    if (!this.players.length || !this.castles.length) {
      return null
    }

    return {
      preset: this.preset,
      matchMode: this.matchMode,
      phase: this.phase,
      turnNumber: this.turnNumber,
      currentPlayerIndex: this.currentPlayerIndex,
      players: this.players.map((player) => ({ id: player.id, seatIndex: player.seatIndex, name: player.name, controller: player.controller, team: player.team, color: player.color, alive: player.alive })),
      castles: this.castles.map((castle) => ({
        playerId: castle.player.id,
        alive: castle.alive,
        origin: [castle.origin.x, castle.origin.y, castle.origin.z],
        rotationY: castle.rotationY,
        supportHeight: castle.supportHeight,
        stones: castle.stones.map((stone) => {
          const translation = stone.body.translation()
          const rotation = stone.body.rotation()
          return { position: [translation.x, translation.y, translation.z], rotation: [rotation.x, rotation.y, rotation.z, rotation.w] }
        }),
        cannons: castle.cannons.map((cannon) => ({ yawOffset: cannon.yawOffset, pitch: cannon.pitch, powder: cannon.powder, loaded: cannon.loaded, ammoReserve: cannon.ammoReserve, recoil: cannon.recoil })),
      })),
      winnerTitle: this.phase === 'game-over' ? this.ui.winnerTitle.textContent ?? undefined : undefined,
      winnerCopy: this.phase === 'game-over' ? this.ui.winnerCopy.textContent ?? undefined : undefined,
      message: this.ui.messageBar.textContent ?? undefined,
    }
  }
}