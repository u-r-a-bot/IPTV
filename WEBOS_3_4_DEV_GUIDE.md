# LG WebOS 3.4.0 — App Development Knowledge Base

> Hand this file to any AI agent working on this project (or any WebOS 3.4 app).
> It captures every compatibility trap we hit so you don't repeat them.

---

## 1. Runtime Environment

| Property | Value |
|---|---|
| Platform | LG WebOS 3.4.0 |
| Browser engine | Chromium ~38 (some builds: 53) |
| JS engine | V8 (old) |
| Screen | 1920 × 1080, TV remote navigation |
| Input | D-pad / remote only — no mouse, no touch |

**Mental model**: Treat it like Chrome 38. Anything that shipped after Chrome 38 is suspect. When in doubt, check caniuse.com for "Chrome 38" support.

---

## 2. JavaScript Incompatibilities

### 2.1 `fetch()` — NOT available
WebOS 3.4 does not have `fetch()`. Calling it silently hangs or errors.

**Fix**: Use a hand-rolled `XMLHttpRequest` Promise wrapper.

```javascript
function xhrGet(url) {
  return new Promise(function (resolve, reject) {
    var x = new XMLHttpRequest();
    x.open('GET', url);
    x.onload = function () {
      if (x.status >= 200 && x.status < 300) {
        resolve(JSON.parse(x.responseText));
      } else {
        reject(new Error('HTTP ' + x.status));
      }
    };
    x.onerror = function () { reject(new Error('Network error')); };
    x.send();
  });
}
```

Never use `fetch()`. Replace every occurrence with `xhrGet()` or equivalent XHR.

---

### 2.2 `NodeList.forEach()` — NOT available (Chrome < 51)
Calling `.forEach()` directly on a `querySelectorAll()` result crashes.

**Fix**:
```javascript
// WRONG — crashes on WebOS 3.4:
document.querySelectorAll('.tab').forEach(function(el) { ... });

// CORRECT:
[].forEach.call(document.querySelectorAll('.tab'), function(el) { ... });
```

---

### 2.3 `HTMLVideoElement.play()` — returns `undefined`, not a Promise (Chrome < 50)
On Chrome < 50, `video.play()` returns `undefined`. Calling `.catch()` on `undefined` throws:
> "cannot read property 'catch' of undefined"

**Fix**:
```javascript
// WRONG — crashes on WebOS 3.4:
vid.play().catch(function() { ... });

// CORRECT:
var pp = vid.play();
if (pp !== undefined) {
  pp.catch(function() { ... });
}
```

---

### 2.4 `Promise.prototype.finally()` — NOT available (Chrome < 63)
Using `.finally()` on any Promise throws a TypeError.

**Fix**: Always split into separate `.then()` and `.catch()` handlers:
```javascript
// WRONG:
doSomething().finally(function() { cleanup(); });

// CORRECT:
doSomething()
  .then(function(result) { cleanup(); return result; })
  .catch(function(err)   { cleanup(); throw err; });
```

---

### 2.0 ⚠️⚠️ `KeyboardEvent.key` is UNDEFINED (Chrome < 51) — THE most important one
`e.key` (the string, e.g. `'ArrowRight'`, `'Enter'`, `'Backspace'`) was **not supported
until Chrome 51**. On WebOS 3.4 (Chrome 38) **`e.key` is `undefined` for every key.**
This silently breaks ALL `if (e.key === 'ArrowRight')`-style code — every check is
always-false, so D-pad navigation, OK/Enter, and Back simply do nothing. (Pointer/Magic
Remote still works because it fires `click`, not `keydown` — a classic misleading symptom:
"mouse works but D-pad doesn't.")

**Fix**: drive everything off `e.keyCode` (universal, including Chrome 38):
| Key | keyCode |
|---|---|
| Backspace | 8 |
| Enter / OK | 13 |
| Escape | 27 |
| Left / Up / Right / Down | 37 / 38 / 39 / 40 |

```javascript
function handleKey(e) {
  var kc = e.keyCode;
  var LEFT = kc===37, UP = kc===38, RIGHT = kc===39, DOWN = kc===40, OK = kc===13;
  if (RIGHT) { /* ... */ }
  // NEVER: if (e.key === 'ArrowRight')
}
```
Note `e.keyCode` is "deprecated" in modern specs but it's the ONLY reliable option on
WebOS 3.4. Do not use `e.key` or `e.code` for this target.

### 2.4b `scrollIntoView({block:'nearest'})` — options object NOT supported (Chrome < 61)
The **boolean** form `scrollIntoView(true/false)` works on Chrome 38, but the **options
object** form is Chrome 61+. On WebOS 3.4 the object `{block:'nearest'}` is coerced to a
truthy value → behaves like `scrollIntoView(true)`, which slams the element to the **top of
the scroll container on every call**. In a D-pad grid this makes navigation jump wildly.

**Fix**: scroll manually with `getBoundingClientRect()` (supported on Chrome 38), only when
the element is actually outside the viewport:
```javascript
function scrollCardIntoView(card) {
  var area = document.getElementById('grid-area'); // the overflow:auto container
  var cr = card.getBoundingClientRect();
  var ar = area.getBoundingClientRect();
  var pad = 28;
  if (cr.top < ar.top + pad)            area.scrollTop -= (ar.top + pad - cr.top);
  else if (cr.bottom > ar.bottom - pad) area.scrollTop += (cr.bottom - (ar.bottom - pad));
}
```

### 2.5 Arrow functions — use with caution
Arrow functions (`=>`) were added in Chrome 45. If targeting Chrome 38 strictly, use `function` everywhere. In practice WebOS 3.4 builds vary — safe to use `function` to be sure.

---

### 2.6 `const` / `let` — mostly safe but use `var` to be sure
`let` and `const` landed in Chrome 41 (strict mode) and 49 (sloppy mode). Use `var` for guaranteed safety.

---

### 2.7 Template literals — NOT safe (Chrome < 41)
```javascript
// WRONG: `Hello ${name}`
// CORRECT: 'Hello ' + name
```

---

## 3. CSS Incompatibilities

### 3.1 `display: grid` — NOT supported (Chrome < 57)
CSS Grid is completely absent. Cards will not lay out at all.

**Fix**: Use `display: flex; flex-wrap: wrap` with explicit `width` on children.

```css
/* WRONG: */
#video-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 18px;
}

/* CORRECT — 4-column flex grid with 18px gutters: */
#video-grid {
  display: flex;
  flex-wrap: wrap;
  padding-bottom: 32px;
}
.video-card {
  /* (100% - 3 × 18px gutter) / 4 columns = 25% - 13.5px */
  width: calc(25% - 13.5px);
  margin-right: 18px;
  margin-bottom: 18px;
  flex-shrink: 0;
}
.video-card:nth-child(4n) {
  margin-right: 0; /* remove right margin on every 4th card */
}
```

Adapt the `calc()` formula for different column counts:
- 3 cols / 16px gap: `calc(33.333% - 10.667px)`, remove on `:nth-child(3n)`
- 2 cols / 16px gap: `calc(50% - 8px)`, remove on `:nth-child(2n)`

---

### 3.2 `gap` on flex containers — NOT supported (Chrome < 84)
`gap`, `row-gap`, `column-gap` on `display: flex` do nothing silently.

**Fix**: Use `margin` on children. For uniform spacing use the adjacent sibling selector:

```css
/* WRONG: */
.my-flex { display: flex; gap: 12px; }

/* CORRECT — horizontal gaps: */
.my-flex > * + * { margin-left: 12px; }

/* CORRECT — vertical gaps (column flex): */
.my-flex > * + * { margin-top: 12px; }

/* CORRECT — explicit last-child cleanup if needed: */
.my-flex > *:last-child { margin-right: 0; }
```

Note: `gap` on `display: grid` also doesn't apply because grid itself isn't supported.

---

### 3.3 `aspect-ratio` — NOT supported (Chrome < 88)
Elements with `aspect-ratio` collapse to zero height.

**Fix**: The classic padding-bottom percentage trick.

```css
/* WRONG: */
.thumb-wrap {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 9;
}
.thumb-wrap img { width: 100%; height: 100%; object-fit: cover; }

/* CORRECT — 16:9 = 9/16 = 56.25%: */
.thumb-wrap {
  position: relative;
  width: 100%;
  height: 0;
  padding-bottom: 56.25%;
  overflow: hidden;
  box-sizing: content-box; /* CRITICAL — see note below */
}
.thumb-wrap img {
  position: absolute;
  top: 0; left: 0;
  width: 100%; height: 100%;
  object-fit: cover;
  display: block;
}
```

**Critical note**: If you have a global `* { box-sizing: border-box }` rule (common in resets), you MUST add `box-sizing: content-box` on the wrapper. With `border-box`, the padding is included in the zero height and the trick produces zero height.

Other common ratios:
- 4:3 → `padding-bottom: 75%`
- 1:1 → `padding-bottom: 100%`
- 21:9 → `padding-bottom: 42.857%`

---

### 3.4 `inset` shorthand — NOT supported (Chrome < 87)
`inset: 0` is equivalent to `top: 0; right: 0; bottom: 0; left: 0` but not supported.

**Fix**:
```css
/* WRONG: */
.overlay { position: absolute; inset: 0; }

/* CORRECT: */
.overlay { position: absolute; top: 0; right: 0; bottom: 0; left: 0; }
```

---

### 3.5 CSS custom properties (`--var`) — NOT supported (Chrome < 49)
CSS variables are absent. Don't use them.

**Fix**: Hardcode values or use a preprocessor (Sass/Less compile-time).

---

### 3.6 `object-fit: cover` on `<img>` — check carefully
`object-fit` landed in Chrome 31 so it should be fine, but only works when the image has explicit dimensions. With the absolute-positioned padding-bottom trick, the `width: 100%; height: 100%` on the image provides those dimensions.

---

### 3.7 `calc()` — supported (Chrome 26+)
`calc()` with mixed units (`%` + `px`) is safe to use.

---

## 4. Backend / Network

### 4.1 Backend discovery
The app uses mDNS/broadcast discovery at startup. For development with a known IP, hardcode the server URL as the first candidate so you can iterate without waiting for discovery:

```javascript
var HARDCODED_SERVER = 'http://192.168.0.191:8000'; // set to your dev machine IP
```

Set to `null` or `''` to disable for production.

### 4.2 CORS
The FastAPI backend must allow cross-origin requests from the TV's origin. Ensure `CORSMiddleware` is configured:

```python
from fastapi.middleware.cors import CORSMiddleware
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
```

### 4.3 Stream proxying
YouTube stream URLs expire and are IP-locked. The backend proxies the stream (`/youtube/stream?url=...`) so the TV never touches YouTube directly. This is required — the TV cannot fetch YouTube stream URLs directly.

### 4.4 Range requests
The `<video>` element issues HTTP Range requests for seeking. The backend must forward the `Range` header and pass through `Content-Range` / `Accept-Ranges` headers from YouTube's response. Already handled in `youtube.py`.

---

## 5. Development Workflow

### 5.1 Packaging
```bash
# From the project root (d:\SLOPPY APPS\IPTV):
ares-package IPTV -o .
```
Produces a `.ipk` file.

### 5.2 Deploying to TV
```bash
ares-install <package>.ipk
ares-launch com.example.app   # replace with your app ID
```

### 5.3 Deploying to emulator
Same commands — the WebOS emulator uses the same Chromium version as WebOS 3.4.

### 5.4 Viewing logs
The TV has no DevTools. Use the on-screen debug overlay or `ares-inspect` (opens a remote DevTools session if supported by the device).

During development, use a visible on-screen log element rather than `console.log` — TV consoles are not accessible without `ares-inspect`.

---

## 6. Quick Reference Cheat Sheet

| Feature | Chrome version added | Safe on WebOS 3.4? | Fix |
|---|---|---|---|
| `fetch()` | 42 | NO | Use `XMLHttpRequest` |
| `Promise` | 32 | YES | — |
| `Promise.finally()` | 63 | NO | Split into `.then()` + `.catch()` |
| `NodeList.forEach` | 51 | NO | `[].forEach.call(nodeList, fn)` |
| `video.play()` → Promise | 50 | NO | Guard: `var p = v.play(); if(p) p.catch(...)` |
| `const` / `let` | 49 | RISKY | Use `var` |
| Arrow functions | 45 | RISKY | Use `function` |
| Template literals | 41 | RISKY | Use string concatenation |
| `display: grid` | 57 | NO | Use `display: flex; flex-wrap: wrap` |
| `gap` on flex | 84 | NO | Use `margin` + `> * + *` selector |
| `aspect-ratio` | 88 | NO | `height:0; padding-bottom: 56.25%` trick |
| `inset` shorthand | 87 | NO | Use `top/right/bottom/left` explicitly |
| CSS custom properties | 49 | NO | Hardcode values |
| `object-fit` | 31 | YES | — |
| `calc()` | 26 | YES | — |
| `position: sticky` | 56 | NO | Use `position: fixed` workaround |
| CSS Grid `fr` unit | 57 | NO | Use `%` + `calc()` |

---

## 6b. Implemented Features & Patterns (reference for extending the app)

These are working patterns already in the codebase — copy them, don't reinvent.

### Pagination ("Load More")
- Backend `/youtube/search` and `/youtube/trending` accept `?limit=N&offset=M` and
  return `{videos, has_more, offset}`. `has_more` is best-effort (true if a full window came back).
- Frontend keeps `currentLoader(offset, limit) -> url`, `pageOffset`, `hasMore`, `loadingMore`.
- The grid renders a focusable **Load More card** (`.load-more-card`, also class `.video-card`)
  as the last item when `hasMore`. Grid navigation counts DOM `.video-card` elements so the
  Load More card is reachable with the D-pad; Enter on it calls `loadMore()` which **appends**
  cards (does not rebuild) so focus stays stable.

### Watch history & favorites (localStorage)
- Keys: `ytv_history` (max 50, most-recent-first) and `ytv_favorites`.
- Stored as slim objects `{id,url,title,thumbnail,channel,duration}`.
- Two special tabs (`data-cat="history"`, `data-cat="favorites"`) are `local: true` in `CATS`
  with a `getItems()` instead of `fetchUrl` — rendered straight from localStorage, no network.
- **Blue colour button (keyCode 406)** toggles favorite on the focused grid card.

### Skeleton loading
- `renderSkeletons(n)` fills the grid with `.video-card.skeleton` placeholders during a fetch
  instead of a spinner. Shimmer via `@keyframes shimmer` on `background-position` (no `aspect-ratio`,
  no `gap` — WebOS-safe). Skeleton thumb reuses `.video-thumb-wrap` to keep the 16:9 ratio.

### Focus memory
- `lastFocusByView[currentView]` remembers the last-focused card index per view
  (`currentView` = category key or `'search:<q>'`). Restored in `renderGrid()`, clamped to range.

### Settings overlay (kills the hardcoded IP)
- `localStorage 'ytv_server'` always wins over `DEFAULT_SERVER`. Discovery tries saved first.
- Gear button in the topbar (`#settings-btn`), reachable by D-pad: **Right past the last tab**
  enters focus zone `'settingsbtn'`. Settings panel has its own arrow-key focus ring
  (`SETTINGS_FOCUS` array + `settingsIdx`) since TVs have no Tab key.
- "Save & Reconnect" probes the new URL, persists it, and reloads the trending feed.
  "Forget Saved Server" clears `ytv_server`.

### Channel avatars (no backend needed)
- `channelAvatar(name)` renders a coloured circle with the channel's first initial.
  Colour is a hash of the name into a fixed palette — deterministic, zero network cost.

### Remote keyCode map (LG WebOS) used in this app
| Key | keyCode | Grid/Home action | Player action |
|---|---|---|---|
| Back | 461 / 10009 | up a level | close player |
| Red | 403 | search focus | close player |
| Green | 404 | next category | **next video** |
| Yellow | 405 | previous category | **previous video** |
| Blue | 406 | toggle favorite | **cycle playback speed** |
| Play | 415 | — | play |
| Pause | 19 | — | pause |
| Stop | 413 | — | close player |
| Rewind | 412 | — | seek -30s |
| FastFwd | 417 | — | seek +30s |
| Vol+/- | 447/448 | — | volume |
| Mute | 449 | — | mute toggle |

### ⚠️ Magic Remote (pointer) gotcha — critical for video players
The LG Magic Remote has a **pointer**. When the pointer is active, the **OK/center
button fires a `click` event at the pointer position — NOT a `keydown` Enter.**
This is why "OK doesn't pause the video" bugs happen: the keydown handler never fires.

Fix pattern (both must exist):
1. **Click to toggle** — add a `click` listener that toggles play/pause. Put it on
   the `<video>` (fires when controls are hidden / `pointer-events:none`) AND on the
   controls overlay (fires when controls are visible / `pointer-events:all`). Use a
   manual `isInteractive(target)` DOM walk to ignore clicks on buttons/scrubber —
   `Element.closest()` is Chrome 41+ and NOT safe on WebOS 3.4.
2. **Mousemove to reveal controls** — add a `mousemove` listener on the player overlay
   that calls `showControls()`. Without it, controls never appear for pointer users.

Keep the `keydown` handlers too — they fire when the user is in D-pad mode.

### ⚠️ Remote Back button (keyCode 461) — use HISTORY, not preventDefault
**Confirmed on real WebOS 3.4 hardware:** the Back button fires `keydown` with
`e.keyCode === 461`, but **`e.preventDefault()` does NOT stop the system from
backgrounding the app / opening the launcher** — not in bubble phase, not in capture
phase. Do not waste time on preventDefault; it doesn't work for Back on this platform.

**Working fix — the history-buffer trick.** WebOS Back navigates browser history when
there is history to pop, and only closes the app when history is empty. So keep exactly
one buffer entry and re-arm it on every pop; Back then fires `popstate` (app stays alive)
and you route the action yourself:
```javascript
try { history.pushState(null, ''); } catch (e) {}      // arm one buffer entry
window.addEventListener('popstate', function () {
  try { history.pushState(null, ''); } catch (e) {}     // re-arm — Back never exits
  handleBack();                                         // your own routing
});

var lastBackTs = 0;
function handleBack() {
  var now = Date.now();
  if (now - lastBackTs < 350) return;   // debounce: stray keydown default + popstate
  lastBackTs = now;
  if (settingsOpen) { closeSettings(); return; }
  if (onPlayer)     { closePlayer();   return; }
  /* ...else navigate within home... */
}
```
Crucially: **do NOT also handle 461 in your keydown handler** — if you `preventDefault`
the 461 keydown you cancel the history-back default, so `popstate` never fires. Let the
keydown fall through untouched; `popstate` owns Back entirely. The user exits the app with
the **Home** button (standard for TV apps), never Back.
- `history.pushState` / `popstate` are Chrome 5+ — safe on WebOS 3.4.

### Player features implemented (patterns to reuse)
- **Resume position** — `localStorage 'ytv_pos_<id>'` holds seconds; saved (throttled
  every 5s + on pause/close) and restored on `loadedmetadata` if 5s < pos < dur-15s.
  Cleared on `ended`.
- **Auto-play next** — `ended` advances to `focusedIdx + 1` (or closes at the end).
- **Playback speed** — `SPEEDS` array cycled via `vid.playbackRate`; Blue button or the
  on-screen `#ctrl-speed` button.
- **Transport buttons** — prev / -10s / play-pause / +10s / next are pointer-clickable
  (`#ctrl-btns`); D-pad uses the global key actions instead of focusing each button.
- **Note on screen sleep**: active fullscreen `<video>` playback keeps WebOS awake
  natively — no extra wake-lock needed during playback. A true wake-lock during long
  *pauses* needs a luna-service permission (`com.webos.service.tvpower`); not added.

---

## 7. Project-Specific Notes

- **App ID**: Check `appinfo.json` in the `IPTV/` folder
- **Backend**: FastAPI + yt-dlp, runs on port 8000
- **Backend entry**: `d:\SLOPPY APPS\IPTV\backend\`
- **Frontend entry**: `d:\SLOPPY APPS\IPTV\IPTV\`
- **Key files**:
  - `IPTV/index.html` — HTML shell, no inline JS/CSS
  - `IPTV/browser.js` — all app logic
  - `IPTV/browser.css` — all styles (WebOS 3.4 compatible)
  - `backend/main.py` — FastAPI app
  - `backend/youtube.py` — YouTube search/stream router

---

## 8. Golden Rules for AI Agents

1. **Never use `fetch()`** — always `XMLHttpRequest` wrapped in a Promise
2. **Never use `display: grid`** — always flex + calculated widths
3. **Never use `gap` on flex** — always explicit margins
4. **Never use `aspect-ratio`** — always padding-bottom percentage trick
5. **Never call `.catch()` directly on `video.play()`** — guard with `if (pp !== undefined)`
6. **Never use `Promise.finally()`** — always duplicate the cleanup in both `.then()` and `.catch()`
7. **Never use `NodeList.forEach()`** — always `[].forEach.call()`
8. **Never use `inset:`** — always `top/right/bottom/left`
9. **Never use CSS custom properties** — hardcode values
10. **Prefer `var` over `const`/`let`**, `function` over arrow functions, string concat over template literals

When adding any new CSS or JS feature, ask: **"Was this in Chrome 38 in 2015?"** If not, find the fallback first.
