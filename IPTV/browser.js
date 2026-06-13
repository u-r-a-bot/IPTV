(function () {
  'use strict';

  // Set after discovery; null until then
  var API  = null;

  // Default server used only when nothing is saved. localStorage 'ytv_server'
  // (set via discovery or Settings) always takes priority over this.
  var DEFAULT_SERVER = 'http://192.168.0.191:8000';
  var COLS = 4;
  var PAGE = 24;   // videos fetched per page / "Load More" batch

  // ── Grid state ───────────────────────────────────────────────────────────────
  var videos        = [];
  var focusedIdx    = 0;
  var focusedTabIdx = 0;
  var focusZone     = 'grid';   // 'search' | 'tabs' | 'grid'
  var activeTab     = 'trending';
  var currentView   = 'trending'; // category key, or 'search:<q>' — used for focus memory
  var lastFocusByView = {};       // remember last-focused card per view

  // ── Pagination state ───────────────────────────────────────────────────────────
  var currentLoader = null;  // function(offset, limit) -> url; null for local views
  var pageOffset    = 0;
  var hasMore       = false;
  var loadingMore   = false;

  function searchUrl(q) {
    return function (o, l) {
      return API + '/youtube/search?q=' + enc(q) + '&limit=' + l + '&offset=' + o;
    };
  }

  var CATS = {
    trending:  { label: 'Trending',  fetchUrl: function (o, l) { return API + '/youtube/trending?limit=' + l + '&offset=' + o; } },
    music:     { label: 'Music',     fetchUrl: searchUrl('trending music 2024') },
    gaming:    { label: 'Gaming',    fetchUrl: searchUrl('gaming highlights 2024') },
    news:      { label: 'News',      fetchUrl: searchUrl('breaking news today') },
    sports:    { label: 'Sports',    fetchUrl: searchUrl('sports highlights today') },
    movies:    { label: 'Movies',    fetchUrl: searchUrl('movie trailers 2024') },
    history:   { label: 'History',   local: true, getItems: getHistory,   empty: 'No watch history yet. Videos you play show up here.' },
    favorites: { label: 'Favorites', local: true, getItems: getFavorites, empty: 'No favorites yet. Press the blue button on a video to add one.' },
  };
  var CAT_KEYS = ['trending','music','gaming','news','sports','movies','history','favorites'];

  var settingsOpen = false;

  // ── Player state ─────────────────────────────────────────────────────────────
  var onPlayer     = false;
  var playerVolume = 1.0;
  var ctrlTimer    = null;
  var bigIconTimer = null;
  var toastTimer   = null;

  var SPEEDS       = [0.5, 0.75, 1, 1.25, 1.5, 2];
  var speedIdx     = 2;        // index into SPEEDS; 2 == 1x
  var lastPosSave  = 0;        // throttle timestamp for savePosition

  var currentFormats   = [];   // quality options for the playing video (asc by height)
  var currentQualityIdx = 0;   // index into currentFormats (highest == default)
  var activeMenu       = null; // open navigable menu (quality/speed) or null
  var currentVideoId   = '';   // id of the playing video (needed for mux stream URLs)
  var pendingSeek      = 0;     // native-seek (resume / quality switch) after metadata
  var knownDuration    = 0;     // true video duration from /info (for early UI)

  // ── DASH/MSE engine (720p/1080p): streams YouTube's own video+audio segments
  // into two SourceBuffers — no ffmpeg, no disk, no seams. Falls back to the
  // cached /muxed file if MSE is unavailable or the stream fails. ──
  var dashActive   = false;
  var dashMs       = null;      // MediaSource
  var dashObjUrl   = null;
  var dashGen      = 0;         // bumped on teardown/seek to invalidate async work
  var dashStarted  = false;     // playback has begun
  var dashAnchor   = 0;         // time to (re)start playback at
  var dashHeight   = 0;
  var dashTracks   = { video: null, audio: null };
  var dashRefreshing  = false;  // a stale-URL refresh is in flight
  var dashRefreshCount = 0;
  var DASH_AHEAD  = 24;         // seconds to keep buffered ahead per track
  var DASH_BEHIND = 15;         // seconds to keep behind before evicting

  // ════════════════════════════════════════════════════════════════════════════
  //  DISCOVERY
  // ════════════════════════════════════════════════════════════════════════════

  var discManualTimer = null;

  document.addEventListener('DOMContentLoaded', function () {
    document.getElementById('disc-connect-btn').addEventListener('click', onManualConnect);
    document.getElementById('disc-ip').addEventListener('keydown', function (e) {
      if (e.keyCode === 13) onManualConnect();
    });

    runDiscovery();
  });

  function runDiscovery() {
    // Saved server (from a previous connect / Settings) wins; else the default.
    var saved = localStorage.getItem('ytv_server');
    var first = saved || DEFAULT_SERVER;

    if (!first) {
      setDiscStatus('Enter your server address', '');
      showManualEntry();
      return;
    }

    setDiscStatus('Connecting to ' + first + '…', saved ? 'Using saved server' : 'Using default server');

    probeServer(first)
      .then(function () {
        localStorage.setItem('ytv_server', first);
        discoverySuccess(first);
      })
      .catch(function (err) {
        var msg = (err && err.message) ? err.message : String(err);
        setDiscStatus('Cannot reach ' + first, 'Error: ' + msg);
        setTimeout(showManualEntry, 1500);
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
      if (e.keyCode === 13) { doSearch(); e.preventDefault(); return; }
      if (e.keyCode === 40) { setFocusZone('grid'); e.preventDefault(); return; }
      if (e.keyCode === 38) { setFocusZone('tabs'); e.preventDefault(); return; }
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
    document.getElementById('ctrl-prev').addEventListener('click', playPrev);
    document.getElementById('ctrl-next').addEventListener('click', playNext);
    document.getElementById('ctrl-back10').addEventListener('click', function () { seekBy(-10); });
    document.getElementById('ctrl-fwd10').addEventListener('click', function () { seekBy(+10); });
    document.getElementById('ctrl-speed').addEventListener('click', openSpeedMenu);
    document.getElementById('ctrl-quality').addEventListener('click', openQualityMenu);
    document.getElementById('player-error-btn').addEventListener('click', closePlayer);
    document.getElementById('player-retry-btn').addEventListener('click', function () { playVideo(focusedIdx); });

    // Magic-remote pointer support: move shows controls, click toggles play/pause
    var overlay = document.getElementById('player-overlay');
    overlay.addEventListener('mousemove', function () { if (onPlayer) showControls(); });
    document.getElementById('controls').addEventListener('click', function (e) {
      if (isInteractive(e.target)) return;   // ignore buttons / scrubber / volume
      togglePlayPause();
    });
    document.getElementById('player-video').addEventListener('click', togglePlayPause);

    // Settings overlay
    document.getElementById('settings-btn').addEventListener('click', openSettings);
    document.getElementById('settings-save').addEventListener('click', saveSettings);
    document.getElementById('settings-forget').addEventListener('click', forgetServer);
    document.getElementById('settings-close').addEventListener('click', closeSettings);
    document.getElementById('settings-ip').addEventListener('keydown', function (e) {
      if (e.keyCode === 13) { saveSettings(); e.preventDefault(); }
    });

    document.getElementById('ctrl-bar-wrap').addEventListener('click', function (e) {
      var dur = totalDuration();
      if (!dur) return;
      var rect = document.getElementById('ctrl-bar-bg').getBoundingClientRect();
      var pct  = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      if (dashActive) dashSeek(pct * dur);
      else document.getElementById('player-video').currentTime = pct * dur;
      showControls();
    });

    // Lazy-load thumbnails as the grid scrolls (pointer wheel / momentum), throttled
    var thumbScrollTimer = null;
    document.getElementById('grid-area').addEventListener('scroll', function () {
      if (thumbScrollTimer) return;
      thumbScrollTimer = setTimeout(function () {
        thumbScrollTimer = null;
        loadVisibleThumbs();
      }, 90);
    });

    document.addEventListener('keydown', handleKey);

    // ── Back button via history (WebOS preventDefault on 461 does NOT stop the
    // system close/launcher). Trick: keep one buffer history entry; Back pops it
    // and fires popstate (app stays alive) instead of closing. Re-arm each time. ──
    try { history.pushState(null, ''); } catch (e) {}
    window.addEventListener('popstate', function () {
      try { history.pushState(null, ''); } catch (e) {}  // re-arm so Back never exits
      handleBack();
    });
  }

  // Single Back action, routed by current view. Debounced so a stray keydown 461
  // default + popstate for one press doesn't double-fire.
  var lastBackTs = 0;
  function handleBack() {
    var now = Date.now();
    if (now - lastBackTs < 350) return;
    lastBackTs = now;

    if (activeMenu)   { menuClose();     return; }
    if (settingsOpen) { closeSettings(); return; }
    if (onPlayer)     { closePlayer();   return; }
    if (focusZone === 'tabs' || focusZone === 'settingsbtn' || focusZone === 'search') {
      setFocusZone('grid'); return;
    }
    if (activeTab !== 'trending') {            // grid, not on default tab
      document.getElementById('search-input').value = '';
      loadCategory('trending');
      return;
    }
    // Already at the trending grid — stay put (Back never exits; use Home to leave)
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
    currentView   = cat;
    focusedTabIdx = CAT_KEYS.indexOf(cat);
    [].forEach.call(document.querySelectorAll('.tab'), function (btn) {
      btn.classList.toggle('active', btn.dataset.cat === cat);
    });
    setLabel(CATS[cat].label);

    var c = CATS[cat];
    if (c.local) {
      // History / Favorites — rendered straight from localStorage, no fetch
      currentLoader = null;
      hasMore       = false;
      videos        = c.getItems();
      document.getElementById('error-msg').classList.add('hidden');
      renderGrid();
      if (!videos.length) showEmpty(c.empty);
    } else {
      startLoad(c.fetchUrl);
    }
    setFocusZone('grid');
  }

  // ── Search ────────────────────────────────────────────────────────────────────
  function doSearch() {
    var q = document.getElementById('search-input').value.trim();
    if (!q) return;
    [].forEach.call(document.querySelectorAll('.tab'), function (b) { b.classList.remove('active'); });
    activeTab   = '';
    currentView = 'search:' + q;
    setLabel('Results: ' + q);
    startLoad(searchUrl(q));
    setFocusZone('grid');
  }

  // ── Fetch first page ────────────────────────────────────────────────────────────
  function startLoad(loaderFn) {
    currentLoader = loaderFn;
    pageOffset    = 0;
    hasMore       = false;
    loadingMore   = false;
    videos        = [];
    document.getElementById('error-msg').classList.add('hidden');
    renderSkeletons(12);

    xhrGet(loaderFn(0, PAGE), 15000)
      .then(function (data) {
        if (data.error) throw new Error(data.error);
        videos     = data.videos || [];
        hasMore    = !!data.has_more && videos.length > 0;
        pageOffset = videos.length;
        renderGrid();
        if (!videos.length) showEmpty('No videos found.');
      })
      .catch(function (e) {
        clearGrid();
        showError(e.message);
      });
  }

  // ── Fetch next page and append ──────────────────────────────────────────────────
  function loadMore() {
    if (!currentLoader || loadingMore || !hasMore) return;
    loadingMore = true;
    setLoadMoreCard('loading');

    xhrGet(currentLoader(pageOffset, PAGE), 15000)
      .then(function (data) {
        if (data.error) throw new Error(data.error);
        var more  = data.videos || [];
        var start = videos.length;
        videos    = videos.concat(more);
        pageOffset = videos.length;
        hasMore   = !!data.has_more && more.length > 0;
        loadingMore = false;
        appendCards(more, start);
        if (more.length) focusCard(start);   // jump to first new card
      })
      .catch(function () {
        loadingMore = false;
        setLoadMoreCard('error');
      });
  }

  // ── Grid rendering ────────────────────────────────────────────────────────────
  function makeCard(v, i) {
    var card = document.createElement('div');
    card.className     = 'video-card';
    card.tabIndex      = 0;
    card.dataset.index = i;

    var badge = v.duration
      ? '<div class="video-dur-badge">' + fmtDur(v.duration) + '</div>' : '';
    var fav = isFavorite(v) ? '<div class="video-fav-badge">&#9733;</div>' : '';

    // Thumbnail is lazy: native loading="lazy" is a no-op on Chrome 38, so the
    // src is held in data-src and swapped in by loadVisibleThumbs() only when the
    // card nears the viewport. This stops 24+ JPEGs decoding at once (the jank).
    card.innerHTML =
      '<div class="video-thumb-wrap">' +
        '<img class="video-thumb" data-src="' + esc(v.thumbnail) + '" alt="">' +
        badge + fav +
        '<div class="video-play-hint">&#9654; OK</div>' +
      '</div>' +
      '<div class="video-info">' +
        channelAvatar(v.channel) +
        '<div class="video-text">' +
          '<div class="video-title">' + esc(v.title)   + '</div>' +
          '<div class="video-meta">'  + esc(v.channel) + '</div>' +
        '</div>' +
      '</div>';

    // Fade the image in once decoded; on error stop hiding it (avoids a blank card)
    var img = card.querySelector('.video-thumb');
    img.addEventListener('load',  function () { img.classList.add('loaded'); });
    img.addEventListener('error', function () { img.classList.add('loaded'); });

    card.addEventListener('click', function () { playVideo(i); });
    return card;
  }

  function makeLoadMoreCard() {
    var card = document.createElement('div');
    card.className = 'video-card load-more-card';
    card.id        = 'load-more-card';
    card.tabIndex  = 0;
    card.innerHTML =
      '<div class="load-more-inner">' +
        '<span class="load-more-icon">&#8595;</span>' +
        '<span class="load-more-text">Load More</span>' +
      '</div>';
    card.addEventListener('click', loadMore);
    return card;
  }

  function renderGrid() {
    var grid = document.getElementById('video-grid');
    grid.innerHTML = '';

    videos.forEach(function (v, i) { grid.appendChild(makeCard(v, i)); });
    if (hasMore) grid.appendChild(makeLoadMoreCard());

    // Restore last-focused position for this view, clamped to range
    var want = lastFocusByView[currentView];
    if (want == null) want = 0;
    var max = grid.querySelectorAll('.video-card').length - 1;
    focusCard(Math.max(0, Math.min(want, max)));
    loadVisibleThumbs();
  }

  // Append newly fetched cards without rebuilding existing ones (keeps focus stable)
  function appendCards(more, startIdx) {
    var grid = document.getElementById('video-grid');
    var lm   = document.getElementById('load-more-card');
    if (lm) grid.removeChild(lm);
    more.forEach(function (v, k) { grid.appendChild(makeCard(v, startIdx + k)); });
    if (hasMore) grid.appendChild(makeLoadMoreCard());
    loadVisibleThumbs();
  }

  function setLoadMoreCard(state) {
    var lm = document.getElementById('load-more-card');
    if (!lm) return;
    var txt = lm.querySelector('.load-more-text');
    if (state === 'loading')    { txt.textContent = 'Loading…';  lm.classList.add('busy'); }
    else if (state === 'error') { txt.textContent = 'Retry';     lm.classList.remove('busy'); }
  }

  function renderSkeletons(n) {
    var grid = document.getElementById('video-grid');
    grid.innerHTML = '';
    for (var i = 0; i < n; i++) {
      var s = document.createElement('div');
      s.className = 'video-card skeleton';
      s.innerHTML =
        '<div class="video-thumb-wrap skel-box"></div>' +
        '<div class="video-info">' +
          '<div class="skel-avatar"></div>' +
          '<div class="video-text">' +
            '<div class="skel-line skel-line-1"></div>' +
            '<div class="skel-line skel-line-2"></div>' +
          '</div>' +
        '</div>';
      grid.appendChild(s);
    }
  }

  function clearGrid() {
    document.getElementById('video-grid').innerHTML = '';
  }

  function focusCard(idx) {
    var cards = document.querySelectorAll('.video-card');
    [].forEach.call(cards, function (c) { c.classList.remove('focused'); });
    if (idx >= 0 && idx < cards.length) {
      cards[idx].classList.add('focused');
      scrollCardIntoView(cards[idx]);
      loadVisibleThumbs();
    }
    focusedIdx = idx;
    focusZone  = 'grid';
    lastFocusByView[currentView] = idx;
  }

  // Manual scroll — scrollIntoView({block:'nearest'}) is Chrome 61+ and on WebOS 3.4
  // (Chrome 38) the options object is coerced to true, slamming the card to the top.
  // Only scroll when the card is actually outside the viewport, with breathing room.
  function scrollCardIntoView(card) {
    var area = document.getElementById('grid-area');
    if (!area) return;
    var cr  = card.getBoundingClientRect();
    var ar  = area.getBoundingClientRect();
    var pad = 28;
    if (cr.top < ar.top + pad) {
      area.scrollTop -= (ar.top + pad - cr.top);
    } else if (cr.bottom > ar.bottom - pad) {
      area.scrollTop += (cr.bottom - (ar.bottom - pad));
    }
  }

  // ── Lazy thumbnail loading (manual — IntersectionObserver is Chrome 51+) ────────
  // Swaps data-src → src for any thumbnail within one screen of the viewport.
  // Cheap: one getBoundingClientRect per still-unloaded image.
  function loadVisibleThumbs() {
    var area = document.getElementById('grid-area');
    if (!area) return;
    var ar     = area.getBoundingClientRect();
    var margin = ar.height || 600;          // preload roughly one screen ahead
    var imgs   = document.querySelectorAll('.video-thumb[data-src]');
    [].forEach.call(imgs, function (img) {
      var r = img.getBoundingClientRect();
      if (r.bottom >= ar.top - margin && r.top <= ar.bottom + margin) {
        img.src = img.getAttribute('data-src');
        img.removeAttribute('data-src');
      }
    });
  }

  // ── Channel avatar (coloured initial — no backend needed) ───────────────────────
  function channelAvatar(name) {
    name = String(name || '').trim();
    var letter = name ? name.charAt(0).toUpperCase() : '?';
    return '<div class="video-avatar" style="background:' + avatarColor(name) + '">' +
           esc(letter) + '</div>';
  }
  function avatarColor(s) {
    var palette = ['#c0392b','#2980b9','#27ae60','#8e44ad','#d35400','#16a085','#34495e','#e67e22'];
    var h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return palette[Math.abs(h) % palette.length];
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
    } else if (zone === 'settingsbtn') {
      document.getElementById('settings-btn').focus();
    }
  }

  // ── Play a video ──────────────────────────────────────────────────────────────
  function playVideo(idx) {
    var v = videos[idx];
    if (!v) return;
    focusedIdx = idx;
    onPlayer   = true;
    currentVideoId = v.id || '';
    recordHistory(v);

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

    currentFormats    = [];
    currentQualityIdx = 0;
    pendingSeek       = 0;
    knownDuration     = 0;

    xhrGet(API + '/youtube/info?url=' + enc(v.url), 20000)
      .then(function (data) {
        if (data.error) throw new Error(data.error);
        knownDuration  = data.duration || 0;
        currentFormats = data.qualities || [];
        if (!currentFormats.length) {
          if (!data.stream_url) throw new Error('No playable stream found for this video.');
          currentFormats = [{ height: 0, label: 'Auto', mode: 'progressive', stream_url: data.stream_url }];
        }
        var idx0 = pickDefaultIdx();             // highest playable ≤1080p (4K is opt-in)

        // Resume from saved position if meaningfully into the video.
        var resume  = getSavedPosition(v.id);
        var startAt = 0;
        if (resume > 5 && knownDuration && resume < knownDuration - 15) {
          startAt = resume;
          showToast('Resumed from ' + fmtDur(resume));
        }
        loadQuality(idx0, startAt);
      })
      .catch(function (e) {
        document.getElementById('player-loading').style.display = 'none';
        document.getElementById('player-error').classList.remove('hidden');
        document.getElementById('player-error-msg').textContent = e.message;
      });
  }

  function closePlayer() {
    var vid = document.getElementById('player-video');
    savePosition(videos[focusedIdx], realTime(), totalDuration());
    menuClose();
    dashTeardown();
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
      document.getElementById('ctrl-dur').textContent = fmtDur(Math.floor(totalDuration()));
      applySpeed();
      // Seek to resume point / position carried across a quality switch.
      if (pendingSeek > 0) {
        try { vid.currentTime = pendingSeek; } catch (e) {}
      }
      pendingSeek = 0;
    });
    vid.addEventListener('timeupdate', function () {
      if (dashActive) dashTick();                    // keep segments flowing / evict
      var dur = totalDuration();
      if (!dur) return;
      var cur = realTime();
      var pct = Math.min(100, cur / dur * 100).toFixed(2) + '%';
      document.getElementById('ctrl-bar-fill').style.width = pct;
      document.getElementById('ctrl-bar-dot').style.left   = pct;
      document.getElementById('ctrl-cur').textContent = fmtDur(Math.floor(cur));
      if (vid.buffered.length > 0) {
        document.getElementById('ctrl-bar-buf').style.width =
          Math.min(100, vid.buffered.end(vid.buffered.length - 1) / dur * 100).toFixed(2) + '%';
      }
      // Persist position at most once every 5s
      var now = Date.now();
      if (now - lastPosSave > 5000) {
        lastPosSave = now;
        savePosition(videos[focusedIdx], cur, dur);
      }
    });
    vid.addEventListener('ended', function () {
      // Finished — clear saved position and auto-advance if possible
      var v = videos[focusedIdx];
      if (v && v.id) { try { localStorage.removeItem(posKey(v.id)); } catch (e) {} }
      if (focusedIdx < videos.length - 1) {
        showToast('▶▶ Up next…');
        playVideo(focusedIdx + 1);
      } else {
        closePlayer();
      }
    });
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
    if (vid.paused) { var pp = vid.play(); if (pp !== undefined) pp.catch(function () {}); flashBigIcon('&#9654;'); }
    else            { vid.pause(); flashBigIcon('&#9646;&#9646;'); }
    showControls();
  }

  function playNext() {
    if (focusedIdx < videos.length - 1) playVideo(focusedIdx + 1);
    else showToast('No next video');
  }
  function playPrev() {
    if (focusedIdx > 0) playVideo(focusedIdx - 1);
    else showToast('No previous video');
  }

  // ── Playback speed ──────────────────────────────────────────────────────────────
  function applySpeed() {
    var vid = document.getElementById('player-video');
    try { vid.playbackRate = SPEEDS[speedIdx]; } catch (e) {}
    document.getElementById('ctrl-speed').textContent = SPEEDS[speedIdx] + 'x';
  }

  // ── Position helpers ────────────────────────────────────────────────────────────
  function realTime() {
    return document.getElementById('player-video').currentTime || 0;
  }
  function totalDuration() {
    var vid = document.getElementById('player-video');
    return vid.duration || knownDuration || 0;
  }

  // ── Load a quality at a given time ──────────────────────────────────────────────
  // Both 'mux' (720p/1080p via /muxed) and 'progressive' (360p via /stream) return
  // a complete, byte-seekable MP4 — the only kind WebOS 3.4's native <video> plays —
  // so playback and seeking are native. `atTime` is applied once metadata loads.
  function loadQuality(idx, atTime) {
    if (idx < 0 || idx >= currentFormats.length) return;
    dashTeardown();                                   // stop any running MSE session
    currentQualityIdx = idx;
    var f   = currentFormats[idx];
    var vid = document.getElementById('player-video');

    document.getElementById('ctrl-quality').textContent = f.label;
    document.getElementById('player-loading').style.display = 'flex';

    // 720p/1080p → DASH/MSE streaming (no disk, no wait). Needs codec info + MSE.
    if (f.mode === 'mux' && f.codecs && dashSupported()) {
      dashStart(f, atTime);
      return;
    }
    // 720p/1080p without MSE → cached complete MP4. 360p → progressive proxy.
    pendingSeek = Math.max(0, atTime || 0);
    if (f.mode === 'mux') {
      document.getElementById('player-loading-title').textContent =
        'Preparing ' + f.label + '… (first time only)';
      vid.src = API + '/youtube/muxed?id=' + enc(currentVideoId) + '&height=' + f.height;
    } else {
      document.getElementById('player-loading-title').textContent = 'Loading ' + f.label + '…';
      vid.src = API + '/youtube/stream?url=' + enc(f.stream_url);
    }
    vid.load();
    var pp = vid.play();
    if (pp !== undefined) {
      pp.catch(function () {
        document.getElementById('player-loading').style.display = 'none';
        showControls(true);
      });
    }
  }

  // ── Quality picker (Red / quality button → menu of options) ─────────────────────
  // A format is playable if: progressive (native), or mp4/avc1 mux (MSE *or* the
  // /muxed native fallback can serve it), or webm/VP9 mux only where the TV's MSE
  // actually supports VP9+Opus — so 1440p/2160p just won't appear on TVs that can't
  // decode them, rather than failing.
  function formatPlayable(f) {
    if (!f) return false;
    if (f.mode !== 'mux') return true;
    if (f.container === 'webm') {
      return dashSupported() && f.codecs && f.acodecs
          && MediaSource.isTypeSupported(f.codecs)
          && MediaSource.isTypeSupported(f.acodecs);
    }
    return true;                                   // mp4/avc1: native-decodable on this TV
  }

  // Default: best playable quality at ≤1080p (4K is bandwidth-heavy → opt-in via menu).
  function pickDefaultIdx() {
    var hi = -1, hiCap = -1;
    for (var i = 0; i < currentFormats.length; i++) {
      if (!formatPlayable(currentFormats[i])) continue;
      if (hi < 0 || currentFormats[i].height > currentFormats[hi].height) hi = i;
      if (currentFormats[i].height <= 1080 &&
          (hiCap < 0 || currentFormats[i].height > currentFormats[hiCap].height)) hiCap = i;
    }
    return hiCap >= 0 ? hiCap : (hi >= 0 ? hi : 0);
  }

  // ── Generic navigable menu (D-pad + Magic-Remote cursor) ────────────────────────
  // Drives both the quality and speed pickers. opts = { kind, el, listEl, anchorEl,
  // items:[{ html, current, onSelect }], idx }. Rows hover-to-focus and click-to-
  // select; a click outside the panel dismisses it.
  function menuOpen(opts) {
    menuClose();
    opts.listEl.innerHTML = '';
    opts.items.forEach(function (it, i) {
      var row = document.createElement('div');
      row.className = 'menu-row' + (it.current ? ' current' : '');
      row.innerHTML = it.html;
      row.addEventListener('mouseenter', function () { menuFocus(i); });
      row.addEventListener('click', function (e) { e.stopPropagation(); menuSelect(i); });
      opts.listEl.appendChild(row);
    });
    activeMenu = opts;
    opts.el.classList.remove('hidden');
    menuFocus(opts.idx || 0);
    showControls(true);
    // Defer so the click that opened the menu doesn't immediately dismiss it.
    setTimeout(function () { document.addEventListener('click', menuOutside, true); }, 0);
  }

  function menuOutside(e) {
    if (!activeMenu) return;
    if (activeMenu.el.contains(e.target)) return;
    if (activeMenu.anchorEl && activeMenu.anchorEl.contains(e.target)) return;
    e.stopPropagation(); e.preventDefault();   // first outside click just dismisses
    menuClose();
  }

  function menuClose() {
    if (!activeMenu) return;
    activeMenu.el.classList.add('hidden');
    activeMenu = null;
    document.removeEventListener('click', menuOutside, true);
  }

  function menuFocus(i) {
    if (!activeMenu) return;
    activeMenu.idx = Math.max(0, Math.min(activeMenu.items.length - 1, i));
    var rows = activeMenu.listEl.children;
    for (var k = 0; k < rows.length; k++) {
      rows[k].className = rows[k].className.replace(/ focused/g, '') + (k === activeMenu.idx ? ' focused' : '');
    }
    var r = rows[activeMenu.idx];
    if (r && r.scrollIntoView) { try { r.scrollIntoView(false); } catch (e) {} }
  }

  function menuMove(dir) { menuFocus(activeMenu.idx + dir); }

  function menuSelect(i) {
    if (!activeMenu) return;
    var it = activeMenu.items[i];
    menuClose();
    if (it && it.onSelect) it.onSelect();
  }

  // ── Quality picker (Red / quality button) ───────────────────────────────────────
  function openQualityMenu() {
    if (activeMenu && activeMenu.kind === 'quality') { menuClose(); return; }   // toggle
    var items = [], curRow = 0, n = 0;
    for (var i = currentFormats.length - 1; i >= 0; i--) {        // highest first
      if (!formatPlayable(currentFormats[i])) continue;
      (function (idx, row) {
        var f = currentFormats[idx];
        var cur = (idx === currentQualityIdx);
        if (cur) curRow = row;
        var tag = f.height >= 2160 ? '4K' : (f.height >= 1440 ? 'QHD' : (f.height >= 1080 ? 'HD' : ''));
        items.push({
          current: cur,
          html: '<span class="menu-row-lbl">' + f.label + '</span>' +
                '<span class="menu-row-tag">' + tag + '</span>' +
                '<span class="menu-row-check">' + (cur ? '✓' : '') + '</span>',
          onSelect: function () {
            if (idx === currentQualityIdx) { showControls(); return; }
            showToast('Quality: ' + f.label);
            loadQuality(idx, realTime());     // keep position across the switch
            showControls();
          }
        });
      })(i, n);
      n++;
    }
    if (items.length < 2) { showToast('Only one quality available'); return; }
    menuOpen({
      kind: 'quality',
      el: document.getElementById('quality-menu'),
      listEl: document.getElementById('quality-menu-list'),
      anchorEl: document.getElementById('ctrl-quality'),
      items: items, idx: curRow
    });
  }

  // ── Speed picker (Blue / speed button) ──────────────────────────────────────────
  function openSpeedMenu() {
    if (activeMenu && activeMenu.kind === 'speed') { menuClose(); return; }     // toggle
    var items = [], curRow = 0, n = 0;
    for (var i = SPEEDS.length - 1; i >= 0; i--) {               // fastest first
      (function (idx, row) {
        var cur = (idx === speedIdx);
        if (cur) curRow = row;
        var lbl = SPEEDS[idx] + '×' + (SPEEDS[idx] === 1 ? '  Normal' : '');
        items.push({
          current: cur,
          html: '<span class="menu-row-lbl">' + lbl + '</span>' +
                '<span class="menu-row-check">' + (cur ? '✓' : '') + '</span>',
          onSelect: function () {
            speedIdx = idx; applySpeed();
            showToast('Speed ' + SPEEDS[idx] + '×');
            showControls();
          }
        });
      })(i, n);
      n++;
    }
    menuOpen({
      kind: 'speed',
      el: document.getElementById('speed-menu'),
      listEl: document.getElementById('speed-menu-list'),
      anchorEl: document.getElementById('ctrl-speed'),
      items: items, idx: curRow
    });
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  DASH / MSE STREAMING ENGINE
  // ════════════════════════════════════════════════════════════════════════════
  function dashSupported() {
    return ('MediaSource' in window) && typeof MediaSource.isTypeSupported === 'function';
  }
  function dashNewTrack(info) {
    return { info: info, sb: null, idx: 0, queue: [], fetching: false,
             initFetched: false, removePending: false, done: false };
  }
  function dashBufEnd(name) {
    var t = dashTracks[name], sb = t && t.sb;
    return (sb && sb.buffered && sb.buffered.length) ? sb.buffered.end(sb.buffered.length - 1) : 0;
  }

  function dashStart(f, atTime) {
    dashTeardown();
    var myGen = ++dashGen;
    dashActive = true; dashStarted = false; dashRefreshing = false; dashRefreshCount = 0;
    dashAnchor = Math.max(0, atTime || 0);
    dashHeight = f.height;
    pendingSeek = 0;                                 // DASH manages position itself
    document.getElementById('ctrl-quality').textContent = f.label;
    document.getElementById('player-loading').style.display = 'flex';
    document.getElementById('player-loading-title').textContent = 'Loading ' + f.label + '…';

    xhrGet(API + '/youtube/dash?id=' + enc(currentVideoId) + '&height=' + f.height, 20000)
      .then(function (d) {
        if (myGen !== dashGen) return;
        if (d.error) throw new Error(d.error);
        if (!dashSupported() || !MediaSource.isTypeSupported(d.video.codecs)
            || !MediaSource.isTypeSupported(d.audio.codecs)) {
          throw new Error('codec unsupported');
        }
        knownDuration = d.duration || knownDuration;
        dashTracks.video = dashNewTrack(d.video);
        dashTracks.audio = dashNewTrack(d.audio);
        dashMs = new MediaSource();
        dashObjUrl = URL.createObjectURL(dashMs);
        dashMs.addEventListener('sourceopen', function () {
          if (myGen !== dashGen) return;
          try { if (knownDuration) dashMs.duration = knownDuration; } catch (e) {}
          dashAddTrack('video'); dashAddTrack('audio');
          dashFetchInit('video', myGen); dashFetchInit('audio', myGen);
        });
        var vid = document.getElementById('player-video');
        vid.src = dashObjUrl; vid.load();
      })
      .catch(function (e) {
        if (myGen !== dashGen) return;
        dashFallback(f, atTime, e && e.message);     // cached /muxed fallback
      });
  }

  // If DASH/MSE can't run, fall back to the cached complete-MP4 file (native).
  function dashFallback(f, atTime, why) {
    if (window.console && console.warn) console.warn('DASH unavailable (' + why + ') — using cached muxed file');
    dashTeardown();
    var vid = document.getElementById('player-video');
    pendingSeek = Math.max(0, atTime || 0);
    document.getElementById('player-loading').style.display = 'flex';
    document.getElementById('player-loading-title').textContent = 'Preparing ' + f.label + '… (first time only)';
    vid.src = API + '/youtube/muxed?id=' + enc(currentVideoId) + '&height=' + f.height;
    vid.load();
    var pp = vid.play(); if (pp !== undefined) pp.catch(function () {});
  }

  function dashTeardown() {
    dashGen++; dashActive = false; dashStarted = false; dashRefreshing = false;
    var v = dashTracks.video, a = dashTracks.audio;
    if (v && v.sb) { try { v.sb.abort(); } catch (e) {} }
    if (a && a.sb) { try { a.sb.abort(); } catch (e) {} }
    try { if (dashMs && dashMs.readyState === 'open') dashMs.endOfStream(); } catch (e) {}
    if (dashObjUrl) { try { URL.revokeObjectURL(dashObjUrl); } catch (e) {} dashObjUrl = null; }
    dashMs = null; dashTracks = { video: null, audio: null };
  }

  function dashAddTrack(name) {
    var t = dashTracks[name];
    t.sb = dashMs.addSourceBuffer(t.info.codecs);
    t.sb.addEventListener('updateend', function () { dashOnUpd(name); });
  }

  function dashRangeGet(name, a, b, cb) {
    var t = dashTracks[name];
    var xhr = new XMLHttpRequest();
    xhr.open('GET', API + t.info.stream + '&start=' + a + '&end=' + b, true);
    xhr.responseType = 'arraybuffer';
    xhr.onload = function () {
      if (xhr.status !== 206 && xhr.status !== 200) { cb('HTTP ' + xhr.status); return; }
      cb(null, xhr.response);
    };
    xhr.onerror = function () { cb('network'); };
    xhr.send();
  }

  function dashFetchInit(name, myGen) {
    var t = dashTracks[name];
    dashRangeGet(name, 0, t.info.initEnd - 1, function (err, data) {
      if (myGen !== dashGen) return;
      if (err) { if (err.indexOf('403') >= 0) dashRefresh(); return; }
      t.queue.push(new Uint8Array(data));
      t.initFetched = true;
      dashPump(name, myGen);
    });
  }

  function dashFetchSeg(name, myGen) {
    var t = dashTracks[name];
    if (myGen !== dashGen || t.fetching || t.removePending) return;
    if (t.idx >= t.info.segments.length) { t.done = true; dashCheckEnd(); return; }
    var seg = t.info.segments[t.idx];                 // [offset, size, startSec]
    if (seg[2] - realTime() > DASH_AHEAD) return;     // enough buffered ahead
    t.fetching = true;
    dashRangeGet(name, seg[0], seg[0] + seg[1] - 1, function (err, data) {
      t.fetching = false;
      if (myGen !== dashGen) return;
      if (err) {
        if (err.indexOf('403') >= 0) { dashRefresh(); return; }   // stale URL → refresh
        setTimeout(function () { if (myGen === dashGen) dashPump(name, myGen); }, 1200);
        return;
      }
      dashRefreshCount = 0;
      t.queue.push(new Uint8Array(data));
      t.idx++;
      dashPump(name, myGen);
    });
  }

  function dashPump(name, myGen) {
    if (myGen !== dashGen) return;
    var t = dashTracks[name], sb = t && t.sb;
    if (!sb || sb.updating) return;
    if (t.removePending) { t.removePending = false; try { sb.remove(0, totalDuration() + 10); return; } catch (e) {} }
    var cut = realTime() - DASH_BEHIND;               // evict old buffer
    if (cut > 0 && sb.buffered.length && sb.buffered.start(0) < cut) { try { sb.remove(0, cut); return; } catch (e) {} }
    if (t.queue.length) {
      var buf = t.queue.shift();
      try { sb.appendBuffer(buf); }
      catch (e) {
        if (e && e.name === 'QuotaExceededError') { t.queue.unshift(buf);
          try { sb.remove(0, realTime() - 5); } catch (_) {} }
        else if (window.console && console.warn) console.warn('append ' + name + ': ' + e);
      }
      return;
    }
    dashFetchSeg(name, myGen);
    dashMaybeStart();
  }

  function dashOnUpd(name) {
    if (!dashActive) return;
    dashPump(name, dashGen); dashMaybeStart(); dashCheckEnd();
  }

  function dashMaybeStart() {
    if (dashStarted || !dashActive) return;
    if (dashBufEnd('video') > 0 && dashBufEnd('audio') > 0) {
      dashStarted = true;
      document.getElementById('player-loading').style.display = 'none';
      var vid = document.getElementById('player-video');
      if (dashAnchor > 0) { try { vid.currentTime = dashAnchor; } catch (e) {} }
      applySpeed();
      var pp = vid.play(); if (pp !== undefined) pp.catch(function () {});
    }
  }

  function dashCheckEnd() {
    if (!dashMs || dashMs.readyState !== 'open') return;
    var v = dashTracks.video, a = dashTracks.audio; if (!v || !a) return;
    if (v.idx >= v.info.segments.length && a.idx >= a.info.segments.length &&
        !v.queue.length && !a.queue.length && v.sb && a.sb && !v.sb.updating && !a.sb.updating) {
      try { dashMs.endOfStream(); } catch (e) {}
    }
  }

  function dashTick() {
    if (!dashActive) return;
    dashPump('video', dashGen); dashPump('audio', dashGen);
  }

  function dashSeek(T) {
    if (!dashActive) return;
    var dur = totalDuration(); if (!dur) return;
    T = Math.max(0, Math.min(dur - 1, T));
    dashGen++; var myGen = dashGen; dashStarted = true; dashAnchor = T;
    var vid = document.getElementById('player-video');
    try { vid.currentTime = T; } catch (e) {}
    var names = ['video', 'audio'];
    for (var n = 0; n < names.length; n++) {
      var t = dashTracks[names[n]]; if (!t) continue;
      t.queue = []; t.fetching = false; t.done = false; t.removePending = true;
      var segs = t.info.segments, i = 0;
      for (var k = 0; k < segs.length; k++) { if (segs[k][2] <= T) i = k; else break; }
      t.idx = i;
      if (t.sb && !t.sb.updating) dashOnUpd(names[n]);
    }
    showControls();
  }

  // YouTube's signed URLs are short-lived; on 403 we silently re-extract fresh
  // ones (same segment map) and resume from the same position — no interruption.
  function dashRefresh() {
    if (dashRefreshing) return;
    if (dashRefreshCount >= 5) { if (window.console && console.warn) console.warn('DASH: gave up after repeated 403s'); return; }
    dashRefreshing = true; dashRefreshCount++;
    var refGen = dashGen;
    xhrGet(API + '/youtube/dash?id=' + enc(currentVideoId) + '&height=' + dashHeight, 20000)
      .then(function (d) {
        dashRefreshing = false;
        if (refGen !== dashGen || !dashActive || d.error) return;
        if (dashTracks.video) dashTracks.video.info.stream = d.video.stream;
        if (dashTracks.audio) dashTracks.audio.info.stream = d.audio.stream;
        dashResumeTrack('video'); dashResumeTrack('audio');
      })
      .catch(function () { dashRefreshing = false; });
  }
  function dashResumeTrack(name) {
    var t = dashTracks[name]; if (!t) return;
    if (!t.initFetched) dashFetchInit(name, dashGen); else dashPump(name, dashGen);
  }

  // ── Resume position (per-video, localStorage) ─────────────────────────────────────
  function posKey(id) { return 'ytv_pos_' + id; }
  function savePosition(v, t, dur) {
    if (!v || !v.id || !dur || !t) return;
    // Don't bother near the very start or end
    if (t < 10 || t > dur - 15) { try { localStorage.removeItem(posKey(v.id)); } catch (e) {} return; }
    try { localStorage.setItem(posKey(v.id), String(Math.floor(t))); } catch (e) {}
  }
  function getSavedPosition(id) {
    try { var s = localStorage.getItem(posKey(id)); return s ? parseInt(s, 10) : 0; }
    catch (e) { return 0; }
  }

  // Walk up the DOM to see if a click landed on an interactive control
  function isInteractive(el) {
    while (el && el !== document.body) {
      if (el.tagName === 'BUTTON') return true;
      if (el.id === 'ctrl-bar-wrap' || el.id === 'ctrl-vol-wrap') return true;
      el = el.parentNode;
    }
    return false;
  }

  function seekBy(secs) {
    var dur = totalDuration();
    if (!dur) return;
    var target = Math.max(0, Math.min(dur - 1, realTime() + secs));
    if (dashActive) dashSeek(target);
    else document.getElementById('player-video').currentTime = target;
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
  // NOTE: e.key is undefined on Chrome 38 (WebOS 3.4) — it wasn't supported until
  // Chrome 51. We MUST drive all navigation off e.keyCode, which is universal.
  function handleKey(e) {
    var kc    = e.keyCode;
    var LEFT  = (kc === 37);
    var UP    = (kc === 38);
    var RIGHT = (kc === 39);
    var DOWN  = (kc === 40);
    var OK    = (kc === 13);

    // ── Settings overlay captures all keys while open ──
    if (settingsOpen) {
      if (DOWN) { moveSettingsFocus(1);  e.preventDefault(); return; }
      if (UP)   { moveSettingsFocus(-1); e.preventDefault(); return; }
      if (OK) {
        var id = SETTINGS_FOCUS[settingsIdx];
        if (id === 'settings-save' || id === 'settings-ip') saveSettings();
        else if (id === 'settings-forget') forgetServer();
        else if (id === 'settings-close')  closeSettings();
        e.preventDefault(); return;
      }
      return;  // Back handled by popstate
    }

    if (onPlayer) {
      // A navigable menu (quality/speed) captures D-pad while open.
      if (activeMenu) {
        if (UP)         { menuMove(-1);              e.preventDefault(); return; }
        if (DOWN)       { menuMove(1);               e.preventDefault(); return; }
        if (OK)         { menuSelect(activeMenu.idx); e.preventDefault(); return; }
        if (kc === 403 || kc === 406) { menuClose(); e.preventDefault(); return; }  // Red/Blue toggle off
        return;
      }

      // Error screen: OK retries, Red/Stop closes (Back handled by popstate)
      var errEl = document.getElementById('player-error');
      if (!errEl.classList.contains('hidden')) {
        if (OK) { playVideo(focusedIdx); e.preventDefault(); return; }
        if (kc === 403 || kc === 413) { closePlayer(); e.preventDefault(); return; }
        return;
      }

      showControls();
      if (LEFT)  { seekBy(-10);        e.preventDefault(); return; }
      if (RIGHT) { seekBy(+10);        e.preventDefault(); return; }
      if (UP)    { changeVolume(+0.1); e.preventDefault(); return; }
      if (DOWN)  { changeVolume(-0.1); e.preventDefault(); return; }
      if (OK)    { togglePlayPause();  e.preventDefault(); return; }
      if (kc === 403)             { openQualityMenu();  e.preventDefault(); return; }  // Red
      if (kc === 415)             { document.getElementById('player-video').play();  showControls(); e.preventDefault(); return; }
      if (kc === 19)              { document.getElementById('player-video').pause(); showControls(); e.preventDefault(); return; }
      if (kc === 413)             { closePlayer();      e.preventDefault(); return; }
      if (kc === 412)             { seekBy(-30);        e.preventDefault(); return; }
      if (kc === 417)             { seekBy(+30);        e.preventDefault(); return; }
      if (kc === 447)             { changeVolume(+0.1); e.preventDefault(); return; }
      if (kc === 448)             { changeVolume(-0.1); e.preventDefault(); return; }
      if (kc === 404)             { playNext();         e.preventDefault(); return; }  // Green
      if (kc === 405)             { playPrev();         e.preventDefault(); return; }  // Yellow
      if (kc === 406)             { openSpeedMenu();    e.preventDefault(); return; }  // Blue
      if (kc === 449) {
        var mv = playerVolume > 0 ? -playerVolume : 1;
        changeVolume(mv); e.preventDefault(); return;
      }
      return;
    }

    if (focusZone === 'search') return;

    // Settings gear is reachable from the tabs row (Right past the last tab)
    if (focusZone === 'settingsbtn') {
      if (LEFT) { setFocusZone('tabs'); e.preventDefault(); return; }
      if (DOWN) { setFocusZone('grid'); e.preventDefault(); return; }
      if (UP)   { setFocusZone('search'); e.preventDefault(); return; }
      if (OK)   { openSettings(); e.preventDefault(); return; }
      return;  // Back handled by popstate
    }

    if (focusZone === 'tabs') {
      var tabs = document.querySelectorAll('.tab');
      if (LEFT)  { var ni = Math.max(0, focusedTabIdx - 1); focusedTabIdx = ni; if (tabs[ni]) tabs[ni].focus(); e.preventDefault(); return; }
      if (RIGHT) {
        if (focusedTabIdx >= tabs.length - 1) { setFocusZone('settingsbtn'); e.preventDefault(); return; }
        var nr = focusedTabIdx + 1; focusedTabIdx = nr; if (tabs[nr]) tabs[nr].focus(); e.preventDefault(); return;
      }
      if (UP)   { setFocusZone('search'); e.preventDefault(); return; }
      if (DOWN) { setFocusZone('grid');   e.preventDefault(); return; }
      if (OK) {
        var cat = tabs[focusedTabIdx] && tabs[focusedTabIdx].getAttribute('data-cat');
        if (cat) loadCategory(cat);
        e.preventDefault(); return;
      }
      return;  // Back handled by popstate
    }

    // Grid zone — count includes the Load More card (also a .video-card)
    var count = document.querySelectorAll('.video-card').length;
    if (RIGHT) { if (focusedIdx < count - 1) focusCard(focusedIdx + 1); e.preventDefault(); return; }
    if (LEFT)  { if (focusedIdx > 0) focusCard(focusedIdx - 1); e.preventDefault(); return; }
    if (DOWN)  { if (focusedIdx + COLS < count) focusCard(focusedIdx + COLS); else if (count) focusCard(count - 1); e.preventDefault(); return; }
    if (UP) {
      if (focusedIdx >= COLS) focusCard(focusedIdx - COLS);
      else setFocusZone('tabs');
      e.preventDefault(); return;
    }
    if (OK) {
      if (focusedIdx < videos.length) playVideo(focusedIdx);
      else if (hasMore) loadMore();        // Load More card focused
      e.preventDefault(); return;
    }
    // Blue colour button — toggle favorite on focused video
    if (kc === 406) {
      if (focusedIdx < videos.length) {
        var added = toggleFavorite(videos[focusedIdx]);
        showGridToast(added ? '★ Added to Favorites' : 'Removed from Favorites');
        if (activeTab === 'favorites') loadCategory('favorites');
        else updateFavBadge(focusedIdx, added);
      }
      e.preventDefault(); return;
    }
    // Back handled by popstate (handleBack)
    if (kc === 403) { setFocusZone('search'); e.preventDefault(); }
    if (kc === 404) { var ni = (CAT_KEYS.indexOf(activeTab) + 1) % CAT_KEYS.length; loadCategory(CAT_KEYS[ni]); e.preventDefault(); }
    if (kc === 405) { var pi = (CAT_KEYS.indexOf(activeTab) - 1 + CAT_KEYS.length) % CAT_KEYS.length; loadCategory(CAT_KEYS[pi]); e.preventDefault(); }
  }

  // ── Watch history & favorites (localStorage) ────────────────────────────────────
  function loadList(key) {
    try { return JSON.parse(localStorage.getItem(key)) || []; }
    catch (e) { return []; }
  }
  function saveList(key, arr) {
    try { localStorage.setItem(key, JSON.stringify(arr)); } catch (e) {}
  }
  function slimVideo(v) {
    return { id: v.id, url: v.url, title: v.title,
             thumbnail: v.thumbnail, channel: v.channel, duration: v.duration };
  }
  function getHistory()   { return loadList('ytv_history'); }
  function getFavorites() { return loadList('ytv_favorites'); }

  function recordHistory(v) {
    if (!v || !v.id) return;
    var h = getHistory().filter(function (x) { return x.id !== v.id; });
    h.unshift(slimVideo(v));
    if (h.length > 50) h = h.slice(0, 50);
    saveList('ytv_history', h);
  }
  function isFavorite(v) {
    if (!v || !v.id) return false;
    return getFavorites().some(function (x) { return x.id === v.id; });
  }
  function toggleFavorite(v) {
    var f = getFavorites();
    for (var i = 0; i < f.length; i++) {
      if (f[i].id === v.id) { f.splice(i, 1); saveList('ytv_favorites', f); return false; }
    }
    f.unshift(slimVideo(v));
    saveList('ytv_favorites', f);
    return true;
  }
  function updateFavBadge(idx, added) {
    var cards = document.querySelectorAll('.video-card');
    var card  = cards[idx];
    if (!card) return;
    var wrap     = card.querySelector('.video-thumb-wrap');
    var existing = card.querySelector('.video-fav-badge');
    if (added && !existing && wrap) {
      var b = document.createElement('div');
      b.className = 'video-fav-badge';
      b.innerHTML = '&#9733;';
      wrap.appendChild(b);
    } else if (!added && existing) {
      existing.parentNode.removeChild(existing);
    }
  }

  // ── Settings overlay ────────────────────────────────────────────────────────────
  var SETTINGS_FOCUS = ['settings-ip', 'settings-save', 'settings-forget', 'settings-close'];
  var settingsIdx = 0;

  function openSettings() {
    settingsOpen = true;
    settingsIdx  = 0;
    var ip = document.getElementById('settings-ip');
    ip.value = API || '';
    document.getElementById('settings-current').textContent =
      API ? ('Currently connected: ' + API) : 'Not connected';
    var msg = document.getElementById('settings-msg');
    msg.textContent = '';
    msg.classList.add('hidden');
    document.getElementById('settings-overlay').classList.remove('hidden');
    ip.focus();
  }
  function closeSettings() {
    settingsOpen = false;
    document.getElementById('settings-overlay').classList.add('hidden');
    setFocusZone('grid');
  }
  function moveSettingsFocus(dir) {
    settingsIdx = Math.max(0, Math.min(SETTINGS_FOCUS.length - 1, settingsIdx + dir));
    var el = document.getElementById(SETTINGS_FOCUS[settingsIdx]);
    if (el) el.focus();
  }
  function saveSettings() {
    var raw = document.getElementById('settings-ip').value.trim();
    if (!raw) return;
    var url = raw.indexOf('http') === 0 ? raw.replace(/\/$/, '') : 'http://' + raw + ':8000';
    var msg = document.getElementById('settings-msg');
    msg.className = '';
    msg.textContent = 'Connecting to ' + url + '…';
    probeServer(url)
      .then(function () {
        localStorage.setItem('ytv_server', url);
        API = url;
        msg.textContent = 'Connected! Reloading…';
        setTimeout(function () {
          closeSettings();
          checkBackend();
          loadCategory('trending');
        }, 700);
      })
      .catch(function () {
        msg.className = 'settings-err';
        msg.textContent = 'Could not reach ' + url;
      });
  }
  function forgetServer() {
    localStorage.removeItem('ytv_server');
    var msg = document.getElementById('settings-msg');
    msg.className = '';
    msg.textContent = 'Saved server cleared — will rediscover on next launch.';
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────
  function setLabel(t) { document.getElementById('grid-label').textContent = t; }
  function showSpinner(v) { document.getElementById('spinner').classList.toggle('hidden', !v); }
  function showError(msg) {
    var el = document.getElementById('error-msg');
    el.style.color  = '#f77';
    el.textContent  = '⚠ ' + msg;
    el.classList.remove('hidden');
  }
  function showEmpty(msg) {
    var el = document.getElementById('error-msg');
    el.style.color  = '#888';
    el.textContent  = msg;
    el.classList.remove('hidden');
  }
  var homeToastTimer = null;
  function showGridToast(msg) {
    var el = document.getElementById('home-toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(homeToastTimer);
    homeToastTimer = setTimeout(function () { el.classList.add('hidden'); }, 1500);
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
