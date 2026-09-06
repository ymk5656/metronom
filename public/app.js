/**
 * Wittner Taktell Classic Mechanical Metronome
 * High-precision Web Audio engine + HiDPI Canvas inverted pendulum physics
 */

(function () {
  'use strict';

  // --- TEMPO SPECIFICATION & NON-LINEAR SCALE ---
  // Authentic Wittner 38 tempo markings
  const TEMPO_MARKS = [
    40, 44, 46, 48, 50, 52, 54, 56, 58, 60,
    63, 66, 69, 72, 76, 80, 84, 88, 92, 96,
    100, 104, 108, 112, 116, 120, 126, 132, 138, 144,
    152, 160, 168, 176, 184, 192, 200, 208
  ];

  // Map each BPM to normalized position [0, 1] along the scale (0 = 40 BPM top, 1 = 208 BPM bottom)
  // Non-linear inverted pendulum period curve calibrated to authentic physical Wittner Taktell spacing
  const TEMPO_POS_MAP = {};
  const MIN_BPM = 40;
  const MAX_BPM = 208;
  const POWER = 0.50;
  const pMin = Math.pow(1 / MIN_BPM, POWER);
  const pMax = Math.pow(1 / MAX_BPM, POWER);

  TEMPO_MARKS.forEach((bpm) => {
    const p = Math.pow(1 / bpm, POWER);
    TEMPO_POS_MAP[bpm] = (pMin - p) / (pMin - pMax);
  });

  function getBpmFromNormalizedY(normY) {
    const clamped = Math.max(0, Math.min(1, normY));
    let closestBpm = TEMPO_MARKS[0];
    let minDiff = Infinity;
    for (const bpm of TEMPO_MARKS) {
      const diff = Math.abs(TEMPO_POS_MAP[bpm] - clamped);
      if (diff < minDiff) {
        minDiff = diff;
        closestBpm = bpm;
      }
    }
    return closestBpm;
  }

  /**
   * Returns authentic Italian tempo marking and Korean interpretation
   * matching classical music metronome standards.
   */
  function getTempoInfo(bpm) {
    if (bpm <= 40) {
      return { italian: 'Larghissimo', korean: '라르기시모', desc: '가장 느리게' };
    }
    if (bpm <= 44) {
      return { italian: 'Grave', korean: '그라베', desc: '무겁고 엄숙하게' };
    }
    if (bpm <= 52) {
      return { italian: 'Largo', korean: '라르고', desc: '폭넓고 느리게' };
    }
    if (bpm <= 60) {
      return { italian: 'Lento', korean: '렌토', desc: '느리게 (Slowly)' };
    }
    if (bpm <= 72) {
      return { italian: 'Adagio', korean: '아다지오', desc: '침착하고 느리게' };
    }
    if (bpm <= 84) {
      return { italian: 'Andante', korean: '안단테', desc: '걸어가듯 천천히' };
    }
    if (bpm <= 96) {
      return { italian: 'Andantino', korean: '안단티노', desc: '안단테보다 조금 빠르게' };
    }
    if (bpm <= 108) {
      return { italian: 'Andante moderato', korean: '안단테 모데라토', desc: '안단테와 모데라토의 중간' };
    }
    if (bpm <= 120) {
      return { italian: 'Moderato', korean: '모데라토', desc: '보통 빠르기로' };
    }
    if (bpm <= 138) {
      return { italian: 'Allegretto', korean: '알레그레토', desc: '조금 빠르게, 경쾌하게' };
    }
    if (bpm <= 168) {
      return { italian: 'Allegro', korean: '알레그로', desc: '빠르게, 신나게' };
    }
    if (bpm <= 176) {
      return { italian: 'Vivace', korean: '비바체', desc: '빠르고 생기있게' };
    }
    if (bpm <= 200) {
      return { italian: 'Presto', korean: '프레스토', desc: '매우 빠르게' };
    }
    return { italian: 'Prestissimo', korean: '프레스티시모', desc: '가장 빠르게' };
  }

  // --- VIRTUAL COORDINATE CONSTANTS (BASE: 460 x 860) ---
  const VW = 460;
  const VH = 860;
  const CX = VW / 2; // 230

  // Pendulum Pivot & Geometry
  const PIVOT_X = CX;
  const PIVOT_Y = 660; // Concealed behind lower front cover
  const ROD_TOP_Y = 74;
  const ROD_LENGTH = PIVOT_Y - ROD_TOP_Y; // 586
  const MAX_SWING_ANGLE = 0.24; // ~13.8 degrees maximum excursion

  // Scale Y coordinates (where weight pointer aligns)
  const SCALE_TOP_Y = 126;    // Position for 40 BPM
  const SCALE_BOTTOM_Y = 442; // Position for 208 BPM
  const SCALE_HEIGHT = SCALE_BOTTOM_Y - SCALE_TOP_Y;

  // Sliding weight dimensions
  const WEIGHT_W_TOP = 42;
  const WEIGHT_W_BOT = 30;
  const WEIGHT_H = 44;

  function getWeightYForBpm(bpm) {
    const norm = TEMPO_POS_MAP[bpm] !== undefined ? TEMPO_POS_MAP[bpm] : 0.5;
    return SCALE_TOP_Y + norm * SCALE_HEIGHT;
  }

  // --- APPLICATION STATE ---
  let isRunning = false;
  let currentBpm = 120;
  let targetBpm = 120;

  // Mute & Onboarding Hint State
  let isMuted = false;
  let showMuteHint = true;
  let muteHintAlpha = 1.0;
  const muteHintSpawnTime = performance.now();
  let muteFeedbackText = '';
  let muteFeedbackAlpha = 0.0;
  let lastMuteFeedbackTime = 0;

  // Dragging state
  let isDraggingWeight = false;
  let dragCurrentY = getWeightYForBpm(120);

  // Animation & Physics state
  let currentAngle = 0;
  let animStartTime = 0;
  let stoppingStartTime = 0;
  let stoppingStartAngle = 0;
  let isStopping = false;

  // Web Audio Context & Scheduler State
  let audioCtx = null;
  let nextNoteTime = 0.0;
  let currentBeat = 0;
  const scheduleAheadTime = 0.12; // 120ms lookahead
  const lookaheadInterval = 25;   // 25ms check interval
  let schedulerTimerId = null;

  // --- WEB AUDIO SYNTHESIZER ---
  function initAudioContext() {
    if (!audioCtx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AudioContextClass();
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
  }

  /**
   * Synthesizes the authentic mechanical wooden click of the Wittner Taktell.
   * Alternates between a crisp "tick" (left-to-right swing) and a slightly deeper "tock" (right-to-left swing).
   */
  function playMechanicalClick(time, beatNumber) {
    if (isMuted || !audioCtx) return;

    const isTick = (beatNumber % 2 === 0);
    const primaryFreq = isTick ? 1080 : 940;
    const bodyFreq = isTick ? 540 : 470;
    const thumpFreq = isTick ? 220 : 190;

    const masterGain = audioCtx.createGain();
    masterGain.gain.setValueAtTime(1.0, time);
    masterGain.connect(audioCtx.destination);

    // 1. Transient noise burst (sharp escapement pallet impact)
    try {
      const sampleCount = Math.floor(audioCtx.sampleRate * 0.0035);
      const noiseBuffer = audioCtx.createBuffer(1, sampleCount, audioCtx.sampleRate);
      const noiseData = noiseBuffer.getChannelData(0);
      for (let i = 0; i < sampleCount; i++) {
        noiseData[i] = (Math.random() * 2 - 1) * Math.exp(-i / (sampleCount * 0.28));
      }
      const noiseSource = audioCtx.createBufferSource();
      noiseSource.buffer = noiseBuffer;

      const noiseFilter = audioCtx.createBiquadFilter();
      noiseFilter.type = 'bandpass';
      noiseFilter.frequency.setValueAtTime(3800, time);
      noiseFilter.Q.setValueAtTime(4.2, time);

      const noiseGain = audioCtx.createGain();
      noiseGain.gain.setValueAtTime(0.85, time);
      noiseGain.gain.exponentialRampToValueAtTime(0.001, time + 0.0035);

      noiseSource.connect(noiseFilter);
      noiseFilter.connect(noiseGain);
      noiseGain.connect(masterGain);

      noiseSource.start(time);
      noiseSource.stop(time + 0.004);
    } catch (e) {
      // Audio buffer fallback if needed
    }

    // 2. High wooden cavity resonance (primary tonal clack)
    const woodOsc = audioCtx.createOscillator();
    const woodGain = audioCtx.createGain();
    woodOsc.type = 'triangle';
    woodOsc.frequency.setValueAtTime(primaryFreq, time);
    woodOsc.frequency.exponentialRampToValueAtTime(primaryFreq * 0.72, time + 0.022);

    woodGain.gain.setValueAtTime(0.92, time);
    woodGain.gain.exponentialRampToValueAtTime(0.001, time + 0.024);

    woodOsc.connect(woodGain);
    woodGain.connect(masterGain);
    woodOsc.start(time);
    woodOsc.stop(time + 0.025);

    // 3. Resonant body warmth (hollow casing acoustic echo)
    const bodyOsc = audioCtx.createOscillator();
    const bodyGain = audioCtx.createGain();
    bodyOsc.type = 'sine';
    bodyOsc.frequency.setValueAtTime(bodyFreq, time);
    bodyOsc.frequency.exponentialRampToValueAtTime(bodyFreq * 0.8, time + 0.034);

    bodyGain.gain.setValueAtTime(0.62, time);
    bodyGain.gain.exponentialRampToValueAtTime(0.001, time + 0.036);

    bodyOsc.connect(bodyGain);
    bodyGain.connect(masterGain);
    bodyOsc.start(time);
    bodyOsc.stop(time + 0.038);

    // 4. Low escapement mechanical thump
    const thumpOsc = audioCtx.createOscillator();
    const thumpGain = audioCtx.createGain();
    thumpOsc.type = 'sine';
    thumpOsc.frequency.setValueAtTime(thumpFreq, time);
    thumpOsc.frequency.exponentialRampToValueAtTime(thumpFreq * 0.5, time + 0.03);

    thumpGain.gain.setValueAtTime(0.48, time);
    thumpGain.gain.exponentialRampToValueAtTime(0.001, time + 0.032);

    thumpOsc.connect(thumpGain);
    thumpGain.connect(masterGain);
    thumpOsc.start(time);
    thumpOsc.stop(time + 0.035);
  }

  // --- AUDIO LOOKAHEAD SCHEDULER ---
  function scheduler() {
    if (!isRunning || !audioCtx) return;

    while (nextNoteTime < audioCtx.currentTime + scheduleAheadTime) {
      playMechanicalClick(nextNoteTime, currentBeat);
      nextNoteTime += 60.0 / currentBpm;
      currentBeat++;
    }
  }

  function startMetronome() {
    initAudioContext();
    if (isRunning) return;

    isRunning = true;
    isStopping = false;
    currentBeat = 0;

    // Synchronize visual pendulum animation and audio clock to audioCtx.currentTime
    const startTime = audioCtx.currentTime + 0.04;
    nextNoteTime = startTime;
    animStartTime = startTime;

    if (schedulerTimerId) clearInterval(schedulerTimerId);
    schedulerTimerId = setInterval(scheduler, lookaheadInterval);
  }

  function stopMetronome() {
    if (!isRunning && !isStopping) return;

    isRunning = false;
    if (schedulerTimerId) {
      clearInterval(schedulerTimerId);
      schedulerTimerId = null;
    }

    // Begin smooth, damped return of pendulum to vertical center (0)
    isStopping = true;
    stoppingStartTime = performance.now();
    stoppingStartAngle = currentAngle;
  }

  function togglePlay() {
    if (isRunning) {
      stopMetronome();
    } else {
      startMetronome();
    }
  }

  // --- CANVAS & HiDPI RETINA SETUP ---
  const canvas = document.getElementById('metronome-canvas');
  const ctx = canvas.getContext('2d');
  let scaleRatio = 1.0;

  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const winW = window.innerWidth;
    const winH = window.innerHeight;

    // Fit virtual aspect ratio (460:860) inside viewport while respecting padding
    const maxW = Math.min(winW - 20, 520);
    const maxH = winH - 24;

    const scale = Math.min(maxW / VW, maxH / VH);
    const displayW = Math.round(VW * scale);
    const displayH = Math.round(VH * scale);

    canvas.width = Math.round(displayW * dpr);
    canvas.height = Math.round(displayH * dpr);

    canvas.style.width = displayW + 'px';
    canvas.style.height = displayH + 'px';

    scaleRatio = scale * dpr;
  }

  window.addEventListener('resize', resizeCanvas);
  window.addEventListener('orientationchange', () => {
    setTimeout(resizeCanvas, 120);
  });

  // --- DRAWING ENGINE ---

  /**
   * Draw the black trapezoidal pyramid casing matching Wittner Taktell Classic
   */
  function drawCase() {
    ctx.save();

    // 1. Deep outer drop shadow for the whole body
    ctx.shadowColor = 'rgba(0, 0, 0, 0.85)';
    ctx.shadowBlur = 40;
    ctx.shadowOffsetY = 24;

    // Outer silhouette of upper pyramid + lower base
    ctx.beginPath();
    // Top hood
    ctx.moveTo(194, 60);
    ctx.lineTo(266, 60);
    // Upper pyramid taper down to shoulders
    ctx.lineTo(288, 96);
    ctx.lineTo(366, 525);
    // Right shoulder chamfer
    ctx.lineTo(425, 595);
    // Right base down to bottom
    ctx.lineTo(415, 792);
    ctx.lineTo(45, 792);
    // Left base up to shoulder
    ctx.lineTo(35, 595);
    // Left shoulder chamfer
    ctx.lineTo(94, 525);
    ctx.lineTo(172, 96);
    ctx.closePath();

    // Body dark gradient
    const bodyGrad = ctx.createLinearGradient(80, 0, 380, 0);
    bodyGrad.addColorStop(0.0, '#121214');
    bodyGrad.addColorStop(0.18, '#242429');
    bodyGrad.addColorStop(0.50, '#313138');
    bodyGrad.addColorStop(0.82, '#202024');
    bodyGrad.addColorStop(1.0, '#0f0f11');
    ctx.fillStyle = bodyGrad;
    ctx.fill();
    ctx.restore();

    // 2. Beveled side highlights on outer casing
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(194, 60);
    ctx.lineTo(172, 96);
    ctx.lineTo(94, 525);
    ctx.lineTo(35, 595);
    ctx.lineTo(45, 790);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(266, 60);
    ctx.lineTo(288, 96);
    ctx.lineTo(366, 525);
    ctx.lineTo(425, 595);
    ctx.lineTo(415, 790);
    ctx.stroke();
    ctx.restore();

    // 3. Top hood latch / catch (where rod parks)
    ctx.save();
    const hoodGrad = ctx.createLinearGradient(CX - 40, 56, CX + 40, 56);
    hoodGrad.addColorStop(0.0, '#101012');
    hoodGrad.addColorStop(0.5, '#3a3a42');
    hoodGrad.addColorStop(1.0, '#0d0d0f');
    ctx.fillStyle = hoodGrad;
    ctx.beginPath();
    ctx.roundRect(196, 52, 68, 44, [6, 6, 2, 2]);
    ctx.fill();

    // Catch cutout slot
    ctx.fillStyle = '#050507';
    ctx.fillRect(CX - 8, 70, 16, 24);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
    ctx.lineWidth = 1;
    ctx.strokeRect(196, 52, 68, 44);
    ctx.restore();

    // 4. Winding Key (on the right side)
    drawWindingKey();

    // 5. Recessed cavity for the brass plate
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(198, 102);
    ctx.lineTo(262, 102);
    ctx.lineTo(348, 522);
    ctx.lineTo(112, 522);
    ctx.closePath();
    ctx.fillStyle = '#070709';
    ctx.fill();
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.9)';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Draw the authentic knurled brass winding key on the right side
   */
  function drawWindingKey() {
    ctx.save();
    const stemX = 364;
    const stemY = 530;

    // Stem shadow
    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.fillRect(stemX, stemY - 3, 22, 14);

    // Brass Stem
    const stemGrad = ctx.createLinearGradient(stemX, stemY - 5, stemX, stemY + 5);
    stemGrad.addColorStop(0.0, '#cf9c2c');
    stemGrad.addColorStop(0.4, '#fae188');
    stemGrad.addColorStop(1.0, '#8d6313');
    ctx.fillStyle = stemGrad;
    ctx.fillRect(stemX, stemY - 4, 20, 9);

    // Key knob head (knurled cylinder)
    const knobX = stemX + 18;
    const knobY = stemY - 20;
    const knobW = 18;
    const knobH = 40;

    // Drop shadow
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = 10;
    ctx.shadowOffsetX = 4;
    ctx.shadowOffsetY = 5;

    const knobGrad = ctx.createLinearGradient(knobX, knobY, knobX + knobW, knobY);
    if (isMuted) {
      knobGrad.addColorStop(0.0, '#755416');
      knobGrad.addColorStop(0.35, '#b88d30');
      knobGrad.addColorStop(0.7, '#8f681d');
      knobGrad.addColorStop(1.0, '#4e3308');
    } else {
      knobGrad.addColorStop(0.0, '#aa7e1d');
      knobGrad.addColorStop(0.35, '#fdeea6');
      knobGrad.addColorStop(0.7, '#d2a336');
      knobGrad.addColorStop(1.0, '#744f0b');
    }
    ctx.fillStyle = knobGrad;
    ctx.beginPath();
    ctx.roundRect(knobX, knobY, knobW, knobH, 4);
    ctx.fill();
    ctx.restore();

    // Knurling ridges on brass key
    ctx.save();
    ctx.strokeStyle = isMuted ? 'rgba(50, 30, 5, 0.65)' : 'rgba(70, 45, 8, 0.5)';
    ctx.lineWidth = 1;
    for (let ky = knobY + 4; ky < knobY + knobH - 3; ky += 3.5) {
      ctx.beginPath();
      ctx.moveTo(knobX + 1, ky);
      ctx.lineTo(knobX + knobW - 1, ky);
      ctx.stroke();
    }
    ctx.restore();

    // Subtle audio status LED on top of the winding key
    ctx.save();
    const iconCenterX = knobX + knobW / 2;
    const ledCenterY = knobY - 8;

    if (isMuted) {
      // Warm coral/red glowing dot on top of key (MUTE ACTIVE)
      ctx.fillStyle = '#ff4d4f';
      ctx.shadowColor = '#ff4d4f';
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.arc(iconCenterX, ledCenterY, 3.5, 0, Math.PI * 2);
      ctx.fill();

      // Inner bright specular highlight
      ctx.fillStyle = '#ffa39e';
      ctx.shadowBlur = 0;
      ctx.beginPath();
      ctx.arc(iconCenterX - 0.8, ledCenterY - 0.8, 1.2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      // Subtle emerald green active dot on top of key (SOUND ON)
      ctx.fillStyle = '#52c41a';
      ctx.shadowColor = '#52c41a';
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.arc(iconCenterX, ledCenterY, 3.0, 0, Math.PI * 2);
      ctx.fill();

      // Inner bright highlight
      ctx.fillStyle = '#b7eb8f';
      ctx.shadowBlur = 0;
      ctx.beginPath();
      ctx.arc(iconCenterX - 0.7, ledCenterY - 0.7, 1.0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /**
   * Draw the brushed brass face plate with slotted screws, authentic markings, and inscriptions
   */
  function drawBrassPlate() {
    ctx.save();

    // Brass trapezoid bounds
    ctx.beginPath();
    ctx.moveTo(201, 106);
    ctx.lineTo(259, 106);
    ctx.lineTo(344, 520);
    ctx.lineTo(116, 520);
    ctx.closePath();

    // Brushed brass gradient
    const brassGrad = ctx.createLinearGradient(116, 0, 344, 0);
    brassGrad.addColorStop(0.00, '#c79c38');
    brassGrad.addColorStop(0.18, '#ecd486');
    brassGrad.addColorStop(0.38, '#fff0be');
    brassGrad.addColorStop(0.50, '#ecd382');
    brassGrad.addColorStop(0.72, '#fcedaa');
    brassGrad.addColorStop(0.90, '#d9ab40');
    brassGrad.addColorStop(1.00, '#a5791a');

    ctx.fillStyle = brassGrad;
    ctx.fill();

    // Plate bevel border
    ctx.strokeStyle = '#694a0d';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Brushed metallic horizontal hairline texture
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)';
    ctx.lineWidth = 0.75;
    for (let y = 110; y < 518; y += 3) {
      ctx.beginPath();
      const progress = (y - 106) / (520 - 106);
      const leftX = 201 - progress * (201 - 116);
      const rightX = 259 + progress * (344 - 259);
      ctx.moveTo(leftX + 2, y);
      ctx.lineTo(rightX - 2, y);
      ctx.stroke();
    }

    // Central pendulum clearance slot / groove
    ctx.fillStyle = '#1c150a';
    ctx.fillRect(CX - 2, 106, 4, 412);
    ctx.strokeStyle = 'rgba(255, 240, 180, 0.35)';
    ctx.lineWidth = 0.5;
    ctx.strokeRect(CX - 2, 106, 4, 412);

    // Two brass corner screws at bottom of face plate
    drawSlottedScrew(132, 506);
    drawSlottedScrew(328, 506);

    // Slotted screw near top
    drawSlottedScrew(CX, 114, 4);

    // Authentic Typography on Brass Plate
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Left inscription: "Yearnmin Metronom"
    ctx.fillStyle = '#2f210a';
    ctx.font = 'italic bold 10px "Times New Roman", Times, Georgia, serif';
    ctx.fillText('Yearnmin', 170, 484);
    ctx.font = 'bold 8px -apple-system, sans-serif';
    ctx.fillText('Metronom', 170, 497);

    // Right inscription: "Mozart Classic"
    ctx.font = 'bold 9.5px "Times New Roman", Times, Georgia, serif';
    ctx.fillText('Mozart', 290, 484);
    ctx.font = 'italic 9px "Times New Roman", Times, Georgia, serif';
    ctx.fillText('Classic', 290, 497);

    // Center bottom: "MADE IN" on left of slot, "KOREA" on right of slot
    ctx.font = 'bold 6.5px -apple-system, sans-serif';
    ctx.letterSpacing = '1px';
    ctx.textAlign = 'right';
    ctx.fillText('MADE IN', CX - 8, 513);
    ctx.textAlign = 'left';
    ctx.fillText('KOREA', CX + 8, 513);
    ctx.letterSpacing = '0px';

    // Tempo markings and notches
    drawTempoScale();

    ctx.restore();
  }

  /**
   * Draw brass slotted screw head with 3D counter-sink bevel
   */
  function drawSlottedScrew(x, y, radius = 5.5) {
    ctx.save();
    // Screw rim shadow
    ctx.fillStyle = '#593e0b';
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();

    // Screw face brass gradient
    const sGrad = ctx.createLinearGradient(x - radius, y - radius, x + radius, y + radius);
    sGrad.addColorStop(0.0, '#f9e6a0');
    sGrad.addColorStop(0.5, '#caa138');
    sGrad.addColorStop(1.0, '#754d0c');
    ctx.fillStyle = sGrad;
    ctx.beginPath();
    ctx.arc(x, y, radius - 0.75, 0, Math.PI * 2);
    ctx.fill();

    // Screw slot
    ctx.strokeStyle = '#2c1e05';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(x - radius * 0.6, y - radius * 0.3);
    ctx.lineTo(x + radius * 0.6, y + radius * 0.3);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Draw the authentic 38 tempo notches and alternating numbers matching the photo:
   * 208 on Left, 200 on Right, ..., 44 on Left, 40 on Right
   */
  function drawTempoScale() {
    ctx.save();
    ctx.lineWidth = 1.1;

    for (let i = 0; i < TEMPO_MARKS.length; i++) {
      const bpm = TEMPO_MARKS[i];
      const y = getWeightYForBpm(bpm);
      const isSelected = (bpm === currentBpm);
      // Photo alignment: 208 is left, 200 is right
      const isLeft = ((TEMPO_MARKS.length - 1 - i) % 2 === 0);

      // Tick marks extend outward beyond the sliding weight width (half-width ~ 21)
      const tickStart = 4;
      const tickEnd = 24;

      if (isLeft) {
        // Horizontal tick line extending left from center slot
        ctx.strokeStyle = isSelected ? '#8a1c00' : '#2b1e09';
        ctx.beginPath();
        ctx.moveTo(CX - tickStart, y);
        ctx.lineTo(CX - tickEnd, y);
        ctx.stroke();

        // Numerals positioned outside the tick line
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.font = isSelected
          ? 'bold 9.5px "Lucida Console", "Courier New", monospace'
          : 'bold 7.5px -apple-system, sans-serif';
        ctx.fillStyle = isSelected ? '#8a1d00' : '#2a1e08';
        ctx.fillText(bpm.toString(), CX - tickEnd - 3, y);
      } else {
        // Horizontal tick line extending right from center slot
        ctx.strokeStyle = isSelected ? '#8a1c00' : '#2b1e09';
        ctx.beginPath();
        ctx.moveTo(CX + tickStart, y);
        ctx.lineTo(CX + tickEnd, y);
        ctx.stroke();

        // Numerals positioned outside the tick line
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.font = isSelected
          ? 'bold 9.5px "Lucida Console", "Courier New", monospace'
          : 'bold 7.5px -apple-system, sans-serif';
        ctx.fillStyle = isSelected ? '#8a1d00' : '#2a1e08';
        ctx.fillText(bpm.toString(), CX + tickEnd + 3, y);
      }
    }

    ctx.restore();
  }

  /**
   * Draw the lower front cover shield with chamfered shoulders, embossed branding, and digital readout
   */
  function drawFrontBaseCover() {
    ctx.save();

    // 1. Lower front cover shape with 45-degree chamfered top shoulders
    ctx.beginPath();
    ctx.moveTo(115, 525);
    ctx.lineTo(345, 525);
    ctx.lineTo(425, 595);
    ctx.lineTo(415, 792);
    ctx.lineTo(45, 792);
    ctx.lineTo(35, 595);
    ctx.lineTo(115, 525);
    ctx.closePath();

    // 3D drop shadow cast onto upper cavity
    ctx.shadowColor = 'rgba(0, 0, 0, 0.9)';
    ctx.shadowBlur = 22;
    ctx.shadowOffsetY = -6;

    // Rich metallic/matte black gradient
    const shieldGrad = ctx.createLinearGradient(40, 525, 420, 792);
    shieldGrad.addColorStop(0.0, '#1a191d');
    shieldGrad.addColorStop(0.2, '#25242a');
    shieldGrad.addColorStop(0.5, '#18171b');
    shieldGrad.addColorStop(0.8, '#222127');
    shieldGrad.addColorStop(1.0, '#0d0d10');

    ctx.fillStyle = shieldGrad;
    ctx.fill();
    ctx.restore();

    // 2. Beveled highlight edge on the shield
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.moveTo(115, 526);
    ctx.lineTo(345, 526);
    ctx.lineTo(424, 595);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(424, 595);
    ctx.lineTo(414, 790);
    ctx.lineTo(46, 790);
    ctx.stroke();

    // 3. Vintage Embossed Typography: "Mozart" & "Classic"
    const goldTextGrad = ctx.createLinearGradient(CX - 90, 595, CX + 90, 665);
    goldTextGrad.addColorStop(0.0, '#dfbe68');
    goldTextGrad.addColorStop(0.3, '#fbf0c2');
    goldTextGrad.addColorStop(0.7, '#fff5d6');
    goldTextGrad.addColorStop(1.0, '#c79c38');

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // "Mozart"
    ctx.shadowColor = 'rgba(0, 0, 0, 0.92)';
    ctx.shadowBlur = 5;
    ctx.shadowOffsetY = 2;
    ctx.fillStyle = goldTextGrad;
    ctx.font = 'bold italic 36px "Georgia", "Times New Roman", serif';
    ctx.fillText('Mozart', CX, 608);

    // "Classic" (harmonious italic serif matching photo)
    ctx.font = 'bold italic 35px "Georgia", "Times New Roman", serif';
    ctx.fillText('Classic', CX, 650);

    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;

    // 4. Discreet Digital BPM Readout Display near bottom base
    drawDigitalReadout();

    ctx.restore();
  }

  /**
   * Discreet, high-contrast digital display inset into bottom base
   * Displays BPM, Italian musical tempo term, and Korean interpretation
   */
  function drawDigitalReadout() {
    ctx.save();
    const boxX = CX - 105;
    const boxY = 708;
    const boxW = 210;
    const boxH = 56;
    const radius = 8;

    // Inset beveled casing
    ctx.fillStyle = '#08080a';
    ctx.beginPath();
    ctx.roundRect(boxX, boxY, boxW, boxH, radius);
    ctx.fill();

    // Inset border
    ctx.strokeStyle = '#282830';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    const displayBpm = isDraggingWeight ? targetBpm : currentBpm;
    const tempoInfo = getTempoInfo(displayBpm);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const ledColor = isRunning ? '#00e5a3' : '#f0b832';
    ctx.fillStyle = ledColor;
    ctx.shadowColor = ledColor;
    ctx.shadowBlur = isRunning ? 9 : 5;

    // Line 1: BPM + Italian Tempo Marking with clean measured spacing
    ctx.font = 'bold 18px "Lucida Console", "Courier New", monospace';
    const bpmStr = `${displayBpm} BPM`;
    const tempoStr = tempoInfo.italian;
    const bpmW = ctx.measureText(bpmStr).width;

    ctx.font = 'bold italic 17px "Georgia", "Times New Roman", serif';
    const tempoW = ctx.measureText(tempoStr).width;
    const sepW = 16;
    const totalW = bpmW + sepW + tempoW;
    const startX = CX - totalW / 2;

    ctx.textAlign = 'left';
    ctx.font = 'bold 18px "Lucida Console", "Courier New", monospace';
    ctx.fillText(bpmStr, startX, boxY + 22);

    ctx.fillStyle = isRunning ? 'rgba(0, 229, 163, 0.7)' : 'rgba(240, 184, 50, 0.7)';
    ctx.font = '14px -apple-system, sans-serif';
    ctx.fillText('·', startX + bpmW + 5, boxY + 21);

    ctx.fillStyle = ledColor;
    ctx.font = 'bold italic 17px "Georgia", "Times New Roman", serif';
    ctx.fillText(tempoStr, startX + bpmW + sepW, boxY + 22);

    ctx.textAlign = 'center';

    // Line 2: Status hint line (Korean text omitted per user request)
    ctx.shadowBlur = 0;
    ctx.fillStyle = isRunning ? 'rgba(0, 229, 163, 0.8)' : 'rgba(255, 255, 255, 0.45)';
    ctx.font = '8.5px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.letterSpacing = '1px';
    let statusText;
    if (isRunning) {
      statusText = isMuted ? '● RUNNING [MUTED 🔇] • TAP TO STOP' : '● RUNNING • TAP TO STOP';
    } else if (isDraggingWeight) {
      statusText = 'SLIDING WEIGHT • RELEASE TO SET';
    } else {
      statusText = isMuted ? 'IDLE [MUTED 🔇] • TAP BODY TO START' : 'IDLE • TAP BODY TO START';
    }
    ctx.fillText(statusText, CX, boxY + 42);
    ctx.letterSpacing = '0px';

    ctx.restore();
  }

  /**
   * Draw the inverted pendulum rod and sliding brass weight.
   * Renders a realistic flat brass/gold metallic bar with stamped graduation notches matching the photo.
   */
  function drawPendulum(angle) {
    ctx.save();

    // Translate context to pendulum pivot
    ctx.translate(PIVOT_X, PIVOT_Y);
    ctx.rotate(angle);

    // 1. Dynamic rod shadow cast onto the brass faceplate
    ctx.save();
    const shadowAngleOffset = angle * 0.6;
    ctx.rotate(shadowAngleOffset);
    ctx.strokeStyle = 'rgba(20, 10, 0, 0.38)';
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, -(ROD_LENGTH - 10));
    ctx.stroke();
    ctx.restore();

    // 2. Flat Brass/Gold Metallic Bar with engraved graduation notch lines
    const barHalfW = 3.8; // Wider gold metallic bar (~7.6px wide)
    const barW = barHalfW * 2;

    // Brushed brass/gold metallic gradient with warm luster
    const rodGrad = ctx.createLinearGradient(-barHalfW, 0, barHalfW, 0);
    rodGrad.addColorStop(0.00, '#9e751d');
    rodGrad.addColorStop(0.18, '#eed788');
    rodGrad.addColorStop(0.48, '#fff6d4');
    rodGrad.addColorStop(0.78, '#e0b84c');
    rodGrad.addColorStop(1.00, '#845e12');

    ctx.fillStyle = rodGrad;
    ctx.beginPath();
    ctx.rect(-barHalfW, -ROD_LENGTH, barW, ROD_LENGTH + 20);
    ctx.fill();

    // 3D side edge bevels
    ctx.strokeStyle = '#5a3d08';
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    ctx.moveTo(-barHalfW, -ROD_LENGTH);
    ctx.lineTo(-barHalfW, 20);
    ctx.moveTo(barHalfW, -ROD_LENGTH);
    ctx.lineTo(barHalfW, 20);
    ctx.stroke();

    // Center hairline specular highlight
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(0, -ROD_LENGTH);
    ctx.lineTo(0, 20);
    ctx.stroke();

    // Stamped horizontal graduation notch marks along the gold bar
    for (let i = 0; i < TEMPO_MARKS.length; i++) {
      const bpm = TEMPO_MARKS[i];
      const notchDist = PIVOT_Y - getWeightYForBpm(bpm);
      const ny = -notchDist;

      // Dark engraved notch
      ctx.strokeStyle = '#382504';
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.moveTo(-barHalfW + 0.5, ny);
      ctx.lineTo(barHalfW - 0.5, ny);
      ctx.stroke();

      // Lower specular highlight
      ctx.strokeStyle = 'rgba(255, 255, 220, 0.75)';
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(-barHalfW + 0.5, ny + 0.75);
      ctx.lineTo(barHalfW - 0.5, ny + 0.75);
      ctx.stroke();
    }

    // Top brass cap / catch clip
    const capW = 9;
    const capH = 5.5;
    const capGrad = ctx.createLinearGradient(-capW / 2, -ROD_LENGTH - capH, capW / 2, -ROD_LENGTH);
    capGrad.addColorStop(0.0, '#d1a538');
    capGrad.addColorStop(0.5, '#fff0be');
    capGrad.addColorStop(1.0, '#916812');
    ctx.fillStyle = capGrad;
    ctx.beginPath();
    ctx.roundRect(-capW / 2, -ROD_LENGTH - capH + 1, capW, capH, 1.5);
    ctx.fill();
    ctx.strokeStyle = '#614309';
    ctx.lineWidth = 0.75;
    ctx.stroke();

    // 3. Sliding Brass Weight
    // Distance from pivot along the rod to the pointer line on the weight
    const weightAbsoluteY = isDraggingWeight ? dragCurrentY : getWeightYForBpm(currentBpm);
    const weightDistFromPivot = PIVOT_Y - weightAbsoluteY;

    drawSlidingWeight(-weightDistFromPivot);

    ctx.restore();
  }

  /**
   * Draw authentic Wittner Taktell inverted trapezoid brass weight with cutouts and rivets
   */
  function drawSlidingWeight(yPos) {
    ctx.save();
    // Offset so the pointer line (-WEIGHT_H / 2 + 1) lands exactly at yPos
    const pointerOffset = (WEIGHT_H / 2 - 1);
    ctx.translate(0, yPos + pointerOffset);

    const halfTop = WEIGHT_W_TOP / 2;
    const halfBot = WEIGHT_W_BOT / 2;
    const h = WEIGHT_H;

    // Weight Drop Shadow on the faceplate
    ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
    ctx.shadowBlur = 12;
    ctx.shadowOffsetY = 4;

    // Inverted trapezoid shield body
    ctx.beginPath();
    ctx.moveTo(-halfTop, -h / 2);
    // Top center cutout ears
    ctx.lineTo(-10, -h / 2);
    ctx.lineTo(-7, -h / 2 + 5);
    ctx.lineTo(7, -h / 2 + 5);
    ctx.lineTo(10, -h / 2);
    ctx.lineTo(halfTop, -h / 2);
    // Tapered sides
    ctx.lineTo(halfBot, h / 2);
    ctx.lineTo(-halfBot, h / 2);
    ctx.closePath();

    // Polished brass gradient
    const weightGrad = ctx.createLinearGradient(-halfTop, 0, halfTop, 0);
    weightGrad.addColorStop(0.00, '#b88924');
    weightGrad.addColorStop(0.20, '#fae38e');
    weightGrad.addColorStop(0.50, '#fff4cc');
    weightGrad.addColorStop(0.80, '#e2b342');
    weightGrad.addColorStop(1.00, '#8c6010');

    ctx.fillStyle = weightGrad;
    ctx.fill();

    ctx.restore(); // Clear shadow

    ctx.save();
    const pointerOffset2 = (WEIGHT_H / 2 - 1);
    ctx.translate(0, yPos + pointerOffset2);

    // Outer brass bevel border
    ctx.strokeStyle = '#5a3d08';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(-halfTop, -h / 2);
    ctx.lineTo(-10, -h / 2);
    ctx.lineTo(-7, -h / 2 + 5);
    ctx.lineTo(7, -h / 2 + 5);
    ctx.lineTo(10, -h / 2);
    ctx.lineTo(halfTop, -h / 2);
    ctx.lineTo(halfBot, h / 2);
    ctx.lineTo(-halfBot, h / 2);
    ctx.closePath();
    ctx.stroke();

    // Central vertical window cutout showing the gold rod with stamped notches
    ctx.fillStyle = 'rgba(30, 20, 5, 0.25)';
    ctx.fillRect(-4.5, -h / 2 + 6, 9, h - 12);
    ctx.strokeStyle = '#523909';
    ctx.lineWidth = 0.6;
    ctx.strokeRect(-4.5, -h / 2 + 6, 9, h - 12);

    // Transverse horizontal brass bar with 2 rivets
    const barY = 2;
    const barGrad = ctx.createLinearGradient(-16, barY - 6, 16, barY + 6);
    barGrad.addColorStop(0.0, '#eac668');
    barGrad.addColorStop(0.5, '#fff0be');
    barGrad.addColorStop(1.0, '#a5791c');
    ctx.fillStyle = barGrad;
    ctx.beginPath();
    ctx.roundRect(-halfBot + 2, barY - 6, WEIGHT_W_BOT - 4, 12, 2);
    ctx.fill();
    ctx.strokeStyle = '#5c3e07';
    ctx.lineWidth = 0.8;
    ctx.stroke();

    // Rivet dots on the weight
    drawSlottedScrew(-8, barY, 2.0);
    drawSlottedScrew(8, barY, 2.0);

    // Top horizontal indicator pointer lines (points to scale notch)
    ctx.strokeStyle = '#1b1204';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(-halfTop + 4, -h / 2 + 1);
    ctx.lineTo(-10, -h / 2 + 1);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(10, -h / 2 + 1);
    ctx.lineTo(halfTop - 4, -h / 2 + 1);
    ctx.stroke();

    ctx.restore();
  }

  /**
   * Toggle mute state and show feedback toast
   */
  function toggleMute() {
    initAudioContext();
    isMuted = !isMuted;
    showMuteHint = false;
    muteFeedbackText = isMuted ? '🔇 음소거 (MUTED)' : '🔊 소리 켜짐 (SOUND ON)';
    muteFeedbackAlpha = 1.0;
    lastMuteFeedbackTime = performance.now();
    if (navigator.vibrate) {
      navigator.vibrate(isMuted ? [15, 35, 15] : 20);
    }
  }

  /**
   * Draw initial onboarding hint pointing directly to the right winding key
   */
  function drawMuteHint() {
    if (!showMuteHint) return;

    const elapsed = performance.now() - muteHintSpawnTime;
    // Auto fade after 8 seconds over 1.2s
    if (elapsed > 8000) {
      const fadeProgress = (elapsed - 8000) / 1200;
      if (fadeProgress >= 1.0) {
        showMuteHint = false;
        return;
      }
      muteHintAlpha = 1.0 - fadeProgress;
    } else {
      muteHintAlpha = Math.min(1.0, elapsed / 280);
    }

    ctx.save();
    ctx.globalAlpha = muteHintAlpha;

    // Gentle floating bobbing animation
    const bob = Math.sin(elapsed * 0.005) * 3;

    // Tooltip Card dimensions (pointing towards winding key at x: 388, y: 515)
    const cardX = 168;
    const cardY = 444 + bob;
    const cardW = 212;
    const cardH = 50;

    // Outer drop shadow
    ctx.shadowColor = 'rgba(0, 0, 0, 0.85)';
    ctx.shadowBlur = 14;
    ctx.shadowOffsetY = 4;

    // Card background
    ctx.fillStyle = 'rgba(18, 18, 22, 0.95)';
    ctx.beginPath();
    ctx.roundRect(cardX, cardY, cardW, cardH, 8);
    ctx.fill();

    // Callout pointer arrow pointing down-right toward winding key (388, 514 + bob)
    ctx.beginPath();
    ctx.moveTo(cardX + cardW - 32, cardY + cardH - 1);
    ctx.lineTo(cardX + cardW + 8, cardY + cardH + 16);
    ctx.lineTo(cardX + cardW - 10, cardY + cardH - 1);
    ctx.closePath();
    ctx.fill();

    // Fine gold border with pulsing accent
    const pulse = 0.5 + 0.5 * Math.sin(elapsed * 0.006);
    ctx.strokeStyle = `rgba(223, 190, 104, ${0.7 + 0.3 * pulse})`;
    ctx.lineWidth = 1.4;
    ctx.shadowColor = `rgba(223, 190, 104, ${0.4 * pulse})`;
    ctx.shadowBlur = 8 * pulse;
    ctx.stroke();

    // Text content inside card
    ctx.shadowBlur = 0;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    // Line 1: Korean guide with mute icon
    ctx.font = 'bold 11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.fillStyle = '#ffdf88';
    ctx.fillText('🔇 우측 태엽: 터치하여 음소거', cardX + 12, cardY + 18);

    // Line 2: English subtext
    ctx.font = '9px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.68)';
    ctx.fillText('Right Key: Tap to Mute / Unmute', cardX + 12, cardY + 34);

    ctx.restore();
  }

  /**
   * Draw temporary animated feedback toast when user toggles mute
   */
  function drawMuteFeedback() {
    if (muteFeedbackAlpha <= 0) return;

    const elapsed = performance.now() - lastMuteFeedbackTime;
    if (elapsed > 1800) {
      muteFeedbackAlpha = 0;
      return;
    } else if (elapsed > 1200) {
      muteFeedbackAlpha = 1.0 - (elapsed - 1200) / 600;
    }

    ctx.save();
    ctx.globalAlpha = muteFeedbackAlpha;

    const toastW = 156;
    const toastH = 28;
    const toastX = CX - toastW / 2;
    const toastY = 538;

    ctx.shadowColor = 'rgba(0, 0, 0, 0.85)';
    ctx.shadowBlur = 10;
    ctx.fillStyle = isMuted ? 'rgba(38, 14, 14, 0.94)' : 'rgba(12, 34, 18, 0.94)';
    ctx.beginPath();
    ctx.roundRect(toastX, toastY, toastW, toastH, 14);
    ctx.fill();

    ctx.strokeStyle = isMuted ? '#ff4d4f' : '#52c41a';
    ctx.lineWidth = 1.2;
    ctx.stroke();

    ctx.shadowBlur = 0;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 10.5px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillStyle = isMuted ? '#ffa39e' : '#b7eb8f';
    ctx.fillText(muteFeedbackText, CX, toastY + toastH / 2);

    ctx.restore();
  }

  // --- MAIN RENDER LOOP ---
  function render() {
    requestAnimationFrame(render);

    // Inverted Pendulum Harmonic Physics
    if (isRunning && audioCtx) {
      const now = audioCtx.currentTime;
      const elapsed = now - animStartTime;
      // Frequency: 1 beat = 1 half-cycle = 60/BPM seconds -> omega = pi * BPM / 60
      const omega = (Math.PI * currentBpm) / 60.0;
      currentAngle = MAX_SWING_ANGLE * Math.sin(omega * elapsed);
    } else if (isStopping) {
      // Smooth cubic ease-out return to vertical center (0) over 320ms
      const now = performance.now();
      const dt = (now - stoppingStartTime) / 320.0;
      if (dt >= 1.0) {
        currentAngle = 0;
        isStopping = false;
      } else {
        const ease = 1 - Math.pow(1 - dt, 3);
        currentAngle = stoppingStartAngle * (1 - ease);
      }
    } else {
      currentAngle = 0;
    }

    // Clear and draw frame
    ctx.save();
    ctx.setTransform(scaleRatio, 0, 0, scaleRatio, 0, 0);
    ctx.clearRect(0, 0, VW, VH);

    // 1. Draw Metronome Outer Case & Cavity (including winding key)
    drawCase();

    // 2. Draw Brass Face Plate with Scale Markings
    drawBrassPlate();

    // 3. Draw Swinging Inverted Pendulum & Sliding Weight
    drawPendulum(currentAngle);

    // 4. Draw Lower Front Shield (covers pivot) & Digital Readout
    drawFrontBaseCover();

    // 5. Draw Onboarding Mute Guide Tooltip & Toast Feedback
    drawMuteHint();
    drawMuteFeedback();

    ctx.restore();
  }

  // --- TOUCH & POINTER INTERACTIONS ---
  let lastTapTime = 0;

  function getCanvasCoords(e) {
    const rect = canvas.getBoundingClientRect();
    const clientX = e.clientX !== undefined ? e.clientX : (e.touches && e.touches[0] ? e.touches[0].clientX : 0);
    const clientY = e.clientY !== undefined ? e.clientY : (e.touches && e.touches[0] ? e.touches[0].clientY : 0);

    const scaleX = VW / rect.width;
    const scaleY = VH / rect.height;

    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY
    };
  }

  function isOverScaleZone(x, y) {
    // Hit region covering the brass scale plate and sliding weight
    const inY = (y >= SCALE_TOP_Y - 20 && y <= SCALE_BOTTOM_Y + 25);
    const inX = (Math.abs(x - CX) <= 90);
    return inY && inX;
  }

  function isOverWindingKey(x, y) {
    // Generous touch hit region around right winding key
    // stemX = 364, stemY = 530, knob covers x: 382..400, y: 510..550
    return (x >= 340 && x <= 450 && y >= 475 && y <= 585);
  }

  function handlePointerDown(e) {
    e.preventDefault();
    const now = performance.now();
    if (now - lastTapTime < 180) return; // Prevent double-trigger from touch+pointer synthetic events
    lastTapTime = now;

    initAudioContext();

    const pt = getCanvasCoords(e);

    // 1. Right Button (Winding Key) -> Toggle Mute / Unmute
    if (isOverWindingKey(pt.x, pt.y)) {
      toggleMute();
      return;
    }

    // Dismiss onboarding hint on any interaction
    if (showMuteHint) {
      showMuteHint = false;
    }

    // When running: tapping ANYWHERE else immediately stops the metronome
    if (isRunning) {
      stopMetronome();
      return;
    }

    // When stopped: check if user touched the scale or weight to adjust tempo
    if (isOverScaleZone(pt.x, pt.y)) {
      isDraggingWeight = true;
      const clampedY = Math.max(SCALE_TOP_Y, Math.min(SCALE_BOTTOM_Y, pt.y));
      dragCurrentY = clampedY;
      const normY = (clampedY - SCALE_TOP_Y) / SCALE_HEIGHT;
      targetBpm = getBpmFromNormalizedY(normY);
      currentBpm = targetBpm;
      if (navigator.vibrate) navigator.vibrate(8);
      return;
    }

    // Otherwise: tapped on outer body or base -> start metronome!
    togglePlay();
  }

  function handlePointerMove(e) {
    if (!isDraggingWeight) return;
    e.preventDefault();

    const pt = getCanvasCoords(e);
    const clampedY = Math.max(SCALE_TOP_Y, Math.min(SCALE_BOTTOM_Y, pt.y));
    dragCurrentY = clampedY;

    const normY = (clampedY - SCALE_TOP_Y) / SCALE_HEIGHT;
    const newBpm = getBpmFromNormalizedY(normY);

    if (newBpm !== targetBpm) {
      targetBpm = newBpm;
      currentBpm = targetBpm;
      if (navigator.vibrate) navigator.vibrate(8);
    }
  }

  function handlePointerUp(e) {
    if (isDraggingWeight) {
      e.preventDefault();
      isDraggingWeight = false;
      currentBpm = targetBpm;
      dragCurrentY = getWeightYForBpm(currentBpm);
      if (navigator.vibrate) navigator.vibrate(12);
    }
  }

  // Bind Pointer Events (with fallback for legacy browsers)
  if (window.PointerEvent) {
    canvas.addEventListener('pointerdown', handlePointerDown, { passive: false });
    window.addEventListener('pointermove', handlePointerMove, { passive: false });
    window.addEventListener('pointerup', handlePointerUp, { passive: false });
    window.addEventListener('pointercancel', handlePointerUp, { passive: false });
  } else {
    canvas.addEventListener('touchstart', handlePointerDown, { passive: false });
    window.addEventListener('touchmove', handlePointerMove, { passive: false });
    window.addEventListener('touchend', handlePointerUp, { passive: false });
    canvas.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('mousemove', handlePointerMove);
    window.addEventListener('mouseup', handlePointerUp);
  }

  // Register PWA Service Worker
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js')
        .then((reg) => {
          console.log('PWA Service Worker registered with scope:', reg.scope);
        })
        .catch((err) => {
          console.log('PWA Service Worker registration failed:', err);
        });
    });
  }

  // Test API for headless automated verification
  window.__metronomeTestApi = {
    getState: () => ({
      isRunning,
      currentBpm,
      targetBpm,
      currentAngle,
      isDraggingWeight,
      isMuted,
      showMuteHint,
      TEMPO_MARKS,
      audioState: audioCtx ? audioCtx.state : 'uninitialized'
    }),
    togglePlay,
    startMetronome,
    stopMetronome,
    toggleMute,
    isOverWindingKey,
    setBpm: (bpm) => {
      if (!isRunning && TEMPO_MARKS.includes(bpm)) {
        currentBpm = bpm;
        targetBpm = bpm;
        dragCurrentY = getWeightYForBpm(bpm);
      }
    },
    getWeightYForBpm,
    getCanvasCoords
  };

  // Initial setup: start stopped at 120 BPM with vertical rod
  resizeCanvas();
  dragCurrentY = getWeightYForBpm(currentBpm);
  render();

})();
