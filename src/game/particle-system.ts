import * as THREE from 'three'

type ParticleSeed = {
  origin: THREE.Vector3
  direction: THREE.Vector3
  color: THREE.Color
  life: number
  speed: number
  gravity: number
}

export class ParticleSystem {
  private readonly scene: THREE.Scene
  private readonly capacity: number
  private readonly geometry: THREE.BufferGeometry
  private readonly material: THREE.PointsMaterial
  private readonly points: THREE.Points
  private readonly positions: Float32Array
  private readonly colors: Float32Array
  private readonly velocities: Float32Array
  private readonly gravities: Float32Array
  private readonly lifetimes: Float32Array
  private readonly maxLifetimes: Float32Array
  private readonly active: Uint8Array

  constructor(scene: THREE.Scene, capacity = 512) {
    this.scene = scene
    this.capacity = capacity
    this.positions = new Float32Array(capacity * 3)
    this.colors = new Float32Array(capacity * 3)
    this.velocities = new Float32Array(capacity * 3)
    this.gravities = new Float32Array(capacity)
    this.lifetimes = new Float32Array(capacity)
    this.maxLifetimes = new Float32Array(capacity)
    this.active = new Uint8Array(capacity)

    this.geometry = new THREE.BufferGeometry()
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3))
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 3))

    this.material = new THREE.PointsMaterial({
      size: 0.28,
      vertexColors: true,
      transparent: true,
      opacity: 0.88,
      depthWrite: false,
      sizeAttenuation: true,
    })

    this.points = new THREE.Points(this.geometry, this.material)
    this.points.frustumCulled = false
    this.scene.add(this.points)
  }

  clear(): void {
    this.active.fill(0)
    this.lifetimes.fill(0)
    this.geometry.attributes.position.needsUpdate = true
    this.geometry.attributes.color.needsUpdate = true
  }

  spawnBurst(seeds: ParticleSeed[]): void {
    seeds.forEach((seed) => {
      const index = this.findFreeIndex()
      if (index === -1) {
        return
      }

      this.active[index] = 1
      this.lifetimes[index] = seed.life
      this.maxLifetimes[index] = seed.life
      this.gravities[index] = seed.gravity

      const offset = index * 3
      this.positions[offset] = seed.origin.x
      this.positions[offset + 1] = seed.origin.y
      this.positions[offset + 2] = seed.origin.z

      this.velocities[offset] = seed.direction.x * seed.speed
      this.velocities[offset + 1] = seed.direction.y * seed.speed
      this.velocities[offset + 2] = seed.direction.z * seed.speed

      this.colors[offset] = seed.color.r
      this.colors[offset + 1] = seed.color.g
      this.colors[offset + 2] = seed.color.b
    })

    this.geometry.attributes.position.needsUpdate = true
    this.geometry.attributes.color.needsUpdate = true
  }

  update(delta: number): void {
    let needsUpdate = false

    for (let index = 0; index < this.capacity; index += 1) {
      if (!this.active[index]) {
        continue
      }

      this.lifetimes[index] -= delta
      const offset = index * 3
      this.velocities[offset + 1] -= this.gravities[index] * delta
      this.positions[offset] += this.velocities[offset] * delta
      this.positions[offset + 1] += this.velocities[offset + 1] * delta
      this.positions[offset + 2] += this.velocities[offset + 2] * delta

      const ratio = Math.max(0, this.lifetimes[index] / this.maxLifetimes[index])
      this.colors[offset] *= ratio < 0.9 ? 0.985 : 1
      this.colors[offset + 1] *= ratio < 0.9 ? 0.985 : 1
      this.colors[offset + 2] *= ratio < 0.9 ? 0.985 : 1

      if (this.lifetimes[index] <= 0) {
        this.active[index] = 0
        this.positions[offset] = 0
        this.positions[offset + 1] = -100
        this.positions[offset + 2] = 0
      }

      needsUpdate = true
    }

    if (needsUpdate) {
      this.geometry.attributes.position.needsUpdate = true
      this.geometry.attributes.color.needsUpdate = true
    }
  }

  private findFreeIndex(): number {
    for (let index = 0; index < this.capacity; index += 1) {
      if (!this.active[index]) {
        return index
      }
    }
    return -1
  }
}