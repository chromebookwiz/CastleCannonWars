import * as THREE from 'three'
import RAPIER from '@dimforge/rapier3d-compat'

import { BattleAudio } from './audio'
import { buildParticipantsFromSeats, buildParticipantsFromSlots, CASTLE_MIN_HEIGHT, TEAM_LABELS, presetLabel } from './config'
import type {
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

type CastleState = {
  player: PlayerState
  group: THREE.Group
  stones: StonePart[]
  cannons: CannonState[]
  supportHeight: number
  alive: boolean
  origin: THREE.Vector3
  rotationY: number
}

type SyncBody = {
  body: RAPIER.RigidBody
  mesh: THREE.Object3D
}

type ParticleState = {
  mesh: THREE.Mesh
  velocity: THREE.Vector3
  gravity: number
  life: number
  maxLife: number
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
const clamp = THREE.MathUtils.clamp
const degToRad = THREE.MathUtils.degToRad
const radToDeg = THREE.MathUtils.radToDeg
const WORLD_UP = new THREE.Vector3(0, 1, 0)

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
  private particles: ParticleState[] = []
  private keysDown = new Set<string>()
  private network: NetworkAdapter = { kind: 'local' }

  private currentPlayerIndex = 0
  private selectedCannonIndex = 0
  private settleUntil = 0
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

  private cameraYaw = degToRad(36)
  private cameraPitch = 0.74
  private cameraDistance = 34
  private cameraTarget = new THREE.Vector3()
  private dragging = false
  private lastPointer = new THREE.Vector2()
  private cameraShake = 0

  private readonly barrelMaterial = new THREE.MeshStandardMaterial({ color: '#202b35', metalness: 0.72, roughness: 0.3 })
  private readonly wheelMaterial = new THREE.MeshStandardMaterial({ color: '#6d4c41', roughness: 0.82 })
  private readonly shadowMaterial = new THREE.MeshStandardMaterial({ color: '#6b705c', roughness: 1 })
  private readonly ballMaterial = new THREE.MeshStandardMaterial({ color: '#2f2f2f', metalness: 0.35, roughness: 0.5 })
  private readonly smokeMaterial = new THREE.MeshStandardMaterial({ color: '#d9d3ca', transparent: true, opacity: 0.9 })
  private readonly sparkMaterial = new THREE.MeshStandardMaterial({ color: '#edae49', emissive: '#7f4f24' })
  private readonly particleGeometry = new THREE.SphereGeometry(0.16, 8, 8)

  constructor(ui: GameUIRefs) {
    this.ui = ui
  }

  async initialize(): Promise<void> {
    await RAPIER.init()
    this.rapierReady = true

    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color('#d9d0c4')
    this.scene.fog = new THREE.Fog('#d9d0c4', 55, 120)

    this.camera = new THREE.PerspectiveCamera(52, 1, 0.1, 250)
    this.camera.position.set(18, 20, 26)

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
    this.startFromSeed({ preset: request.preset, participants })
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
    this.startFromSeed({ preset: request.preset, participants })
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

    this.particles.forEach((particle) => {
      this.scene.remove(particle.mesh)
    })

    this.projectiles = []
    this.castles = []
    this.players = []
    this.syncedBodies = []
    this.particles = []
    this.isCharging = false
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
    const radius = this.players.length === 2 ? 23 : 25
    this.players.forEach((player, index) => {
      const angle = (index / this.players.length) * Math.PI * 2
      const origin = new THREE.Vector3(Math.cos(angle) * radius, 0, Math.sin(angle) * radius)
      const rotationY = angle + Math.PI / 2
      player.castle = this.createCastle(player, origin, rotationY)
      this.castles.push(player.castle)
    })
  }

  private createCastle(player: PlayerState, origin: THREE.Vector3, rotationY: number): CastleState {
    const group = new THREE.Group()
    group.position.copy(origin)
    group.rotation.y = rotationY
    this.scene.add(group)

    const castle: CastleState = {
      player,
      group,
      stones: [],
      cannons: [],
      supportHeight: 0,
      alive: true,
      origin: origin.clone(),
      rotationY,
    }

    const placements = this.generateCastleBlueprint()
    placements.forEach(({ position, size, tint }) => {
      const worldPosition = position.clone().applyAxisAngle(WORLD_UP, rotationY).add(origin)
      const body = this.world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic().setTranslation(worldPosition.x, worldPosition.y, worldPosition.z).setLinearDamping(0.34).setAngularDamping(0.58),
      )
      this.world.createCollider(
        RAPIER.ColliderDesc.cuboid(size.x * 0.5, size.y * 0.5, size.z * 0.5).setDensity(1.35).setFriction(0.98).setRestitution(0.01),
        body,
      )

      const mesh = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), new THREE.MeshStandardMaterial({ color: tint, roughness: 0.95 }))
      mesh.castShadow = true
      mesh.receiveShadow = true
      this.scene.add(mesh)

      castle.stones.push({ body, mesh, height: size.y })
      this.syncedBodies.push({ body, mesh })
    })

    this.createCaptain(castle)
    castle.cannons = this.createCannons(castle)
    this.updateCastleHeight(castle)
    return castle
  }

  private generateCastleBlueprint(): Array<{ position: THREE.Vector3; size: THREE.Vector3; tint: string }> {
    const blocks = new Map<string, { position: THREE.Vector3; size: THREE.Vector3; tint: string }>()
    const addBlock = (x: number, y: number, z: number, size = new THREE.Vector3(1.1, 0.7, 1.1), tint = '#bab7b0') => {
      const key = `${x.toFixed(2)}:${y.toFixed(2)}:${z.toFixed(2)}:${size.x.toFixed(2)}:${size.y.toFixed(2)}:${size.z.toFixed(2)}`
      if (!blocks.has(key)) {
        blocks.set(key, { position: new THREE.Vector3(x, y, z), size: size.clone(), tint })
      }
    }

    const wallLevels = 5
    const wallHalf = 5.7
    const spacing = 1.18

    for (let level = 0; level < wallLevels; level += 1) {
      const y = 0.35 + level * 0.72
      for (let step = -4; step <= 4; step += 1) {
        addBlock(step * spacing, y, wallHalf)
        addBlock(step * spacing, y, -wallHalf)
      }
      for (let step = -3; step <= 3; step += 1) {
        addBlock(wallHalf, y, step * spacing)
        addBlock(-wallHalf, y, step * spacing)
      }
    }

    for (let step = -4; step <= 4; step += 2) {
      addBlock(step * spacing, 4.18, wallHalf, new THREE.Vector3(1.05, 0.62, 1.08), '#d0cbc1')
      addBlock(step * spacing, 4.18, -wallHalf, new THREE.Vector3(1.05, 0.62, 1.08), '#d0cbc1')
    }
    for (let step = -3; step <= 3; step += 2) {
      addBlock(wallHalf, 4.18, step * spacing, new THREE.Vector3(1.08, 0.62, 1.05), '#d0cbc1')
      addBlock(-wallHalf, 4.18, step * spacing, new THREE.Vector3(1.08, 0.62, 1.05), '#d0cbc1')
    }

    const towerCenters = [new THREE.Vector2(-5.7, -5.7), new THREE.Vector2(5.7, -5.7), new THREE.Vector2(-5.7, 5.7), new THREE.Vector2(5.7, 5.7)]
    towerCenters.forEach((center) => {
      for (let level = 0; level < 8; level += 1) {
        const y = 0.35 + level * 0.72
        for (let x = -1; x <= 1; x += 1) {
          for (let z = -1; z <= 1; z += 1) {
            addBlock(center.x + x * 1.04, y, center.y + z * 1.04, new THREE.Vector3(1.02, 0.7, 1.02), '#b6b2ab')
          }
        }
      }
      addBlock(center.x, 6.1, center.y, new THREE.Vector3(2.3, 0.65, 2.3), '#d7d2c8')
    })

    for (let level = 0; level < 4; level += 1) {
      const y = 0.35 + level * 0.72
      for (let x = -2; x <= 2; x += 1) {
        for (let z = -2; z <= 2; z += 1) {
          addBlock(x * 1.12, y, z * 1.12, new THREE.Vector3(1.02, 0.7, 1.02), '#a9a59d')
        }
      }
    }

    addBlock(0, 3.55, 0, new THREE.Vector3(6.1, 0.6, 6.1), '#cbc8c1')
    addBlock(0, 4.25, -5.72, new THREE.Vector3(2.1, 0.55, 0.8), '#8d6748')
    addBlock(0, 1.1, -5.2, new THREE.Vector3(1.4, 2.1, 0.75), '#6b4f3a')
    addBlock(-1.35, 1.45, -4.1, new THREE.Vector3(1.15, 1.35, 1.15), '#9f9a92')
    addBlock(1.35, 1.45, -4.1, new THREE.Vector3(1.15, 1.35, 1.15), '#9f9a92')

    return Array.from(blocks.values())
  }

  private createCaptain(castle: CastleState): void {
    const captain = new THREE.Group()
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.28, 0.85, 6, 12), new THREE.MeshStandardMaterial({ color: castle.player.color, roughness: 0.78 }))
    body.castShadow = true

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.26, 16, 16), new THREE.MeshStandardMaterial({ color: '#f0d1b2', roughness: 0.8 }))
    head.position.y = 0.95
    head.castShadow = true

    const plume = new THREE.Mesh(new THREE.ConeGeometry(0.15, 0.4, 8), new THREE.MeshStandardMaterial({ color: '#2f3e46', roughness: 0.5 }))
    plume.position.y = 1.28
    plume.castShadow = true

    captain.add(body, head, plume)
    captain.position.set(0, 5.3, 0)
    castle.group.add(captain)
  }

  private createCannons(castle: CastleState): CannonState[] {
    const mounts = [
      { anchor: new THREE.Vector3(-5.6, 6.55, -5.35), aim: new THREE.Vector3(0, 0, -1) },
      { anchor: new THREE.Vector3(5.6, 6.55, -5.35), aim: new THREE.Vector3(0, 0, -1) },
      { anchor: new THREE.Vector3(0, 4.95, 5.95), aim: new THREE.Vector3(0, 0, 1) },
      { anchor: new THREE.Vector3(0, 4.95, -5.95), aim: new THREE.Vector3(0, 0, -1) },
    ]

    return mounts.map((mount, index) => {
      const root = new THREE.Group()
      root.position.copy(mount.anchor)
      castle.group.add(root)

      const yawPivot = new THREE.Group()
      root.add(yawPivot)
      const pitchPivot = new THREE.Group()
      yawPivot.add(pitchPivot)

      const carriage = new THREE.Mesh(new THREE.BoxGeometry(1.25, 0.35, 1.25), this.wheelMaterial)
      carriage.position.y = -0.18
      carriage.castShadow = true
      pitchPivot.add(carriage)

      const wheelLeft = new THREE.Mesh(new THREE.TorusGeometry(0.32, 0.12, 10, 20), this.wheelMaterial)
      wheelLeft.rotation.y = Math.PI / 2
      wheelLeft.position.set(-0.48, -0.26, 0)
      wheelLeft.castShadow = true
      pitchPivot.add(wheelLeft)
      const wheelRight = wheelLeft.clone()
      wheelRight.position.x = 0.48
      pitchPivot.add(wheelRight)

      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.34, 2.2, 18), this.barrelMaterial.clone())
      barrel.rotation.x = Math.PI / 2
      barrel.position.set(0, 0.2, 0.75)
      barrel.castShadow = true
      pitchPivot.add(barrel)

      const muzzle = new THREE.Object3D()
      muzzle.position.set(0, 0.2, 1.85)
      pitchPivot.add(muzzle)

      const loadedBall = new THREE.Mesh(new THREE.SphereGeometry(0.19, 14, 14), this.ballMaterial)
      loadedBall.position.set(0, 0.2, 0.62)
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
        const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.21, 12, 12), this.ballMaterial)
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
      this.cameraPitch = clamp(this.cameraPitch + dy * 0.004, 0.32, 1.1)
    })

    window.addEventListener('pointerup', () => {
      this.dragging = false
    })

    this.renderer.domElement.addEventListener('wheel', (event: WheelEvent) => {
      this.cameraDistance = clamp(this.cameraDistance + event.deltaY * 0.015, 18, 48)
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

    const tracked = ['KeyA', 'KeyD', 'KeyW', 'KeyS']
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
    const targetCastle = this.getCurrentPlayer()?.castle
    const desiredTarget = targetCastle?.origin ?? new THREE.Vector3()
    this.cameraTarget.lerp(desiredTarget, 1 - Math.pow(0.0001, delta))
    this.cameraShake = Math.max(0, this.cameraShake - delta * 1.8)

    const horizontal = Math.cos(this.cameraPitch) * this.cameraDistance
    const shakeOffset = new THREE.Vector3((Math.random() - 0.5) * this.cameraShake, Math.random() * this.cameraShake, (Math.random() - 0.5) * this.cameraShake)
    const desiredPosition = new THREE.Vector3(
      this.cameraTarget.x + Math.sin(this.cameraYaw) * horizontal,
      this.cameraTarget.y + Math.sin(this.cameraPitch) * this.cameraDistance + 7,
      this.cameraTarget.z + Math.cos(this.cameraYaw) * horizontal,
    ).add(shakeOffset)

    this.camera.position.lerp(desiredPosition, 1 - Math.pow(0.0001, delta))
    this.camera.lookAt(this.cameraTarget.x, this.cameraTarget.y + 4.5, this.cameraTarget.z)
  }

  private updateHumanControls(delta: number): void {
    const player = this.getCurrentPlayer()
    if (!player || !this.canHumanControl(player)) {
      return
    }
    const cannon = this.getSelectedCannon()
    if (!cannon) {
      return
    }

    if (this.keysDown.has('KeyA')) {
      cannon.yawOffset += 0.95 * delta
    }
    if (this.keysDown.has('KeyD')) {
      cannon.yawOffset -= 0.95 * delta
    }
    if (this.keysDown.has('KeyW')) {
      cannon.pitch += 0.65 * delta
    }
    if (this.keysDown.has('KeyS')) {
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

  private updateTurnState(now: number): void {
    if (this.phase === 'settling' && now >= this.settleUntil) {
      this.advanceTurn()
      if (this.shouldCommitLastAction()) {
        this.commitQueued = true
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

  private updateParticles(delta: number): void {
    this.particles = this.particles.filter((particle) => {
      particle.life -= delta
      particle.velocity.y -= particle.gravity * delta
      particle.mesh.position.addScaledVector(particle.velocity, delta)
      const lifeRatio = Math.max(0, particle.life / particle.maxLife)
      particle.mesh.scale.setScalar(lifeRatio)
      ;(particle.mesh.material as THREE.MeshStandardMaterial).opacity = lifeRatio
      if (particle.life <= 0) {
        this.scene.remove(particle.mesh)
        return false
      }
      return true
    })
  }

  private updateCastleHeights(): void {
    this.castles.forEach((castle) => {
      if (!castle.alive) {
        return
      }

      this.updateCastleHeight(castle)
      if (castle.supportHeight < CASTLE_MIN_HEIGHT) {
        castle.alive = false
        castle.player.alive = false
        this.dimCastle(castle)
        this.spawnParticleBurst(castle.origin.clone().add(new THREE.Vector3(0, 4, 0)), { count: 20, color: '#cfc9c1', scale: 0.22, life: 1.3, speed: 3, gravity: 2.2 })
        this.setMessage(`${castle.player.name} has been eliminated. Their castle dropped below the survival height.`)
      }
    })
  }

  private updateCastleHeight(castle: CastleState): void {
    const footprintHeights = new Map<string, number>()

    castle.stones.forEach((stone) => {
      const position = stone.body.translation()
      const local = new THREE.Vector3(position.x, position.y, position.z).sub(castle.origin).applyAxisAngle(WORLD_UP, -castle.rotationY)
      if (Math.abs(local.x) > 9 || Math.abs(local.z) > 9) {
        return
      }
      const key = `${Math.round(local.x / 1.2)}:${Math.round(local.z / 1.2)}`
      const topY = position.y + stone.height * 0.5
      const current = footprintHeights.get(key) ?? 0
      if (topY > current) {
        footprintHeights.set(key, topY)
      }
    })

    const heights = Array.from(footprintHeights.values()).sort((left, right) => right - left)
    const sampleSize = Math.max(6, Math.min(12, Math.ceil(heights.length * 0.35)))
    const sample = heights.slice(0, sampleSize)
    const average = sample.length ? sample.reduce((sum, value) => sum + value, 0) / sample.length : 0
    const coveragePenalty = heights.length < 10 ? (10 - heights.length) * 0.2 : 0
    castle.supportHeight = Math.max(0, average - coveragePenalty)
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
    const cannon = this.getSelectedCannon()
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
    const cannon = this.getSelectedCannon()
    if (cannon) {
      this.loadCannon(cannon)
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
    const cannon = this.getSelectedCannon()
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
    this.settleUntil = performance.now() + 4200
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
    const castle = this.getCurrentPlayer()?.castle
    if (castle && force) {
      this.cameraTarget.copy(castle.origin)
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
    for (let index = 0; index < options.count; index += 1) {
      const material = (options.color === '#edae49' ? this.sparkMaterial : this.smokeMaterial).clone()
      material.color = new THREE.Color(options.color)
      material.transparent = true
      const mesh = new THREE.Mesh(this.particleGeometry, material)
      mesh.position.copy(origin)
      const direction = options.align
        ? options.align.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.8, (Math.random() - 0.3) * 0.6, (Math.random() - 0.5) * 0.8)).normalize()
        : new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.9, Math.random() - 0.5).normalize()
      mesh.scale.setScalar(options.scale * (0.6 + Math.random() * 0.8))
      this.scene.add(mesh)
      this.particles.push({ mesh, velocity: direction.multiplyScalar(options.speed * (0.7 + Math.random() * 0.7)), gravity: options.gravity, life: options.life, maxLife: options.life })
    }
  }

  private getCurrentPlayer(): PlayerState | undefined {
    return this.players[this.currentPlayerIndex]
  }

  private getSelectedCannon(): CannonState | undefined {
    return this.getCurrentPlayer()?.castle?.cannons[this.selectedCannonIndex]
  }

  private updateHud(): void {
    const player = this.getCurrentPlayer()
    const cannon = this.getSelectedCannon()
    this.ui.hudPlayer.textContent = player ? `${player.name}${player.controller === 'ai' ? ' [AI]' : ''}` : 'No match started'
    this.ui.hudMode.textContent = this.phase === 'lobby' ? 'Lobby' : this.network.kind === 'online' ? `Online room ${this.network.session.roomCode}` : presetLabel(this.preset)
    this.ui.hudTurn.textContent = this.phase === 'lobby' ? '-' : `${this.turnNumber}`
    this.ui.hudCannon.textContent = cannon ? `#${cannon.id + 1} | yaw ${radToDeg(cannon.yawOffset).toFixed(0)}° | pitch ${radToDeg(cannon.pitch).toFixed(0)}°` : '-'
    this.ui.hudHeight.textContent = player?.castle ? `${player.castle.supportHeight.toFixed(1)}m / ${CASTLE_MIN_HEIGHT.toFixed(1)}m` : '-'
    this.ui.hudCharge.textContent = cannon ? `${Math.round(cannon.powder)}%` : '0%'
    this.ui.chargeFill.setAttribute('style', `width:${cannon ? cannon.powder : 0}%`)
    this.ui.hudAmmo.textContent = cannon ? `${cannon.ammoReserve} balls in stack${cannon.loaded ? ' + 1 loaded' : ''}` : '-'

    const activeHuman = Boolean(player && this.canHumanControl(player))
    this.ui.prevButton.disabled = !activeHuman
    this.ui.nextButton.disabled = !activeHuman
    this.ui.loadButton.disabled = !activeHuman
    this.ui.fireButton.disabled = !activeHuman
    this.ui.chargeButton.disabled = !activeHuman || !cannon?.loaded
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