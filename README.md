# AV-Sync // Acoustic Data Link Prototype

> **Created by Shubham**  
> A minimalist, anti-AI-slop web prototype for transferring data wirelessly between devices using sound waves.

---

## 📻 Overview

**AV-Sync** turns any standard speaker and microphone into a software-defined acoustic modem. It modulates digital text into discrete acoustic frequency tones (MFSK - Multiple Frequency-Shift Keying) and demodulates incoming audio in real time using high-resolution FFT frequency analysis.

### Features:
* **Dual Frequency Bands:**
  * **Audible Chirp (`1.3 kHz – 3.0 kHz`):** Robust, high-range acoustic chirping that penetrates ambient room noise.
  * **Near-Ultrasound (`17.3 kHz – 19.8 kHz`):** Inaudible to adult human ears, enabling completely silent data transmission using standard 44.1 kHz / 48 kHz hardware.
* **MFSK Modulation & Frame Encoding:**
  * Dual-pilot preamble synchronization (`SYNC-A`, `SYNC-B`).
  * 16-FSK (1 tone = 4-bit nibble; 2 tones per byte).
  * CRC checksum validation.
  * EOF delimiter tone.
* **Real-time 60 FPS Telemetry Canvas:**
  * 4096-point FFT spectrum visualizer.
  * Audio oscilloscope waveform monitor.
  * Real-time frequency band detection highlighting.
* **Internal Loopback Bus:**
  * Test transmissions locally in a single tab without microphone permissions or speaker feedback.
* **Two-Device Air Transfer:**
  * Open AV-Sync on two separate laptops or phones on the same table, click `Start Listener` on one, and `Transmit Audio` on the other!

---

## 🎨 Design Philosophy: Anti-AI-Slop

Most AI-generated prototypes suffer from the **"AI Slop" syndrome**:
1. *The generic purple/indigo-to-cyan gradient on every button and hero banner.*
2. *The ubiquitous, personality-free "Inter" or "Roboto" font on all elements.*
3. *A formulaic 3-card grid with empty corporate jargon ("Unlock seamless synergy").*
4. *Floating glossy 3D spheres or glassmorphic bubbles.*
5. *Dummy mockups where buttons do nothing.*

### How AV-Sync Solves This:
* **Tactile Industrial Aesthetic:** Inspired by Dieter Rams, Braun, and Teenage Engineering hardware synthesizers.
* **Obsidian & Matte Slate Palette:** Deep background (`#090b0e`), hairline borders (`#212631`), with functional **Signal Amber (`#f59e0b`)** and **Phosphor Green (`#10b981`)** LED indicators.
* **Engineered Typographic Hierarchy:** High-contrast display typography paired with dense **JetBrains Mono** telemetry tables.
* **Asymmetric Functional Workbench:** Dual-rack instrumentation panel (Transmitter on left, Receiver + Spectrogram on right).
* **100% Real, Working Code:** Not a static mockup. Web Audio oscillators actually synthesize sound waves, and `AnalyserNode` detects frequencies live.

---

## 🚀 Quick Start

To run AV-Sync:
1. Simply double-click [index.html](file:///c:/Users/Shubham/Desktop/Jitter%20link/index.html) in your browser (Chrome, Edge, Firefox, or Safari), or run a lightweight local server:
   ```bash
   npx serve .
   # or
   python -m http.server 8000
   ```
2. Click **START LISTENER (MIC)** on the Receiver panel (allow microphone access).
3. Type any text in the Transmitter panel (e.g. `SYNC_CODE_984`) or pick a preset.
4. Click **TRANSMIT AUDIO** and watch the sound waves transfer and decode!

---
*AV-Sync &bull; Created by Shubham*
