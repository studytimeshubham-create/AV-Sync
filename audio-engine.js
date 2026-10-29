/**
 * AV-Sync // Acoustic Modem Engine
 * Industrial High-Reliability Data-Over-Sound Powered by Reed-Solomon Multi-Tone ECC
 * Created by Shubham
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
    this.activeSource = null;

    // ggwave instance
    this.ggwave = null;
    this.instance = null;
    this.isInitializing = false;

    // Profile & Speed settings
    this.profileType = 'audible'; // 'audible' | 'ultrasonic'
    this.speedType = 'fast';       // 'normal' | 'fast' | 'fastest' | 'dt'
    this.volume = 0.8;
    this.isLoopback = false;

    // Display metadata
    this.activeProfile = {
      name: 'Audible Chirp (ECC)',
      baseFreq: 1500,
      stepFreq: 80,
      syncA: 1300,
      description: '1.2 kHz - 3.2 kHz multi-tone with Reed-Solomon error correction'
    };

    // State
    this.isTransmitting = false;
    this.isListening = false;
    this.carrierLock = false;

    // Callbacks
    this.onStatusChange = null;
    this.onDataReceived = null;
    this.onTelemetryUpdate = null;
    this.onPreambleLocked = null;
  }

  async initAudioContext() {
    if (!this.audioCtx) {
      const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
      this.audioCtx = new AudioCtxClass();

      // Output bus
      this.masterGain = this.audioCtx.createGain();
      this.masterGain.gain.setValueAtTime(this.volume, this.audioCtx.currentTime);
      this.masterGain.connect(this.audioCtx.destination);

      // Loopback internal bridge
      this.loopbackGain = this.audioCtx.createGain();
      this.loopbackGain.gain.setValueAtTime(this.isLoopback ? 1.0 : 0.0, this.audioCtx.currentTime);

      // Analyser for 60fps Canvas spectrum display
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.08;

      // Silent sink prevents GC of scriptProcessor
      this.silentSink = this.audioCtx.createGain();
      this.silentSink.gain.setValueAtTime(0.0, this.audioCtx.currentTime);
      this.silentSink.connect(this.audioCtx.destination);

      this.loopbackGain.connect(this.analyser);
    }

    if (this.audioCtx.state === 'suspended') {
      await this.audioCtx.resume();
    }

    // Initialize ggwave WASM engine
    if (!this.ggwave && !this.isInitializing) {
      this.isInitializing = true;
      try {
        if (typeof window.ggwave_factory === 'function') {
          this.ggwave = await window.ggwave_factory();
          const parameters = this.ggwave.getDefaultParameters();
          parameters.sampleRateInp = this.audioCtx.sampleRate;
          parameters.sampleRateOut = this.audioCtx.sampleRate;
          parameters.sampleFormatInp = this.ggwave.SampleFormat.GGWAVE_SAMPLE_FORMAT_F32;
          parameters.sampleFormatOut = this.ggwave.SampleFormat.GGWAVE_SAMPLE_FORMAT_F32;
          this.instance = this.ggwave.init(parameters);
        }
      } catch (err) {
        console.error('Failed to initialize ggwave engine', err);
      } finally {
        this.isInitializing = false;
      }
    }

    return this.audioCtx;
  }

  getProtocolId() {
    if (!this.ggwave) return 1; // Default fallback ID

    const p = this.ggwave.ProtocolId;
    if (this.profileType === 'ultrasonic') {
      if (this.speedType === 'normal') return p.GGWAVE_PROTOCOL_ULTRASOUND_NORMAL;
      if (this.speedType === 'fastest') return p.GGWAVE_PROTOCOL_ULTRASOUND_FASTEST;
      return p.GGWAVE_PROTOCOL_ULTRASOUND_FAST;
    }

    if (this.speedType === 'dt') return p.GGWAVE_PROTOCOL_DT_FAST;
    if (this.speedType === 'normal') return p.GGWAVE_PROTOCOL_AUDIBLE_NORMAL;
    if (this.speedType === 'fastest') return p.GGWAVE_PROTOCOL_AUDIBLE_FASTEST;
    return p.GGWAVE_PROTOCOL_AUDIBLE_FAST;
  }

  setProfile(profileKey) {
    this.profileType = profileKey;
    if (profileKey === 'ultrasonic') {
      this.activeProfile = {
        name: 'Near-Ultrasound (Silent)',
        baseFreq: 17500,
        stepFreq: 90,
        syncA: 17200,
        description: '17.2 kHz - 19.8 kHz inaudible multi-carrier'
      };
    } else {
      this.activeProfile = {
        name: 'Audible Chirp (ECC)',
        baseFreq: 1500,
        stepFreq: 80,
        syncA: 1300,
        description: '1.2 kHz - 3.2 kHz robust acoustic multi-tone'
      };
    }
  }

  setSpeed(speedKey) {
    this.speedType = speedKey;
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
      this.startListening();
    }
  }

  encodePayload(text) {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(text || '');
    const byteCount = bytes.length;

    // Estimate transmission duration based on protocol
    const durationPerByte = this.speedType === 'normal' ? 0.14 : this.speedType === 'fastest' ? 0.05 : 0.09;
    const estSec = Math.max(0.6, 0.4 + byteCount * durationPerByte);

    return {
      byteCount,
      tones: new Array(Math.max(16, byteCount * 2 + 12)),
      totalDurationMs: Math.round(estSec * 1000)
    };
  }

  /**
   * Transmits the encoded audio payload using Web Audio API buffer playback.
   */
  async transmit(text, onProgress) {
    await this.initAudioContext();
    if (this.isTransmitting) {
      this.abortTransmission();
    }

    if (!this.ggwave || !this.instance) {
      console.warn('Engine not ready yet. Retrying initialization...');
      await this.initAudioContext();
    }

    this.isTransmitting = true;
    const protocolId = this.getProtocolId();
    const volInt = Math.max(5, Math.min(100, Math.round(this.volume * 50)));

    // Generate waveform through ggwave engine
    const waveformBytes = this.ggwave.encode(this.instance, text, protocolId, volInt);
    if (!waveformBytes || waveformBytes.length === 0) {
      this.isTransmitting = false;
      return null;
    }

    const floatSamples = new Float32Array(
      waveformBytes.buffer,
      waveformBytes.byteOffset,
      waveformBytes.length / 4
    );

    const sampleRate = this.audioCtx.sampleRate;
    const durationSec = floatSamples.length / sampleRate;

    if (this.onStatusChange) {
      this.onStatusChange({ state: 'TRANSMITTING', duration: durationSec * 1000 });
    }

    // Create and populate Web Audio buffer
    const audioBuffer = this.audioCtx.createBuffer(1, floatSamples.length, sampleRate);
    audioBuffer.getChannelData(0).set(floatSamples);

    const source = this.audioCtx.createBufferSource();
    source.buffer = audioBuffer;
    this.activeSource = source;

    source.connect(this.masterGain);
    if (this.isLoopback) {
      source.connect(this.loopbackGain);
    }

    const startTime = this.audioCtx.currentTime + 0.05;
    source.start(startTime);

    if (onProgress) {
      onProgress({
        currentIndex: 1,
        totalTones: floatSamples.length,
        currentFreq: this.activeProfile.baseFreq,
        label: `ECC FRAME [${floatSamples.length} samples]`
      });
    }

    return new Promise((resolve) => {
      source.onended = () => {
        this.isTransmitting = false;
        this.activeSource = null;
        if (this.onStatusChange) {
          this.onStatusChange({ state: 'IDLE' });
        }
        resolve({ byteCount: text.length, durationSec });
      };
    });
  }

  abortTransmission() {
    if (this.activeSource) {
      try {
        this.activeSource.stop();
        this.activeSource.disconnect();
      } catch (e) {}
      this.activeSource = null;
    }
    this.isTransmitting = false;
    if (this.onStatusChange) {
      this.onStatusChange({ state: 'IDLE' });
    }
  }

  async playTestTone(freq = 1500, durationMs = 400) {
    await this.initAudioContext();
    const osc = this.audioCtx.createOscillator();
    const g = this.audioCtx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, this.audioCtx.currentTime);

    g.gain.setValueAtTime(0.001, this.audioCtx.currentTime);
    g.gain.linearRampToValueAtTime(this.volume * 0.5, this.audioCtx.currentTime + 0.05);
    g.gain.linearRampToValueAtTime(0.001, this.audioCtx.currentTime + durationMs / 1000);

    osc.connect(g);
    g.connect(this.masterGain);
    if (this.isLoopback) g.connect(this.loopbackGain);

    osc.start();
    osc.stop(this.audioCtx.currentTime + durationMs / 1000);
  }

  /**
   * Receiver: Start microphone listening & synchronous stream processing
   */
  async startListening() {
    await this.initAudioContext();

    if (!this.scriptProcessor) {
      // 4096 samples provides optimal buffer stability
      this.scriptProcessor = this.audioCtx.createScriptProcessor(4096, 1, 1);
      this.scriptProcessor.onaudioprocess = (e) => this.handleAudioProcess(e);

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
        console.warn('Microphone permission denied. Switching to internal loopback.', err);
        this.setLoopback(true);
      }
    }

    this.isListening = true;
    this.carrierLock = false;

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
    this.carrierLock = false;
    if (this.onPreambleLocked) this.onPreambleLocked(false);
    if (this.onStatusChange) {
      this.onStatusChange({ state: 'STANDBY' });
    }
  }

  /**
   * Synchronous audio process callback (runs on Web Audio thread)
   */
  handleAudioProcess(e) {
    if (!this.isListening || !this.ggwave || !this.instance) return;

    const inputData = e.inputBuffer.getChannelData(0);

    // Compute RMS level and telemetry
    let sumSq = 0;
    for (let i = 0; i < inputData.length; i++) {
      sumSq += inputData[i] * inputData[i];
    }
    const rms = Math.sqrt(sumSq / inputData.length);
    const dbLevel = Math.round(20 * Math.log10(Math.max(1e-5, rms)));

    // Carrier presence heuristic
    const carrierActive = rms > 0.015;
    if (carrierActive !== this.carrierLock) {
      this.carrierLock = carrierActive;
      if (this.onPreambleLocked) this.onPreambleLocked(carrierActive);
    }

    if (this.onTelemetryUpdate && Math.random() < 0.25) {
      this.onTelemetryUpdate({
        peakFreq: this.carrierLock ? this.activeProfile.baseFreq : 0,
        signalDb: dbLevel,
        carrierLocked: this.carrierLock,
        rxState: this.carrierLock ? 'CARRIER_ACTIVE' : 'LISTENING'
      });
    }

    // Feed raw float samples to ggwave demodulator
    const inputBytes = new Int8Array(inputData.buffer, inputData.byteOffset, inputData.byteLength);
    const decoded = this.ggwave.decode(this.instance, inputBytes);

    if (decoded && decoded.length > 0) {
      try {
        const text = new TextDecoder('utf-8').decode(decoded);
        if (text && text.trim().length > 0) {
          if (this.onDataReceived) {
            this.onDataReceived({
              text,
              bytes: decoded,
              length: decoded.length,
              isValid: true,
              timestamp: new Date().toLocaleTimeString(),
              checksumHex: 'ECC PASS'
            });
          }
        }
      } catch (err) {
        console.error('Error decoding received payload', err);
      }
    }
  }
}

window.AVSyncAudioEngine = AVSyncAudioEngine;
