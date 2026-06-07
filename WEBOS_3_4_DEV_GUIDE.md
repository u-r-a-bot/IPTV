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
