/* ==========================================================================
   motion.js — motion engine for the portfolio
   Written in ES5 (var / function) to match the convention in AGENTS.md.

   One rAF loop drives every continuous effect (cursor, parallax, tilt,
   magnetic, timeline rail, canvas) so the page never runs competing
   animation loops. Viewport-triggered work uses IntersectionObserver and
   unobserves after firing.

   Everything degrades safely: with JavaScript off, or with
   prefers-reduced-motion set, the page renders its resting state.
   ========================================================================== */
(function () {
  'use strict';

  var doc = document;
  var root = doc.documentElement;
  var body = doc.body;

  /* ---------------------------------------------------------------------
     Environment
     --------------------------------------------------------------------- */
  var mqReduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  var mqHover = window.matchMedia('(hover: hover) and (pointer: fine)');
  var reduce = mqReduce.matches;
  var fine = mqHover.matches;

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function on(el, type, fn, opts) { if (el) el.addEventListener(type, fn, opts || false); }

  var qsa = function (sel, ctx) { return Array.prototype.slice.call((ctx || doc).querySelectorAll(sel)); };

  /* Touch / coarse-pointer devices get none of the cursor or 3D effects. */
  function hasTouch() {
    return ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
  }

  /* ---------------------------------------------------------------------
     Single rAF ticker — paused while the tab is hidden
     --------------------------------------------------------------------- */
  var subs = [];
  var rafId = null;

  function frame() {
    for (var i = 0; i < subs.length; i++) {
      try { subs[i](); } catch (e) { /* a broken effect must not stop the rest */ }
    }
    rafId = subs.length ? window.requestAnimationFrame(frame) : null;
  }

  function subscribe(fn) {
    if (subs.indexOf(fn) === -1) subs.push(fn);
    if (rafId === null && !doc.hidden) rafId = window.requestAnimationFrame(frame);
  }

  doc.addEventListener('visibilitychange', function () {
    if (doc.hidden) {
      if (rafId !== null) { window.cancelAnimationFrame(rafId); rafId = null; }
    } else if (rafId === null && subs.length) {
      rafId = window.requestAnimationFrame(frame);
    }
  });

  /* ---------------------------------------------------------------------
     Reveal system
     Adds both `is-in` (motion.css) and `visible` (the inline critical
     styles) so one observer drives both layers.
     --------------------------------------------------------------------- */
  var revealIO = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      var el = entry.target;
      el.classList.add('is-in');
      el.classList.add('visible');
      revealIO.unobserve(el);

      /* Fire any nested counters / pipelines once, with the parent. */
      qsa('[data-count]', el).forEach(countUp);
      var pipe = el.querySelector ? el.querySelector('.m-pipeline') : null;
      if (pipe) lightPipeline(pipe);
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });

  function observeReveal(el, delayMs) {
    if (!el) return;
    if (typeof delayMs === 'number') el.style.setProperty('--d', delayMs + 'ms');
    revealIO.observe(el);
  }

  /* Auto-stagger: every direct child of [data-stagger] gets an increasing delay. */
  qsa('[data-stagger]').forEach(function (group) {
    var step = parseInt(group.getAttribute('data-stagger'), 10) || 70;
    qsa(':scope > *', group).forEach(function (child, i) {
      child.style.setProperty('--d', (i * step) + 'ms');
      if (!child.hasAttribute('data-reveal') && !child.hasAttribute('data-hero-step')) {
        child.setAttribute('data-reveal', 'up');
      }
    });
  });

  /* Anything that opts into the reveal system. */
  qsa('[data-reveal], [data-hero-step]').forEach(function (el) {
    /* Nested groups handle their own children. */
    if (el.querySelector('[data-stagger]') && el.hasAttribute('data-hero-step')) return;
    observeReveal(el);
  });

  /* Keep the pre-existing `.reveal` class working through this engine, so the
     inline styles (section accent underline, project tag cascade) still fire. */
  qsa('.reveal').forEach(function (el) {
    if (!el.hasAttribute('data-reveal') && el.classList.contains('reveal')) {
      revealIO.observe(el);
    }
  });

  /* ---------------------------------------------------------------------
     Number counting
     --------------------------------------------------------------------- */
  var countIO = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      countUp(entry.target);
      countIO.unobserve(entry.target);
    });
  }, { threshold: 0.3 });

  function countUp(el) {
    if (el.getAttribute('data-counted') === '1') return;
    var target = parseFloat(el.getAttribute('data-target') || el.getAttribute('data-count'));
    if (isNaN(target)) return;
    el.setAttribute('data-counted', '1');

    var decimals = parseInt(el.getAttribute('data-decimals') || '0', 10);
    var suffix = el.getAttribute('data-suffix') || '';
    var prefix = el.getAttribute('data-prefix') || '';

    if (reduce) { el.textContent = prefix + target.toFixed(decimals) + suffix; return; }

    var duration = 1400;
    var start = performance.now();
    function tick(now) {
      var p = clamp((now - start) / duration, 0, 1);
      var eased = 1 - Math.pow(1 - p, 3);
      el.textContent = prefix + (eased * target).toFixed(decimals) + suffix;
      if (p < 1) window.requestAnimationFrame(tick);
    }
    window.requestAnimationFrame(tick);
  }

  qsa('.stat-number, .count-value, [data-count]').forEach(function (el) {
    countIO.observe(el);
  });

  /* ---------------------------------------------------------------------
     Scroll-driven effects (one handler, batched into the ticker)
     --------------------------------------------------------------------- */
  var scrollY = window.pageYOffset || 0;
  var vw = window.innerWidth;
  var vh = window.innerHeight;
  var anchorY = vh * 0.55;

  var progressBar = doc.querySelector('.scroll-progress');
  var header = doc.querySelector('header');
  var hero = doc.querySelector('.hero');
  var bgGrid = doc.querySelector('.bg-grid');

  function readViewport() {
    vw = window.innerWidth;
    vh = window.innerHeight;
    anchorY = vh * 0.55;
  }

  /* Hero background parallax: pointer drift + a slow scroll-linked rise. */
  var pointerX = 0, pointerY = 0;   /* -1..1 */
  var smoothPX = 0, smoothPY = 0;

  function updateScroll() {
    scrollY = window.pageYOffset || root.scrollTop || 0;

    var scrollable = root.scrollHeight - vh;
    if (progressBar) {
      var pct = scrollable > 0 ? (scrollY / scrollable) * 100 : 0;
      progressBar.style.width = pct + '%';
    }

    if (header) header.classList.toggle('is-compact', scrollY > 40);

    /* Background layers drift apart from each other. */
    if (hero && !reduce) {
      var rect = hero.getBoundingClientRect();
      if (rect.bottom > 0 && rect.top < vh) {
        var drift = clamp(rect.top / vh, -1, 1);
        var mx = smoothPX * 26 + drift * -40;
        var my = smoothPY * 20 + drift * -60;
        root.style.setProperty('--bg-x', mx.toFixed(2) + 'px');
        root.style.setProperty('--bg-y', my.toFixed(2) + 'px');
      }
    }

    /* Timeline rails fill as their section passes the reading line. */
    timelines.forEach(function (tl) {
      var r = tl.el.getBoundingClientRect();
      if (r.bottom < -200 || r.top > vh + 200) return;
      var px = anchorY - r.top;
      var fill = clamp(px / Math.max(r.height, 1), 0, 1);
      tl.el.style.setProperty('--rail', (fill * 100).toFixed(2) + '%');
      setActiveNode(tl);
    });

    /* Project artwork parallaxes gently inside its fixed frame. */
    projects.forEach(function (p) {
      var r = p.visual.getBoundingClientRect();
      if (r.bottom < 0 || r.top > vh) return;
      var centre = (r.top + r.height / 2 - vh / 2) / vh;  /* -1..1 */
      p.visual.style.setProperty('--art-y', (-centre * 16).toFixed(2) + 'px');
    });
  }

  var ticking = false;
  on(window, 'scroll', function () {
    if (ticking) return;
    ticking = true;
    window.requestAnimationFrame(function () { updateScroll(); ticking = false; });
  }, { passive: true });
  on(window, 'resize', function () { readViewport(); updateScroll(); });

  /* Smoothed pointer position, fed by the shared ticker. */
  subscribe(function () {
    if (reduce) return;
    smoothPX += (pointerX - smoothPX) * 0.08;
    smoothPY += (pointerY - smoothPY) * 0.08;
  });

  /* ---------------------------------------------------------------------
     Timelines — progressive rail + active node
     --------------------------------------------------------------------- */
  var timelines = qsa('.m-timeline').map(function (el) {
    return { el: el, items: qsa('.m-tl-item', el) };
  });

  function setActiveNode(tl) {
    var best = null, bestDist = Infinity;
    tl.items.forEach(function (item) {
      var r = item.getBoundingClientRect();
      if (r.bottom < 0 || r.top > vh) return;
      var d = Math.abs((r.top + r.height / 2) - anchorY);
      if (d < bestDist) { bestDist = d; best = item; }
    });
    tl.items.forEach(function (item) {
      item.classList.toggle('is-active', item === best);
    });
  }

  timelines.forEach(function (tl) {
    tl.items.forEach(function (item, i) {
      observeReveal(item, i * 90);
    });
  });

  /* ---------------------------------------------------------------------
     Projects — tilt, magnetic-free card response, pointer light
     --------------------------------------------------------------------- */
  var projects = [];
  if (fine && !reduce) {
    projects = qsa('.project').map(function (el) {
      return { el: el, visual: el.querySelector('.project-visual') };
    }).filter(function (p) { return !!p.visual; });

    projects.forEach(function (p) {
      var rect = null;
      on(p.el, 'pointermove', function (e) {
        if (reduce) return;
        rect = rect || p.el.getBoundingClientRect();
        var nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        var ny = ((e.clientY - rect.top) / rect.height) * 2 - 1;
        p.el.style.setProperty('--rx', (nx * 3.4).toFixed(2));
        p.el.style.setProperty('--ry', (-ny * 2.4).toFixed(2));
        p.visual.style.setProperty('--mx', ((nx + 1) * 50).toFixed(1) + '%');
        p.visual.style.setProperty('--my', ((ny + 1) * 50).toFixed(1) + '%');
      });
      on(p.el, 'pointerleave', function () {
        p.el.style.setProperty('--rx', '0');
        p.el.style.setProperty('--ry', '0');
        p.visual.style.setProperty('--mx', '50%');
        p.visual.style.setProperty('--my', '50%');
      });
    });
  }

  /* ---------------------------------------------------------------------
     Hero portrait tilt + glow
     --------------------------------------------------------------------- */
  var portrait = doc.querySelector('.hero-portrait');
  if (portrait && fine && !reduce) {
    on(portrait, 'pointermove', function (e) {
      var r = portrait.getBoundingClientRect();
      var nx = ((e.clientX - r.left) / r.width) * 2 - 1;
      var ny = ((e.clientY - r.top) / r.height) * 2 - 1;
      portrait.style.setProperty('--tilt-x', nx.toFixed(3));
      portrait.style.setProperty('--tilt-y', ny.toFixed(3));
    });
    on(portrait, 'pointerleave', function () {
      portrait.style.setProperty('--tilt-x', '0');
      portrait.style.setProperty('--tilt-y', '0');
    });
  }

  /* ---------------------------------------------------------------------
     Global pointer tracking → cursor + parallax
     --------------------------------------------------------------------- */
  var cursorDot = doc.querySelector('.m-cursor');
  var cursorRing = doc.querySelector('.m-cursor-ring');
  var useCursor = fine && !hasTouch() && cursorDot && cursorRing;

  if (useCursor && !reduce) {
    var cx = 0, cy = 0, rx = 0, ry = 0, has = false;

    on(window, 'pointermove', function (e) {
      pointerX = (e.clientX / vw) * 2 - 1;
      pointerY = (e.clientY / vh) * 2 - 1;
      cx = e.clientX; cy = e.clientY;
      if (!has) { rx = cx; ry = cy; has = true; }
      cursorDot.classList.add('is-on');
      cursorRing.classList.add('is-on');
      cursorDot.style.transform = 'translate3d(' + cx + 'px,' + cy + 'px,0)';
    }, { passive: true });

    on(doc, 'pointerdown', function () { body.classList.add('m-cursor-down'); });
    on(doc, 'pointerup', function () { body.classList.remove('m-cursor-down'); });
    on(doc, 'mouseleave', function () {
      cursorDot.classList.remove('is-on');
      cursorRing.classList.remove('is-on');
    });

    /* The ring trails the dot. */
    subscribe(function () {
      rx += (cx - rx) * 0.16;
      ry += (cy - ry) * 0.16;
      cursorRing.style.transform = 'translate3d(' + rx.toFixed(2) + 'px,' + ry.toFixed(2) + 'px,0)';
    });

    /* Hover intent, delegated so it survives DOM changes. */
    var INTERACTIVE = 'a, button, summary, .tag, .m-badge, input, textarea, [role="button"]';
    var MEDIA = '.project-visual, .terminal, .m-terminal';
    on(doc, 'mouseover', function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      if (t.closest(MEDIA)) body.classList.add('m-cursor-media');
      else if (t.closest(INTERACTIVE)) body.classList.add('m-cursor-active');
    });
    on(doc, 'mouseout', function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      if (t.closest(MEDIA)) body.classList.remove('m-cursor-media');
      else if (t.closest(INTERACTIVE)) body.classList.remove('m-cursor-active');
    });
  }

  /* ---------------------------------------------------------------------
     Background particles — deliberately cheap
     ~24 dots, capped at ~30fps by skipping alternate frames, and only
     pair-linked when they are genuinely close. Draws into a single
     canvas; nothing else on the page repaints for it.
     --------------------------------------------------------------------- */
  var canvas = doc.getElementById('bgParticles');
  if (canvas && fine && !reduce && canvas.getContext) {
    var ctx = canvas.getContext('2d');
    var dpr = 1;
    var dots = [];
    var frameNo = 0;
    var MAX_DOTS = 24;
    var LINK_DIST = 150;
    var SKIP = 2;                       /* run at ~30fps, not 60 */

    function sizeCanvas() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.floor(vw * dpr));
      canvas.height = Math.max(1, Math.floor(vh * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function seedDots() {
      var n = Math.max(8, Math.min(MAX_DOTS, Math.round(vw / 64)));
      dots = [];
      for (var i = 0; i < n; i++) {
        dots.push({
          x: Math.random() * vw,
          y: Math.random() * vh,
          vx: (Math.random() - 0.5) * 0.14,
          vy: (Math.random() - 0.5) * 0.14,
          r: Math.random() * 1.3 + 0.7
        });
      }
    }

    function drawParticles() {
      frameNo++;
      if (frameNo % SKIP) return;
      ctx.clearRect(0, 0, vw, vh);

      var i, j, dx, dy, d2, a, b;
      for (i = 0; i < dots.length; i++) {
        a = dots[i];
        a.x += a.vx; a.y += a.vy;
        if (a.x < -20) a.x = vw + 20; else if (a.x > vw + 20) a.x = -20;
        if (a.y < -20) a.y = vh + 20; else if (a.y > vh + 20) a.y = -20;
      }

      ctx.strokeStyle = 'rgba(23, 33, 29, .10)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (i = 0; i < dots.length; i++) {
        for (j = i + 1; j < dots.length; j++) {
          dx = dots[i].x - dots[j].x;
          dy = dots[i].y - dots[j].y;
          d2 = dx * dx + dy * dy;
          if (d2 < LINK_DIST * LINK_DIST) {
            ctx.moveTo(dots[i].x, dots[i].y);
            ctx.lineTo(dots[j].x, dots[j].y);
          }
        }
      }
      ctx.stroke();

      ctx.fillStyle = 'rgba(23, 33, 29, .20)';
      for (i = 0; i < dots.length; i++) {
        ctx.beginPath();
        ctx.arc(dots[i].x, dots[i].y, dots[i].r, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    readViewport();
    sizeCanvas();
    seedDots();
    on(window, 'resize', function () { readViewport(); sizeCanvas(); seedDots(); });
    subscribe(drawParticles);
  }

  /* ---------------------------------------------------------------------
     Magnetic buttons — a deliberately small pull
     --------------------------------------------------------------------- */
  if (fine && !reduce) {
    qsa('[data-magnetic]').forEach(function (el) {
      var strength = parseFloat(el.getAttribute('data-magnetic')) || 5;
      on(el, 'pointermove', function (e) {
        var r = el.getBoundingClientRect();
        var ox = (e.clientX - (r.left + r.width / 2));
        var oy = (e.clientY - (r.top + r.height / 2));
        el.style.setProperty('--mx', clamp(ox * 0.16, -strength, strength).toFixed(2) + 'px');
        el.style.setProperty('--my', clamp(oy * 0.24, -strength, strength).toFixed(2) + 'px');
      });
      on(el, 'pointerleave', function () {
        el.style.setProperty('--mx', '0px');
        el.style.setProperty('--my', '0px');
      });
    });
  }

  /* ---------------------------------------------------------------------
     Navigation — sliding indicator + scrollspy
     --------------------------------------------------------------------- */
  var navLinks = doc.querySelector('.nav-links');
  var indicator = doc.querySelector('.m-nav-indicator');
  var navAnchors = navLinks ? qsa('a', navLinks) : [];

  function moveIndicator() {
    if (!indicator || !navLinks || !fine) return;
    var active = navLinks.querySelector('a.active');
    if (!active) { indicator.classList.remove('is-on'); return; }
    var linkRect = active.getBoundingClientRect();
    var navRect = navLinks.getBoundingClientRect();
    if (!linkRect.width) { indicator.classList.remove('is-on'); return; }
    indicator.style.width = linkRect.width + 'px';
    indicator.style.transform = 'translateX(' + (linkRect.left - navRect.left).toFixed(2) + 'px)';
    indicator.classList.add('is-on');
  }

  if (navAnchors.length) {
    /* The inline script already drives the `.active` class; mirror it here. */
    new MutationObserver(function () { moveIndicator(); })
      .observe(navLinks, { attributes: true, subtree: true, attributeFilter: ['class'] });
    on(window, 'resize', moveIndicator);
    on(window, 'load', moveIndicator);
    moveIndicator();
  }

  /* Smooth in-page navigation that also accounts for the sticky header. */
  qsa('a[href^="#"]').forEach(function (a) {
    var id = a.getAttribute('href').slice(1);
    if (!id) return;
    on(a, 'click', function (e) {
      var target = doc.getElementById(id);
      if (!target) return;
      e.preventDefault();
      var top = target.getBoundingClientRect().top + (window.pageYOffset || 0) - 74;
      window.scrollTo({ top: Math.max(top, 0), behavior: reduce ? 'auto' : 'smooth' });
      if (history.replaceState) history.replaceState(null, '', '#' + id);
    });
  });

  /* ---------------------------------------------------------------------
     Section titles — consistent line + accent reveal
     --------------------------------------------------------------------- */
  qsa('.section-title').forEach(function (h) {
    if (h.querySelector('.m-title-text')) return;
    var text = h.textContent.trim();
    if (!text) return;
    h.textContent = '';
    var span = doc.createElement('span');
    span.className = 'm-title-text';
    span.textContent = text;
    h.appendChild(span);
    revealIO.observe(h);
  });

  /* ---------------------------------------------------------------------
     About — keyword-by-keyword reveal
     --------------------------------------------------------------------- */
  qsa('[data-words]').forEach(function (el) {
    /* Walk every text node inside the element — including text nested in
       <strong>/<em> — and wrap each word so it can rise independently. */
    var walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    var texts = [];
    var node;
    while ((node = walker.nextNode())) {
      if (node.nodeValue && /\S/.test(node.nodeValue)) texts.push(node);
    }

    var idx = 0;
    texts.forEach(function (textNode) {
      var inStrong = !!textNode.parentNode.nodeName.match(/^(STRONG|B|EM)$/);
      var frag = doc.createDocumentFragment();
      textNode.nodeValue.split(/(\s+)/).forEach(function (part) {
        if (!part) return;
        if (/^\s+$/.test(part)) { frag.appendChild(doc.createTextNode(part)); return; }
        var w = doc.createElement('span');
        w.className = 'm-word' + (inStrong ? ' m-word--strong' : '');
        w.textContent = part;
        w.style.setProperty('--d', (idx * 26) + 'ms');
        idx++;
        frag.appendChild(w);
      });
      textNode.parentNode.replaceChild(frag, textNode);
    });

    el.classList.add('m-words');
    revealIO.observe(el);
  });

  /* ---------------------------------------------------------------------
     Terminal — types its lines, then lights the pipeline
     --------------------------------------------------------------------- */
  function lightPipeline(pipe) {
    pipe.classList.add('is-in');
    var items = qsa('li', pipe);
    if (!items.length) return;
    var i = 0;
    function step() {
      if (i > 0) items[i - 1].classList.remove('is-lit');
      if (i >= items.length) return;
      items[i].classList.add('is-lit');
      i++;
      if (reduce) return;
      window.setTimeout(step, 480);
    }
    step();
  }

  qsa('.m-terminal').forEach(function (term) {
    var bodyEl = term.querySelector('.m-terminal-body');
    var caret = term.querySelector('.m-caret');
    if (!bodyEl) return;

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        io.unobserve(entry.target);
        if (reduce) {
          /* Show every line at once and drop the blinking caret. */
          qsa('.m-tline', term).forEach(function (l) { l.classList.add('m-typed'); });
          if (caret && caret.parentNode) caret.parentNode.removeChild(caret);
          return;
        }
        typeLines(term, caret);
      });
    }, { threshold: 0.3 });
    io.observe(term);
  });

  function typeLines(term, caret) {
    var lines = qsa('.m-tline', term);
    var i = 0;
    function next() {
      if (i >= lines.length) return;
      lines[i].classList.add('m-typed');
      i++;
      window.setTimeout(next, 340);
    }
    next();
  }

  /* ---------------------------------------------------------------------
     Contact — success acknowledgement
     --------------------------------------------------------------------- */
  var sentNote = doc.querySelector('.m-sent-note');
  on(doc, 'click', function (e) {
    var a = e.target.closest ? e.target.closest('.contact-action, .m-social a') : null;
    if (!a || !sentNote) return;
    var label = a.getAttribute('data-sent') || 'Done — talk soon';
    sentNote.textContent = label;
    sentNote.classList.add('is-on');
    window.setTimeout(function () { sentNote.classList.remove('is-on'); }, 2600);
  });

  /* ---------------------------------------------------------------------
     Easter egg — type "frappe" (or "python") to open a terminal toast
     --------------------------------------------------------------------- */
  var egg = doc.querySelector('.m-egg');
  if (egg && !reduce) {
    var buffer = '';
    var eggTimer = null;
    var eggBody = egg.querySelector('.m-terminal-body');
    on(doc, 'keydown', function (e) {
      var t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key && e.key.length === 1) buffer = (buffer + e.key.toLowerCase()).slice(-16);
      window.clearTimeout(eggTimer);
      eggTimer = window.setTimeout(function () { buffer = ''; }, 1600);

      if (/frappe|python|sudo/.test(buffer) && eggBody) {
        buffer = '';
        eggBody.textContent = '';
        var lines = [
          ['$ ', 'grep -r "coffee" .', 'c-dim'],
          ['# no results. it is always Python day here.', ''],
          ['$ ', 'pip install curiosity', 'c-key'],
          ['Successfully installed curiosity-3y', 'c-str']
        ];
        lines.forEach(function (l, i) {
          var p = doc.createElement('p');
          p.className = 'm-tline';
          p.style.setProperty('--d', (i * 140) + 'ms');
          var s1 = doc.createElement('span'); s1.className = l[2]; s1.textContent = l[0];
          var s2 = doc.createElement('span'); s2.className = 'c-key'; s2.textContent = l[1];
          var s3 = doc.createElement('span'); s3.className = l[2]; s3.textContent = l[3];
          p.appendChild(s1); p.appendChild(s2); p.appendChild(s3);
          eggBody.appendChild(p);
        });
        /* Reveal them immediately — no stepper needed for a throwaway toast. */
        qsa('.m-tline', eggBody).forEach(function (p) { p.classList.add('m-typed'); });
        egg.classList.add('is-on');
        window.setTimeout(function () { egg.classList.remove('is-on'); }, 5200);
      }
    });
  }

  /* ---------------------------------------------------------------------
     Reduced-motion changes take effect live
     --------------------------------------------------------------------- */
  var onMqChange = function () { reduce = mqReduce.matches; };
  if (mqReduce.addEventListener) mqReduce.addEventListener('change', onMqChange);
  else if (mqReduce.addListener) mqReduce.addListener(onMqChange);

  /* ---------------------------------------------------------------------
     Boot
     --------------------------------------------------------------------- */
  function boot() {
    readViewport();
    updateScroll();
    moveIndicator();

    /* Kick the counters for anything already on screen. */
    qsa('.stat-number, .count-value, [data-count]').forEach(function (el) {
      var r = el.getBoundingClientRect();
      if (r.top < vh && r.bottom > 0) countUp(el);
    });

    /* Loader is purely decorative and self-dismisses in CSS; this only
       removes it from the a11y tree and the hit-test path sooner. */
    var loader = doc.querySelector('.m-loader');
    if (loader) {
      window.setTimeout(function () { loader.classList.add('is-done'); }, 1250);
    }
  }

  if (doc.readyState === 'complete') boot();
  else on(window, 'load', boot);

  /* Expose a tiny surface for debugging without leaking internals. */
  window.PortfolioMotion = {
    version: '1.0',
    reduced: function () { return reduce; }
  };
})();
