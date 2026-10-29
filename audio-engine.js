/**
 * AV-Sync // Acoustic Modem Engine
 * Developed for AV-Sync Minimalist Data Transfer
 * Created by Shubham
 *
 * Implements MFSK (Multiple Frequency-Shift Keying) over Web Audio API.
 * Encodes binary/text data into discrete audio frequencies (Audible or Near-Ultrasound).
 * Decodes captured microphone/loopback audio using real-time FFT frequency bin tracking.
 */

class AVSyncAudioEngine {
  constructor() {
    this.audioCtx = null;
    this.analyser = null;
    this.micStream = null;
    this.micSource = null;
    this.loopbackGain = null;
    this.masterGain = null;

    // Profiles definition
    this.profiles = {
      audible: {
        name: 'Audible Chirp',
        baseFreq: 1650,
        stepFreq: 80, // 16 bins: 1650Hz to 2850Hz
        pilotFreqA: 1350,
        pilotFreqB: 1470,
        eofFreq: 2980,
        defaultDuration: 75, // ms per symbol
        description: '1.3 kHz - 3.0 kHz. Penetrates room noise, audible confirmation'
      },
      ultrasonic: {
        name: 'Near-Ultrasound',
        baseFreq: 18100,
        stepFreq: 90, // 16 bins: 18100Hz to 19450Hz
        pilotFreqA: 17300,
        pilotFreqB: 17700,
        eofFreq: 19800,
        defaultDuration: 85, // ms per symbol
        description: '17.3 kHz - 19.8 kHz. Inaudible to adult humans, silent transfer'
      }
    };

    this.activeProfile = this.profiles.audible;
    this.symbolDuration = 75; // ms
    this.volume = 0.8;
    this.isLoopback = false;

    // Transmitter State
    this.isTransmitting = false;
    this.activeOscillators = [];

    // Receiver State
    this.isListening = false;
    this.rxState = 'IDLE'; // IDLE, PILOT_A, PILOT_B, RECEIVING, COMPLETE
    this.rxBuffer = [];
    this.rxNibbleBuffer = [];
    this.lastSymbolTime = 0;
    this.carrierLock = false;
    this.onStatusChange = null;
    this.onDataReceived = null;
    this.onTelemetryUpdate = null;
    this.onPreambleLocked = null;

    // Internal loop frame
    this.listenInterval = null;
  }

  async initAudioContext() {
    if (!this.audioCtx) {
      const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
      this.audioCtx = new AudioCtxClass();
      
      this.masterGain = this.audioCtx.createGain();
      this.masterGain.gain.setValueAtTime(this.volume, this.audioCtx.currentTime);
      this.masterGain.connect(this.audioCtx.destination);

      this.loopbackGain = this.audioCtx.createGain();
      this.loopbackGain.gain.setValueAtTime(0, this.audioCtx.currentTime);

      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 4096; // ~10.7Hz resolution at 44.1kHz
      this.analyser.smoothingTimeConstant = 0.15;

      this.loopbackGain.connect(this.analyser);
    }

    if (this.audioCtx.state === 'suspended') {
      await this.audioCtx.resume();
    }
    return this.audioCtx;
  }

  setProfile(profileKey) {
    if (this.profiles[profileKey]) {
      this.activeProfile = this.profiles[profileKey];
      this.symbolDuration = this.activeProfile.defaultDuration;
    }
  }

  setSpeed(durationMs) {
    this.symbolDuration = Math.max(35, Math.min(200, durationMs));
  }

  setVolume(vol) {
    this.volume = Math.max(0, Math.min(1, vol));
    if (this.masterGain && this.audioCtx) {
      this.masterGain.gain.setValueAtTime(this.volume, this.audioCtx.currentTime);
    }
  }

  setLoopback(enable) {
    this.isLoopback = enable;
    if (this.loopbackGain && this.audioCtx) {
      this.loopbackGain.gain.setValueAtTime(enable ? 1.0 : 0.0, this.audioCtx.currentTime);
    }
  }

  /**
   * Encodes a string into an array of frequency-duration pairs.
   * Format:
   * 1. Pilot Tone A (160ms)
   * 2. Pilot Tone B (120ms)
   * 3. Length Byte (2 nibbles)
   * 4. Payload Bytes (2 nibbles each)
   * 5. Checksum Byte (2 nibbles)
   * 6. End-Of-Frame Tone (100ms)
   */
  encodePayload(text) {
    const encoder = new TextEncoder();
    const bytes = Array.from(encoder.encode(text));
    const length = bytes.length;
    
    // Simple 8-bit checksum: sum of bytes % 256
    const checksum = (bytes.reduce((acc, b) => acc + b, 0) + length) & 0xff;

    const fullBytes = [length, ...bytes, checksum];
    const tones = [];

    // Preamble tones
    tones.push({ freq: this.activeProfile.pilotFreqA, duration: 180, isControl: true, label: 'SYNC-A' });
    tones.push({ freq: this.activeProfile.pilotFreqB, duration: 120, isControl: true, label: 'SYNC-B' });

    // Data symbols: each byte split into High Nibble & Low Nibble (0..15)
    fullBytes.forEach((b) => {
      const highNibble = (b >> 4) & 0x0f;
      const lowNibble = b & 0x0f;

      const freqHigh = this.activeProfile.baseFreq + highNibble * this.activeProfile.stepFreq;
      const freqLow = this.activeProfile.baseFreq + lowNibble * this.activeProfile.stepFreq;

      tones.push({ freq: freqHigh, duration: this.symbolDuration, nibble: highNibble, isData: true });
      tones.push({ freq: freqLow, duration: this.symbolDuration, nibble: lowNibble, isData: true });
    });

    // End-of-frame tone
    tones.push({ freq: this.activeProfile.eofFreq, duration: 120, isControl: true, label: 'EOF' });

    return {
      tones,
      byteCount: length,
      totalDurationMs: tones.reduce((sum, t) => sum + t.duration, 0),
      rawBytes: fullBytes
    };
  }

  /**
   * Transmits the encoded tones using Web Audio oscillators.
   */
  async transmit(text, onProgress) {
    await this.initAudioContext();
    if (this.isTransmitting) {
      this.abortTransmission();
    }

    const transmission = this.encodePayload(text);
    this.isTransmitting = true;

    if (this.onStatusChange) {
      this.onStatusChange({ state: 'TRANSMITTING', duration: transmission.totalDurationMs });
    }

    let startTime = this.audioCtx.currentTime + 0.05; // small lead-in buffer

    transmission.tones.forEach((tone, index) => {
      const osc = this.audioCtx.createOscillator();
      const toneGain = this.audioCtx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(tone.freq, startTime);

      // Smooth attack/decay envelope to avoid acoustic clicks that pollute spectrum
      const attackTime = 0.005;
      const decayTime = 0.005;
      const toneDurationSec = tone.duration / 1000;

      toneGain.gain.setValueAtTime(0.0001, startTime);
      toneGain.gain.linearRampToValueAtTime(1.0, startTime + attackTime);
      toneGain.gain.setValueAtTime(1.0, startTime + toneDurationSec - decayTime);
      toneGain.gain.linearRampToValueAtTime(0.0001, startTime + toneDurationSec);

      osc.connect(toneGain);
      toneGain.connect(this.masterGain);

      // Also connect to loopback if active
      if (this.isLoopback) {
        toneGain.connect(this.loopbackGain);
      }

      osc.start(startTime);
      osc.stop(startTime + toneDurationSec);

      this.activeOscillators.push(osc);

      // Schedule progress notification
      setTimeout(() => {
        if (this.isTransmitting && onProgress) {
          onProgress({
            currentIndex: index,
            totalTones: transmission.tones.length,
            currentFreq: tone.freq,
            label: tone.label || `NIBBLE: 0x${tone.nibble.toString(16).toUpperCase()}`
          });
        }
      }, (startTime - this.audioCtx.currentTime) * 1000);

      startTime += toneDurationSec;
    });

    // Schedule completion
    const totalWait = (startTime - this.audioCtx.currentTime) * 1000 + 50;
    return new Promise((resolve) => {
      setTimeout(() => {
        this.isTransmitting = false;
        this.activeOscillators = [];
        if (this.onStatusChange) {
          this.onStatusChange({ state: 'IDLE' });
        }
        resolve(transmission);
      }, totalWait);
    });
  }

  abortTransmission() {
    this.activeOscillators.forEach((osc) => {
      try {
        osc.stop();
        osc.disconnect();
      } catch (e) {}
    });
    this.activeOscillators = [];
    this.isTransmitting = false;
    if (this.onStatusChange) {
      this.onStatusChange({ state: 'IDLE' });
    }
  }

  /**
   * Diagnostic: play a single pure sine tone
   */
  async playTestTone(freq = 1800, durationMs = 400) {
    await this.initAudioContext();
    const osc = this.audioCtx.createOscillator();
    const g = this.audioCtx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, this.audioCtx.currentTime);

    g.gain.setValueAtTime(0.001, this.audioCtx.currentTime);
    g.gain.linearRampToValueAtTime(this.volume, this.audioCtx.currentTime + 0.05);
    g.gain.linearRampToValueAtTime(0.001, this.audioCtx.currentTime + durationMs / 1000);

    osc.connect(g);
    g.connect(this.masterGain);
    if (this.isLoopback) g.connect(this.loopbackGain);

    osc.start();
    osc.stop(this.audioCtx.currentTime + durationMs / 1000);
  }

  /**
   * Receiver: Start microphone listening and real-time FFT processing
   */
  async startListening() {
    await this.initAudioContext();

    if (!this.micStream && !this.isLoopback) {
      try {
        this.micStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false
          }
        });
        this.micSource = this.audioCtx.createMediaStreamSource(this.micStream);
        this.micSource.connect(this.analyser);
      } catch (err) {
        console.warn('Microphone access denied or unavailable. Fallback to loopback mode.', err);
        this.setLoopback(true);
      }
    }

    this.isListening = true;
    this.rxState = 'IDLE';
    this.rxNibbleBuffer = [];
    this.rxBuffer = [];
    this.carrierLock = false;

    this.runReceiverLoop();

    if (this.onStatusChange) {
      this.onStatusChange({ state: 'LISTENING' });
    }
  }

  stopListening() {
    this.isListening = false;
    if (this.listenInterval) {
      cancelAnimationFrame(this.listenInterval);
      this.listenInterval = null;
    }
    if (this.micStream) {
      this.micStream.getTracks().forEach((track) => track.stop());
      this.micStream = null;
    }
    if (this.micSource) {
      try {
        this.micSource.disconnect();
      } catch (e) {}
      this.micSource = null;
    }
    this.carrierLock = false;
    if (this.onStatusChange) {
      this.onStatusChange({ state: 'STANDBY' });
    }
  }

  /**
   * Real-time Demodulator loop using AnalyserNode FFT data.
   */
  runReceiverLoop() {
    const bufferLength = this.analyser.frequencyBinCount;
    const dataArray = new Float32Array(bufferLength);
    const sampleRate = this.audioCtx.sampleRate;
    const binResolution = sampleRate / this.analyser.fftSize;

    // Helper: calculate energy at a specific frequency
    const getFrequencyEnergy = (targetFreq) => {
      const centerBin = Math.round(targetFreq / binResolution);
      let maxEnergy = -150;
      // Check 3 bins around center
      for (let b = Math.max(0, centerBin - 1); b <= Math.min(bufferLength - 1, centerBin + 1); b++) {
        if (dataArray[b] > maxEnergy) {
          maxEnergy = dataArray[b];
        }
      }
      return maxEnergy;
    };

    // Helper: find the dominant nibble (0..15)
    const detectNibble = () => {
      let bestNibble = -1;
      let highestPower = -120;
      for (let n = 0; n < 16; n++) {
        const f = this.activeProfile.baseFreq + n * this.activeProfile.stepFreq;
        const pwr = getFrequencyEnergy(f);
        if (pwr > highestPower) {
          highestPower = pwr;
          bestNibble = n;
        }
      }
      return { nibble: bestNibble, power: highestPower };
    };

    let pilotATicks = 0;
    let pilotBTicks = 0;
    let lastSampleTime = 0;
    let expectedLength = null;
    let payloadBytes = [];
    let receivedChecksum = null;

    const processAudioFrame = (timestamp) => {
      if (!this.isListening) return;

      this.analyser.getFloatFrequencyData(dataArray);

      // Measure ambient noise floor around target band
      const profile = this.activeProfile;
      const syncAPower = getFrequencyEnergy(profile.pilotFreqA);
      const syncBPower = getFrequencyEnergy(profile.pilotFreqB);
      const eofPower = getFrequencyEnergy(profile.eofFreq);

      // Dynamic SNR threshold: requires signal to be at least -68 dBFS and higher than background
      const DETECTION_THRESHOLD = -65;

      // Report telemetry
      if (this.onTelemetryUpdate && timestamp - lastSampleTime > 80) {
        let maxVal = -150;
        let peakFreq = 0;
        for (let i = 10; i < bufferLength; i++) {
          if (dataArray[i] > maxVal) {
            maxVal = dataArray[i];
            peakFreq = Math.round(i * binResolution);
          }
        }
        this.onTelemetryUpdate({
          peakFreq,
          signalDb: Math.round(maxVal),
          carrierLocked: this.carrierLock,
          rxState: this.rxState
        });
      }

      // STATE MACHINE
      if (this.rxState === 'IDLE') {
        if (syncAPower > DETECTION_THRESHOLD && syncAPower > syncBPower + 8) {
          pilotATicks++;
          if (pilotATicks >= 3) {
            this.rxState = 'PILOT_A';
            pilotATicks = 0;
          }
        } else {
          pilotATicks = Math.max(0, pilotATicks - 1);
        }
      } else if (this.rxState === 'PILOT_A') {
        if (syncBPower > DETECTION_THRESHOLD && syncBPower > syncAPower + 8) {
          pilotBTicks++;
          if (pilotBTicks >= 2) {
            this.rxState = 'RECEIVING';
            this.carrierLock = true;
            if (this.onPreambleLocked) this.onPreambleLocked(true);
            pilotBTicks = 0;
            this.rxNibbleBuffer = [];
            payloadBytes = [];
            expectedLength = null;
            receivedChecksum = null;
            lastSampleTime = performance.now();
          }
        }
      } else if (this.rxState === 'RECEIVING') {
        // Sample symbols at fixed time intervals matching symbolDuration
        const now = performance.now();
        const elapsed = now - lastSampleTime;

        if (elapsed >= this.symbolDuration * 0.95) {
          lastSampleTime = now;

          // Check if EOF tone is triggered
          if (eofPower > DETECTION_THRESHOLD && eofPower > getFrequencyEnergy(profile.baseFreq)) {
            this.finalizePacket(payloadBytes, expectedLength, receivedChecksum);
            this.resetReceiverState();
          } else {
            const detected = detectNibble();
            if (detected.nibble !== -1 && detected.power > DETECTION_THRESHOLD) {
              this.rxNibbleBuffer.push(detected.nibble);

              // Every 2 nibbles form a full 8-bit byte
              if (this.rxNibbleBuffer.length === 2) {
                const byteVal = (this.rxNibbleBuffer[0] << 4) | this.rxNibbleBuffer[1];
                this.rxNibbleBuffer = [];

                if (expectedLength === null) {
                  expectedLength = byteVal;
                } else if (payloadBytes.length < expectedLength) {
                  payloadBytes.push(byteVal);
                } else if (receivedChecksum === null) {
                  receivedChecksum = byteVal;
                  // Packet payload complete!
                  this.finalizePacket(payloadBytes, expectedLength, receivedChecksum);
                  this.resetReceiverState();
                }
              }
            }
          }
        }
      }

      this.listenInterval = requestAnimationFrame(processAudioFrame);
    };

    this.listenInterval = requestAnimationFrame(processAudioFrame);
  }

  finalizePacket(bytes, expectedLength, checksum) {
    try {
      const calculatedChecksum = (bytes.reduce((acc, b) => acc + b, 0) + expectedLength) & 0xff;
      const isValid = calculatedChecksum === checksum;

      const decoder = new TextDecoder('utf-8', { fatal: false });
      const text = decoder.decode(new Uint8Array(bytes));

      if (this.onDataReceived) {
        this.onDataReceived({
          text,
          bytes,
          length: bytes.length,
          isValid,
          timestamp: new Date().toLocaleTimeString(),
          checksumHex: `0x${(checksum || 0).toString(16).padStart(2, '0').toUpperCase()}`
        });
      }
    } catch (e) {
      console.error('Packet decode error', e);
    }
  }

  resetReceiverState() {
    this.rxState = 'IDLE';
    this.carrierLock = false;
    this.rxNibbleBuffer = [];
    if (this.onPreambleLocked) this.onPreambleLocked(false);
  }
}

window.AVSyncAudioEngine = AVSyncAudioEngine;
