/**
 * AV-Sync // Acoustic Telemetry Visualizer
 * Real-time 60 FPS HTML5 Canvas Audio Spectrogram, Waterfall & FFT Analyzer
 * Created by Shubham
 */

class AVSyncVisualizer {
  constructor(canvasElement, audioEngine) {
    this.canvas = canvasElement;
    this.ctx = this.canvas.getContext('2d');
    this.engine = audioEngine;
    this.animationId = null;

    // Waterfall buffer canvas
    this.waterfallCanvas = document.createElement('canvas');
    this.waterfallCtx = this.waterfallCanvas.getContext('2d');

    this.resizeCanvas();
    window.addEventListener('resize', () => this.resizeCanvas());

    this.mode = 'combined'; // 'combined' | 'waterfall' | 'spectrum'
    this.colorScheme = 'amber-phosphor'; // 'amber-phosphor' | 'cyber-green' | 'monochrome'
  }

  resizeCanvas() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.width = rect.width;
    this.height = rect.height;

    this.canvas.width = Math.floor(rect.width * dpr);
    this.canvas.height = Math.floor(rect.height * dpr);
    this.ctx.scale(dpr, dpr);

    if (this.waterfallCanvas.width !== this.canvas.width || this.waterfallCanvas.height !== this.canvas.height) {
      this.waterfallCanvas.width = this.canvas.width;
      this.waterfallCanvas.height = this.canvas.height;
      this.waterfallCtx.fillStyle = '#0a0c0e';
      this.waterfallCtx.fillRect(0, 0, this.waterfallCanvas.width, this.waterfallCanvas.height);
    }
  }

  start() {
    if (this.animationId) return;
    const render = () => {
      this.draw();
      this.animationId = requestAnimationFrame(render);
    };
    this.animationId = requestAnimationFrame(render);
  }

  stop() {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
  }

  draw() {
    const width = this.width;
    const height = this.height;
    const ctx = this.ctx;

    // Clear background with deep instrument obsidian
    ctx.fillStyle = '#0c0e12';
    ctx.fillRect(0, 0, width, height);

    // Draw grid lines
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
    ctx.lineWidth = 1;
    const gridCols = 8;
    for (let i = 1; i < gridCols; i++) {
      const x = (width / gridCols) * i;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
    const gridRows = 4;
    for (let j = 1; j < gridRows; j++) {
      const y = (height / gridRows) * j;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    if (!this.engine.analyser) {
      // Standby state: Idle oscilloscope line
      ctx.strokeStyle = 'rgba(245, 158, 11, 0.3)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(0, height / 2);
      for (let x = 0; x < width; x += 4) {
        const y = height / 2 + Math.sin(x * 0.02 + performance.now() * 0.002) * 2;
        ctx.lineTo(x, y);
      }
      ctx.stroke();

      ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
      ctx.font = '11px "JetBrains Mono", Consolas, monospace';
      ctx.fillText('AUDIO BUS STANDBY // ENGINE INACTIVE', 16, height / 2 - 12);
      return;
    }

    const bufferLength = this.engine.analyser.frequencyBinCount;
    const freqData = new Uint8Array(bufferLength);
    this.engine.analyser.getByteFrequencyData(freqData);

    const timeData = new Uint8Array(bufferLength);
    this.engine.analyser.getByteTimeDomainData(timeData);

    const sampleRate = this.engine.audioCtx.sampleRate;
    const nyquist = sampleRate / 2;

    // Draw active frequency highlight band for current profile
    const profile = this.engine.activeProfile;
    const startX = (profile.pilotFreqA / nyquist) * width;
    const endX = ((profile.baseFreq + 16 * profile.stepFreq) / nyquist) * width;

    ctx.fillStyle = this.engine.isTransmitting
      ? 'rgba(245, 158, 11, 0.12)'
      : this.engine.carrierLock
      ? 'rgba(16, 185, 129, 0.15)'
      : 'rgba(255, 255, 255, 0.03)';
    ctx.fillRect(startX, 0, Math.max(12, endX - startX), height);

    // Band label
    ctx.fillStyle = this.engine.isTransmitting ? '#f59e0b' : this.engine.carrierLock ? '#10b981' : '#64748b';
    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.fillText(
      `BAND [${Math.round(profile.pilotFreqA)}Hz - ${Math.round(profile.baseFreq + 16 * profile.stepFreq)}Hz]`,
      Math.max(10, Math.min(width - 150, startX)),
      16
    );

    // Draw FFT Spectrum bars / path
    const spectrumHeight = height * 0.7;
    ctx.beginPath();
    ctx.moveTo(0, height);

    for (let i = 0; i < bufferLength; i++) {
      const freq = (i / bufferLength) * nyquist;
      const x = (freq / nyquist) * width;
      const value = freqData[i] / 255;
      const y = height - value * spectrumHeight;

      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }

    ctx.lineTo(width, height);
    ctx.closePath();

    // Gradient fill
    const grad = ctx.createLinearGradient(0, height - spectrumHeight, 0, height);
    if (this.engine.carrierLock) {
      grad.addColorStop(0, 'rgba(16, 185, 129, 0.7)');
      grad.addColorStop(0.6, 'rgba(16, 185, 129, 0.15)');
      grad.addColorStop(1, 'rgba(16, 185, 129, 0.0)');
      ctx.strokeStyle = '#10b981';
    } else if (this.engine.isTransmitting) {
      grad.addColorStop(0, 'rgba(245, 158, 11, 0.8)');
      grad.addColorStop(0.6, 'rgba(245, 158, 11, 0.2)');
      grad.addColorStop(1, 'rgba(245, 158, 11, 0.0)');
      ctx.strokeStyle = '#f59e0b';
    } else {
      grad.addColorStop(0, 'rgba(56, 189, 248, 0.5)');
      grad.addColorStop(0.6, 'rgba(56, 189, 248, 0.1)');
      grad.addColorStop(1, 'rgba(56, 189, 248, 0.0)');
      ctx.strokeStyle = '#38bdf8';
    }

    ctx.fillStyle = grad;
    ctx.fill();
    ctx.lineWidth = 1.2;
    ctx.stroke();

    // Draw Oscilloscope overlay at the top 30%
    ctx.beginPath();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
    const sliceWidth = width / bufferLength;
    let ox = 0;
    const oscYCenter = height * 0.22;
    const oscAmp = height * 0.15;

    for (let i = 0; i < bufferLength; i += 4) {
      const v = (timeData[i] - 128) / 128;
      const oy = oscYCenter + v * oscAmp;
      if (i === 0) ctx.moveTo(ox, oy);
      else ctx.lineTo(ox, oy);
      ox += sliceWidth * 4;
    }
    ctx.stroke();

    // Frequency tick labels at bottom
    ctx.fillStyle = '#64748b';
    ctx.font = '9px "JetBrains Mono", monospace';
    const ticks = [1000, 5000, 10000, 15000, 18000, 20000];
    ticks.forEach((f) => {
      if (f <= nyquist) {
        const tx = (f / nyquist) * width;
        ctx.beginPath();
        ctx.moveTo(tx, height - 6);
        ctx.lineTo(tx, height);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
        ctx.stroke();
        ctx.fillText(`${f >= 1000 ? f / 1000 + 'k' : f}Hz`, tx - 12, height - 9);
      }
    });
  }
}

window.AVSyncVisualizer = AVSyncVisualizer;
