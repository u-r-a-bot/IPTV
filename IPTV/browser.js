(function () {
  'use strict';

  // Set after discovery; null until then
  var API  = null;

  // Hardcoded server — tried first before any scanning
  var HARDCODED_SERVER = 'http://192.168.0.191:8000';
  var COLS = 4;

  // ── Grid state ───────────────────────────────────────────────────────────────
  var videos        = [];
  var focusedIdx    = 0;
  var focusedTabIdx = 0;
  var focusZone     = 'grid';   // 'search' | 'tabs' | 'grid'
  var activeTab     = 'trending';

  var CATS = {
    trending: { label: 'Trending', fetchUrl: function() { return API + '/youtube/trending'; } },
    music:    { label: 'Music',    fetchUrl: function() { return API + '/youtube/search?q=' + enc('trending music 2024'); } },
    gaming:   { label: 'Gaming',   fetchUrl: function() { return API + '/youtube/search?q=' + enc('gaming highlights 2024'); } },
    news:     { label: 'News',     fetchUrl: function() { return API + '/youtube/search?q=' + enc('breaking news today'); } },
    sports:   { label: 'Sports',   fetchUrl: function() { return API + '/youtube/search?q=' + enc('sports highlights today'); } },
    movies:   { label: 'Movies',   fetchUrl: function() { return API + '/youtube/search?q=' + enc('movie trailers 2024'); } },
  };
  var CAT_KEYS = ['trending','music','gaming','news','sports','movies'];

  // ── Player state ─────────────────────────────────────────────────────────────
  var onPlayer     = false;
  var playerVolume = 1.0;
  var ctrlTimer    = null;
  var bigIconTimer = null;
  var toastTimer   = null;

  // ════════════════════════════════════════════════════════════════════════════
  //  DISCOVERY
  // ════════════════════════════════════════════════════════════════════════════

  var discManualTimer = null;

  document.addEventListener('DOMContentLoaded', function () {
    document.getElementById('disc-connect-btn').addEventListener('click', onManualConnect);
    document.getElementById('disc-ip').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') onManualConnect();
    });

    runDiscovery();
  });

  function runDiscovery() {
    setDiscStatus('Connecting to ' + HARDCODED_SERVER + '…', '');

    probeServer(HARDCODED_SERVER)
      .then(function () {
        localStorage.setItem('ytv_server', HARDCODED_SERVER);
        discoverySuccess(HARDCODED_SERVER);
      })
      .catch(function (err) {
        var msg = (err && err.message) ? err.message : String(err);
        setDiscStatus('Cannot reach ' + HARDCODED_SERVER, 'Error: ' + msg);
        setTimeout(showManualEntry, 3000);
      });
  }

  function runDiscoveryScan() {
    setDiscStatus('Searching for backend on local network…', '');

    // 1 — try localStorage cache first (fast path)
    var cached = localStorage.getItem('ytv_server');
    if (cached) {
      setDiscStatus('Reconnecting to ' + cached + '…', '');
      probeServer(cached)
        .then(function () { discoverySuccess(cached); })
        .catch(function () {
          localStorage.removeItem('ytv_server');
          setDiscStatus('Cached server unreachable. Scanning…', '');
          startScan();
        });
      return;
    }

    startScan();
  }

  function startScan() {
    setDiscStatus('Scanning local network…', 'Checking subnets…');

    var commonSubnets = [
      '192.168.1', '192.168.0', '192.168.2', '192.168.4',
      '10.0.0',    '10.0.1',    '10.1.0',    '172.16.0'
    ];

    // 12 s before showing manual entry — parallel scan on TV hardware needs more time
    discManualTimer = setTimeout(showManualEntry, 12000);

    var resolved = false;
    var pending  = 2; // common-subnet scan + WebRTC branch

    function onFound(url) {
      if (resolved) return;
      resolved = true;
      clearTimeout(discManualTimer);
      localStorage.setItem('ytv_server', url);
      discoverySuccess(url);
    }

    function onScanFail() {
      pending -= 1;
      if (pending === 0 && !resolved) {
        clearTimeout(discManualTimer);
        setDiscStatus('Backend not found automatically.', '');
        showManualEntry();
      }
    }

    // Scan all common subnets in PARALLEL immediately — no waiting for WebRTC
    scanSubnets(commonSubnets).then(onFound).catch(onScanFail);

    // WebRTC runs concurrently; if it detects a non-standard subnet, scan that too
    getLocalSubnet().then(function (subnet) {
      if (!resolved && subnet && commonSubnets.indexOf(subnet) === -1) {
        setDiscSub('Also scanning detected subnet: ' + subnet + '.0/24');
        pending++;
        scanSubnets([subnet]).then(onFound).catch(onScanFail);
      }
      onScanFail(); // WebRTC branch done regardless of whether it added a scan
    }).catch(onScanFail);
  }

  function discoverySuccess(url) {
    API = url;
    setDiscStatus('Connected to ' + url, '');

    // Small pause so user sees the "connected" message, then fade out overlay
    setTimeout(function () {
      var ov = document.getElementById('discovery-overlay');
      ov.classList.add('fade-out');
      setTimeout(function () { ov.classList.add('gone'); }, 420);
      initApp();
    }, 600);
  }

  function showManualEntry() {
    document.getElementById('disc-manual').classList.remove('hidden');
    document.getElementById('disc-ip').focus();
  }

  function onManualConnect() {
    var raw = document.getElementById('disc-ip').value.trim();
    if (!raw) return;

    // Accept bare IP or full URL
    var url = raw.startsWith('http') ? raw.replace(/\/$/, '') : 'http://' + raw + ':8000';

    setDiscStatus('Connecting to ' + url + '…', '');
    document.getElementById('disc-manual-err').classList.add('hidden');

    probeServer(url)
      .then(function () {
        localStorage.setItem('ytv_server', url);
        discoverySuccess(url);
      })
      .catch(function () {
        var err = document.getElementById('disc-manual-err');
        err.textContent = 'Could not reach backend at ' + url;
        err.classList.remove('hidden');
        setDiscStatus('Connection failed.', 'Check IP and make sure uvicorn is running.');
      });
  }

  // ── Discovery helpers ─────────────────────────────────────────────────────────

  function xhrGet(url, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.timeout = timeoutMs;
      xhr.onload = function () {
        if (xhr.status < 200 || xhr.status >= 300) {
          reject(new Error('HTTP ' + xhr.status));
          return;
        }
        try { resolve(JSON.parse(xhr.responseText)); }
        catch (e) { reject(new Error('bad json')); }
      };
      xhr.onerror   = function () { reject(new Error('network error')); };
      xhr.ontimeout = function () { reject(new Error('timeout')); };
      xhr.open('GET', url, true);
      xhr.send();
    });
  }

  function probeServer(url) {
    return xhrGet(url + '/health', 4000).then(function (data) {
      if (data.name !== 'ytv') throw new Error('not our server');
    });
  }

  function tryIP(ip) {
    var url = 'http://' + ip + ':8000';
    return xhrGet(url + '/health', 3000).then(function (data) {
      if (data.name !== 'ytv') throw new Error();
      return url;
    });
  }

  function scanSubnets(subnets) {
    // Priority order: .1–.20 (routers/servers), .100–.150 (common DHCP), rest
    var order = [];
    for (var i = 1;   i <= 20;  i++) order.push(i);
    for (var i = 100; i <= 150; i++) order.push(i);
    for (var i = 21;  i <= 99;  i++) order.push(i);
    for (var i = 151; i <= 254; i++) order.push(i);

    // Build queue: check same host number across all subnets before moving on
    var queue = [];
    order.forEach(function (n) {
      subnets.forEach(function (s) { queue.push(s + '.' + n); });
    });

    // Concurrency-limited pool — avoids overwhelming the TV's TCP stack
    return new Promise(function (resolve, reject) {
      var LIMIT  = 30;
      var qIdx   = 0;
      var active = 0;
      var failed = 0;
      var done   = false;

      function dispatch() {
        while (!done && active < LIMIT && qIdx < queue.length) {
          var ip = queue[qIdx++];
          active++;
          tryIP(ip)
            .then(function (url) {
              if (!done) { done = true; resolve(url); }
            })
            .catch(function () {
              active--;
              failed++;
              if (!done) {
                if (failed >= queue.length) reject(new Error('all failed'));
                else dispatch();
              }
            });
        }
      }

      dispatch();
    });
  }

  // Resolves as soon as the first promise resolves; rejects if all reject
  function promiseAny(promises) {
    return new Promise(function (resolve, reject) {
      var remaining = promises.length;
      if (!remaining) { reject(new Error('empty')); return; }
      promises.forEach(function (p) {
        Promise.resolve(p).then(resolve).catch(function () {
          remaining -= 1;
          if (remaining === 0) reject(new Error('all failed'));
        });
      });
    });
  }

  // Use WebRTC to extract the device's local IP subnet (e.g. "192.168.1")
  // Resolves with null if WebRTC is unavailable or returns mDNS (.local) addresses
  function getLocalSubnet() {
    return new Promise(function (resolve) {
      try {
        var pc   = new RTCPeerConnection({ iceServers: [] });
        var done = false;

        function finish(result) {
          if (done) return;
          done = true;
          clearTimeout(timeout);
          try { pc.close(); } catch (e) {}
          resolve(result);
        }

        var timeout = setTimeout(function () { finish(null); }, 2500);

        pc.createDataChannel('');
        pc.createOffer()
          .then(function (o) { return pc.setLocalDescription(o); })
          .catch(function () { finish(null); });

        pc.onicecandidate = function (e) {
          if (done) return;
          if (!e.candidate) { finish(null); return; } // ICE gathering complete, no IP found

          var cand = e.candidate.candidate;
          // Modern Chromium returns mDNS names (xxx.local) instead of raw IPs
          if (cand.indexOf('.local') !== -1) { finish(null); return; }

          var m = /(\d+)\.(\d+)\.(\d+)\.\d+/.exec(cand);
          if (m) finish(m[1] + '.' + m[2] + '.' + m[3]);
        };
      } catch (err) {
        resolve(null);
      }
    });
  }

  function setDiscStatus(msg, sub) {
    document.getElementById('disc-status').textContent = msg;
    setDiscSub(sub || '');
  }
  function setDiscSub(msg) {
    document.getElementById('disc-sub').textContent = msg;
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  APP INIT (runs after discovery succeeds)
  // ════════════════════════════════════════════════════════════════════════════

  function initApp() {
    checkBackend();
    setInterval(checkBackend, 15000);
    loadCategory('trending');

    document.getElementById('search-btn').addEventListener('click', doSearch);
    document.getElementById('search-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter')     { doSearch(); e.preventDefault(); return; }
      if (e.key === 'ArrowDown') { setFocusZone('grid'); e.preventDefault(); return; }
      if (e.key === 'ArrowUp')   { setFocusZone('tabs'); e.preventDefault(); return; }
    });
    document.getElementById('search-input').addEventListener('focus', function () {
      focusZone = 'search';
    });

    [].forEach.call(document.querySelectorAll('.tab'), function (btn, i) {
      btn.addEventListener('click', function () { loadCategory(btn.dataset.cat); });
      btn.addEventListener('focus', function () { focusZone = 'tabs'; focusedTabIdx = i; });
    });

    setupVideoEvents();
    document.getElementById('ctrl-back-btn').addEventListener('click', closePlayer);
    document.getElementById('ctrl-playpause').addEventListener('click', togglePlayPause);
    document.getElementById('player-error-btn').addEventListener('click', closePlayer);

    document.getElementById('ctrl-bar-wrap').addEventListener('click', function (e) {
      var vid = document.getElementById('player-video');
      if (!vid.duration) return;
      var rect = document.getElementById('ctrl-bar-bg').getBoundingClientRect();
      vid.currentTime = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * vid.duration;
      showControls();
    });

    document.addEventListener('keydown', handleKey);
  }

  // ── Backend health dot ────────────────────────────────────────────────────────
  function checkBackend() {
    var d = document.getElementById('backend-dot');
    xhrGet(API + '/health', 4000)
      .then(function () {
        d.className = 'online';
        d.title     = 'Backend online';
      })
      .catch(function () {
        d.className = '';
        d.title     = 'Backend offline';
      });
  }

  // ── Category loading ──────────────────────────────────────────────────────────
  function loadCategory(cat) {
    activeTab     = cat;
    focusedTabIdx = CAT_KEYS.indexOf(cat);
    [].forEach.call(document.querySelectorAll('.tab'), function (btn) {
      btn.classList.toggle('active', btn.dataset.cat === cat);
    });
    setLabel(CATS[cat].label);
    loadVideos(CATS[cat].fetchUrl());
    setFocusZone('grid');
  }

  // ── Search ────────────────────────────────────────────────────────────────────
  function doSearch() {
    var q = document.getElementById('search-input').value.trim();
    if (!q) return;
    [].forEach.call(document.querySelectorAll('.tab'), function (b) { b.classList.remove('active'); });
    setLabel('Results: ' + q);
    loadVideos(API + '/youtube/search?q=' + enc(q));
    setFocusZone('grid');
  }

  // ── Fetch videos ──────────────────────────────────────────────────────────────
  function loadVideos(url) {
    showSpinner(true);
    document.getElementById('video-grid').innerHTML = '';
    videos = [];
    document.getElementById('error-msg').classList.add('hidden');

    xhrGet(url, 15000)
      .then(function (data) {
        if (data.error) throw new Error(data.error);
        videos = data.videos || [];
        renderGrid();
        showSpinner(false);
      })
      .catch(function (e) {
        showError(e.message);
        showSpinner(false);
      });
  }

  // ── Grid rendering ────────────────────────────────────────────────────────────
  function renderGrid() {
    var grid = document.getElementById('video-grid');
    grid.innerHTML = '';
    focusedIdx = 0;

    videos.forEach(function (v, i) {
      var card = document.createElement('div');
      card.className  = 'video-card';
      card.tabIndex   = 0;
      card.dataset.index = i;

      var badge = v.duration
        ? '<div class="video-dur-badge">' + fmtDur(v.duration) + '</div>' : '';

      card.innerHTML =
        '<div class="video-thumb-wrap">' +
          '<img class="video-thumb" src="' + esc(v.thumbnail) + '" alt="" loading="lazy">' +
          badge +
        '</div>' +
        '<div class="video-info">' +
          '<div class="video-title">' + esc(v.title)   + '</div>' +
          '<div class="video-meta">'  + esc(v.channel) + '</div>' +
        '</div>';

      card.addEventListener('click', function () { playVideo(i); });
      grid.appendChild(card);
    });

    focusCard(0);
  }

  function focusCard(idx) {
    var cards = document.querySelectorAll('.video-card');
    [].forEach.call(cards, function (c) { c.classList.remove('focused'); });
    if (idx >= 0 && idx < cards.length) {
      cards[idx].classList.add('focused');
      cards[idx].scrollIntoView({ block: 'nearest' });
    }
    focusedIdx = idx;
    focusZone  = 'grid';
  }

  function setFocusZone(zone) {
    focusZone = zone;
    if (zone === 'grid') {
      focusCard(focusedIdx >= 0 ? focusedIdx : 0);
    } else if (zone === 'tabs') {
      var tabs = document.querySelectorAll('.tab');
      var idx  = Math.max(0, focusedTabIdx);
      if (tabs[idx]) tabs[idx].focus();
      focusZone = 'tabs';
    } else if (zone === 'search') {
      document.getElementById('search-input').focus();
    }
  }

  // ── Play a video ──────────────────────────────────────────────────────────────
  function playVideo(idx) {
    var v = videos[idx];
    if (!v) return;
    focusedIdx = idx;
    onPlayer   = true;

    document.getElementById('ctrl-title').textContent   = v.title;
    document.getElementById('ctrl-channel').textContent = v.channel || '';

    document.getElementById('player-overlay').classList.remove('hidden');
    document.getElementById('player-loading').style.display = 'flex';
    document.getElementById('player-loading-title').textContent = v.title;
    document.getElementById('player-error').classList.add('hidden');
    document.getElementById('controls').classList.remove('visible');

    document.getElementById('ctrl-bar-fill').style.width = '0%';
    document.getElementById('ctrl-bar-buf').style.width  = '0%';
    document.getElementById('ctrl-bar-dot').style.left   = '0%';
    document.getElementById('ctrl-cur').textContent = '0:00';
    document.getElementById('ctrl-dur').textContent = '--:--';

    var vid = document.getElementById('player-video');
    vid.pause();
    vid.removeAttribute('src');
    vid.load();
    vid.volume = playerVolume;

    xhrGet(API + '/youtube/info?url=' + enc(v.url), 20000)
      .then(function (data) {
        if (data.error)       throw new Error(data.error);
        if (!data.stream_url) throw new Error('No playable stream found for this video.');
        vid.src = API + '/youtube/stream?url=' + enc(data.stream_url);
        var pp = vid.play();
        if (pp !== undefined) {
          pp.catch(function () {
            document.getElementById('player-loading').style.display = 'none';
            showControls(true);
          });
        }
      })
      .catch(function (e) {
        document.getElementById('player-loading').style.display = 'none';
        document.getElementById('player-error').classList.remove('hidden');
        document.getElementById('player-error-msg').textContent = e.message;
      });
  }

  function closePlayer() {
    var vid = document.getElementById('player-video');
    vid.pause();
    vid.removeAttribute('src');
    vid.load();
    document.getElementById('player-overlay').classList.add('hidden');
    document.getElementById('player-loading').style.display = 'flex';
    document.getElementById('player-loading-title').textContent = 'Loading video…';
    document.getElementById('controls').classList.remove('visible');
    clearTimeout(ctrlTimer);
    onPlayer  = false;
    focusZone = 'grid';
    focusCard(focusedIdx);
  }

  // ── Video element events ──────────────────────────────────────────────────────
  function setupVideoEvents() {
    var vid = document.getElementById('player-video');

    vid.addEventListener('canplay', function () {
      document.getElementById('player-loading').style.display = 'none';
      showControls();
    });
    vid.addEventListener('waiting', function () {
      document.getElementById('player-loading').style.display = 'flex';
      document.getElementById('player-loading-title').textContent = 'Buffering…';
    });
    vid.addEventListener('playing', function () {
      document.getElementById('player-loading').style.display = 'none';
      setPlayBtn(true);
    });
    vid.addEventListener('pause', function () {
      setPlayBtn(false);
      showControls(true);
    });
    vid.addEventListener('loadedmetadata', function () {
      document.getElementById('ctrl-dur').textContent = fmtDur(Math.floor(vid.duration));
    });
    vid.addEventListener('timeupdate', function () {
      if (!vid.duration) return;
      var pct = (vid.currentTime / vid.duration * 100).toFixed(2) + '%';
      document.getElementById('ctrl-bar-fill').style.width = pct;
      document.getElementById('ctrl-bar-dot').style.left   = pct;
      document.getElementById('ctrl-cur').textContent = fmtDur(Math.floor(vid.currentTime));
      if (vid.buffered.length > 0) {
        var bufEnd = vid.buffered.end(vid.buffered.length - 1);
        document.getElementById('ctrl-bar-buf').style.width =
          (bufEnd / vid.duration * 100).toFixed(2) + '%';
      }
    });
    vid.addEventListener('ended', closePlayer);
    vid.addEventListener('error', function () {
      document.getElementById('player-loading').style.display = 'none';
      document.getElementById('player-error').classList.remove('hidden');
      document.getElementById('player-error-msg').textContent =
        'Stream error — URL may have expired. Press Back and retry.';
    });
  }

  function setPlayBtn(playing) {
    document.getElementById('ctrl-playpause').innerHTML = playing ? '&#9646;&#9646;' : '&#9654;';
  }

  // ── Controls visibility ───────────────────────────────────────────────────────
  function showControls(keepOpen) {
    document.getElementById('controls').classList.add('visible');
    clearTimeout(ctrlTimer);
    if (!keepOpen) {
      ctrlTimer = setTimeout(function () {
        if (!document.getElementById('player-video').paused) hideControls();
      }, 3500);
    }
  }
  function hideControls() {
    document.getElementById('controls').classList.remove('visible');
  }

  // ── Playback helpers ──────────────────────────────────────────────────────────
  function togglePlayPause() {
    var vid = document.getElementById('player-video');
    if (vid.paused) { vid.play(); flashBigIcon('&#9654;'); }
    else            { vid.pause(); flashBigIcon('&#9646;&#9646;'); }
    showControls();
  }

  function seekBy(secs) {
    var vid = document.getElementById('player-video');
    if (!vid.duration) return;
    vid.currentTime = Math.max(0, Math.min(vid.duration, vid.currentTime + secs));
    showToast(secs > 0 ? '+' + secs + 's  >>' : '<< ' + Math.abs(secs) + 's');
    showControls();
  }

  function changeVolume(delta) {
    playerVolume = Math.max(0, Math.min(1, playerVolume + delta));
    document.getElementById('player-video').volume = playerVolume;
    document.getElementById('ctrl-vol-fill').style.width = (playerVolume * 100) + '%';
    document.getElementById('ctrl-vol-pct').textContent  = Math.round(playerVolume * 100) + '%';
    showToast('VOL ' + Math.round(playerVolume * 100) + '%');
    showControls();
  }

  function flashBigIcon(html) {
    var el = document.getElementById('ctrl-bigicon');
    el.innerHTML = html;
    el.classList.add('flash');
    clearTimeout(bigIconTimer);
    bigIconTimer = setTimeout(function () { el.classList.remove('flash'); }, 700);
  }

  function showToast(msg) {
    var el = document.getElementById('action-toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.add('hidden'); }, 900);
  }

  // ── Remote / keyboard handler ─────────────────────────────────────────────────
  function handleKey(e) {
    var kc = e.keyCode;

    if (onPlayer) {
      showControls();
      if (e.key === 'ArrowLeft')  { seekBy(-10);        e.preventDefault(); return; }
      if (e.key === 'ArrowRight') { seekBy(+10);        e.preventDefault(); return; }
      if (e.key === 'ArrowUp')    { changeVolume(+0.1); e.preventDefault(); return; }
      if (e.key === 'ArrowDown')  { changeVolume(-0.1); e.preventDefault(); return; }
      if (e.key === 'Enter')      { togglePlayPause();  e.preventDefault(); return; }
      if (e.key === 'Backspace')  { closePlayer();      e.preventDefault(); return; }
      if (kc === 461 || kc === 10009) { closePlayer();      e.preventDefault(); return; }
      if (kc === 403)             { closePlayer();      e.preventDefault(); return; }
      if (kc === 415)             { document.getElementById('player-video').play();  showControls(); e.preventDefault(); return; }
      if (kc === 19)              { document.getElementById('player-video').pause(); showControls(); e.preventDefault(); return; }
      if (kc === 413)             { closePlayer();      e.preventDefault(); return; }
      if (kc === 412)             { seekBy(-30);        e.preventDefault(); return; }
      if (kc === 417)             { seekBy(+30);        e.preventDefault(); return; }
      if (kc === 447)             { changeVolume(+0.1); e.preventDefault(); return; }
      if (kc === 448)             { changeVolume(-0.1); e.preventDefault(); return; }
      if (kc === 449) {
        var mv = playerVolume > 0 ? -playerVolume : 1;
        changeVolume(mv); e.preventDefault(); return;
      }
      return;
    }

    if (focusZone === 'search') return;

    if (focusZone === 'tabs') {
      var tabs = document.querySelectorAll('.tab');
      if (e.key === 'ArrowLeft')  { var ni = Math.max(0, focusedTabIdx - 1); focusedTabIdx = ni; if (tabs[ni]) tabs[ni].focus(); e.preventDefault(); return; }
      if (e.key === 'ArrowRight') { var ni = Math.min(tabs.length - 1, focusedTabIdx + 1); focusedTabIdx = ni; if (tabs[ni]) tabs[ni].focus(); e.preventDefault(); return; }
      if (e.key === 'ArrowUp')    { setFocusZone('search'); e.preventDefault(); return; }
      if (e.key === 'ArrowDown')  { setFocusZone('grid');   e.preventDefault(); return; }
      if (e.key === 'Enter') {
        var cat = tabs[focusedTabIdx] && tabs[focusedTabIdx].dataset.cat;
        if (cat) loadCategory(cat);
        e.preventDefault(); return;
      }
      if (e.key === 'Backspace' || kc === 461 || kc === 10009) { loadCategory('trending'); e.preventDefault(); return; }
      return;
    }

    // Grid zone
    var count = videos.length;
    if (e.key === 'ArrowRight') { if (focusedIdx < count - 1) focusCard(focusedIdx + 1); e.preventDefault(); return; }
    if (e.key === 'ArrowLeft')  { if (focusedIdx > 0) focusCard(focusedIdx - 1); e.preventDefault(); return; }
    if (e.key === 'ArrowDown')  { if (focusedIdx + COLS < count) focusCard(focusedIdx + COLS); e.preventDefault(); return; }
    if (e.key === 'ArrowUp') {
      if (focusedIdx >= COLS) focusCard(focusedIdx - COLS);
      else setFocusZone('tabs');
      e.preventDefault(); return;
    }
    if (e.key === 'Enter')     { if (count) playVideo(focusedIdx); e.preventDefault(); return; }
    if (e.key === 'Backspace' || kc === 461 || kc === 10009) {
      document.getElementById('search-input').value = '';
      loadCategory('trending');
      e.preventDefault(); return;
    }
    if (kc === 403) { setFocusZone('search'); e.preventDefault(); }
    if (kc === 404) { var ni = (CAT_KEYS.indexOf(activeTab) + 1) % CAT_KEYS.length; loadCategory(CAT_KEYS[ni]); e.preventDefault(); }
    if (kc === 405) { var ni = (CAT_KEYS.indexOf(activeTab) - 1 + CAT_KEYS.length) % CAT_KEYS.length; loadCategory(CAT_KEYS[ni]); e.preventDefault(); }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────
  function setLabel(t) { document.getElementById('grid-label').textContent = t; }
  function showSpinner(v) { document.getElementById('spinner').classList.toggle('hidden', !v); }
  function showError(msg) {
    var el = document.getElementById('error-msg');
    el.textContent = '⚠ ' + msg;
    el.classList.remove('hidden');
  }
  function enc(s) { return encodeURIComponent(s); }
  function esc(s) {
    return String(s || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function fmtDur(secs) {
    if (!secs || secs < 0) return '';
    var h = Math.floor(secs / 3600);
    var m = Math.floor((secs % 3600) / 60);
    var s = Math.floor(secs % 60);
    return h ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
  }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }

}());
