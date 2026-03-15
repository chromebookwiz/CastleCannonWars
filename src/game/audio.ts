export class BattleAudio {
  private context: AudioContext | null = null

  private ensureContext(): AudioContext | null {
    if (typeof window === 'undefined') {
      return null
    }

    if (!this.context) {
      const AudioCtor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!AudioCtor) {
        return null
      }
      this.context = new AudioCtor()
    }

    if (this.context.state === 'suspended') {
      void this.context.resume()
    }

    return this.context
  }

  unlock(): void {
    this.ensureContext()
  }

  playShot(intensity: number): void {
    const context = this.ensureContext()
    if (!context) {
      return
    }

    const now = context.currentTime
    const gain = context.createGain()
    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.exponentialRampToValueAtTime(0.32 + intensity * 0.18, now + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.35)
    gain.connect(context.destination)

    const oscillator = context.createOscillator()
    oscillator.type = 'triangle'
    oscillator.frequency.setValueAtTime(120 - intensity * 25, now)
    oscillator.frequency.exponentialRampToValueAtTime(42, now + 0.25)
    oscillator.connect(gain)
    oscillator.start(now)
    oscillator.stop(now + 0.35)

    const noiseBuffer = context.createBuffer(1, context.sampleRate * 0.22, context.sampleRate)
    const channel = noiseBuffer.getChannelData(0)
    for (let index = 0; index < channel.length; index += 1) {
      channel[index] = (Math.random() * 2 - 1) * (1 - index / channel.length)
    }

    const noise = context.createBufferSource()
    noise.buffer = noiseBuffer
    const filter = context.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.setValueAtTime(680, now)
    noise.connect(filter)
    filter.connect(gain)
    noise.start(now)
    noise.stop(now + 0.2)
  }

  playImpact(intensity: number): void {
    const context = this.ensureContext()
    if (!context) {
      return
    }

    const now = context.currentTime
    const gain = context.createGain()
    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.exponentialRampToValueAtTime(0.1 + intensity * 0.09, now + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18)
    gain.connect(context.destination)

    const oscillator = context.createOscillator()
    oscillator.type = 'square'
    oscillator.frequency.setValueAtTime(80 + intensity * 35, now)
    oscillator.frequency.exponentialRampToValueAtTime(35, now + 0.16)
    oscillator.connect(gain)
    oscillator.start(now)
    oscillator.stop(now + 0.18)
  }
}