/**
 * AV-Sync // Application Controller
 * Wires UI to Audio Engine & Real-time Canvas Visualizer
 * Created by Shubham
 */

document.addEventListener('DOMContentLoaded', () => {
  // Audio Engine & Visualizer instances
  const engine = new AVSyncAudioEngine();
  const canvas = document.getElementById('visualizerCanvas');
  const visualizer = new AVSyncVisualizer(canvas, engine);
  visualizer.start();

  // DOM Elements - Header & Telemetry
  const carrierLed = document.getElementById('carrierLed');
  const carrierStatus = document.getElementById('carrierStatus');
  const sampleRateDisplay = document.getElementById('sampleRateDisplay');
  const openManifestBtn = document.getElementById('openManifestBtn');
  const closeManifestBtn = document.getElementById('closeManifestBtn');
  const manifestModal = document.getElementById('manifestModal');

  // DOM Elements - Transmitter (TX)
  const txState = document.getElementById('txState');
  const profAudibleBtn = document.getElementById('profAudibleBtn');
  const profUltraBtn = document.getElementById('profUltraBtn');
  const profileHint = document.getElementById('profileHint');
  const speedHint = document.getElementById('speedHint');
  const speedBtns = document.querySelectorAll('[data-speed]');
  const txPayloadInput = document.getElementById('txPayloadInput');
  const charCount = document.getElementById('charCount');
  const txBytesVal = document.getElementById('txBytesVal');
  const txTonesVal = document.getElementById('txTonesVal');
  const txDurationVal = document.getElementById('txDurationVal');
  const volumeSlider = document.getElementById('volumeSlider');
  const volLabel = document.getElementById('volLabel');
  const loopbackToggle = document.getElementById('loopbackToggle');
  const transmitBtn = document.getElementById('transmitBtn');
  const testToneBtn = document.getElementById('testToneBtn');
  const chipBtns = document.querySelectorAll('.chip-btn');

  // DOM Elements - Receiver (RX)
  const rxStateLabel = document.getElementById('rxStateLabel');
  const canvasBandTag = document.getElementById('canvasBandTag');
  const rxPeakFreq = document.getElementById('rxPeakFreq');
  const rxSignalDb = document.getElementById('rxSignalDb');
  const rxLockStatus = document.getElementById('rxLockStatus');
  const rxCrcStatus = document.getElementById('rxCrcStatus');
  const listenBtn = document.getElementById('listenBtn');
  const stopListenBtn = document.getElementById('stopListenBtn');
  const rxPayloadDisplay = document.getElementById('rxPayloadDisplay');
  const copyRxBtn = document.getElementById('copyRxBtn');
  const clearLogBtn = document.getElementById('clearLogBtn');
  const historyTableBody = document.getElementById('historyTableBody');

  let historyEntries = [];

  // Update TX calculations
  function updateTxTelemetry() {
    const text = txPayloadInput.value || '';
    const encoded = engine.encodePayload(text);

    charCount.textContent = `${text.length} chars / ${encoded.byteCount} bytes`;
    txBytesVal.textContent = `${encoded.byteCount} B`;
    txTonesVal.textContent = encoded.tones.length;
    txDurationVal.textContent = `${(encoded.totalDurationMs / 1000).toFixed(2)}s`;
  }

  // Band Profiles
  profAudibleBtn.addEventListener('click', () => {
    profAudibleBtn.classList.add('active');
    profUltraBtn.classList.remove('active');
    engine.setProfile('audible');
    profileHint.textContent = '1.3 kHz - 3.0 kHz';
    canvasBandTag.textContent = 'AUDIBLE BAND (1.3k - 3.0k)';
    updateTxTelemetry();
  });

  profUltraBtn.addEventListener('click', () => {
    profUltraBtn.classList.add('active');
    profAudibleBtn.classList.remove('active');
    engine.setProfile('ultrasonic');
    profileHint.textContent = '17.3 kHz - 19.8 kHz';
    canvasBandTag.textContent = 'NEAR-ULTRASOUND BAND (17.3k - 19.8k)';
    updateTxTelemetry();
  });

  // Speed Profiles
  speedBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      speedBtns.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const speedKey = btn.getAttribute('data-speed');
      engine.setSpeed(speedKey);

      const labels = {
        normal: 'Robust (Max ECC Parity)',
        fast: 'Fast (Balanced Multi-Tone)',
        fastest: 'Turbo (High Throughput)',
        dt: 'Dual-Tone (Resonant Acoustic)'
      };
      speedHint.textContent = labels[speedKey] || speedKey;
      updateTxTelemetry();
    });
  });

  // Payload Input
  txPayloadInput.addEventListener('input', updateTxTelemetry);

  // Quick Preset Tokens
  chipBtns.forEach((chip) => {
    chip.addEventListener('click', () => {
      txPayloadInput.value = chip.getAttribute('data-token');
      updateTxTelemetry();
    });
  });

  // Volume
  volumeSlider.addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    volLabel.textContent = `${val}%`;
    engine.setVolume(val / 100);
  });

  // Loopback
  loopbackToggle.addEventListener('change', (e) => {
    engine.setLoopback(e.target.checked);
    if (e.target.checked) {
      listenBtn.disabled = true;
      stopListenBtn.disabled = false;
      rxStateLabel.textContent = 'ACTIVE (LOOP)';
      rxStateLabel.style.color = 'var(--color-amber)';
      if (engine.audioCtx) {
        sampleRateDisplay.textContent = `${(engine.audioCtx.sampleRate / 1000).toFixed(1)} kHz`;
      }
    } else {
      listenBtn.disabled = false;
      stopListenBtn.disabled = true;
      rxStateLabel.textContent = engine.isListening ? 'ACTIVE' : 'STANDBY';
      rxStateLabel.style.color = engine.isListening ? 'var(--color-green)' : 'var(--text-muted)';
    }
  });

  // Transmit Action
  transmitBtn.addEventListener('click', async () => {
    const text = txPayloadInput.value.trim();
    if (!text) return;

    transmitBtn.disabled = true;
    transmitBtn.innerHTML = `<span>&bull; TRANSMITTING...</span>`;
    txState.textContent = 'BROADCASTING';
    txState.style.color = 'var(--color-amber)';

    await engine.transmit(text, (progress) => {
      txState.textContent = `${progress.label} [${progress.currentFreq}Hz]`;
    });

    transmitBtn.disabled = false;
    transmitBtn.innerHTML = `<span>&blacktriangleright; TRANSMIT AUDIO</span>`;
    txState.textContent = 'READY';
    txState.style.color = 'var(--color-green)';
  });

  // Test Tone
  testToneBtn.addEventListener('click', async () => {
    testToneBtn.disabled = true;
    const testFreq = engine.activeProfile.baseFreq;
    await engine.playTestTone(testFreq, 500);
    testToneBtn.disabled = false;
  });

  // Receiver Listen (Mic)
  listenBtn.addEventListener('click', async () => {
    await engine.startListening();
    if (engine.audioCtx) {
      sampleRateDisplay.textContent = `${(engine.audioCtx.sampleRate / 1000).toFixed(1)} kHz`;
    }
    listenBtn.disabled = true;
    stopListenBtn.disabled = false;
    rxStateLabel.textContent = 'ACTIVE';
    rxStateLabel.style.color = 'var(--color-green)';
  });

  stopListenBtn.addEventListener('click', () => {
    engine.stopListening();
    listenBtn.disabled = false;
    stopListenBtn.disabled = true;
    rxStateLabel.textContent = 'STANDBY';
    rxStateLabel.style.color = 'var(--text-muted)';
    carrierLed.className = 'led-indicator';
    carrierStatus.textContent = 'CARRIER: IDLE';
  });

  // Engine Event Callbacks
  engine.onStatusChange = (status) => {
    if (status.state === 'LISTENING') {
      rxStateLabel.textContent = 'ACTIVE';
      rxStateLabel.style.color = 'var(--color-green)';
    } else if (status.state === 'STANDBY') {
      rxStateLabel.textContent = 'STANDBY';
      rxStateLabel.style.color = 'var(--text-muted)';
    }
  };

  engine.onPreambleLocked = (locked) => {
    if (locked) {
      carrierLed.className = 'led-indicator active';
      carrierStatus.textContent = 'CARRIER: LOCKED';
      rxLockStatus.textContent = 'SYNC LOCKED';
      rxLockStatus.style.color = 'var(--color-green)';
    } else {
      carrierLed.className = 'led-indicator';
      carrierStatus.textContent = 'CARRIER: IDLE';
      rxLockStatus.textContent = 'SEARCHING';
      rxLockStatus.style.color = 'var(--text-muted)';
    }
  };

  engine.onTelemetryUpdate = (telemetry) => {
    rxPeakFreq.textContent = `${telemetry.peakFreq} Hz`;
    rxSignalDb.textContent = `${telemetry.signalDb} dB`;
  };

  // Packet Received Handler
  engine.onDataReceived = (packet) => {
    rxPayloadDisplay.classList.remove('empty');
    rxPayloadDisplay.textContent = packet.text;

    // Visual pulse
    rxPayloadDisplay.style.transition = 'none';
    rxPayloadDisplay.style.color = '#fff';
    rxPayloadDisplay.style.backgroundColor = 'rgba(16, 185, 129, 0.2)';
    setTimeout(() => {
      rxPayloadDisplay.style.transition = 'all 0.5s ease';
      rxPayloadDisplay.style.color = 'var(--color-green)';
      rxPayloadDisplay.style.backgroundColor = 'transparent';
    }, 200);

    rxCrcStatus.textContent = packet.isValid ? 'VALID (PASS)' : 'CORRUPT (FAIL)';
    rxCrcStatus.className = `telemetry-val ${packet.isValid ? 'badge-pass' : 'badge-fail'}`;

    // Add to history
    addHistoryEntry(packet);
  };

  function addHistoryEntry(packet) {
    if (historyEntries.length === 0) {
      historyTableBody.innerHTML = '';
    }
    historyEntries.unshift(packet);

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${packet.timestamp}</td>
      <td style="font-weight: 600; color: #fff;">${escapeHtml(packet.text)}</td>
      <td>${packet.length} B</td>
      <td class="${packet.isValid ? 'badge-pass' : 'badge-fail'}">${packet.isValid ? 'PASS' : 'FAIL'} (${packet.checksumHex})</td>
    `;
    historyTableBody.prepend(tr);
  }

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Copy to Clipboard
  copyRxBtn.addEventListener('click', () => {
    const text = rxPayloadDisplay.textContent.trim();
    if (text && !rxPayloadDisplay.classList.contains('empty')) {
      navigator.clipboard.writeText(text).then(() => {
        const orig = copyRxBtn.textContent;
        copyRxBtn.textContent = 'COPIED!';
        copyRxBtn.style.color = 'var(--color-green)';
        setTimeout(() => {
          copyRxBtn.textContent = orig;
          copyRxBtn.style.color = '';
        }, 1200);
      });
    }
  });

  // Clear Log
  clearLogBtn.addEventListener('click', () => {
    historyEntries = [];
    historyTableBody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--text-muted); padding: 12px;">No frames recorded yet.</td></tr>`;
  });

  // Anti-Slop Modal
  openManifestBtn.addEventListener('click', () => {
    manifestModal.classList.add('open');
  });

  closeManifestBtn.addEventListener('click', () => {
    manifestModal.classList.remove('open');
  });

  manifestModal.addEventListener('click', (e) => {
    if (e.target === manifestModal) {
      manifestModal.classList.remove('open');
    }
  });

  // Initial calculation
  updateTxTelemetry();
});
