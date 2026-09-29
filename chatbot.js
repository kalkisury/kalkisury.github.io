/**
 * Chatbot Component v2.0.0 — with the 3D Robot Assistant
 * ─────────────────────────────────────────────────────────────────────────
 * A modular, self-contained AI chatbot component with clear separation of
 * concerns:
 *
 *   RobotController      → layered 3D robot assistant (animation engine)
 *   ApiService          → Backend API communication (auth, retries, errors)
 *   ConversationState    → Message history, conversation_id, localStorage
 *   MarkdownRenderer     → Safe markdown-to-HTML (XSS-safe, no raw HTML)
 *   ChatbotRenderer      → DOM rendering (messages, typing, suggestions)
 *   Chatbot              → Main controller orchestrating all modules
 *
 * Configuration via data attributes on the #chatbot container:
 *   data-api-endpoint        Backend REST endpoint (default: /api/chat)
 *   data-welcome-message     Custom welcome text
 *   data-suggested-questions JSON array of starter questions
 *   data-bot-name            Override bot display name
 *
 * All API keys and secrets stay on the backend — never in this file.
 *
 * @license MIT
 */
(function (global, factory) {
  'use strict';

  // ── Configuration ──────────────────────────────────────────────────────
  /* Statuses that mean "this host has no API on it" rather than "the API is
     unhappy" — used both for the offline message and for host failover. */
  var NO_BACKEND_STATUSES = [404, 405, 501];

  var DEFAULT_CONFIG = {
    /* Candidate API origins, tried in order at runtime. Same-origin is always
       appended last, so local Flask dev needs no configuration. See
       createEndpointResolver. */
    apiHosts: [],
    apiPath: '/api/chat',
    apiHealthPath: '/api/chat/health',
    healthTimeout: 4000,
    welcomeMessage: 'Hello! 👋 Welcome. How can I assist you today?',
    typingMessage: 'AI Assistant is typing',
    placeholderText: 'Type your message...',
    errorMessage: "Sorry, I couldn't process your request right now. Please try again.",
    errorRetryText: 'Retry',
    sendButtonLabel: 'Send',
    minimizeTitle: 'Minimize chat',
    closeTitle: 'Close chat',
    openTitle: 'Open AI Assistant',
    suggestedQuestions: [
      'What services do you offer?',
      'How can I get in touch?',
      'What is your experience?',
      'What are your skills?'
    ],
    storageKey: 'chatbot_conversation',
    requestTimeout: 15000,
    debug: false,
    /* Shown when the chat API cannot be reached at all — e.g. the site is
       hosted on a static host (GitHub Pages / Surge) and no backend URL has
       been configured. Distinct from errorMessage, which is for a failed
       request to a backend that is present. */
    offlineMessage:
      "I can't reach my brain right now — the chat service isn't available. " +
      'Feel free to email kalkisurya330@gmail.com instead.',
    /* Robot-specific config */
    tooltipMessage: 'Ask me anything 👋',
    greetingInterval: 24 * 60 * 60 * 1000, /* 24h — first-time greeting cooldown */
    tooltipDuration: 5000,
      movementIntervalMin: 14000,
      movementIntervalMax: 26000,
    blinkIntervalMin: 2600,
    blinkIntervalMax: 7200,
    personalityIntervalMin: 7000,
    personalityIntervalMax: 15000,
    attentionIntervalMin: 45000,
    attentionIntervalMax: 95000,
    peekIntervalMin: 110000,
    peekIntervalMax: 210000,
    sleepAfter: 75000
  };

  // ── Utility helpers ───────────────────────────────────────────────────
  var utils = {
    generateId: function () {
      if (global.crypto && global.crypto.randomUUID) {
        return global.crypto.randomUUID();
      }
      return Date.now().toString(36) + Math.random().toString(36).slice(2, 11);
    },

    formatTime: function (iso) {
      try {
        var d = new Date(iso);
        var h = String(d.getHours()).padStart(2, '0');
        var m = String(d.getMinutes()).padStart(2, '0');
        return h + ':' + m;
      } catch (e) {
        return '';
      }
    },

    nowISO: function () {
      return new Date().toISOString();
    },

    isMobile: function () {
      return /Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
        navigator.userAgent
      );
    },

    defer: function (fn) {
      if (typeof global.requestAnimationFrame !== 'undefined') {
        global.requestAnimationFrame(fn);
      } else {
        setTimeout(fn, 0);
      }
    }
  };

  // ── Motion primitives ───────────────────────────────────────────────────
  /*
   * Every animated property of the robot is a "channel": a target value that
   * the current value chases through a damped spring. One rAF loop integrates
   * all channels and writes the resulting transforms, so every transition in
   * the system (idle → hover → chat open → listening → thinking, and back)
   * is inherently smooth and interruptible — retargeting mid-flight blends
   * instead of snapping.
   *
   * Short, characterful accents (a wave, a nod, a blink) are layered on top of
   * a channel as a decaying oscillator, so they compose with whatever the
   * state machine is doing rather than fighting it.
   */
  var TAU = Math.PI * 2;

  var SPRING = { k: 110, d: 21, eps: 0.0015 };  /* body, limbs          */
  var SOFT = { k: 22, d: 9.4, eps: 0.04 };      /* travel across screen */
  var FAST = { k: 520, d: 46, eps: 0.004 };     /* expressions          */
  var SNAP = { k: 900, d: 60, eps: 0.003 };     /* blinks               */

  function ch(v) {
    return { v: v, target: v, vel: 0, amp: 0, freq: 0, decay: 0, phase: 0 };
  }

  function stepChannel(c, dt, p) {
    /* Sub-stepped so a long frame (backgrounded tab, GC pause) can never
       push the spring past its stability limit and explode it. */
    var steps = dt > 0.02 ? Math.min(10, Math.ceil(dt / 0.01)) : 1;
    var h = dt / steps;
    for (var i = 0; i < steps; i++) {
      var dx = c.target - c.v;
      if (dx !== 0 || c.vel !== 0) {
        c.vel += (dx * p.k - c.vel * p.d) * h;
        c.v += c.vel * h;
        if (Math.abs(c.target - c.v) < p.eps && Math.abs(c.vel) < p.eps * 14) {
          c.v = c.target;
          c.vel = 0;
        }
      }
    }
    if (c.amp !== 0) {
      c.phase += c.freq * TAU * dt;
      c.amp *= Math.exp(-c.decay * dt);
      if (Math.abs(c.amp) < 0.04) c.amp = 0;
    }
  }

  /* Decaying oscillator layered on a channel — the accent/animation layer */
  function kick(c, amp, freq, decay) {
    c.amp = amp;
    c.freq = freq;
    c.decay = decay;
    c.phase = 0;
  }

  function chVal(c) {
    return c.amp !== 0 ? c.v + c.amp * Math.sin(c.phase) : c.v;
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
  }

  function rnd(lo, hi) {
    return lo + Math.random() * (hi - lo);
  }

  // ── RobotController ─────────────────────────────────────────────────────
  /**
   * Drives the layered 3D robot: idle life (floating, breathing, blinking,
   * head drift, antenna sway), personality accents, eye tracking, a magnetic
   * cursor response, autonomous travel with takeoff and landing, scroll
   * awareness, sleep/wake, and per-state expressions for the chatbot
   * lifecycle.
   *
   * Communicates with the Chatbot controller via custom events:
   *   chatbot:open         → robot takes on its docked pose
   *   chatbot:listening    → attentive pose, gaze to the chat input
   *   chatbot:thinking     → focused pose, slow antenna pulse, thinking dots
   *   chatbot:responding   → double blink, nod, antenna flash, upward lift
   *   chatbot:notification → head turn, antenna pulse, soft glow
   *   chatbot:error        → concerned tilt, short warning antenna pulse
   *   chatbot:success      → arms-up celebration
   *   chatbot:close        → settles back into idle
   */
  function createRobotController(container, config) {
    var robotEl = container.querySelector('#chatbotRobot');
    if (!robotEl) {
      return {
        setState: function () {},
        playClick: function () {},
        showAttention: function () {},
        isChatOpen: function () { return false; },
        destroy: function () {}
      };
    }

    var parts = {
      float: robotEl.querySelector('.robot__float'),
      shadow: robotEl.querySelector('.robot__shadow'),
      glow: robotEl.querySelector('.robot__glow'),
      antenna: robotEl.querySelector('.robot__antenna'),
      tip: robotEl.querySelector('.robot__antenna-tip'),
      armL: robotEl.querySelector('.robot__arm--left'),
      armR: robotEl.querySelector('.robot__arm--right'),
      torso: robotEl.querySelector('.robot__torso'),
      core: robotEl.querySelector('.robot__core'),
      head: robotEl.querySelector('.robot__head'),
      eyeL: robotEl.querySelector('.robot__eye--left'),
      eyeR: robotEl.querySelector('.robot__eye--right'),
      pupilL: robotEl.querySelector('.robot__eye--left .robot__pupil'),
      pupilR: robotEl.querySelector('.robot__eye--right .robot__pupil'),
      lidL: robotEl.querySelector('.robot__eye--left .robot__lid'),
      lidR: robotEl.querySelector('.robot__eye--right .robot__lid'),
      browL: robotEl.querySelector('.robot__brow--left'),
      browR: robotEl.querySelector('.robot__brow--right'),
      mouth: robotEl.querySelector('.robot__mouth')
    };

    /* ── Environment ── */
    var mqMotion = global.matchMedia ? global.matchMedia('(prefers-reduced-motion: reduce)') : null;
    var reduced = !!(mqMotion && mqMotion.matches);
    var viewport = { w: 0, h: 0 };
    var intensity = 1;        /* global amplitude scale (mobile / reduced) */
    var safeZones = [];
    var zoneMetrics = { w: 96, h: 110, margin: 28, mobile: false };

    /* ── Channels ── */
    var C = {
      posX: ch(28), posY: ch(28),      /* viewport offset, spring-soft   */
      scale: ch(1), squash: ch(0),      /* overall size + press squash   */
      lift: ch(0),                      /* takeoff / altitude            */
      bob: ch(0),                       /* idle float                    */
      leanX: ch(0), leanZ: ch(0),       /* magnetic lean, travel bank     */
      torso: ch(1),                     /* breathing                     */
      yaw: ch(0), pitch: ch(0), tilt: ch(0),
      eyeX: ch(0), eyeY: ch(0), eyeOpen: ch(1),
      smile: ch(0), brow: ch(0), mouthOpen: ch(0),
      armL: ch(10), armR: ch(-10),
      ant: ch(0), antSpin: ch(0), antGlow: ch(0),
      core: ch(1), glow: ch(0),
      shadow: ch(1), shadowO: ch(0.5)
    };
    var PARAM = {
      posX: SOFT, posY: SOFT, scale: SPRING, squash: FAST, lift: SPRING,
      bob: SPRING, leanX: SPRING, leanZ: SPRING, torso: SPRING,
      yaw: FAST, pitch: FAST, tilt: FAST,
      eyeX: FAST, eyeY: FAST, eyeOpen: SNAP,
      smile: FAST, brow: FAST, mouthOpen: FAST,
      armL: SPRING, armR: SPRING,
      ant: SPRING, antSpin: SPRING, antGlow: FAST,
      core: SPRING, glow: SPRING, shadow: SPRING, shadowO: SPRING
    };

    /* ── Runtime flags ── */
    var running = false;
    var rafId = null;
    var lastTime = 0;
    var clock = 0;              /* animation time, in seconds           */
    var state = 'idle';
    var chatOpen = false;
    var hovered = false;
    var asleep = false;
    var lastActivity = 0;   /* seconds on the animation clock */
    var pointer = { x: null, y: null };
    var proximity = 0;          /* 0..1 cursor nearness                */
    var scrollLean = 0;
    var scrollLeanTarget = 0;
    var scrollIntensity = 0;
    var gazeLock = null;        /* explicit gaze override              */
    var proximityHold = false;
    var peekActive = false;

    /* ── Timers ── */
    var timers = {};
    function later(name, ms, fn) {
      clearTimeout(timers[name]);
      timers[name] = setTimeout(function () { delete timers[name]; fn(); }, ms);
    }
    function cancel(name) {
      clearTimeout(timers[name]);
      delete timers[name];
    }

    /* ── Viewport & safe zones ── */
    function isMobileViewport() {
      var w = document.documentElement.clientWidth || window.innerWidth;
      return w <= 768;
    }

    function readViewport() {
      /* clientWidth/Height, not innerWidth/Height: the fixed-position
         containing block excludes classic scrollbars, so zone maths has to
         use the layout viewport or the robot parks under the scrollbar. */
      var doc = document.documentElement;
      viewport.w = doc.clientWidth || window.innerWidth;
      viewport.h = doc.clientHeight || window.innerHeight;
      zoneMetrics.mobile = isMobileViewport();
      zoneMetrics.w = zoneMetrics.mobile ? 78 : (viewport.w <= 1024 ? 88 : 96);
      zoneMetrics.h = Math.round(zoneMetrics.w * 1.15);
      zoneMetrics.margin = zoneMetrics.mobile ? 16 : 28;
    }

    function calculateSafeZones() {
      readViewport();
      var m = zoneMetrics.margin;
      var w = zoneMetrics.w;
      var h = zoneMetrics.h;
      /* The robot drifts across the whole viewport on every device, so both
         mobile and desktop get the same four resting spots. Keeping the
         bottom row clear of the extreme corners avoids the notch and the
         home indicator on phones. */
      var topOffset = clamp(Math.round(viewport.h * 0.14), 96, 140);
      var topBottom = Math.max(m, viewport.h - h - topOffset);
      safeZones = [
        { x: viewport.w - w - m, y: topBottom },
        { x: m, y: topBottom },
        { x: viewport.w - w - m, y: m },
        { x: m, y: m }
      ];
    }

    function currentZoneIndex() {
      var x = Math.round(C.posX.target), y = Math.round(C.posY.target);
      for (var i = 0; i < safeZones.length; i++) {
        if (Math.abs(safeZones[i].x - x) < 3 && Math.abs(safeZones[i].y - y) < 3) return i;
      }
      return -1;
    }

    function clampToSafeArea(x, y) {
      var m = zoneMetrics.margin;
      var maxX = Math.max(m, viewport.w - zoneMetrics.w - m);
      var maxY = Math.max(m, viewport.h - zoneMetrics.h - m);
      return { x: clamp(x, m, maxX), y: clamp(y, m, maxY) };
    }

    /* ── State machine ──
     * Each state only describes the resting pose of every channel; the springs
     * do the rest. That is what makes state changes read as transitions
     * rather than swaps.
     */
    var POSES = {
      idle: {
        scale: 1, lift: 0, torso: 1, yaw: 0, pitch: 0, tilt: 0,
        eyeOpen: 1, smile: 0.15, brow: 0, mouthOpen: 0,
        armL: 10, armR: -10, ant: 0, antGlow: 0.12, glow: 0, core: 1
      },
      hover: {
        scale: 1.09, lift: 3, torso: 1, yaw: 0, pitch: -3, tilt: 0,
        eyeOpen: 1, smile: 0.45, brow: 0.35, mouthOpen: 0,
        armL: 16, armR: -16, ant: 0, antGlow: 0.55, glow: 0.5, core: 1.08
      },
      curious: {
        scale: 1.05, lift: 2, torso: 1, yaw: 0, pitch: -6, tilt: 12,
        eyeOpen: 1.12, smile: 0.3, brow: 0.75, mouthOpen: 0.15,
        armL: 14, armR: -12, ant: 0, antGlow: 0.7, glow: 0.42, core: 1.05
      },
      chatOpen: {
        scale: 0.98, lift: 1, torso: 1, yaw: 0, pitch: -4, tilt: 0,
        eyeOpen: 1, smile: 0.35, brow: 0.2, mouthOpen: 0,
        armL: 8, armR: -8, ant: 0, antGlow: 0.4, glow: 0.34, core: 1
      },
      listening: {
        scale: 1, lift: 1.5, torso: 1, yaw: 0, pitch: -5, tilt: 0,
        eyeOpen: 1.06, smile: 0.25, brow: 0.5, mouthOpen: 0,
        armL: 9, armR: -9, ant: 0, antGlow: 0.6, glow: 0.3, core: 1.04
      },
      thinking: {
        scale: 0.99, lift: 2.5, torso: 1, yaw: 6, pitch: 5, tilt: -3,
        eyeOpen: 0.78, smile: 0.1, brow: 0.85, mouthOpen: 0.35,
        armL: 6, armR: -22, ant: 0, antGlow: 0.85, glow: 0.28, core: 1
      },
      responding: {
        scale: 1.04, lift: 5, torso: 1, yaw: 0, pitch: -7, tilt: 0,
        eyeOpen: 1, smile: 0.8, brow: 0.3, mouthOpen: 0.1,
        armL: 12, armR: -12, ant: 0, antGlow: 1, glow: 0.55, core: 1.12
      },
      notification: {
        scale: 1.03, lift: 2, torso: 1, yaw: 12, pitch: -4, tilt: -4,
        eyeOpen: 1, smile: 0.5, brow: 0.6, mouthOpen: 0,
        armL: 10, armR: -20, ant: 0, antGlow: 0.95, glow: 0.6, core: 1.1
      },
      error: {
        scale: 0.97, lift: 0, torso: 1, yaw: 0, pitch: 4, tilt: -13,
        eyeOpen: 0.72, smile: -0.35, brow: 0.9, mouthOpen: 0.2,
        armL: 4, armR: -4, ant: 0, antGlow: 0.9, glow: 0.22, core: 0.9
      },
      success: {
        scale: 1.06, lift: 8, torso: 1, yaw: 0, pitch: -6, tilt: 0,
        eyeOpen: 1, smile: 1, brow: 0.4, mouthOpen: 0.25,
        armL: 150, armR: -150, ant: 0, antGlow: 1, glow: 0.7, core: 1.2
      },
      sleep: {
        scale: 0.96, lift: 0, torso: 0.97, yaw: 0, pitch: 9, tilt: 5,
        eyeOpen: 0.2, smile: 0.05, brow: -0.2, mouthOpen: 0,
        armL: 4, armR: -4, ant: 0, antGlow: 0.04, glow: 0, core: 0.7
      }
    };

    /* Channels that still move a little under prefers-reduced-motion: state
       changes stay legible, but the range of motion is halved. */
    var REDUCED_RANGE = {
      yaw: 0.5, pitch: 0.5, tilt: 0.5, lift: 0.4, armL: 0.4, armR: 0.4,
      bob: 0, leanX: 0, leanZ: 0, torso: 0
    };

    /* Sets a channel directly, honouring the reduced-motion range */
    function hold(key, value) {
      if (reduced && REDUCED_RANGE[key] !== undefined) value *= REDUCED_RANGE[key];
      C[key].target = value;
    }

    function applyPose(name) {
      var pose = POSES[name] || POSES.idle;
      for (var key in pose) {
        if (Object.prototype.hasOwnProperty.call(pose, key) && C[key]) {
          var v = pose[key];
          if (reduced && REDUCED_RANGE[key] !== undefined) v *= REDUCED_RANGE[key];
          C[key].target = v;
        }
      }
    }

    var STATE_CLASSES = /(^|\s)robot--(idle|hover|curious|chat-open|listening|thinking|responding|notification|error|success|sleep|moving|landing|attention)(\s|$)/g;

    function setState(name) {
      if (state === name) return;
      state = name;
      applyPose(name);
      robotEl.className = robotEl.className.replace(STATE_CLASSES, ' ').replace(/\s+/g, ' ').trim();
      robotEl.classList.add('robot--' + name);
    }

    /* ── Idle life: the continuous, low-frequency part of the character ── */
    function idleDrive(dt) {
      var t = clock;
      var calm = reduced ? 0 : (asleep ? 0.25 : 1) * intensity;
      var floatAmp = calm * (chatOpen ? 1.3 : 2.3) * (1 - scrollIntensity * 0.5);
      var drift = 1 - Math.exp(-dt * 1.2);   /* frame-rate independent */

      /* Two detuned sines so the float never looks metronomic */
      C.bob.target = (Math.sin(t * 1.36) * 0.62 + Math.sin(t * 0.83 + 1.7) * 0.38) * floatAmp;

      /* Breathing: shoulders expand a touch on a slow cycle */
      C.torso.target = 1 + Math.sin(t * 1.7) * 0.022 * calm;

      /* Head drift and antenna sway — present but never busy */
      if (!asleep && !chatOpen) {
        C.yaw.target += (Math.sin(t * 0.51) * 3.4 * calm - C.yaw.target) * drift;
        C.ant.target = Math.sin(t * 1.1) * 4.5 * calm;
        C.antSpin.target = Math.sin(t * 0.37) * 6 * calm;
      }
      if (asleep) C.antGlow.target = 0.04;
    }

    /* ── Blinking ── */
    var blinkRestore = null;
    function scheduleBlink() {
      if (reduced) return;
      var lo = asleep ? 6000 : config.blinkIntervalMin;
      var hi = asleep ? 11000 : config.blinkIntervalMax;
      later('blink', rnd(lo, hi), function () {
        blink();
        scheduleBlink();
      });
    }

    function blink(ms) {
      if (blinkRestore !== null) return;
      blinkRestore = C.eyeOpen.target;
      C.eyeOpen.target = 0.02;
      later('blinkOpen', ms || 105, function () {
        C.eyeOpen.target = blinkRestore;
        blinkRestore = null;
        if (Math.random() < 0.18 && !asleep) later('blink2', 170, function () { blink(90); });
      });
    }

    /* ── Personality accents (idle only, never while busy) ── */
    function schedulePersonality() {
      if (reduced) return;
      later('personality', rnd(config.personalityIntervalMin, config.personalityIntervalMax), function () {
        personalityBeat();
        schedulePersonality();
      });
    }

    function personalityBeat() {
      if (reduced || asleep || chatOpen || state === 'moving' || state === 'landing') return;
      if (state !== 'idle' && state !== 'curious' && state !== 'hover') return;
      var dir = Math.random() < 0.5 ? 1 : -1;
      var pick = Math.random();
      if (pick < 0.24) {
        kick(C.tilt, rnd(6, 11) * dir, 0.5, 0.45);      /* head tilt     */
        kick(C.ant, rnd(3, 6), 0.8, 0.7);
      } else if (pick < 0.44) {
        kick(C.yaw, rnd(8, 14) * dir, 0.32, 0.4);      /* look around   */
        kick(C.eyeX, 2.4 * dir, 0.5, 0.6);
      } else if (pick < 0.62) {
        kick(C.pitch, 7, 0.9, 1.5);                     /* nod           */
        kick(C.armR, -9, 0.9, 1.6);
      } else if (pick < 0.78) {
        kick(C.ant, rnd(10, 16), 1.1, 1.1);             /* antenna flick */
        kick(C.antGlow, 0.45, 1.6, 1.8);
      } else if (pick < 0.9) {
        kick(C.leanZ, rnd(3, 5) * dir, 0.45, 0.6);     /* small adjust  */
        kick(C.bob, 3.5, 0.5, 0.9);
      } else {
        kick(C.torso, 0.035, 0.35, 0.35);               /* idle hum      */
        kick(C.core, 0.3, 0.9, 0.8);
        kick(C.smile, 0.3, 0.8, 0.9);
      }
    }

    /* ── Attention: an occasional, never-repeating nudge ── */
    function scheduleAttention() {
      if (reduced) return;
      later('attention', rnd(config.attentionIntervalMin, config.attentionIntervalMax), function () {
        playAttention();
        scheduleAttention();
      });
    }

    function playAttention() {
      if (reduced || asleep || chatOpen || travel.active) return;
      setState('attention');
      C.glow.target = 0.75;
      kick(C.ant, 16, 1.4, 1.2);
      kick(C.antGlow, 0.6, 1.8, 1.4);
      kick(C.bob, 4, 0.85, 1.3);
      kick(C.tilt, 5, 0.7, 0.9);
      blink(80);
      later('attentionBack', 2600, function () {
        if (state === 'attention') setState('idle');
      });
    }

    /* ── Peek: rare personality cameo from the screen edge ── */
    function schedulePeek() {
      if (reduced) return;
      later('peek', rnd(config.peekIntervalMin, config.peekIntervalMax), function () {
        playPeek();
        schedulePeek();
      });
    }

    function playPeek() {
      if (reduced || asleep || chatOpen || hovered || travel.active) return;
      peekActive = true;
      var from = { x: C.posX.v, y: C.posY.v };
      /* `x` is a right-offset, so a small value means "on the right" — peek
         off whichever edge the robot is already closest to. */
      var atRight = from.x < viewport.w / 2;
      travelTo(atRight
        ? Math.min(viewport.w - 30, from.x + 44)
        : Math.max(-30, from.x - 44), from.y, 900);
      C.tilt.target = atRight ? 10 : -10;
      C.yaw.target = atRight ? -12 : 12;
      C.eyeOpen.target = 1.15;
      C.glow.target = 0.5;
      C.antGlow.target = 0.9;
      C.lift.target = 4;
      kick(C.ant, 12, 1.2, 1.0);
      later('peekBack', 1700, function () {
        if (!peekActive) return;
        peekActive = false;
        var home = clampToSafeArea(from.x, from.y);
        travelTo(home.x, home.y, 1000);
        C.tilt.target = 0;
        C.lift.target = 0;
        C.glow.target = 0;
        C.antGlow.target = 0.12;
        if (state === 'idle' || state === 'curious') C.eyeOpen.target = 1;
      });
    }

    /* ── Autonomous travel: takeoff → cruise → landing → settle ──
     * Travel is kinematic rather than a spring: a timed smoothstep gives a
     * predictable takeoff, a readable cruise and an exact touchdown, and the
     * duration scales with the distance so a short hop and a full crossing of
     * the screen both look unhurried.
     */
    var travel = { active: false };
    var mover = { active: false, x0: 0, y0: 0, x1: 0, y1: 0, t: 0, dur: 1, onDone: null };

    function travelDuration(dist) {
      return clamp(1500 + dist * 1.9, 1800, 4600);
    }

    function travelTo(x, y, dur, onDone) {
      mover.active = true;
      mover.x0 = C.posX.v;
      mover.y0 = C.posY.v;
      mover.x1 = x;
      mover.y1 = y;
      mover.t = 0;
      mover.dur = Math.max(200, dur);
      mover.onDone = onDone || null;
      C.posX.target = x;
      C.posY.target = y;
    }

    /* Keeps the current velocity and redirects to a new destination */
    function retargetTravel(x, y) {
      if (!mover.active) { C.posX.target = x; C.posY.target = y; return; }
      var dx = x - C.posX.v;
      var dy = y - C.posY.v;
      travelTo(x, y, travelDuration(Math.sqrt(dx * dx + dy * dy)), mover.onDone);
    }

    function stopTravel() {
      travel.active = false;
      peekActive = false;
      mover.active = false;
      mover.onDone = null;
    }

    function scheduleNextMove() {
      if (reduced) return;
      if (hovered || chatOpen || asleep || travel.active || peekActive) return;
      later('move', rnd(config.movementIntervalMin, config.movementIntervalMax), startTravel);
    }

    function startTravel() {
      if (safeZones.length < 2) return;
      var from = currentZoneIndex();
      var next = from;
      while (next === from) {
        next = Math.floor(Math.random() * safeZones.length);
      }
      var zone = safeZones[next];
      travel.active = true;
      setState('moving');
      /* Takeoff: rise a little and bank into the direction of travel */
      C.lift.target = 7;
      C.antGlow.target = 0.7;
      C.eyeOpen.target = 1.05;
      kick(C.bob, 3, 0.8, 0.9);
      kick(C.ant, 14, 1.1, 0.7);
      kick(C.armL, 10, 1.4, 0.5);
      kick(C.armR, -10, 1.4, 0.5);
      travelTo(zone.x, zone.y, travelDuration(Math.sqrt(
        Math.pow(zone.x - C.posX.v, 2) + Math.pow(zone.y - C.posY.v, 2)
      )), land);
    }

    function land() {
      travel.active = false;
      setState('landing');
      C.lift.target = 0;
      C.antGlow.target = 0.12;
      C.leanZ.target = 0;
      C.tilt.target = 0;
      C.yaw.target = 0;
      /* Touch down, then a soft hover bounce */
      kick(C.bob, -4, 0.75, 1.15);
      kick(C.torso, -0.05, 0.75, 1.1);
      later('landed', 950, function () {
        if (state === 'landing') setState('idle');
        C.eyeOpen.target = 1;
        scheduleNextMove();
      });
    }

    function updateMover(dt) {
      if (!mover.active) return;
      mover.t += dt * 1000;   /* mover timings are in milliseconds */
      var u = clamp(mover.t / mover.dur, 0, 1);
      /* smoothstep: zero velocity at both ends, fastest in the middle */
      var e = u * u * (3 - 2 * u);
      var dx = mover.x1 - mover.x0;
      var dy = mover.y1 - mover.y0;
      var span = Math.sqrt(dx * dx + dy * dy) || 1;
      C.posX.v = C.posX.target = mover.x0 + dx * e;
      C.posY.v = C.posY.target = mover.y0 + dy * e;
      if (travel.active) {
        /* Bank, lean and limb swing scale with actual speed and direction */
        var speed = (6 * u * (1 - u) * span / mover.dur) / 260;
        var dirX = dx / span;
        var dirY = dy / span;
        C.leanZ.target = clamp(-dirX * 6 * speed, -7, 7) * intensity;
        C.yaw.target = clamp(dirX * 14 * speed, -14, 14) * intensity;
        C.pitch.target = clamp(dirY * 5 * speed, -5, 5) * intensity;
        C.tilt.target = clamp(-dirX * 5 * speed, -6, 6) * intensity;
        C.armL.target = 12 + clamp(speed * 14, 0, 12);
        C.armR.target = -12 - clamp(speed * 14, 0, 12);
        C.ant.target = Math.sin(clock * 2.2) * 7;
      }
      if (u >= 1) {
        mover.active = false;
        var done = mover.onDone;
        mover.onDone = null;
        if (done) done();
      }
    }

    /* ── Gaze: eyes follow the cursor, or the chat input while docked ── */
    function gazePoint() {
      if (gazeLock) return gazeLock;
      if (chatOpen) {
        var input = container.querySelector('#chatbotInput');
        if (input) {
          var r = input.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }
      }
      if (pointer.x !== null) return pointer;
      return null;
    }

    function updateGaze() {
      var g = gazePoint();
      if (!g || reduced) { proximity = 0; return; }
      /* Derived from the known geometry rather than getBoundingClientRect,
         so tracking the cursor never forces a layout every frame. */
      var cx = viewport.w - C.posX.v - zoneMetrics.w / 2;
      var cy = viewport.h - C.posY.v - zoneMetrics.h * 0.6;
      var dx = g.x - cx;
      var dy = g.y - cy;
      var dist = Math.sqrt(dx * dx + dy * dy);

      proximity = clamp(1 - dist / 240, 0, 1);
      var nx = dist > 0.001 ? dx / dist : 0;
      var ny = dist > 0.001 ? dy / dist : 0;
      var attn = (chatOpen ? 1 : proximity) * intensity;

      C.eyeX.target = clamp(nx * 2.1 * attn, -2.4, 2.4);
      C.eyeY.target = clamp(ny * 1.7 * attn, -1.8, 1.8);

      if (!chatOpen) {
        /* Head follows more slowly than the eyes, and only when nearby */
        C.yaw.target += (clamp(nx * 15 * proximity, -15, 15) - C.yaw.target) * 0.12;
        C.pitch.target += (clamp(-ny * 11 * proximity, -9, 9) - C.pitch.target) * 0.12;
        /* Magnetic lean: a few pixels toward the pointer, never in the way */
        C.leanX.target = nx * 4.5 * proximity * intensity;
        C.glow.target = Math.max(state === 'hover' ? 0.5 : 0, proximity * 0.5);
        if (!hovered) C.scale.target = 1 + proximity * 0.05 * intensity;
      }

      /* Lingering nearby reads as curiosity */
      if (!hovered && !chatOpen && !asleep && state === 'idle') {
        if (proximity > 0.5 && !proximityHold) {
          proximityHold = true;
          later('curious', 1000, function () {
            if (proximity > 0.42 && state === 'idle' && !hovered && !chatOpen) {
              setState('curious');
              kick(C.tilt, 5, 0.6, 0.7);
              kick(C.ant, 9, 0.9, 0.8);
              later('curiousBack', 3400, function () {
                if (state === 'curious') setState('idle');
              });
            }
          });
        }
      } else if (proximityHold) {
        cancel('curious');
        proximityHold = false;
        if (state === 'curious') setState('idle');
      }
    }

    /* ── Sleep & wake ── */
    function markActivity() {
      lastActivity = clock;
      if (asleep) wake();
    }

    function sleep() {
      if (asleep) return;
      asleep = true;
      cancel('peek');
      cancel('attention');
      cancel('move');
      cancel('curious');
      proximityHold = false;
      stopTravel();
      setState('sleep');
      C.glow.target = 0;
      C.lift.target = 0;
    }

    function wake() {
      if (!asleep) return;
      asleep = false;
      setState(chatOpen ? 'chatOpen' : 'idle');
      C.eyeOpen.target = 1;
      C.antGlow.target = 0.8;
      kick(C.pitch, -7, 0.6, 0.8);     /* head lifts  */
      kick(C.scale, 0.05, 0.55, 0.7);  /* little stretch */
      kick(C.torso, 0.06, 0.55, 0.7);
      kick(C.ant, 14, 1.0, 0.9);
      blink(90);
      later('wakeGlow', 2600, function () { C.antGlow.target = 0.12; });
      if (!reduced) {
        schedulePeek();
        scheduleAttention();
        scheduleNextMove();
        later('sleepCheck', 15000, sleepCheck);
      }
    }

    function sleepCheck() {
      if (asleep) return;
      if (chatOpen) {
        lastActivity = clock;
      } else if (clock - lastActivity > config.sleepAfter / 1000) {
        sleep();
        return;
      }
      later('sleepCheck', Math.max(5000, Math.round(config.sleepAfter / 4)), sleepCheck);
    }

    /* ── Scroll awareness ──
       The lean is eased in the frame loop, never written straight from the
       scroll handler: one wheel tick can be several hundred pixels, so a raw
       delta saturated the lean immediately and flipped it on every direction
       change, which read as the robot twitching instead of leaning. */
    var lastScrollY = window.pageYOffset || 0;
    function onScroll() {
      var y = window.pageYOffset || 0;
      var delta = y - lastScrollY;
      lastScrollY = y;
      if (Math.abs(delta) > 1) {
        scrollLeanTarget = clamp(-delta / 320, -1, 1);
        scrollIntensity = 1;
      }
      markActivity();
      /* Autonomous travel pauses while the reader is scrolling */
      if (!asleep && !chatOpen && !hovered && !travel.active) {
        cancel('move');
        later('move', config.movementIntervalMin, scheduleNextMove);
      }
    }

    /* The attack is deliberately slower than the scroll: the lean lags the
       page and catches up, the way a body shifts its weight, rather than
       tracking each wheel tick and twitching with it. */
    function updateScrollLean(dt) {
      var rising = Math.abs(scrollLeanTarget) > Math.abs(scrollLean);
      scrollLean += (scrollLeanTarget - scrollLean) * Math.min(1, dt * (rising ? 5.5 : 2.6));
      if (Math.abs(scrollLeanTarget) < 0.004) scrollLeanTarget = 0;
      if (scrollLeanTarget === 0 && Math.abs(scrollLean) < 0.004) scrollLean = 0;
    }

    /* ── Frame loop ── */
    function tick(now) {
      rafId = global.requestAnimationFrame(tick);
      if (!lastTime) lastTime = now;
      var dt = (now - lastTime) / 1000;
      lastTime = now;
      if (dt > 0.1) dt = 0.1;   /* the tab was hidden — do not explode */
      clock += dt;

      scrollIntensity = Math.max(0, scrollIntensity - dt * 0.9);
      updateScrollLean(dt);

      idleDrive(dt);
      updateMover(dt);
      updateGaze();
      updateShadow();

      for (var key in C) {
        if (Object.prototype.hasOwnProperty.call(C, key)) {
          stepChannel(C[key], dt, PARAM[key] || SPRING);
        }
      }
      render();
    }

    /* Shadow reacts to altitude and to the robot riding closer to the page */
    function updateShadow() {
      var lift = C.lift.v;
      C.shadow.target = clamp((1 - lift * 0.035) * (1 + proximity * 0.22), 0.6, 1.35);
      C.shadowO.target = clamp(0.5 - lift * 0.022 + proximity * 0.12, 0.16, 0.7);
    }

    function render() {
      var s = chVal(C.scale);
      var squash = C.squash.v;
      var bob = chVal(C.bob);
      var lift = C.lift.v;

      /* Container position (spring-interpolated, never linear) */
      var px = Math.round(C.posX.v);
      var py = Math.round(C.posY.v);
      if (container._rx !== px) { container.style.right = px + 'px'; container._rx = px; }
      if (container._ry !== py) { container.style.bottom = py + 'px'; container._ry = py; }

      /* Float root: bob, magnetic lean, travel bank */
      if (parts.float) {
        parts.float.style.transform =
          'translate3d(' + C.leanX.v.toFixed(2) + 'px,' + (-lift * 1.6 + bob).toFixed(2) + 'px,0)' +
          ' rotateZ(' + (C.leanZ.v + scrollLean * 1.6 * intensity).toFixed(2) + 'deg)' +
          ' scale(' + s.toFixed(4) + ',' + (s * (1 + squash * 0.9) - squash * 0.35 * s).toFixed(4) + ')';
      }

      /* Ground shadow */
      if (parts.shadow) {
        var sh = C.shadow.v;
        parts.shadow.style.transform = 'translate(-50%,0) scale(' + sh.toFixed(3) + ',' + (sh * 0.9).toFixed(3) + ')';
        parts.shadow.style.opacity = C.shadowO.v.toFixed(3);
      }

      /* Glow halo */
      if (parts.glow) {
        var g = C.glow.v;
        parts.glow.style.opacity = g.toFixed(3);
        parts.glow.style.transform = 'scale(' + (0.82 + g * 0.4).toFixed(3) + ')';
      }

      /* Antenna: sway, spin, and an independent glow reaction */
      if (parts.antenna) {
        parts.antenna.style.transform =
          'rotate(' + (chVal(C.ant) + C.antSpin.v * 0.5).toFixed(2) + 'deg) rotateY(' + C.antSpin.v.toFixed(2) + 'deg)';
      }
      if (parts.tip) {
        var ag = clamp(chVal(C.antGlow), 0, 1.3);
        parts.tip.style.transform = 'scale(' + (1 + ag * 0.2).toFixed(3) + ')';
        if (ag > 0.05) {
          parts.tip.style.boxShadow = '0 0 ' + (ag * 9).toFixed(1) + 'px ' + (ag * 2.2).toFixed(1) + 'px rgba(236,104,73,' + (ag * 0.7).toFixed(2) + ')';
        } else {
          parts.tip.style.boxShadow = 'none';
        }
      }

      /* Arms */
      if (parts.armL) parts.armL.style.transform = 'rotate(' + chVal(C.armL).toFixed(2) + 'deg)';
      if (parts.armR) parts.armR.style.transform = 'rotate(' + chVal(C.armR).toFixed(2) + 'deg)';

      /* Torso breathing and chest light */
      if (parts.torso) {
        var br = chVal(C.torso);
        parts.torso.style.transform = 'scale(' + (2 - br).toFixed(4) + ',' + br.toFixed(4) + ')';
      }
      if (parts.core) {
        var coreV = chVal(C.core);
        parts.core.style.transform = 'scale(' + (1 + (coreV - 1) * 0.12).toFixed(3) + ')';
        if (coreV > 1.06) {
          parts.core.style.boxShadow = '0 0 ' + ((coreV - 1) * 18).toFixed(1) + 'px rgba(236,104,73,' + ((coreV - 1) * 1.3).toFixed(2) + ')';
        } else {
          parts.core.style.boxShadow = 'none';
        }
      }

      /* Head: look, lean and tilt all interpolate independently */
      if (parts.head) {
        parts.head.style.transform =
          'rotateY(' + chVal(C.yaw).toFixed(2) + 'deg)' +
          ' rotateX(' + (chVal(C.pitch) * 0.9).toFixed(2) + 'deg)' +
          ' rotateZ(' + chVal(C.tilt).toFixed(2) + 'deg)';
      }

      /* Eyes: pupil tracking with lids that close for blinks and sleep */
      var open = clamp(C.eyeOpen.v, 0, 1.35);
      var lid = clamp(1 - open, 0, 1);
      var gx = chVal(C.eyeX).toFixed(2);
      var gy = chVal(C.eyeY).toFixed(2);
      if (parts.pupilL) parts.pupilL.style.transform = 'translate(' + gx + 'px,' + gy + 'px)';
      if (parts.pupilR) parts.pupilR.style.transform = 'translate(' + gx + 'px,' + gy + 'px)';
      if (parts.eyeL) parts.eyeL.style.transform = 'scaleY(' + Math.max(0.06, open).toFixed(3) + ')';
      if (parts.eyeR) parts.eyeR.style.transform = 'scaleY(' + Math.max(0.06, open).toFixed(3) + ')';
      if (parts.lidL) parts.lidL.style.transform = 'scaleY(' + lid.toFixed(3) + ')';
      if (parts.lidR) parts.lidR.style.transform = 'scaleY(' + lid.toFixed(3) + ')';

      /* Brows: focus, curiosity, concern */
      var bw = C.brow.v;
      var bAbs = clamp(Math.abs(bw), 0, 1).toFixed(2);
      if (parts.browL) {
        parts.browL.style.opacity = bAbs;
        parts.browL.style.transform = 'translateY(' + (-bw * 3).toFixed(2) + 'px) rotate(' + (-bw * 8).toFixed(2) + 'deg)';
      }
      if (parts.browR) {
        parts.browR.style.opacity = bAbs;
        parts.browR.style.transform = 'translateY(' + (bw * 1.2).toFixed(2) + 'px) rotate(' + (bw * 8).toFixed(2) + 'deg)';
      }

      /* Mouth: neutral → smile → small "o" while thinking */
      if (parts.mouth) {
        var sm = clamp(C.smile.v, -1, 1.2);
        var mo = clamp(C.mouthOpen.v, 0, 1);
        parts.mouth.style.transform =
          'scaleX(' + (0.85 - mo * 0.45 + sm * 0.12).toFixed(3) + ') scaleY(' + (1 + sm * 1.5 + mo * 1.2).toFixed(3) + ')';
      }
    }

    function start() {
      if (running) return;
      running = true;
      lastTime = 0;
      rafId = global.requestAnimationFrame(tick);
    }

    function stop() {
      running = false;
      if (rafId) global.cancelAnimationFrame(rafId);
      rafId = null;
    }

    /* ── Interaction handlers ── */
    function onPointerMove(e) {
      pointer.x = e.clientX;
      pointer.y = e.clientY;
      markActivity();
    }

    function onPointerEnter() {
      hovered = true;
      cancel('move');
      if (!asleep) {
        setState('hover');
        C.antGlow.target = 0.6;
      }
      showTooltip();
    }

    function onPointerLeave() {
      hovered = false;
      if (!asleep && !chatOpen) setState('idle');
      hideTooltipDelayed();
      if (!asleep && !chatOpen) scheduleNextMove();
    }

    function onResize() {
      calculateSafeZones();
      var pinned = clampToSafeArea(mover.active ? C.posX.v : C.posX.target,
                                   mover.active ? C.posY.v : C.posY.target);
      retargetTravel(pinned.x, pinned.y);
    }

    function onVisibility() {
      if (document.hidden) stop(); else start();
    }

    /* ── Tooltip / greeting ── */
    function showTooltip() {
      var tip = container.querySelector('#chatbotTooltip');
      if (!tip) return;
      tip.setAttribute('aria-hidden', 'false');
      tip.classList.add('visible');
      if (!isFirstVisit()) later('tip', 3200, hideTooltip);
    }

    function hideTooltip() {
      var tip = container.querySelector('#chatbotTooltip');
      if (!tip) return;
      tip.setAttribute('aria-hidden', 'true');
      tip.classList.remove('visible');
    }

    function hideTooltipDelayed() {
      later('tip', 2200, hideTooltip);
    }

    function isFirstVisit() {
      try {
        var key = 'chatbot_robot_greeting_' + window.location.pathname;
        var lastSeen = parseFloat(sessionStorage.getItem(key) || '0');
        var now = Date.now();
        if (now - lastSeen < config.greetingInterval) return false;
        sessionStorage.setItem(key, String(now));
        return true;
      } catch (e) {
        return false;
      }
    }

    function initGreeting() {
      if (!isFirstVisit()) return;
      showTooltip();
      setState('attention');
      C.glow.target = 0.8;
      kick(C.ant, 18, 1.3, 1.1);
      kick(C.bob, 5, 0.9, 1.2);
      later('tip', config.tooltipDuration, hideTooltip);
      later('greet', 2400, function () {
        if (state === 'attention') setState('idle');
      });
    }

    /* ── Chat lifecycle choreography ── */
    function onChatOpen() {
      chatOpen = true;
      cancel('move');
      cancel('peek');
      cancel('attention');
      cancel('curious');
      proximityHold = false;
      /* Docks inside its safe area, wherever the robot happens to be */
      var pinned = clampToSafeArea(C.posX.target, C.posY.target);
      C.posX.target = pinned.x;
      C.posY.target = pinned.y;
      setState('chat-open');
      C.glow.target = 0.34;
      kick(C.bob, 3, 0.7, 1.1);
      kick(C.ant, 12, 1.1, 1.0);
      later('openPose', 600, function () {
        if (chatOpen) setState('listening');
      });
    }

    function onChatClose() {
      chatOpen = false;
      setState('idle');
      C.glow.target = 0;
      /* Settles back into its float with one small bounce */
      kick(C.bob, 5, 0.8, 1.15);
      kick(C.torso, 0.04, 0.8, 1.0);
      hold('lift', 2);
      later('relift', 280, function () { if (!chatOpen) C.lift.target = 0; });
      if (!asleep && !reduced) {
        scheduleNextMove();
        schedulePeek();
        scheduleAttention();
      }
    }

    /* Click: compress, nod, antenna flash — the window then opens from here */
    function playClick() {
      markActivity();
      if (reduced) return;
      C.squash.target = 0.12;
      later('unsquash', 130, function () {
        C.squash.target = 0;
        kick(C.squash, -0.08, 1.1, 1.4);
      });
      kick(C.pitch, 8, 1.0, 1.6);
      kick(C.antGlow, 0.9, 2.2, 2.2);
      kick(C.ant, 16, 1.6, 1.4);
      C.antGlow.target = 0.9;
      C.glow.target = 0.8;
      later('clickGlow', 750, function () {
        if (!chatOpen) C.glow.target = 0;
        C.antGlow.target = 0.2;
      });
    }

    /* ── Chatbot events → robot states ── */
    function onChatbotEvent(name, fn) {
      container.addEventListener('chatbot:' + name, fn);
    }
    onChatbotEvent('open', onChatOpen);
    onChatbotEvent('close', onChatClose);
    onChatbotEvent('listening', function () { if (chatOpen) setState('listening'); });
    onChatbotEvent('idle', function () {
      if (chatOpen) setState('listening');
      else if (!travel.active && !hovered) setState('idle');
    });
    onChatbotEvent('thinking', function () {
      setState('thinking');
      markActivity();
      C.antGlow.target = 0.85;
    });
    onChatbotEvent('responding', function () {
      setState('responding');
      markActivity();
      C.glow.target = 0.6;
      hold('lift', 5);
      kick(C.pitch, -8, 1.1, 1.4);     /* nod          */
      kick(C.bob, 5, 0.7, 0.9);        /* subtle rise  */
      kick(C.antGlow, 0.7, 2.4, 2.0);  /* antenna flash */
      blink(80);
      blink(70);
    });
    onChatbotEvent('notification', function () {
      if (chatOpen) return;
      setState('notification');
      markActivity();
      kick(C.yaw, 14, 0.5, 0.7);      /* head turn */
      kick(C.antGlow, 0.7, 1.6, 1.5);
      C.antGlow.target = 0.7;
      C.glow.target = 0.6;
      later('notifBack', 2400, function () {
        if (state === 'notification') setState('idle');
      });
    });
    onChatbotEvent('error', function () {
      /* Normal movement pauses, then a concerned tilt */
      cancel('move');
      stopTravel();
      setState('error');
      markActivity();
      C.lift.target = 0;
      kick(C.tilt, -9, 0.45, 0.5);
      kick(C.antGlow, 0.6, 2.6, 2.2);  /* short warning pulse */
      kick(C.eyeY, -1.4, 1.4, 1.4);
      later('errorBack', 2600, function () {
        if (state === 'error') setState(chatOpen ? 'listening' : 'idle');
        if (!chatOpen && !asleep) scheduleNextMove();
      });
    });
    onChatbotEvent('success', function () {
      setState('success');
      markActivity();
      hold('lift', 8);
      hold('glow', 0.7);
      kick(C.bob, 6, 1.0, 1.2);
      kick(C.ant, 18, 1.8, 1.4);
      blink(80);
      later('successBack', 1900, function () {
        if (state === 'success') setState(chatOpen ? 'listening' : 'idle');
        hold('lift', 0);
        C.glow.target = chatOpen ? 0.34 : 0;
      });
    });

    /* ── Wire up ── */
    var listeners = [];
    function on(target, type, fn, opts) {
      target.addEventListener(type, fn, opts);
      listeners.push([target, type, fn, opts]);
    }

    on(document, 'mousemove', onPointerMove, { passive: true });
    on(robotEl.parentNode || container, 'mouseenter', onPointerEnter);
    on(robotEl.parentNode || container, 'mouseleave', onPointerLeave);
    on(global, 'scroll', onScroll, { passive: true });
    on(global, 'resize', onResize);
    on(global, 'keydown', markActivity);
    on(global, 'touchstart', markActivity, { passive: true });
    on(document, 'visibilitychange', onVisibility);
    on(container, 'robot:peek', playPeek);
    on(container, 'robot:attention', playAttention);

    /* ── Init ── */
    calculateSafeZones();
    intensity = reduced ? 0 : (isMobileViewport() ? 0.55 : 1);
    var home = safeZones.length ? safeZones[safeZones.length - 1] : { x: 28, y: 28 };
    var startPos = clampToSafeArea(home.x, home.y);
    C.posX.v = C.posX.target = startPos.x;
    C.posY.v = C.posY.target = startPos.y;
    container.style.right = Math.round(startPos.x) + 'px';
    container.style.bottom = Math.round(startPos.y) + 'px';
    setState('idle');
    start();

    if (!reduced) {
      robotEl.style.opacity = '0';
      kick(C.scale, -0.18, 0.5, 0.35);
      later('entrance', 60, function () {
        robotEl.style.transition = 'opacity 0.45s ease';
        robotEl.style.opacity = '1';
        later('entrance2', 540, function () { robotEl.style.transition = ''; });
      });

      initGreeting();
      scheduleBlink();
      schedulePersonality();
      scheduleAttention();
      schedulePeek();
      scheduleNextMove();
      later('sleepCheck', config.sleepAfter, sleepCheck);
    }

    /* Honour a mid-session change to the motion preference */
    function onMotionPreference(e) {
      reduced = e.matches;
      intensity = reduced ? 0 : (isMobileViewport() ? 0.55 : 1);
      if (reduced) {
        ['blink', 'personality', 'attention', 'peek', 'move', 'curious', 'sleepCheck'].forEach(cancel);
        stopTravel();
        setState('idle');
      } else {
        lastActivity = clock;
        scheduleBlink();
        schedulePersonality();
        scheduleAttention();
        schedulePeek();
        scheduleNextMove();
        later('sleepCheck', config.sleepAfter, sleepCheck);
      }
    }
    if (mqMotion) {
      if (typeof mqMotion.addEventListener === 'function') mqMotion.addEventListener('change', onMotionPreference);
      else if (typeof mqMotion.addListener === 'function') mqMotion.addListener(onMotionPreference);
    }

    /* ── Public API ── */
    return {
      setState: setState,
      showAttention: playAttention,
      playClick: playClick,
      playPeek: playPeek,
      gazeAt: function (x, y) { gazeLock = (x === null || x === undefined) ? null : { x: x, y: y }; },
      wake: wake,
      isChatOpen: function () { return chatOpen; },
      getPosition: function () { return { right: C.posX.v, bottom: C.posY.v }; },
      getSize: function () { return { width: zoneMetrics.w, height: zoneMetrics.h }; },
      destroy: function () {
        stop();
        for (var name in timers) {
          if (Object.prototype.hasOwnProperty.call(timers, name)) clearTimeout(timers[name]);
        }
        timers = {};
        for (var i = 0; i < listeners.length; i++) {
          listeners[i][0].removeEventListener(listeners[i][1], listeners[i][2], listeners[i][3]);
        }
        listeners = [];
      }
    };
  }

  // ── EndpointResolver ───────────────────────────────────────────────────
  /**
   * Picks which backend to talk to, at runtime.
   *
   * The site is static (GitHub Pages / Surge) and the API is a separate
   * service, so the host cannot simply be hardcoded: a free-tier host may be
   * asleep, cold-starting, or down, and hardcoding one makes the whole chatbot
   * fail. Instead, config.apiHosts is an ordered list of candidate origins. The
   * first one that answers its health check wins, and the winner is cached so
   * subsequent messages skip the probe.
   *
   * The same origin is always tried last, which is what makes local development
   * (Flask serving the site itself) work with no configuration at all.
   */
  var ENDPOINT_CACHE_KEY = 'chatbot_api_endpoint';

  function createEndpointResolver(config) {
    var candidates = [];

    (config.apiHosts || []).forEach(function (host) {
      var trimmed = String(host).replace(/\/+$/, '');
      if (trimmed) candidates.push(trimmed + config.apiPath);
    });

    /* Same-origin last: correct under Flask, harmless on a static host because
       its /api/chat returns 404 and the candidate is simply skipped. */
    if (global.location && global.location.origin) {
      candidates.push(global.location.origin + config.apiPath);
    }

    var cached = null;

    function readCache() {
      if (cached) return cached;
      try {
        cached = global.localStorage.getItem(ENDPOINT_CACHE_KEY);
      } catch (e) {
        /* private mode — fall back to probing every time */
      }
      return cached;
    }

    function writeCache(endpoint) {
      cached = endpoint;
      try {
        global.localStorage.setItem(ENDPOINT_CACHE_KEY, endpoint);
      } catch (e) {
        /* non-fatal */
      }
    }

    function clearCache() {
      cached = null;
      try {
        global.localStorage.removeItem(ENDPOINT_CACHE_KEY);
      } catch (e) {
        /* non-fatal */
      }
    }

    function isHealthy(endpoint) {
      var url = endpoint.replace(/\/api\/chat$/, '') + config.apiHealthPath;
      var controller = new AbortController();
      var timer = setTimeout(function () { controller.abort(); }, config.healthTimeout);
      return fetch(url, { method: 'GET', signal: controller.signal })
        .then(function (r) {
          clearTimeout(timer);
          return r.ok;
        })
        .catch(function () {
          clearTimeout(timer);
          return false;
        });
    }

    /**
     * Resolve to a working endpoint. Re-checks the cached host first so a
     * backend that died since the last visit is detected rather than retried.
     */
    function resolve() {
      var remembered = readCache();
      var list = candidates.slice();

      /* Try the remembered host first, without a probe, when it's still
         first-choice — probing on every message would double the latency. */
      if (remembered && list.indexOf(remembered) === 0) {
        return Promise.resolve(remembered);
      }
      if (remembered) {
        list.unshift(remembered);
      }

      function tryNext(i) {
        if (i >= list.length) {
          clearCache();
          return Promise.reject(new Error('No chat API host is reachable'));
        }
        return isHealthy(list[i]).then(function (ok) {
          if (ok) {
            writeCache(list[i]);
            return list[i];
          }
          return tryNext(i + 1);
        });
      }

      return tryNext(0);
    }

    /* Warm the cache in the background so the first message is not delayed by
       a health probe. */
    function prewarm() {
      resolve().catch(function () {
        /* No host yet — the offline message covers this when a message is sent */
      });
    }

    return { resolve: resolve, invalidate: clearCache, prewarm: prewarm };
  }

  // ── ApiService ─────────────────────────────────────────────────────────
  /**
   * Handles all communication with the backend chat API.
   * Never stores or exposes API keys — that logic lives on the server.
   */
  function createApiService(config, resolver) {
    var timeout = config.requestTimeout;

    function post(endpoint, message, conversationId) {
      var payload = JSON.stringify({
        message: message,
        conversation_id: conversationId
      });

      var controller = new AbortController();
      var timer = setTimeout(function () { controller.abort(); }, timeout);

      return fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: payload,
        signal: controller.signal
      })
        .then(function (response) {
          clearTimeout(timer);
          if (!response.ok) {
            var err = new Error('API responded with status ' + response.status);
            err.status = response.status;
            throw err;
          }
          return response.json();
        })
        .then(function (data) {
          return {
            reply: (data.reply || data.message || data.response || '').trim(),
            conversationId: data.conversation_id || conversationId
          };
        })
        .catch(function (err) {
          /* An aborted request leaves status undefined, which the caller
             reports as "unreachable". Mark it so. */
          if (err && err.status === undefined) err.status = undefined;
          throw err;
        });
    }

    /**
     * Resolve a working host, then post. If that host fails in a way that
     * suggests the host itself is the problem (no response at all, or the
     * endpoint does not exist), the cached host is dropped and the next
     * candidate is tried — so a sleeping or removed backend is recovered from
     * without a page reload.
     */
    function send(message, conversationId) {
      return resolver.resolve().then(function (endpoint) {
        return post(endpoint, message, conversationId).catch(function (err) {
          var status = err && err.status;
          var hostIsGone =
            status === undefined ||
            NO_BACKEND_STATUSES.indexOf(status) !== -1;
          if (!hostIsGone) throw err;
          resolver.invalidate();
          return resolver.resolve().then(function (next) {
            if (next === endpoint) throw err; /* nowhere left to go */
            return post(next, message, conversationId);
          });
        });
      });
    }

    return { send: send, prewarm: resolver.prewarm };
  }

  // ── ConversationState ─────────────────────────────────────────────────
  /**
   * Manages message history, conversation_id, and persistence.
   * History is cleared on every page refresh (localStorage is wiped on load),
   * but persists across open/close within the same session so the chatbot
   * minimisation doesn't lose context.
   */
  function createConversationState(config) {
    var STORAGE_KEY = config.storageKey;

    /* Clear persisted history on page load — every refresh starts fresh */
    try {
      global.localStorage.removeItem(STORAGE_KEY);
    } catch (e) {
      /* localStorage may be unavailable (private mode) — fail silently */
    }

    var state = {
      conversationId: null,
      messages: [],
      isFirstOpen: true,

      addMessage: function (sender, text) {
        var msg = {
          id: utils.generateId(),
          sender: sender,
          text: text,
          timestamp: utils.nowISO()
        };
        this.messages.push(msg);
        this.save();
        return msg;
      },

      setConversationId: function (id) {
        this.conversationId = id;
        this.save();
      },

      markOpened: function () {
        this.isFirstOpen = false;
        this.save();
      },

      clear: function () {
        this.messages = [];
        this.conversationId = null;
        this.save();
      },

      save: function () {
        try {
          global.localStorage.setItem(
            STORAGE_KEY,
            JSON.stringify({
              conversationId: this.conversationId,
              messages: this.messages,
              isFirstOpen: this.isFirstOpen
            })
          );
        } catch (e) {
          /* localStorage may be unavailable (private mode) — fail silently */
        }
      }
    };

    return state;
  }

  // ── MarkdownRenderer ───────────────────────────────────────────────────
  /**
   * Converts markdown to safe HTML. All user-supplied text is HTML-escaped
   * first, so no raw HTML can survive injection. Only the markdown syntax
   * we explicitly parse produces HTML tags.
   *
   * Supported: bold, italic, strikethrough, inline code, fenced code blocks,
   *            links (protocol-validated), unordered lists, ordered lists,
   *            blockquotes, headings.
   */
  var MarkdownRenderer = {
    _escapeHtml: function (text) {
      return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    },

    _renderInline: function (text) {
      // Bold — **text** or __text__
      text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      text = text.replace(/__(.+?)__/g, '<strong>$1</strong>');
      // Italic — *text* or _text_
      text = text.replace(/\*(.+?)\*/g, '<em>$1</em>');
      text = text.replace(/_(.+?)_/g, '<em>$1</em>');
      // Strikethrough — ~~text~~
      text = text.replace(/~~(.+?)~~/g, '<s>$1</s>');
      // Inline code — `code`
      text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
      // Links — [text](url) with protocol validation
      text = text.replace(
        /\[([^\]]+)\]\(([^)]+)\)/g,
        function (m, linkText, url) {
          var clean = url.trim();
          if (clean.match(/^https?:\/\/|^mailto:|^tel:|^ftp:/)) {
            return '<a href="' + clean + '" target="_blank" rel="noopener noreferrer">' + linkText + '</a>';
          }
          return linkText;
        }
      );
      return text;
    },

    render: function (text) {
      if (!text) return '';

      // 1. Escape all HTML first — prevents XSS
      var escaped = this._escapeHtml(text);
      var lines = escaped.split('\n');
      var html = [];
      var i, line;

      // State trackers
      var inCodeBlock = false;
      var codeLang = '';
      var codeLines = [];
      var inList = false;
      var listType = null; // 'ul' or 'ol'

      var pushListOpen = function (type) {
        html.push('<' + type + '>');
        inList = true;
        listType = type;
      };

      var pushListClose = function () {
        if (inList) {
          html.push('</' + listType + '>');
          inList = false;
          listType = null;
        }
      };

      var flushCodeBlock = function () {
        if (inCodeBlock) {
          pushListClose();
          var cls = codeLang ? ' class="code-block"' : '';
          html.push('<pre' + cls + '><code>' + MarkdownRenderer._escapeHtml(codeLines.join('\n')) + '</code></pre>');
          codeLines = [];
          codeLang = '';
          inCodeBlock = false;
        }
      };

      for (i = 0; i < lines.length; i++) {
        line = lines[i];

        // Fenced code block
        var fenceMatch = line.match(/^(```+)(.+)?/);
        if (fenceMatch) {
          flushCodeBlock();
          if (!inCodeBlock) {
            inCodeBlock = true;
            codeLang = fenceMatch[2] ? fenceMatch[2].trim() : '';
            codeLines = [];
          } else {
            inCodeBlock = false;
            var cls = codeLang ? ' class="code-block"' : '';
            html.push('<pre' + cls + '><code>' + MarkdownRenderer._escapeHtml(codeLines.join('\n')) + '</code></pre>');
            codeLines = [];
            codeLang = '';
          }
          continue;
        }
        if (inCodeBlock) {
          codeLines.push(line);
          continue;
        }

        // Unordered list
        var ulMatch = line.match(/^[-*+]\s+(.+)/);
        if (ulMatch) {
          flushCodeBlock();
          if (listType !== 'ul') {
            pushListClose();
            pushListOpen('ul');
          }
          html.push('<li>' + this._renderInline(ulMatch[1]) + '</li>');
          continue;
        }

        // Ordered list
        var olMatch = line.match(/^\d+\.\s+(.+)/);
        if (olMatch) {
          flushCodeBlock();
          if (listType !== 'ol') {
            pushListClose();
            pushListOpen('ol');
          }
          html.push('<li>' + this._renderInline(olMatch[1]) + '</li>');
          continue;
        }

        // Heading
        var hMatch = line.match(/^(#{1,6})\s+(.+)/);
        if (hMatch) {
          flushCodeBlock();
          pushListClose();
          var level = hMatch[1].length;
          html.push('<h' + level + '>' + this._renderInline(hMatch[2]) + '</h' + level + '>');
          continue;
        }

        // Blockquote
        var bqMatch = line.match(/^>\s+(.+)/);
        if (bqMatch) {
          flushCodeBlock();
          pushListClose();
          html.push('<blockquote>' + this._renderInline(bqMatch[1]) + '</blockquote>');
          continue;
        }

        // Horizontal rule
        if (line.match(/^---+$|^\*\*\*+$|^___+$/)) {
          flushCodeBlock();
          pushListClose();
          html.push('<hr>');
          continue;
        }

        // Regular paragraph
        flushCodeBlock();
        pushListClose();
        if (line.trim() !== '') {
          html.push('<p>' + this._renderInline(line) + '</p>');
        }
      }

      flushCodeBlock();
      pushListClose();

      return html.join('');
    }
  };

  // ── ChatbotRenderer ────────────────────────────────────────────────────
  /**
   * Handles all DOM rendering for the chatbot UI.
   * Pure presentation layer — no business logic.
   */
  function createChatbotRenderer(container, config, state) {
    var el = {
      toggle: container.querySelector('#chatbotToggle'),
      window: container.querySelector('#chatbotWindow'),
      messages: container.querySelector('#chatbotMessages'),
      suggestions: container.querySelector('#chatbotSuggestions'),
      form: container.querySelector('#chatbotForm'),
      input: container.querySelector('#chatbotInput'),
      send: container.querySelector('#chatbotSend'),
      minimize: container.querySelector('#chatbotMinimize'),
      header: container.querySelector('.chatbot-header'),
      notification: container.querySelector('#chatbotNotification')
    };

    /* Create close button if it doesn't exist in the markup */
    if (!container.querySelector('#chatbotClose')) {
      var closeBtn = document.createElement('button');
      closeBtn.className = 'chatbot-header-button chatbot-close';
      closeBtn.id = 'chatbotClose';
      closeBtn.setAttribute('aria-label', config.closeTitle);
      closeBtn.setAttribute('type', 'button');
      closeBtn.innerHTML =
        '<svg viewBox="0 0 24 24" aria-hidden="true" width="20" height="20">' +
        '<path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" fill="currentColor"/>' +
        '</svg>';
      el.minimize.parentNode.insertBefore(closeBtn, el.minimize.nextSibling);
    }
    el.close = container.querySelector('#chatbotClose');

    // Callback hooks (set by the controller)
    el.onSuggestionClick = null;
    el.onRetry = null;
    el.onQuickQuestion = null;

    /* Prevents close timeout firing during rapid open/close */
    var closeTimer = null;

    /* ── Drag-to-move for floating window ── */
    var isDragging = false;
    var dragOffsetX = 0;
    var dragOffsetY = 0;
    var dragStartX = 0;
    var dragStartY = 0;
    var originalRight = 0;
    var originalBottom = 0;

    function startDrag(e) {
      if (isDragging || utils.isMobile()) return;
      if (e.button !== 0) return;

      isDragging = true;
      dragStartX = e.clientX;
      dragStartY = e.clientY;

      var rect = el.window.getBoundingClientRect();
      originalRight = window.innerWidth - rect.right;
      originalBottom = window.innerHeight - rect.bottom;

      el.window.classList.add('dragging');
      document.body.classList.add('chatbot-window-dragging');

      e.preventDefault();
      e.stopPropagation();
    }

    function onDrag(e) {
      if (!isDragging) return;

      var deltaX = e.clientX - dragStartX;
      var deltaY = e.clientY - dragStartY;

      var newRight = originalRight - deltaX;
      var newBottom = originalBottom - deltaY;

      var margin = 20;
      var winW = el.window.offsetWidth;
      var winH = el.window.offsetHeight;
      var maxRight = window.innerWidth - winW - margin;
      var maxBottom = window.innerHeight - winH - margin;

      newRight = Math.max(margin, Math.min(newRight, maxRight));
      newBottom = Math.max(margin, Math.min(newBottom, maxBottom));

      el.window.style.right = newRight + 'px';
      el.window.style.bottom = newBottom + 'px';
    }

    function stopDrag() {
      if (!isDragging) return;
      isDragging = false;
      el.window.classList.remove('dragging');
      document.body.classList.remove('chatbot-window-dragging');
    }

    if (el.window && el.header) {
      el.header.addEventListener('mousedown', startDrag);
      global.addEventListener('mousemove', onDrag);
      global.addEventListener('mouseup', stopDrag);
    }

    var r = {
      el: el,

      /* Window visibility */
      openWindow: function () {
        if (closeTimer) {
          clearTimeout(closeTimer);
          closeTimer = null;
        }
        el.window.removeAttribute('hidden');
        el.window.classList.add('is-open');
        el.toggle.setAttribute('aria-expanded', 'true');
        el.toggle.setAttribute('aria-label', config.closeTitle);
        document.body.classList.add('chatbot-open');
        /* The scrolling element is <html>, so locking <body> alone left the
           page scrollable behind the fullscreen mobile sheet — and scrolling
           is what shifted the fixed window until the close button was out of
           reach. Lock both. */
        document.documentElement.classList.add('chatbot-open');
        utils.defer(function () { el.input.focus(); });
      },

      closeWindow: function () {
        el.window.classList.remove('is-open');
        el.toggle.setAttribute('aria-expanded', 'false');
        el.toggle.setAttribute('aria-label', config.openTitle);
        document.body.classList.remove('chatbot-open');
        document.documentElement.classList.remove('chatbot-open');
        /* Remove hidden after transition for clean DOM */
        closeTimer = setTimeout(function () {
          el.window.setAttribute('hidden', '');
          closeTimer = null;
        }, 300);
      },

      isWindowOpen: function () {
        return el.window.classList.contains('is-open');
      },

      /* Message rendering */
      renderMessage: function (message) {
        var div = document.createElement('div');
        div.className = 'chatbot-message ' + message.sender;
        div.setAttribute('role', 'log');

        var content = document.createElement('div');
        content.className = 'message-content';

        if (message.sender === 'bot') {
          content.innerHTML = MarkdownRenderer.render(message.text);
        } else {
          content.textContent = message.text;
        }

        div.appendChild(content);

        var time = document.createElement('div');
        time.className = 'message-time';
        time.textContent = utils.formatTime(message.timestamp);
        div.appendChild(time);

        return div;
      },

      /* Typing indicator */
      renderTypingIndicator: function () {
        var div = document.createElement('div');
        div.className = 'chatbot-typing';
        div.setAttribute('role', 'status');
        div.setAttribute('aria-live', 'polite');

        var label = document.createElement('span');
        label.className = 'typing-text';
        label.textContent = config.typingMessage + ' ';
        div.appendChild(label);

        var dots = document.createElement('span');
        dots.className = 'typing-dots';
        for (var i = 0; i < 3; i++) {
          var dot = document.createElement('span');
          dot.className = 'typing-dot';
          dots.appendChild(dot);
        }
        div.appendChild(dots);

        return div;
      },

      /* Error message with retry */
      renderError: function (messageText, showRetry) {
        var div = document.createElement('div');
        div.className = 'chatbot-message bot error';
        div.setAttribute('role', 'log');

        var content = document.createElement('div');
        content.className = 'message-content message-error';
        content.innerHTML = MarkdownRenderer.render(messageText);

        if (showRetry !== false) {
          var retryBtn = document.createElement('button');
          retryBtn.className = 'chatbot-error-retry';
          retryBtn.setAttribute('type', 'button');
          retryBtn.textContent = config.errorRetryText;
          retryBtn.addEventListener('click', function () {
            if (typeof el.onRetry === 'function') {
              el.onRetry(div);
            }
          });
          content.appendChild(retryBtn);
        }

        div.appendChild(content);

        var time = document.createElement('div');
        time.className = 'message-time';
        time.textContent = utils.formatTime(utils.nowISO());
        div.appendChild(time);

        return div;
      },

      /* Suggested questions — only ever shown on a fresh, empty conversation.
         renderSuggestions() is the single gate: it refuses to draw once the
         user has sent anything, so no other caller can bring them back
         mid-chat. The welcome message is added by the caller before this runs,
         so the test is "has the user spoken", not "are there any messages". */
      renderSuggestions: function (questions) {
        var hasUserTurn = state.messages.some(function (msg) {
          return msg.sender === 'user';
        });
        if (hasUserTurn) {
          this.hideSuggestions();
          return;
        }
        el.suggestions.innerHTML = '';
        el.suggestions.removeAttribute('hidden');
        questions.forEach(function (q) {
          var btn = document.createElement('button');
          btn.className = 'chatbot-suggestion';
          btn.setAttribute('type', 'button');
          btn.setAttribute('role', 'button');
          btn.textContent = q;
          btn.addEventListener('click', function () {
            if (typeof el.onSuggestionClick === 'function') {
              el.onSuggestionClick(q);
            }
          });
          el.suggestions.appendChild(btn);
        });
      },

      hideSuggestions: function () {
        el.suggestions.setAttribute('hidden', '');
      },

      /* Append a message element to the chat area */
      append: function (element) {
        el.messages.appendChild(element);
        this.scrollToBottom();
      },

      /* Remove a message element (e.g. typing indicator) */
      remove: function (element) {
        if (element && element.parentNode) {
          element.parentNode.removeChild(element);
        }
      },

      scrollToBottom: function () {
        /* Use scrollTop so it works on both WebKit and Firefox */
        el.messages.scrollTop = el.messages.scrollHeight;
      },

      /* Send button state */
      setSendButtonState: function (enabled) {
        el.send.disabled = !enabled;
      },

      /* Notification badge (unread count when window closed) */
      setNotification: function (count) {
        if (!el.notification) return;
        if (count > 0) {
          el.notification.textContent = count > 9 ? '9+' : String(count);
          el.notification.classList.add('visible');
        } else {
          el.notification.classList.remove('visible');
        }
      },

      getInput: function () {
        return el.input.value.trim();
      },

      clearInput: function () {
        el.input.value = '';
      },

      focusInput: function () {
        el.input.focus();
      }
    };

    return r;
  }

  // ── Chatbot (Main Controller) ──────────────────────────────────────────
  /**
   * Orchestrates ApiService, ConversationState, and ChatbotRenderer.
   */
  function createChatbot(container) {
    /* Merge data-attribute overrides with defaults */
    var config = Object.assign({}, DEFAULT_CONFIG);

    /* Backend hosts, most specific first:
       1. global.CHATBOT_API_HOSTS — an array in the optional config.js, so one
          build of the same files can point at whichever hosts are currently up
          without editing HTML. The first reachable one wins.
       2. data-api-hosts on the container (JSON array), same idea.
       3. same-origin, always tried last — correct when Flask serves the site,
          harmless on a static host because the path 404s and is skipped. */
    if (global.CHATBOT_API_HOSTS) {
      config.apiHosts = [].concat(global.CHATBOT_API_HOSTS);
    }
    var dh = container.getAttribute('data-api-hosts');
    if (dh) {
      try {
        config.apiHosts = JSON.parse(dh);
      } catch (e) {
        /* keep defaults */
      }
    }

    var wm = container.getAttribute('data-welcome-message');
    if (wm) config.welcomeMessage = wm;

    var sq = container.getAttribute('data-suggested-questions');
    if (sq) {
      try {
        config.suggestedQuestions = JSON.parse(sq);
      } catch (e) {
        /* keep default */
      }
    }

    /* Initialise modules */
    var state = createConversationState(config);
    var resolver = createEndpointResolver(config);
    var api = createApiService(config, resolver);
    var ui = createChatbotRenderer(container, config, state);

    /* Transient state */
    var typingEl = null;      /* typing indicator DOM node */
    var lastUserText = null;  /* for retry */
    var unreadCount = 0;
    var isSending = false;    /* prevents duplicate submissions */
    var robotIdleTimer = null; /* timer to reset robot to idle after responding */
    var analyticsCb = null;   /* optional external analytics callback */

    /* ── Helpers ── */
    function dispatchChatEvent(name, detail) {
      container.dispatchEvent(new CustomEvent('chatbot:' + name, {
        detail: detail || {}
      }));
    }

    /* ── Event handlers ── */

    /* Places the chat window so it reads as expanding out of the robot */
    function alignWindowToRobot() {
      var robot = container._robot;
      var win = ui.el.window;
      if (!robot || !robot.getPosition || !win) return;
      if ((document.documentElement.clientWidth || window.innerWidth) <= 768) return;   /* fullscreen sheet on mobile */
      var pos = robot.getPosition();
      var size = robot.getSize();
      var vw = document.documentElement.clientWidth || window.innerWidth;
      var vh = document.documentElement.clientHeight || window.innerHeight;
      var w = win.offsetWidth || 380;
      var h = win.offsetHeight || 420;
      var right = clamp(pos.right, 16, Math.max(16, vw - w - 16));
      var bottom = clamp(pos.bottom + size.height + 8, 16, Math.max(16, vh - h - 16));
      win.style.right = right + 'px';
      win.style.bottom = bottom + 'px';
    }

    function handleToggle() {
      if (ui.isWindowOpen()) {
        handleClose();
      } else {
        var robot = container._robot;
        if (robot && robot.playClick) robot.playClick();
        handleOpen();
      }
    }

    function handleOpen() {
      ui.openWindow();
      alignWindowToRobot();
      state.markOpened();
      unreadCount = 0;
      ui.setNotification(0);

      /*
       * Only populate the messages area when the DOM is empty — this
       * happens on page load (fresh DOM) or after clearHistory().
       * Reopening without a refresh preserves existing DOM nodes.
       */
      if (ui.el.messages.children.length === 0) {
        if (state.messages.length === 0) {
          /* No history at all — show welcome + suggestions */
          var welcomeMsg = state.addMessage('bot', config.welcomeMessage);
          ui.append(ui.renderMessage(welcomeMsg));
          ui.renderSuggestions(config.suggestedQuestions);
        } else {
          /* Restore persisted history from localStorage */
          state.messages.forEach(function (msg) {
            ui.append(ui.renderMessage(msg));
          });
          ui.scrollToBottom();
        }
      }

      dispatchChatEvent('open');
      dispatchChatEvent('listening');
      track('chatbot_opened');

      /* Resolve a working backend while the user is still reading, so the
         first message isn't delayed by a health probe. */
      if (typeof api.prewarm === 'function') api.prewarm();
    }

    function handleClose() {
      ui.closeWindow();
      dispatchChatEvent('close');
      track('chatbot_closed');
    }

    function handleMinimize() {
      ui.closeWindow();
      /* The robot only knows the chat is closed if it hears about it */
      dispatchChatEvent('close');
      track('chatbot_closed');
    }

    function handleSend(text) {
      text = (text || ui.getInput()).trim();
      if (!text || ui.isWindowOpen() === false || isSending) return;

      isSending = true;
      ui.hideSuggestions();
      ui.clearInput();
      ui.setSendButtonState(false);

      /* Add user message */
      var userMsg = state.addMessage('user', text);
      ui.append(ui.renderMessage(userMsg));
      lastUserText = text;
      track('message_sent');

      /* Show typing indicator */
      typingEl = ui.renderTypingIndicator();
      ui.append(typingEl);

      /* Notify robot to show "thinking" state */
      dispatchChatEvent('thinking');

      /* Ensure conversation_id exists */
      if (!state.conversationId) {
        state.setConversationId(utils.generateId());
      }

      /* Send to API */
      api
        .send(text, state.conversationId)
        .then(handleApiSuccess)
        .catch(handleApiError);
    }

    function handleApiSuccess(data) {
      /* Remove typing indicator */
      if (typingEl) {
        ui.remove(typingEl);
        typingEl = null;
      }

      /* Update conversation id if server returned a new one */
      if (data.conversationId && data.conversationId !== state.conversationId) {
        state.setConversationId(data.conversationId);
      }

      /* Add bot response */
      var botMsg = state.addMessage('bot', data.reply);
      ui.append(ui.renderMessage(botMsg));

      /* Update conversation id if server returned a new one */
      if (data.conversationId && data.conversationId !== state.conversationId) {
        state.setConversationId(data.conversationId);
      }

      /* Notify robot to show "responding" state briefly, then idle */
      dispatchChatEvent('responding');

      /* If window was closed, show notification */
      if (!ui.isWindowOpen()) {
        unreadCount++;
        ui.setNotification(unreadCount);
        dispatchChatEvent('notification');
      }

      /* Return robot to idle after response animation */
      clearTimeout(robotIdleTimer);
      robotIdleTimer = setTimeout(function () {
        dispatchChatEvent('idle');
      }, 2000);

      track('message_received');
      isSending = false;
      ui.setSendButtonState(true);
    }

    function handleApiError(error) {
      if (typingEl) {
        ui.remove(typingEl);
        typingEl = null;
      }

      isSending = false;
      ui.setSendButtonState(true);

      /* Distinguish "the API isn't there" from "the API is there but unhappy".
         On a static host with no backend wired up, POST /api/chat comes back
         404/405/501 (the path doesn't exist), and a dead host gives a network
         error with no status. Both mean retrying cannot help, so show the
         offline message and omit the retry button. A 5xx from a real backend is
         transient and stays retryable. */
      var status = error && error.status;
      var noBackend =
        !error || status === undefined || NO_BACKEND_STATUSES.indexOf(status) !== -1;

      var errMsg = noBackend
        ? ui.renderError(config.offlineMessage, false)
        : ui.renderError(config.errorMessage, true);
      ui.append(errMsg);

      /* Notify robot of error — auto-return to idle after delay */
      dispatchChatEvent('error');

      /* Wire up the retry button */
      ui.el.onRetry = function (errorDiv) {
        ui.remove(errorDiv);
        isSending = true;
        ui.setSendButtonState(false);
        typingEl = ui.renderTypingIndicator();
        ui.append(typingEl);
        dispatchChatEvent('thinking');
        api
          .send(lastUserText, state.conversationId)
          .then(function (data) {
            /* Recovering from an error earns the robot a small celebration */
            dispatchChatEvent('success');
            handleApiSuccess(data);
          })
          .catch(handleApiError);
        track('message_retried');
      };

      track('chat_error', {
        error: error.message || 'Unknown error',
        status: error.status || 'N/A'
      });
    }

    function handleSuggestion(question) {
      handleSend(question);
      track('suggested_question_clicked', { question: question });
    }

    function handleKeyDown(event) {
      if (event.key === 'Escape') {
        if (ui.isWindowOpen()) {
          handleClose();
        }
      }
    }

    function handleFormSubmit(event) {
      event.preventDefault();
      handleSend();
    }

    function handleInputKey(event) {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        if (event.target.value.trim()) {
          handleSend();
        }
      }
    }

    function handleInputUpdate() {
      ui.setSendButtonState(this.value.trim().length > 0);
    }

    function handleInputFocus() {
      /* The robot turns its attention to the input as soon as it is used */
      if (ui.isWindowOpen()) dispatchChatEvent('listening');
    }

    /* Analytics hook — callers can override before init */
    function track(eventName, data) {
      if (typeof analyticsCb === 'function') {
        analyticsCb(eventName, data || {});
      }
      if (config.debug) {
        global.console.log('[Chatbot]', eventName, data || '');
      }
    }

    /* ── Wire up listeners ── */
    ui.el.toggle.addEventListener('click', handleToggle);
    ui.el.minimize.addEventListener('click', handleMinimize);
    ui.el.close.addEventListener('click', handleClose);
    ui.el.form.addEventListener('submit', handleFormSubmit);
    ui.el.input.addEventListener('keydown', handleInputKey);
    ui.el.input.addEventListener('input', handleInputUpdate);
    ui.el.input.addEventListener('focus', handleInputFocus);

    /* Suggestion clicks */
    ui.el.onSuggestionClick = handleSuggestion;

    /* Global keyboard handling (Escape) */
    global.addEventListener('keydown', handleKeyDown);

    /* ── Public API ── */
    var apiObj = {
      open: handleOpen,
      close: handleClose,
      toggle: handleToggle,
      sendMessage: handleSend,
      clearHistory: function () {
        state.clear();
        ui.el.messages.innerHTML = '';
        ui.hideSuggestions();
      },
      setAnalyticsCallback: function (cb) {
        analyticsCb = cb;
      },
      getState: function () {
        return {
          messages: state.messages,
          conversationId: state.conversationId,
          isFirstOpen: state.isFirstOpen
        };
      }
    };

  /* Store references on the container for external access */
    container._chatbot = apiObj;
    container._robot = createRobotController(container, config);
    return apiObj;
  }

  // ── Auto-init ──────────────────────────────────────────────────────────
  /*
   * Lazy initialization: the robot controller is instantiated alongside the
   * chatbot, but its animations and movement only activate after the page
   * has fully loaded (see robot controller init). The script itself is
   * loaded with `defer` so it never blocks the initial page render.
   */
  function initAll() {
    var containers = document.querySelectorAll('.chatbot');
    containers.forEach(function (container) {
      createChatbot(container);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAll);
  } else {
    initAll();
  }

  /* Export for module loaders if available */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { createChatbot: createChatbot };
  }
})(typeof window !== 'undefined' ? window : this);
