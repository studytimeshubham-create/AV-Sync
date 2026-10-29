/**
 * AV-Sync // Acoustic Modem Engine
 * High-Reliability Grid-Synchronized MFSK Acoustic Data Link
 * Created by Shubham
 *
 * Transmits UTF-8 data via Frequency-Shift Keying with precision preamble framing.
 * Demodulates in real time via continuous PCM stream processing & Goertzel tone filters.
 */

class AVSyncAudioEngine {
  constructor() {
    this.audioCtx = null;
    this.analyser = null;
    this.micStream = null;
    this.micSource = null;
    this.scriptProcessor = null;
    this.silentSink = null;
    this.loopbackGain = null;
    this.masterGain = null;

    // Profiles definition
    this.profiles = {
      audible: {
        name: 'Audible Chirp',
        syncA: 1200,      // 180ms
        syncB: 1450,      // 180ms
        syncPip: 1700,    // 80ms delimiter
        guardMs: 40,      // 40ms silence before data
        baseFreq: 1880,
        stepFreq: 70,     // 16 bins: 1880 to 2930 Hz
        defaultDuration: 75, // ms per symbol
        description: '1.2 kHz - 3.0 kHz. Robust acoustic chirps, punches through room noise'
      },
      ultrasonic: {
        name: 'Near-Ultrasound',
        syncA: 17200,     // 180ms
        syncB: 17600,     // 180ms
        syncPip: 18000,   // 80ms delimiter
        guardMs: 40,      // 40ms silence before data
        baseFreq: 18250,
        stepFreq: 90,     // 16 bins: 18250 to 19600 Hz
        defaultDuration: 85, // ms per symbol
        description: '17.2 kHz - 19.8 kHz. Inaudible to adult humans, silent transfer'
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
    this.rxState = 'SEARCH_SYNC_A';
    this.carrierLock = false;

    // Callbacks
    this.onStatusChange = null;
    this.onDataReceived = null;
    this.onTelemetryUpdate = null;
    this.onPreambleLocked = null;

    // Rolling PCM buffer for receiver demodulation
    this.pcmBuffer = new Float32Array(44100 * 4); // 4 seconds rolling buffer
    this.pcmWriteIndex = 0;
    this.totalSamplesProcessed = 0;
  }

  async initAudioContext() {
    if (!this.audioCtx) {
      const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
      this.audioCtx = new AudioCtxClass();

      // Master output volume
      this.masterGain = this.audioCtx.createGain();
      this.masterGain.gain.setValueAtTime(this.volume, this.audioCtx.currentTime);
      this.masterGain.connect(this.audioCtx.destination);

      // Loopback internal bus
      this.loopbackGain = this.audioCtx.createGain();
      this.loopbackGain.gain.setValueAtTime(this.isLoopback ? 1.0 : 0.0, this.audioCtx.currentTime);

      // Analyser for 60fps Canvas spectrum display
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.05;

      // Silent sink so ScriptProcessor doesn't get garbage-collected by the browser
      this.silentSink = this.audioCtx.createGain();
      this.silentSink.gain.setValueAtTime(0.0, this.audioCtx.currentTime);
      this.silentSink.connect(this.audioCtx.destination);

      // Direct loopback routing
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
      this.resetReceiver();
    }
  }

  setSpeed(durationMs) {
    this.symbolDuration = Math.max(40, Math.min(150, durationMs));
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
    if (enable && !this.isListening) {
      // Auto-initialize listening pipe for seamless loopback test
      this.startListening();
    }
  }

  /**
   * Encodes a string into an array of frequency-duration pairs.
   */
  encodePayload(text) {
    const encoder = new TextEncoder();
    const bytes = Array.from(encoder.encode(text));
    const length = bytes.length;

    // 8-bit checksum: sum of bytes % 256
    const checksum = (bytes.reduce((acc, b) => acc + b, 0) + length) & 0xff;
    const fullBytes = [length, ...bytes, checksum];
    const tones = [];

    // Preamble tones
    tones.push({ freq: this.activeProfile.syncA, duration: 180, isControl: true, label: 'SYNC-A' });
    tones.push({ freq: this.activeProfile.syncB, duration: 180, isControl: true, label: 'SYNC-B' });
    tones.push({ freq: this.activeProfile.syncPip, duration: 80, isControl: true, label: 'SYNC-PIP' });
    tones.push({ freq: 0, duration: this.activeProfile.guardMs, isControl: true, label: 'GUARD' }); // 40ms silence

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
    tones.push({ freq: this.activeProfile.syncPip, duration: 80, isControl: true, label: 'END-PIP' });

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

    let startTime = this.audioCtx.currentTime + 0.05; // 50ms lead-in buffer

    transmission.tones.forEach((tone, index) => {
      const toneDurationSec = tone.duration / 1000;

      if (tone.freq > 0) {
        const osc = this.audioCtx.createOscillator();
        const toneGain = this.audioCtx.createGain();

        osc.type = 'sine';
        osc.frequency.setValueAtTime(tone.freq, startTime);

        // Raised-cosine / linear ramp to prevent spectral clicking
        const attackTime = Math.min(0.005, toneDurationSec / 4);
        toneGain.gain.setValueAtTime(0.0001, startTime);
        toneGain.gain.linearRampToValueAtTime(1.0, startTime + attackTime);
        toneGain.gain.setValueAtTime(1.0, startTime + toneDurationSec - attackTime);
        toneGain.gain.linearRampToValueAtTime(0.0001, startTime + toneDurationSec);

        osc.connect(toneGain);
        toneGain.connect(this.masterGain);

        if (this.isLoopback) {
          toneGain.connect(this.loopbackGain);
        }

        osc.start(startTime);
        osc.stop(startTime + toneDurationSec);
        this.activeOscillators.push(osc);
      }

      // Schedule UI progress notification
      setTimeout(() => {
        if (this.isTransmitting && onProgress) {
          onProgress({
            currentIndex: index,
            totalTones: transmission.tones.length,
            currentFreq: tone.freq,
            label: tone.label || `0x${tone.nibble.toString(16).toUpperCase()}`
          });
        }
      }, (startTime - this.audioCtx.currentTime) * 1000);

      startTime += toneDurationSec;
    });

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
  async playTestTone(freq = 1880, durationMs = 400) {
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
   * Receiver: Start microphone listening & synchronous PCM demodulation pipeline
   */
  async startListening() {
    await this.initAudioContext();

    if (!this.scriptProcessor) {
      // 2048 samples = ~46ms per processing slice
      this.scriptProcessor = this.audioCtx.createScriptProcessor(2048, 1, 1);
      this.scriptProcessor.onaudioprocess = (e) => this.handleAudioProcess(e);

      // Connect loopback to scriptProcessor
      this.loopbackGain.connect(this.scriptProcessor);
      this.scriptProcessor.connect(this.silentSink);
    }

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
        this.micSource.connect(this.scriptProcessor);
      } catch (err) {
        console.warn('Microphone unavailable or blocked. Switching to internal loopback mode.', err);
        this.setLoopback(true);
      }
    }

    this.isListening = true;
    this.resetReceiver();

    if (this.onStatusChange) {
      this.onStatusChange({ state: 'LISTENING' });
    }
  }

  stopListening() {
    this.isListening = false;
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
    this.resetReceiver();
    if (this.onStatusChange) {
      this.onStatusChange({ state: 'STANDBY' });
    }
  }

  resetReceiver() {
    this.rxState = 'SEARCH_SYNC_A';
    this.carrierLock = false;
    this.syncACount = 0;
    this.syncBCount = 0;
    this.pipDetected = false;
    this.t0Sample = 0;
    this.currentSymbolIndex = 0;
    this.decodedNibbles = [];
    this.expectedTotalNibbles = null;
    this.expectedPayloadLength = null;
    if (this.onPreambleLocked) this.onPreambleLocked(false);
  }

  /**
   * Optimized Goertzel tone energy measurement over an arbitrary PCM subarray.
   */
  measureToneEnergy(samples, targetFreq) {
    const N = samples.length;
    if (N === 0) return 0;
    const sampleRate = this.audioCtx ? this.audioCtx.sampleRate : 44100;
    const k = Math.round((targetFreq / sampleRate) * N);
    const omega = (2 * Math.PI * k) / N;
    const coeff = 2 * Math.cos(omega);
    let q0 = 0, q1 = 0, q2 = 0;

    for (let i = 0; i < N; i++) {
      q0 = coeff * q1 - q2 + samples[i];
      q2 = q1;
      q1 = q0;
    }
    return q1 * q1 + q2 * q2 - coeff * q1 * q2;
  }

  /**
   * Synchronous Audio Processing loop (triggered every 2048 PCM samples)
   */
  handleAudioProcess(e) {
    if (!this.isListening) return;

    const inputData = e.inputBuffer.getChannelData(0);
    const sampleRate = this.audioCtx.sampleRate;
    const bufLen = this.pcmBuffer.length;

    // Append to circular PCM buffer
    for (let i = 0; i < inputData.length; i++) {
      this.pcmBuffer[(this.pcmWriteIndex + i) % bufLen] = inputData[i];
    }
    const chunkStartGlobal = this.totalSamplesProcessed;
    this.pcmWriteIndex = (this.pcmWriteIndex + inputData.length) % bufLen;
    this.totalSamplesProcessed += inputData.length;

    // Helper: read slice of absolute sample range [startSample, endSample]
    const getSlice = (startSample, endSample) => {
      const len = endSample - startSample;
      const slice = new Float32Array(len);
      for (let s = 0; s < len; s++) {
        const absIdx = startSample + s;
        const circIdx = ((absIdx % bufLen) + bufLen) % bufLen;
        slice[s] = this.pcmBuffer[circIdx];
      }
      return slice;
    };

    // Calculate background noise floor and telemetry
    const inspectWindow = Math.min(inputData.length, 1024);
    const inspectSlice = inputData.subarray(0, inspectWindow);
    const profile = this.activeProfile;

    const pA = this.measureToneEnergy(inspectSlice, profile.syncA);
    const pB = this.measureToneEnergy(inspectSlice, profile.syncB);
    const pPip = this.measureToneEnergy(inspectSlice, profile.syncPip);

    // Dynamic threshold based on input RMS
    let sumSq = 0;
    for (let i = 0; i < inspectSlice.length; i++) sumSq += inspectSlice[i] * inspectSlice[i];
    const rms = Math.sqrt(sumSq / inspectSlice.length);
    const dbLevel = Math.round(20 * Math.log10(Math.max(1e-5, rms)));

    // Emit live telemetry for UI
    if (this.onTelemetryUpdate && Math.random() < 0.3) {
      this.onTelemetryUpdate({
        peakFreq: pPip > pA && pPip > pB ? profile.syncPip : pB > pA ? profile.syncB : profile.syncA,
        signalDb: dbLevel,
        carrierLocked: this.carrierLock,
        rxState: this.rxState
      });
    }

    const MIN_ENERGY = 2.0;

    // RECEIVER STATE MACHINE
    if (this.rxState === 'SEARCH_SYNC_A') {
      if (pA > MIN_ENERGY && pA > pB * 2.5) {
        this.syncACount = (this.syncACount || 0) + 1;
        if (this.syncACount >= 2) {
          this.rxState = 'SEARCH_SYNC_B';
          this.syncACount = 0;
        }
      } else {
        this.syncACount = Math.max(0, (this.syncACount || 0) - 1);
      }
    } else if (this.rxState === 'SEARCH_SYNC_B') {
      if (pB > MIN_ENERGY && pB > pA * 2.5) {
        this.syncBCount = (this.syncBCount || 0) + 1;
        if (this.syncBCount >= 2) {
          this.rxState = 'SEARCH_SYNC_PIP';
          this.syncBCount = 0;
          this.pipDetected = false;
        }
      }
    } else if (this.rxState === 'SEARCH_SYNC_PIP') {
      if (pPip > MIN_ENERGY && pPip > pB * 2.0) {
        this.pipDetected = true;
      } else if (this.pipDetected && pPip < MIN_ENERGY * 0.8) {
        // Pip transition ended!
        const guardSamples = Math.round((profile.guardMs / 1000) * sampleRate);
        this.t0Sample = this.totalSamplesProcessed + guardSamples;
        this.rxState = 'RECEIVING';
        this.carrierLock = true;
        this.currentSymbolIndex = 0;
        this.decodedNibbles = [];
        this.expectedTotalNibbles = null;
        this.expectedPayloadLength = null;

        if (this.onPreambleLocked) this.onPreambleLocked(true);
      }
    } else if (this.rxState === 'RECEIVING') {
      const symSamples = Math.round((this.symbolDuration / 1000) * sampleRate);
      const halfWindow = Math.round(0.015 * sampleRate); // 30ms total evaluation window centered on symbol

      // Process all symbols whose time window has fully arrived
      while (true) {
        const centerSample = this.t0Sample + Math.round((this.currentSymbolIndex + 0.5) * symSamples);
        const windowEnd = centerSample + halfWindow;

        // Has this symbol window passed in real time?
        if (this.totalSamplesProcessed < windowEnd) {
          break; // Wait for more audio samples
        }

        const symbolSlice = getSlice(centerSample - halfWindow, centerSample + halfWindow);
        const endPipEnergy = this.measureToneEnergy(symbolSlice, profile.syncPip);

        // Find dominant nibble among 16 frequency bins
        let maxEnergy = 0;
        let bestNibble = -1;

        for (let n = 0; n < 16; n++) {
          const freq = profile.baseFreq + n * profile.stepFreq;
          const energy = this.measureToneEnergy(symbolSlice, freq);
          if (energy > maxEnergy) {
            maxEnergy = energy;
            bestNibble = n;
          }
        }

        // Check if EOF tone or premature termination
        if (endPipEnergy > maxEnergy * 2.5 && endPipEnergy > MIN_ENERGY && this.decodedNibbles.length >= 4) {
          this.finalizeReception();
          this.resetReceiver();
          break;
        }

        if (bestNibble !== -1) {
          this.decodedNibbles.push(bestNibble);
        }

        // After first 2 nibbles, we know the exact expected packet length
        if (this.decodedNibbles.length === 2 && this.expectedPayloadLength === null) {
          this.expectedPayloadLength = (this.decodedNibbles[0] << 4) | this.decodedNibbles[1];
          // Total nibbles: (1 length byte + expectedPayloadLength bytes + 1 checksum byte) * 2
          this.expectedTotalNibbles = (1 + this.expectedPayloadLength + 1) * 2;
        }

        this.currentSymbolIndex++;

        // Have we received all expected nibbles?
        if (this.expectedTotalNibbles !== null && this.decodedNibbles.length >= this.expectedTotalNibbles) {
          this.finalizeReception();
          this.resetReceiver();
          break;
        }

        // Safety timeout: prevent runaway decoding if packet length byte was heavily corrupted
        if (this.currentSymbolIndex > 256) {
          this.resetReceiver();
          break;
        }
      }
    }
  }

  finalizeReception() {
    const nibbles = this.decodedNibbles;
    const bytes = [];
    for (let i = 0; i + 1 < nibbles.length; i += 2) {
      bytes.push((nibbles[i] << 4) | nibbles[i + 1]);
    }

    if (bytes.length < 2) return;

    const length = bytes[0];
    const payload = bytes.slice(1, 1 + length);
    const checksum = bytes[1 + length];

    const calculatedChecksum = (payload.reduce((acc, b) => acc + b, 0) + length) & 0xff;
    const isValid = calculatedChecksum === checksum;

    const decoder = new TextDecoder('utf-8', { fatal: false });
    const text = decoder.decode(new Uint8Array(payload));

    if (this.onDataReceived) {
      this.onDataReceived({
        text,
        bytes: payload,
        length: payload.length,
        isValid,
        timestamp: new Date().toLocaleTimeString(),
        checksumHex: `0x${(checksum || 0).toString(16).padStart(2, '0').toUpperCase()}`
      });
    }
  }
}

window.AVSyncAudioEngine = AVSyncAudioEngine;
