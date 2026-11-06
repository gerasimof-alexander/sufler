/* Суфлер — app logic. No dependencies besides lib/vosk.js (speech engine)
   and tracker.js (script ↔ speech alignment). */
"use strict";
const APP_VERSION = "2.3";
const $ = (id) => document.getElementById(id);
const TR = window.PrompterTracker;
const now = () => performance.now();

/* Speech models available in this build (downloaded once, then offline). */
const MODELS = {
  /* grammar: restrict the recognizer to the script's words. Tested on recorded
     speech: the Ukrainian nano model returns random words in that mode, so it is off. */
  uk: { file: "models/uk.tar.gz#parts=8&size=77620626", mb: 74, name: "Українська", grammar: false },
  /* Russian: put vosk-model-small-ru-0.22 into models/ and uncomment.
  ru: { file: "models/ru.tar.gz", mb: 45, name: "Російська", grammar: false }, */
};
const LANGS = Object.keys(MODELS);

/* =====================================================================
   Storage
   ===================================================================== */
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { } },
};
const DEFAULTS = {
  font: 64, line: 1.45, width: 88, eye: 33, light: false, underline: true,
  countdown: true, mode: "voice", speed: 10,
};
const cfg = Object.assign({}, DEFAULTS, store.get("sufler.cfg", {}));
const saveCfg = () => store.set("sufler.cfg", cfg);

function detectLang(text) {
  const ru = (text.match(/[ыэъё]/gi) || []).length;
  const uk = (text.match(/[іїєґ]/gi) || []).length;
  if (ru >= 3 && ru > uk * 1.5) return "ru";
  if (uk >= 3 && uk > ru * 1.5) return "uk";
  return null;
}
function makeScript(text) {
  return { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), text: text || "",
    lang: LANGS.includes(detectLang(text || "")) ? detectLang(text || "") : LANGS[0], langSet: false, pos: 0, updated: Date.now() };
}
let scripts = store.get("sufler.scripts", null);
if (!Array.isArray(scripts)) {
  scripts = [];
  const old = localStorage.getItem("prompter_text");               // text from the old version
  if (old && old.trim()) scripts.push(makeScript(old));
}
if (!scripts.length) scripts.push(makeScript(""));
for (const s of scripts) if (!MODELS[s.lang]) s.lang = LANGS[0];
let current = scripts.find((s) => s.id === store.get("sufler.current")) || scripts[0];
let saveTimer = 0;
function saveScripts(now) {
  clearTimeout(saveTimer);
  const doSave = () => { store.set("sufler.scripts", scripts); store.set("sufler.current", current.id); };
  if (now) doSave(); else saveTimer = setTimeout(doSave, 300);
}
const titleOf = (s) => (s.text.split("\n").find((l) => l.trim()) || "Без назви").trim().slice(0, 70);
const wordCount = (t) => (t.match(/[\p{L}\p{N}]+/gu) || []).length;
function fmtTime(sec) { sec = Math.max(0, Math.round(sec)); return Math.floor(sec / 60) + ":" + String(sec % 60).padStart(2, "0"); }

/* =====================================================================
   Speech models (Vosk). One model in memory at a time.
   The patched lib/vosk.js keeps each model in its own IndexedDB storage,
   so after the first download everything works offline.
   ===================================================================== */
const modelURL = (lang) => new URL(MODELS[lang].file, location.href).href;
function modelStorage(lang) {   // must mirror the key used inside lib/vosk.js
  const key = modelURL(lang).replace(/^[a-z]+:\/\/[^\/]+/i, "").replace(/[?#].*$/, "").replace(/[\W]/g, "_");
  return { db: "/vosk_" + key, file: "/vosk_" + key + "/model/extracted.ok" };
}
const cachedLangs = {};          // lang -> true/false (known state)
function checkCached(lang) {
  const { db, file } = modelStorage(lang);
  return new Promise((resolve) => {
    let req;
    try { req = indexedDB.open(db); } catch (e) { return resolve(false); }
    req.onupgradeneeded = (e) => { try { e.target.transaction.abort(); } catch (x) { } };  // don't create it
    req.onerror = () => resolve(false);
    req.onblocked = () => resolve(false);
    req.onsuccess = () => {
      const d = req.result;
      try {
        if (!d.objectStoreNames.contains("FILE_DATA")) { d.close(); return resolve(false); }
        const c = d.transaction("FILE_DATA", "readonly").objectStore("FILE_DATA").count(file);
        c.onsuccess = () => { d.close(); resolve(c.result > 0); };
        c.onerror = () => { d.close(); resolve(false); };
      } catch (e) { d.close(); resolve(false); }
    };
  }).then((v) => (cachedLangs[lang] = v));
}

const engine = { lang: null, model: null, promise: null, state: "idle", stage: "", progress: 0, error: "", token: 0 };
const engineListeners = new Set();
const emitEngine = () => engineListeners.forEach((f) => { try { f(); } catch (e) { } });

function friendlyError(msg, lang) {
  msg = String(msg || "");
  if (/fetch|network|load failed|HTTP/i.test(msg) || !navigator.onLine)
    return "Модель «" + MODELS[lang].name + "» ще не завантажена на цей пристрій. Підключіться до інтернету один раз.";
  if (/memory|OOM|allocation/i.test(msg)) return "Не вистачило пам'яті. Закрийте інші вкладки та спробуйте ще раз.";
  return "Не вдалося запустити розпізнавання" + (msg ? " (" + msg + ")" : "") + ".";
}

/* Load (download on first use) the model for a language. Resolves with the Vosk model. */
function ensureModel(lang) {
  if (engine.lang === lang && engine.promise) return engine.promise;
  if (engine.model) { try { engine.model.terminate(); } catch (e) { } }
  const token = ++engine.token;
  Object.assign(engine, { lang, model: null, state: "loading", stage: "start", progress: 0, error: "" });
  emitEngine();
  let model, watchdog, lastTick = now();
  engine.promise = new Promise((resolve, reject) => {
    const fail = (msg) => { clearInterval(watchdog); try { model.worker.terminate(); } catch (e) { } reject(new Error(friendlyError(msg, lang))); };
    try { model = new Vosk.Model(modelURL(lang)); } catch (e) { return fail(e.message); }
    model.addEventListener("load", (e) => {
      clearInterval(watchdog);
      if (e.detail && e.detail.result) resolve(model); else fail("");
    });
    model.addEventListener("error", (e) => {
      if (!model.ready) fail(e.detail && e.detail.error);
      else console.warn("vosk:", e.detail && e.detail.error);
    });
    model.addEventListener("progress", (e) => {
      lastTick = now();
      if (token !== engine.token) return;
      engine.stage = "download";
      engine.progress = e.detail.total ? e.detail.loaded / e.detail.total : 0;
      emitEngine();
    });
    model.addEventListener("stage", (e) => {
      lastTick = now();
      if (token !== engine.token) return;
      engine.stage = e.detail.stage; emitEngine();
    });
    /* a stalled download or a frozen worker must not hang the app forever */
    watchdog = setInterval(() => {
      const limit = engine.stage === "download" ? 45000 : 240000;
      if (now() - lastTick > limit) fail("timeout");
    }, 2000);
  });
  engine.promise.then((m) => {
    if (token !== engine.token) { try { m.terminate(); } catch (e) { } return; }
    Object.assign(engine, { model: m, state: "ready", stage: "", progress: 1 });
    cachedLangs[lang] = true;
    emitEngine();
  }, (err) => {
    if (token !== engine.token) return;
    Object.assign(engine, { model: null, promise: null, state: "error", error: err.message });
    emitEngine();
  });
  return engine.promise;
}

/* download a language for offline use without keeping it in memory */
function cacheOnly(lang) {
  if (engine.lang === lang) return ensureModel(lang);
  return new Promise((resolve, reject) => {
    const m = new Vosk.Model(modelURL(lang));
    const row = $("m" + lang[0].toUpperCase() + lang.slice(1));
    const end = (ok, msg) => { try { m.worker.terminate(); } catch (e) { } ok ? resolve() : reject(new Error(friendlyError(msg, lang))); };
    m.addEventListener("progress", (e) => { if (row) row.textContent = "Завантаження " + Math.round(100 * e.detail.loaded / (e.detail.total || 1)) + "%"; });
    m.addEventListener("stage", (e) => {
      if (e.detail.stage === "extract" && row) row.textContent = "Розпаковка…";
      if (e.detail.stage === "init") { cachedLangs[lang] = true; end(true); }   // files are saved by now
    });
    m.addEventListener("load", () => { cachedLangs[lang] = true; end(true); });
    m.addEventListener("error", (e) => end(false, e.detail && e.detail.error));
  });
}

/* =====================================================================
   HOME screen
   ===================================================================== */
function renderList() {
  const list = $("list");
  list.innerHTML = "";
  [...scripts].sort((a, b) => b.updated - a.updated).forEach((s) => {
    const b = document.createElement("button");
    b.className = "item" + (s === current ? " on" : "");
    const t = document.createElement("b"); t.textContent = titleOf(s);
    const m = document.createElement("small");
    const wc = wordCount(s.text);
    m.textContent = (LANGS.length > 1 ? (s.lang === "ru" ? "РУС" : "УКР") + " · " : "") + wc + " сл. · " + new Date(s.updated).toLocaleDateString("uk-UA", { day: "numeric", month: "short" });
    b.append(t, m);
    b.onclick = () => { selectScript(s); $("aside").classList.remove("open"); };
    list.appendChild(b);
  });
}
function selectScript(s) {
  current = s;
  $("text").value = s.text;
  saveScripts(true);
  renderList(); renderHomeState();
  preloadIfUseful();
}
function renderStats() {
  const wc = wordCount(current.text);
  $("stats").textContent = wc ? wc + " слів · ≈ " + fmtTime(wc / 125 * 60) : "";
  const total = TR.parseScript(current.text).spoken.length;
  const canResume = current.pos > 5 && current.pos < total - 3;
  $("resumeBtn").classList.toggle("hidden", !canResume);
}
function renderLangHint() {
  const d = detectLang(current.text), hint = $("langHint");
  hint.textContent = "";
  if (d && d !== current.lang && MODELS[d]) {
    hint.append((d === "ru" ? "Схоже, текст російською. " : "Схоже, текст українською. "));
    const b = document.createElement("button");
    b.textContent = "Перемкнути на " + (d === "ru" ? "РУС" : "УКР");
    b.onclick = () => setLang(d, true);
    hint.append(b);
  }
}
function renderHomeState() {
  document.querySelectorAll("#langSeg button").forEach((b) => b.classList.toggle("on", b.dataset.lang === current.lang));
  document.querySelectorAll("#modeSeg button").forEach((b) => b.classList.toggle("on", b.dataset.mode === cfg.mode));
  renderStats(); renderLangHint(); renderChip();
}
function setLang(lang, manual) {
  current.lang = lang;
  if (manual) current.langSet = true;
  current.updated = Date.now();
  saveScripts(); renderList(); renderHomeState();
  preloadIfUseful();
}
function homeMsg(text, isErr) { const m = $("homeMsg"); m.textContent = text || ""; m.className = isErr ? "err" : ""; }

function renderChip() {
  const chip = $("modelChip"), label = $("modelLabel"), lang = current.lang;
  chip.className = "chip";
  let txt;
  if (engine.lang === lang && engine.state === "loading") {
    chip.classList.add("busy");
    txt = engine.stage === "download" ? "Завантаження " + Math.round(engine.progress * 100) + "%"
      : engine.stage === "extract" ? "Розпаковка…" : engine.stage === "init" ? "Запуск…" : "Підготовка…";
  } else if (engine.lang === lang && engine.state === "ready") { chip.classList.add("ready"); txt = "Голос готовий · офлайн"; }
  else if (engine.lang === lang && engine.state === "error") { chip.classList.add("err"); txt = "Помилка · повторити"; }
  else if (cachedLangs[lang]) { chip.classList.add("ready"); txt = "Збережено офлайн"; }
  else txt = "Завантажити голос · " + MODELS[lang].mb + " МБ";
  label.textContent = txt;
  $("modelShort").textContent = chip.classList.contains("busy") ? (engine.stage === "download" ? Math.round(engine.progress * 100) + "%" : "…")
    : chip.classList.contains("ready") ? "голос ✓" : chip.classList.contains("err") ? "помилка" : "⬇ " + MODELS[lang].mb + " МБ";
  chip.title = engine.state === "error" ? engine.error : "";
  renderModelRows();
}
function renderModelRows() {
  for (const lang of LANGS) {
    const small = $("m" + lang[0].toUpperCase() + lang.slice(1));
    const btn = document.querySelector('[data-dl="' + lang + '"]');
    if (!small || !btn) continue;
    if (engine.lang === lang && engine.state === "loading") {
      small.textContent = engine.stage === "download" ? "Завантаження " + Math.round(engine.progress * 100) + "%" : "Підготовка…";
      btn.disabled = true; btn.textContent = "…";
    } else if (cachedLangs[lang]) {
      small.textContent = "Збережено на пристрої · працює без інтернету"; btn.disabled = true; btn.textContent = "Готово ✓";
    } else {
      small.textContent = "Не завантажено · " + MODELS[lang].mb + " МБ"; btn.disabled = false; btn.textContent = "Завантажити";
    }
  }
}
engineListeners.add(renderChip);
engineListeners.add(renderLoader);

/* start loading the model in the background when it is already on the device */
function preloadIfUseful() {
  if (cfg.mode !== "voice" || P.active) return;
  const lang = current.lang;
  if (engine.lang === lang && engine.promise) return;
  checkCached(lang).then((ok) => { renderChip(); if (ok && current.lang === lang && !P.active) ensureModel(lang).catch(() => { }); });
}

/* ---- home events ---- */
$("text").addEventListener("input", () => {
  current.text = $("text").value;
  current.updated = Date.now();
  if (!current.langSet) { const d = detectLang(current.text); if (d && d !== current.lang && MODELS[d]) { current.lang = d; renderHomeState(); preloadIfUseful(); } }
  current.pos = 0;
  saveScripts(); renderStats(); renderLangHint();
  clearTimeout(renderList.t); renderList.t = setTimeout(renderList, 400);
});
$("newBtn").onclick = () => {
  const s = makeScript(""); scripts.push(s); selectScript(s);
  $("aside").classList.remove("open");
  setTimeout(() => $("text").focus(), 50);
};
$("deleteBtn").onclick = () => {
  if (!current.text.trim() && scripts.length === 1) return;
  if (current.text.trim() && !confirm("Видалити «" + titleOf(current) + "»?")) return;
  scripts = scripts.filter((s) => s !== current);
  if (!scripts.length) scripts.push(makeScript(""));
  selectScript([...scripts].sort((a, b) => b.updated - a.updated)[0]);
};
$("importBtn").onclick = () => $("fileIn").click();
$("fileIn").onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = "";
  if (!f) return;
  const text = await f.text();
  const s = makeScript(text); scripts.push(s); selectScript(s);
};
$("listBtn").onclick = () => $("aside").classList.add("open");
$("closeList").onclick = () => $("aside").classList.remove("open");
document.querySelectorAll("#langSeg button").forEach((b) => (b.onclick = () => setLang(b.dataset.lang, true)));
document.querySelectorAll("#modeSeg button").forEach((b) => (b.onclick = () => { cfg.mode = b.dataset.mode; saveCfg(); renderHomeState(); preloadIfUseful(); }));
$("modelChip").onclick = () => {
  if (engine.lang === current.lang && engine.state === "loading") return;
  ensureModel(current.lang).catch((e) => homeMsg(e.message, true));
};

/* =====================================================================
   SETTINGS
   ===================================================================== */
const ranges = [];
function bindRange(id, out, get, set, fmt) {
  const el = $(id);
  const show = () => { el.value = get(); $(out).textContent = fmt(get()); };
  el.oninput = () => { set(+el.value); show(); saveCfg(); settingsChanged(); };
  ranges.push(show);
  show();
}
bindRange("sFont", "oFont", () => cfg.font, (v) => (cfg.font = v), (v) => v);
bindRange("sLine", "oLine", () => Math.round(cfg.line * 100), (v) => (cfg.line = v / 100), (v) => (v / 100).toFixed(2));
bindRange("sWidth", "oWidth", () => cfg.width, (v) => (cfg.width = v), (v) => v + "%");
bindRange("sEye", "oEye", () => cfg.eye, (v) => (cfg.eye = v), (v) => v + "%");
function bindSwitch(id, key) {
  const el = $(id);
  const show = () => el.classList.toggle("on", !!cfg[key]);
  el.onclick = () => { cfg[key] = !cfg[key]; show(); saveCfg(); settingsChanged(); };
  ranges.push(show);
  show();
}
bindSwitch("tLight", "light");
bindSwitch("tUnder", "underline");
bindSwitch("tCount", "countdown");

/* every change is visible at once: whole-app theme, live preview, open prompter */
function settingsChanged() {
  applyTheme();
  renderPreview();
  renderFormat();
  if (P.active) { applyLook(); relayout(); }
}
function applyTheme() {
  document.documentElement.classList.toggle("light", !!cfg.light);
  const m = document.querySelector('meta[name="theme-color"]');
  if (m) m.setAttribute("content", cfg.light ? "#f4f3ef" : "#0c0c0d");
}
function renderFormat() {
  $("fmtLine").textContent = "Шрифт " + cfg.font + " · інтервал " + cfg.line.toFixed(2) + " · ширина " + cfg.width +
    "% · лінія " + cfg.eye + "% · " + (cfg.light ? "світла" : "темна") + " тема · підкреслення " + (cfg.underline ? "так" : "ні") +
    " · відлік " + (cfg.countdown ? "так" : "ні");
}
$("resetFmt").onclick = () => {
  for (const k of ["font", "line", "width", "eye", "light", "underline", "countdown"]) cfg[k] = DEFAULTS[k];
  saveCfg(); ranges.forEach((f) => f()); settingsChanged();
};

/* a scaled copy of the real prompter screen of this device */
function renderPreview() {
  const box = $("pv");
  if (!box || $("settings").classList.contains("hidden")) return;
  const W = window.innerWidth, H = window.innerHeight;
  const avail = box.parentElement.clientWidth;
  const k = Math.min(avail / W, 230 / H);
  box.style.height = Math.round(H * k) + "px";
  box.style.width = Math.round(W * k) + "px";
  box.style.marginLeft = box.style.marginRight = "auto";
  const scr = $("pvScreen");
  scr.style.width = W + "px"; scr.style.height = H + "px";
  scr.style.transform = "scale(" + k + ")";
  scr.classList.toggle("light", !!cfg.light);
  const t = $("pvText");
  t.style.fontSize = cfg.font + "px";
  t.style.lineHeight = cfg.line;
  t.style.width = cfg.width + "%";
  t.style.maxWidth = Math.max(600, cfg.font * 22) + "px";
  t.classList.toggle("underline", !!cfg.underline);
  const sample = current.text.trim() ||
    "Привіт! Це приклад тексту для суфлера. Так виглядатиме рядок, який ви читаєте. Підберіть розмір шрифту, інтервал і ширину під себе.";
  const sents = sample.replace(/\s+/g, " ").match(/[^.!?…]+[.!?…]*\s*/g) || [sample];
  t.textContent = "";
  const add = (txt, cls) => { const sp = document.createElement("span"); sp.textContent = txt; if (cls) sp.className = cls; t.appendChild(sp); return sp; };
  const first = add(sents[0] || "", "done");
  add(sents[1] || "", "cur");
  add(sents.slice(2, 6).join(""), "");
  /* put the start of the current sentence on the reading line */
  const lineH = cfg.font * cfg.line;
  const y = first.offsetTop + first.offsetHeight - lineH;
  t.style.top = Math.round(H * cfg.eye / 100 - lineH / 2 - Math.max(0, y)) + "px";
  $("pvEye").style.top = cfg.eye + "%";
}
$("settingsBtn").onclick = () => {
  renderModelRows(); LANGS.forEach((l) => checkCached(l).then(renderModelRows));
  $("settings").classList.remove("hidden");
  ranges.forEach((f) => f());
  renderFormat(); renderPreview(); renderLogRow();
};
$("closeSettings").onclick = () => $("settings").classList.add("hidden");
$("settings").onclick = (e) => { if (e.target === $("settings")) $("settings").classList.add("hidden"); };
document.querySelectorAll("[data-dl]").forEach((b) => (b.onclick = () => {
  const lang = b.dataset.dl;
  b.disabled = true;
  (lang === engine.lang || lang === current.lang ? ensureModel(lang) : cacheOnly(lang))
    .then(() => { renderModelRows(); renderChip(); })
    .catch((e) => { renderModelRows(); alert(e.message); });
}));
function renderLogRow() {
  let info = "Ще немає. З'явиться після запису в режимі «Голос».";
  try {
    const l = JSON.parse(localStorage.getItem("sufler.lastLog") || "null");
    if (l) info = new Date(l.at).toLocaleString("uk-UA", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) +
      " · " + fmtTime(l.sec || 0) + " · «" + (l.title || "").slice(0, 30) + "»";
  } catch (e) { }
  $("logInfo").textContent = info;
}
$("shareLog").onclick = async () => {
  const raw = localStorage.getItem("sufler.lastLog");
  if (!raw) return;
  const d = new Date(), pad = (n) => String(n).padStart(2, "0");
  const name = "sufler-log-" + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + "-" + pad(d.getHours()) + pad(d.getMinutes()) + ".json";
  const file = new File([raw], name, { type: "application/json" });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: "Журнал суфлера" }); return; }
  } catch (e) { if (e && e.name === "AbortError") return; }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(file); a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
};
$("about").textContent = "Версія " + APP_VERSION + ". Працює без інтернету після першого завантаження. Тексти зберігаються лише на цьому пристрої.";

/* =====================================================================
   LOADER (shown only when the user waits for the model)
   ===================================================================== */
let loaderWanted = false;
function renderLoader() {
  const show = loaderWanted && engine.state === "loading";
  $("loader").classList.toggle("hidden", !show);
  if (!show) return;
  const bar = $("ldBar");
  $("ldTitle").textContent = "Готуємо розпізнавання · " + MODELS[engine.lang].name;
  if (engine.stage === "download") {
    bar.classList.remove("indet");
    bar.firstElementChild.style.width = Math.round(engine.progress * 100) + "%";
    $("ldText").textContent = "Перше завантаження " + Math.round(engine.progress * 100) + "% — далі працюватиме без інтернету";
  } else {
    bar.classList.add("indet");
    $("ldText").textContent = engine.stage === "extract" ? "Розпаковка моделі…" : engine.stage === "init" ? "Запуск розпізнавача… (кілька секунд)" : "Читання моделі з пам'яті пристрою…";
  }
}
$("ldCancel").onclick = () => { loaderWanted = false; renderLoader(); startCancelled = true; };
let startCancelled = false;

/* =====================================================================
   PROMPTER
   ===================================================================== */
const P = {
  active: false, mode: "voice", script: null, tokens: [], spoken: [], els: [], lay: null,
  pos: 0, y: 0, v: 0, target: 0, paused: false, dragging: false, counting: false,
  tracker: null, raf: 0, lastT: 0, elapsed: 0, doneUpTo: 0, curSent: -1, ended: false,
};
const content = $("content");

function buildContent() {
  const parsed = TR.parseScript(P.script.text);
  P.tokens = parsed.tokens; P.spoken = parsed.spoken;
  P.tracker = new TR.Tracker(parsed);
  content.innerHTML = "";
  P.els = new Array(P.tokens.length);
  P.sentEls = new Map();
  for (const [a, b] of parsed.paras) {
    const p = document.createElement("p");
    for (let i = a; i < b; i++) {
      const t = P.tokens[i];
      const s = document.createElement("span");
      s.className = t.note ? "w note" : "w";
      s.textContent = i < b - 1 ? t.raw + " " : t.raw;   // space inside: the sentence underline stays unbroken
      p.appendChild(s);
      P.els[i] = s;
      if (!P.sentEls.has(t.sent)) P.sentEls.set(t.sent, []);
      P.sentEls.get(t.sent).push(s);
    }
    content.appendChild(p);
  }
  const end = document.createElement("div");
  end.className = "end"; end.textContent = "• КІНЕЦЬ •";
  content.appendChild(end);
}

function applyLook() {
  const pr = $("prompter");
  pr.classList.toggle("light", !!cfg.light);
  content.classList.toggle("underline", !!cfg.underline && P.mode === "voice");
}

/* measure word positions once per layout (never during animation) */
function measure() {
  const lineH = cfg.font * cfg.line;
  const cw = content.clientWidth || 1;
  const tops = new Float64Array(P.els.length), lefts = new Float64Array(P.els.length);
  for (let i = 0; i < P.els.length; i++) { tops[i] = P.els[i].offsetTop; lefts[i] = P.els[i].offsetLeft; }
  const endEl = content.lastElementChild;
  P.lay = { lineH, cw, tops, lefts, end: endEl ? endEl.offsetTop : 0, H: window.innerHeight };
}
const eyeY = () => P.lay.H * cfg.eye / 100;

/* content y (px) the eyeline should point at for spoken position p:
   moves smoothly along the line as words are read */
function yForPos(p) {
  const L = P.lay;
  if (!P.tokens.length) return 0;
  if (!P.spoken.length) return L.lineH * 0.5;
  if (p >= P.spoken.length) {
    const last = P.spoken[P.spoken.length - 1].tok;
    return L.tops[last] + L.lineH * 1.2;
  }
  const t = P.spoken[p].tok;
  const frac = Math.min(1, Math.max(0, L.lefts[t] / L.cw));
  return L.tops[t] + L.lineH * (0.5 + 0.8 * frac);
}

/* token at the eyeline (for auto mode and after a manual scroll) */
function tokenAtY(y) {
  const L = P.lay, tops = L.tops;
  let lo = 0, hi = tops.length - 1, ans = tops.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (tops[mid] + L.lineH > y) { ans = mid; hi = mid - 1; } else lo = mid + 1;
  }
  return ans;
}
function spokenAtOrAfterToken(t) {
  const sp = P.spoken;
  let lo = 0, hi = sp.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (sp[m].tok < t) lo = m + 1; else hi = m; }
  return lo;
}

function applyTypography() {
  content.style.fontSize = cfg.font + "px";
  content.style.lineHeight = cfg.line;
  content.style.width = cfg.width + "%";
  content.style.maxWidth = Math.max(600, cfg.font * 22) + "px";
  content.style.paddingBottom = "100vh";
  $("eyeline").style.top = cfg.eye + "%";
}

function relayout() {
  if (!P.active) return;
  /* keep the same word at the eyeline across font/size/orientation changes */
  const anchorTok = P.lay ? tokenAtY(P.y) : 0;
  applyTypography();
  measure();
  if (P.mode === "voice") P.target = P.y = yForPos(P.pos);
  else P.target = P.y = P.lay.tops[anchorTok] + P.lay.lineH * 0.5;
  P.v = 0;
  P.doneUpTo = -1; markDone(true);
  render();
}

/* dim words already read; underline the current sentence */
function markDone(force) {
  let upTo;
  if (P.mode === "voice") upTo = P.pos < P.spoken.length ? P.spoken[P.pos].tok : P.tokens.length;
  else upTo = P.lay ? tokenAtY(P.y - P.lay.lineH * 0.6) : 0;
  if (!force && upTo === P.doneUpTo) return;
  const from = force ? 0 : Math.max(0, Math.min(upTo, P.doneUpTo)), to = force ? P.els.length : Math.max(upTo, P.doneUpTo);
  for (let i = from; i < to; i++) P.els[i].classList.toggle("done", i < upTo);
  P.doneUpTo = upTo;
  const sent = P.mode === "voice" && upTo < P.tokens.length ? P.tokens[upTo].sent : -1;
  if (sent !== P.curSent || force) {
    content.querySelectorAll(".w.cur").forEach((e) => e.classList.remove("cur"));
    (P.sentEls.get(sent) || []).forEach((e) => e.classList.add("cur"));
    P.curSent = sent;
  }
}

function setPos(p) {
  p = Math.max(0, Math.min(P.spoken.length, p));
  P.pos = p;
  P.target = yForPos(p);
  markDone(false);
  const S = P.spoken.length || 1;
  $("progress").style.width = (100 * p / S) + "%";
}

/* ---------------- animation loop ---------------- */
function render() {
  content.style.transform = "translate3d(0," + (eyeY() - P.y).toFixed(1) + "px,0)";
}
function frame(t) {
  P.raf = requestAnimationFrame(frame);
  const dt = Math.min(0.05, Math.max(0, (t - P.lastT) / 1000));
  P.lastT = t;
  if (!P.paused && !P.counting) P.elapsed += dt;
  if (P.dragging) return;
  const L = P.lay;
  if (P.mode === "auto" && !P.paused && !P.counting) {
    const step = cfg.speed * 0.05 * L.lineH * dt;   // constant speed: moves text directly, no lag
    P.target += step; P.y += step;
    if (P.target > L.end + L.lineH) { P.target = L.end + L.lineH; if (!P.ended) { P.ended = true; setPaused(true, "Кінець тексту"); } }
    markDone(false);
    const S = P.tokens.length || 1;
    $("progress").style.width = (100 * Math.min(1, tokenAtY(P.y) / S)) + "%";
  }
  /* critically damped spring with a speed limit: glides, never jerks */
  const w = P.mode === "auto" ? 9 : 5.5;
  const a = w * w * (P.target - P.y) - 2 * w * P.v;
  P.v += a * dt;
  const vmax = L.lineH * 7;
  if (P.v > vmax) P.v = vmax; else if (P.v < -vmax) P.v = -vmax;
  P.y += P.v * dt;
  if (Math.abs(P.target - P.y) < 0.2 && Math.abs(P.v) < 1) { P.y = P.target; P.v = 0; }
  render();
  updateTimer();
}
let lastTimerSec = -1;
function updateTimer() {
  const s = Math.floor(P.elapsed);
  if (s !== lastTimerSec) { lastTimerSec = s; $("timer").textContent = fmtTime(s); }
}

/* ---------------- start / stop ---------------- */
async function startPrompter(fromSaved) {
  homeMsg("");
  const text = current.text.trim();
  if (!text) { homeMsg("Спочатку вставте текст.", true); return; }
  const mode = cfg.mode;
  if (mode === "voice" && !TR.parseScript(text).spoken.length) {
    homeMsg("У тексті немає слів українською чи російською — для нього підійде режим «Авто».", true); return;
  }
  startCancelled = false;
  $("startBtn").disabled = true; $("resumeBtn").disabled = true;
  /* audio + wake-lock video must start inside the tap on iOS */
  if (mode === "voice") mic.prepare();
  wake.on();
  try {
    if (mode === "voice") {
      const lang = current.lang;
      if (!(engine.lang === lang && engine.state === "ready")) {
        loaderWanted = true; renderLoader();
        await ensureModel(lang);
        loaderWanted = false; renderLoader();
        if (startCancelled) throw new Error("");
      }
      await mic.start();
    }
    enterPrompter(mode, fromSaved);
  } catch (e) {
    loaderWanted = false; renderLoader();
    mic.stop(); wake.off();
    if (e && e.message) homeMsg(e.name === "NotAllowedError" || /permission|denied|not allowed/i.test(e.message)
      ? "Немає доступу до мікрофона. Дозвольте мікрофон для цього сайту в налаштуваннях браузера (Safari → Налаштування сайту → Мікрофон)."
      : e.message, true);
  } finally {
    $("startBtn").disabled = false; $("resumeBtn").disabled = false;
  }
}

function enterPrompter(mode, fromSaved) {
  P.active = true; P.mode = mode; P.script = current;
  P.paused = false; P.ended = false; P.elapsed = 0; P.curSent = -1; P.doneUpTo = -1; lastTimerSec = -1;
  heard.reset();
  $("home").classList.add("hidden");
  $("prompter").classList.remove("hidden");
  $("speedBox").classList.toggle("hidden", mode !== "auto");
  $("mic").classList.toggle("hidden", mode !== "voice");
  $("heard").textContent = "";
  updateSpeed();
  buildContent();
  applyLook(); applyTypography(); measure();
  let start = fromSaved ? current.pos : 0;
  if (!(start > 0 && start < P.spoken.length)) start = 0;
  P.tracker.setPos(start, 0);
  P.pos = start;
  P.y = P.target = mode === "voice" ? yForPos(start) : (start ? P.lay.tops[P.spoken[start].tok] + P.lay.lineH * 0.5 : P.lay.lineH * 0.5);
  P.v = 0;
  markDone(true);
  setPos(start);
  if (mode === "auto") P.target = P.y;
  render();
  P.lastT = performance.now();
  cancelAnimationFrame(P.raf);
  P.raf = requestAnimationFrame(frame);
  setBanner(null);
  showHud();
  goFullscreen();
  if (mode === "voice") { slog.begin(); recog.start(); } else if (cfg.countdown) countdown(); else setPaused(false);
  updatePauseBtn();
}

function exitPrompter() {
  if (!P.active) return;
  if (P.mode === "voice") P.script.pos = P.pos;
  else P.script.pos = P.lay ? spokenAtOrAfterToken(tokenAtY(P.y)) : 0;
  saveScripts(true);
  P.active = false;
  cancelAnimationFrame(P.raf);
  clearInterval(countdown.t);
  slog.add("exit"); slog.finish();
  recog.stop(); mic.stop(); wake.off();
  exitFullscreen();
  $("prompter").classList.add("hidden");
  $("home").classList.remove("hidden");
  $("countdown").classList.add("hidden");
  renderHomeState();
}

function countdown() {
  P.counting = true;
  let n = 3;
  const el = $("countdown");
  el.textContent = n; el.classList.remove("hidden");
  clearInterval(countdown.t);
  countdown.t = setInterval(() => {
    n--;
    if (n <= 0) { clearInterval(countdown.t); el.classList.add("hidden"); P.counting = false; P.lastT = performance.now(); }
    else el.textContent = n;
  }, 1000);
}

function setBanner(text, sub) {
  const b = $("banner");
  if (!text) { b.classList.add("hidden"); return; }
  b.textContent = text;
  if (sub) { const s = document.createElement("small"); s.textContent = sub; b.appendChild(s); }
  b.classList.remove("hidden");
}
function setPaused(v, why) {
  P.paused = v;
  if (v && P.mode === "auto") { P.target = P.y; P.v = 0; }   // stop dead, no coasting
  if (P.mode === "voice" && !v) heard.spendAll();      // speech while paused never moves the text
  if (P.mode === "voice") slog.add("pause", v ? 1 : 0, P.pos);
  setBanner(v ? (why || "Пауза") : null, v ? (P.mode === "voice" ? "Голос не слухаю. Пробіл або ⏵ — продовжити" : "Торкніться або Пробіл — продовжити") : null);
  updatePauseBtn();
  if (P.mode === "voice") mic.renderState();
}
function togglePause() {
  if (P.counting) return;
  if (P.ended && P.mode === "auto") { P.ended = false; restart(); return; }
  setPaused(!P.paused);
}
function updatePauseBtn() { $("pauseBtn").textContent = P.paused ? "⏵" : "⏸"; }
function restart() {
  P.tracker.setPos(0, heard.total());
  P.ended = false;
  if (P.mode === "voice") slog.add("restart", 0);
  if (P.mode === "voice") { setPos(0); }
  else { P.target = P.lay.lineH * 0.5; P.doneUpTo = -1; markDone(true); if (cfg.countdown) countdown(); setPaused(false); }
}
function updateSpeed() { $("speedVal").textContent = cfg.speed; }
function changeSpeed(d) { cfg.speed = Math.max(1, Math.min(40, cfg.speed + d)); updateSpeed(); saveCfg(); }
function changeFont(d) {
  cfg.font = Math.max(24, Math.min(140, cfg.font + d)); saveCfg();
  $("sFont").value = cfg.font; $("oFont").textContent = cfg.font;
  relayout();
}

/* move by whole lines (keyboard, remote, pedal) */
function nudge(lines) {
  const L = P.lay;
  if (P.mode === "voice") {
    const y = yForPos(P.pos) + lines * L.lineH;
    const p = spokenAtOrAfterToken(tokenAtY(y - L.lineH * 0.5));
    P.tracker.setPos(p, heard.total());
    setPos(p);
    slog.add("key", p);
  } else {
    P.target = Math.max(0, P.target + lines * L.lineH);
  }
}

/* re-anchor after the text was moved by hand */
function anchorToScreen() {
  if (P.mode === "voice") {
    const p = spokenAtOrAfterToken(tokenAtY(P.y - P.lay.lineH * 0.5));
    P.tracker.setPos(p, heard.total());
    P.pos = p; P.target = P.y;
    slog.add("swipe", p);
    markDone(false);
    $("progress").style.width = (100 * p / (P.spoken.length || 1)) + "%";
  } else {
    P.target = P.y;
    markDone(false);
  }
}

/* ---------------- HUD ---------------- */
let hudTimer = 0;
function showHud() {
  $("hud").classList.remove("off");
  clearTimeout(hudTimer);
  hudTimer = setTimeout(() => { if (!P.paused) $("hud").classList.add("off"); }, 3500);
}
function toggleHud() { if ($("hud").classList.contains("off")) showHud(); else { clearTimeout(hudTimer); $("hud").classList.add("off"); } }
$("hud").addEventListener("pointerdown", (e) => { e.stopPropagation(); showHud(); });
$("exitBtn").onclick = exitPrompter;
$("pauseBtn").onclick = togglePause;
$("restartBtn").onclick = restart;
$("fontUp").onclick = () => changeFont(4);
$("fontDown").onclick = () => changeFont(-4);
$("slower").onclick = () => changeSpeed(-1);
$("faster").onclick = () => changeSpeed(1);
$("mic").onclick = () => { if (mic.state === "err") mic.restart(); };

/* ---------------- touch / mouse / wheel ---------------- */
(() => {
  const st = $("stage");
  let lastY = 0, moved = 0, downAt = 0, id = null;
  st.addEventListener("pointerdown", (e) => {
    if (P.mode === "voice") mic.revive();
    id = e.pointerId; lastY = e.clientY; moved = 0; downAt = now();
    P.dragging = true; P.v = 0;
    try { st.setPointerCapture(id); } catch (x) { }
  });
  st.addEventListener("pointermove", (e) => {
    if (e.pointerId !== id) return;
    const dy = e.clientY - lastY; lastY = e.clientY;
    moved += Math.abs(dy);
    if (moved > 6) { P.y = Math.max(-P.lay.H, P.y - dy); P.target = P.y; render(); }
  });
  const up = (e) => {
    if (e.pointerId !== id) return;
    id = null; P.dragging = false;
    if (moved > 6) anchorToScreen();
    else if (now() - downAt < 500) {           // a tap
      if (P.mode === "auto") { togglePause(); showHud(); } else toggleHud();
    }
    P.lastT = performance.now();
  };
  st.addEventListener("pointerup", up);
  st.addEventListener("pointercancel", up);
  let wheelT = 0;
  st.addEventListener("wheel", (e) => {
    e.preventDefault();
    P.y = Math.max(-P.lay.H, P.y + e.deltaY); P.target = P.y; P.v = 0; render();
    P.dragging = true;
    clearTimeout(wheelT);
    wheelT = setTimeout(() => { P.dragging = false; anchorToScreen(); P.lastT = performance.now(); }, 250);
  }, { passive: false });
})();

document.addEventListener("keydown", (e) => {
  if (!P.active) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); startPrompter(false); }
    return;
  }
  const k = e.key;
  let handled = true;
  if (k === " " || k === "Enter" || k === "b" || k === "B" || k === "." ) togglePause();
  else if (k === "ArrowDown" || k === "PageDown") nudge(1);
  else if (k === "ArrowUp" || k === "PageUp") nudge(-1);
  else if (k === "ArrowRight") P.mode === "auto" ? changeSpeed(1) : nudge(1);
  else if (k === "ArrowLeft") P.mode === "auto" ? changeSpeed(-1) : nudge(-1);
  else if (k === "+" || k === "=") changeFont(4);
  else if (k === "-" || k === "_") changeFont(-4);
  else if (k === "Home") restart();
  else if (k === "Escape") exitPrompter();
  else handled = false;
  if (handled) { e.preventDefault(); showHud(); }
});

let resizeT = 0;
window.addEventListener("resize", () => { clearTimeout(resizeT); resizeT = setTimeout(() => { relayout(); renderPreview(); }, 120); });

/* =====================================================================
   HEARD WORDS — what the recognizer said, numbered across the session
   ===================================================================== */
let heardBuf = new TR.Heard();
const heard = {
  reset() { heardBuf = new TR.Heard(); },
  total() { return heardBuf.total(); },
  spendAll() { if (P.tracker) P.tracker.spent = heardBuf.total(); },
  push(text, isFinal) { heardBuf.push(text, isFinal); },
  window(n) { return heardBuf.window(n); },
};

/* =====================================================================
   SESSION LOG — what was heard and where the text was, for the last voice
   session. Saved on the device only; the user can send it for analysis.
   ===================================================================== */
const slog = {
  cur: null, last: "", dirty: false,
  begin() {
    this.cur = { v: APP_VERSION, at: new Date().toISOString(), ua: navigator.userAgent, lang: P.script.lang,
      title: titleOf(P.script), script: P.script.text, start: P.pos, ev: [] };
    this.t0 = now(); this.last = ""; this.dirty = true;
  },
  add(...e) {
    if (!this.cur || this.cur.ev.length > 30000) return;
    this.cur.ev.push([Math.round(now() - this.t0), ...e]); this.dirty = true;
  },
  result(text, isFinal, pos) {
    if (!isFinal && text === this.last) return;
    this.last = isFinal ? "" : text;
    this.add(isFinal ? "F" : "p", text, pos);
  },
  save() {
    if (!this.cur || !this.dirty) return;
    this.cur.end = P.pos; this.cur.sec = Math.round((now() - this.t0) / 1000);
    try { localStorage.setItem("sufler.lastLog", JSON.stringify(this.cur)); } catch (e) { }
    this.dirty = false;
  },
  finish() { this.save(); this.cur = null; },
};
setInterval(() => { if (P.active) slog.save(); }, 10000);

/* =====================================================================
   RECOGNIZER — one per prompter session, recreated on any error
   ===================================================================== */
const recog = {
  rec: null, sent: 0, got: 0, lastGot: 0, grammar: null, failures: 0,
  start() {
    this.stop();
    if (!engine.model) return;
    const sr = mic.ctx ? mic.ctx.sampleRate : 48000;
    if (MODELS[P.script.lang].grammar && this.failures < 2) this.grammar = JSON.stringify(TR.grammarWords(P.script.text).concat(["<UNK>"]));
    else this.grammar = null;
    let rec;
    try { rec = new engine.model.KaldiRecognizer(sr, this.grammar || undefined); }
    catch (e) { console.warn(e); return; }
    this.rec = rec; this.sent = this.got = 0; this.lastGot = now();
    rec.on("partialresult", (m) => this.onResult(m.result.partial, false));
    rec.on("result", (m) => this.onResult(m.result.text, true));
    rec.on("error", (m) => {
      console.warn("recognizer error", m && m.error);
      this.failures++;
      setTimeout(() => P.active && P.mode === "voice" && this.start(), 300);
    });
  },
  stop() {
    if (this.rec) { try { this.rec.remove(); } catch (e) { } }
    this.rec = null;
  },
  feed(buf, sr) {
    if (!this.rec) return;
    /* never let audio pile up: if the engine falls behind (>1.5 s), drop audio
       rather than show text that lags further and further behind the voice */
    if (this.sent - this.got > 36) { slog.add("drop"); return; }
    this.sent++;
    try { this.rec.acceptWaveformFloat(buf, sr); } catch (e) { }
  },
  onResult(text, isFinal) {
    this.got++; this.lastGot = now();
    if (!text) return;
    heard.push(text, isFinal);
    if (!P.active || P.paused) { slog.result(text, isFinal, P.pos); return; }
    const w = heard.window(12);
    const p = P.tracker.update(w.words, w.start);
    if (p >= 0) setPos(p);
    slog.result(text, isFinal, P.pos);
    showHeard(text);
  },
};
let heardT = 0;
function showHeard(text) {
  $("heard").textContent = String(text).replace(/\[unk\]|<UNK>/g, "…").split(/\s+/).slice(-6).join(" ");
  clearTimeout(heardT);
  heardT = setTimeout(() => ($("heard").textContent = ""), 3000);
}

/* =====================================================================
   MICROPHONE — survives interruptions (calls, Siri, app switching)
   ===================================================================== */
const mic = {
  ctx: null, stream: null, src: null, node: null, mute: null,
  state: "off", lastAudio: 0, level: 0, watch: 0, restarting: false, lastRestart: 0,
  prepare() {   // called synchronously inside the tap
    try {
      if (!this.ctx || this.ctx.state === "closed") this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.ctx.resume().catch(() => { });
    } catch (e) { }
  },
  async start() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia)
      throw new Error("Цей браузер не дає доступу до мікрофона. Відкрийте суфлер у Safari або Chrome через https.");
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    this.prepare();
    const ctx = this.ctx;
    await ctx.resume().catch(() => { });
    this.src = ctx.createMediaStreamSource(this.stream);
    const onAudio = (buf, rms) => {
      this.lastAudio = now();
      this.level = this.level * 0.7 + rms * 0.3;
      if (P.active && !P.paused) recog.feed(buf, ctx.sampleRate);
    };
    try {
      if (!ctx.audioWorklet) throw new Error("no worklet");
      if (!mic.workletReady || mic.workletCtx !== ctx) { await ctx.audioWorklet.addModule("capture-worklet.js"); mic.workletReady = true; mic.workletCtx = ctx; }
      this.node = new AudioWorkletNode(ctx, "capture", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      this.node.port.onmessage = (e) => onAudio(e.data.buf, e.data.rms);
    } catch (e) {
      this.node = ctx.createScriptProcessor(2048, 1, 1);
      this.node.onaudioprocess = (ev) => {
        const d = ev.inputBuffer.getChannelData(0);
        let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i] * d[i];
        onAudio(new Float32Array(d), Math.sqrt(s / (d.length / 4)));
      };
    }
    this.mute = ctx.createGain(); this.mute.gain.value = 0;
    this.src.connect(this.node); this.node.connect(this.mute); this.mute.connect(ctx.destination);
    const track = this.stream.getAudioTracks()[0];
    if (track) track.onended = () => this.restart();
    ctx.onstatechange = () => { if (ctx.state !== "running" && P.active) ctx.resume().catch(() => { }); };
    this.lastAudio = now();
    this.state = "live";
    clearInterval(this.watch);
    this.watch = setInterval(() => this.check(), 1000);
    this.renderState();
  },
  stop() {
    clearInterval(this.watch);
    try { this.src && this.src.disconnect(); } catch (e) { }
    try { this.node && this.node.disconnect(); } catch (e) { }
    try { this.mute && this.mute.disconnect(); } catch (e) { }
    try { this.stream && this.stream.getTracks().forEach((t) => t.stop()); } catch (e) { }
    try { this.ctx && this.ctx.close(); } catch (e) { }
    this.ctx = this.stream = this.src = this.node = this.mute = null;
    this.workletReady = false;
    this.state = "off";
  },
  async restart() {
    if (this.restarting || !P.active || P.mode !== "voice") return;
    slog.add("mic-restart");
    this.restarting = true; this.lastRestart = now();
    this.state = "warn"; this.renderState();
    try {
      this.stop(); this.prepare();
      await this.start();
      recog.start();
    } catch (e) {
      console.warn("mic restart failed", e);
      this.state = "err"; this.renderState();
      setBanner("Мікрофон вимкнувся", "Торкніться червоної точки вгорі, щоб увімкнути");
      showHud();
    }
    this.restarting = false;
  },
  /* called from a touch: the only moment iOS lets audio start again */
  revive() {
    if (!P.active || P.mode !== "voice") return;
    if (this.state === "err" || !this.ctx) { this.restart(); return; }
    if (this.ctx.state !== "running") this.ctx.resume().then(() => { if (this.blocked) { this.blocked = false; setBanner(null); } }).catch(() => { });
  },
  check() {
    if (!P.active || P.mode !== "voice") return;
    const silentFor = now() - this.lastAudio;
    if (silentFor > 2000 && this.ctx && this.ctx.state !== "running") {
      this.ctx.resume().catch(() => { });
      if (silentFor > 3000 && !this.blocked) {        // the system wants a touch first
        this.blocked = true;
        setBanner("Торкніться екрана", "щоб знову увімкнути мікрофон");
        showHud();
      }
    } else if (this.blocked && silentFor < 1000) { this.blocked = false; setBanner(P.paused ? "Пауза" : null); }
    if (silentFor > 4000 && now() - this.lastRestart > 6000 && !(this.ctx && this.ctx.state !== "running")) this.restart();
    /* engine stopped answering (worker crashed) → reload it */
    if (recog.rec && recog.sent - recog.got > 30 && now() - recog.lastGot > 6000) recoverEngine();
    this.state = this.state === "err" ? "err" : silentFor > 2000 ? "warn" : "live";
    this.renderState();
  },
  renderState() {
    const el = $("mic");
    el.className = P.paused ? "paused" : this.state;
    const s = 1 + Math.min(this.level * 12, 0.9);
    el.style.transform = this.state === "live" && !P.paused ? "scale(" + s.toFixed(2) + ")" : "";
  },
};
setInterval(() => { if (P.active && P.mode === "voice" && mic.state === "live") mic.renderState(); }, 120);

let recovering = false;
async function recoverEngine() {
  if (recovering) return;
  recovering = true;
  setBanner("Перезапуск розпізнавання…", "кілька секунд");
  slog.add("engine-restart");
  const lang = P.script.lang;
  try {
    engine.promise = null; engine.lang = null;
    await ensureModel(lang);
    if (P.active) { recog.start(); setBanner(null); }
  } catch (e) { setBanner("Розпізнавання не працює", e.message); }
  recovering = false;
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !P.active) return;
  wake.on();
  if (P.mode === "voice") {               // iOS may stop the microphone in the background
    const t = mic.stream && mic.stream.getAudioTracks()[0];
    if (!t || t.readyState !== "live") mic.restart();
    else if (mic.ctx && mic.ctx.state !== "running") mic.ctx.resume().catch(() => { });
  }
  P.lastT = performance.now();
});

/* =====================================================================
   SCREEN STAYS ON + FULLSCREEN
   ===================================================================== */
const wake = {
  lock: null,
  async on() {
    const v = $("wakeVideo");
    try { const p = v.play(); if (p) p.catch(() => { }); } catch (e) { }   // fallback for older iOS
    try { if ("wakeLock" in navigator && !this.lock) { this.lock = await navigator.wakeLock.request("screen"); this.lock.addEventListener("release", () => (this.lock = null)); } } catch (e) { }
  },
  off() {
    try { $("wakeVideo").pause(); } catch (e) { }
    try { this.lock && this.lock.release(); } catch (e) { }
    this.lock = null;
  },
};
function goFullscreen() {
  const d = document.documentElement;
  try { (d.requestFullscreen || d.webkitRequestFullscreen || (() => { })).call(d)?.catch?.(() => { }); } catch (e) { }
}
function exitFullscreen() {
  try { if (document.fullscreenElement) document.exitFullscreen().catch(() => { }); else if (document.webkitFullscreenElement) document.webkitExitFullscreen(); } catch (e) { }
}

/* =====================================================================
   BOOT
   ===================================================================== */
$("startBtn").onclick = () => startPrompter(false);
$("resumeBtn").onclick = () => startPrompter(true);

applyTheme();
$("text").value = current.text;
if (LANGS.length < 2) $("langSeg").classList.add("hidden");
document.querySelectorAll("#langSeg button").forEach((b) => { if (!MODELS[b.dataset.lang]) b.classList.add("hidden"); });
renderList();
renderHomeState();
Promise.all(LANGS.map(checkCached)).then(() => { renderChip(); preloadIfUseful(); });
try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) { }
try { indexedDB.deleteDatabase("/vosk"); } catch (e) { }   // storage of the old version

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  const hadWorker = !!navigator.serviceWorker.controller;   // first visit: nothing to announce
  navigator.serviceWorker.register("sw.js").then((reg) => {
    reg.addEventListener("updatefound", () => {
      const nw = reg.installing;
      nw && nw.addEventListener("statechange", () => {
        if (nw.state === "activated" && hadWorker && !P.active)
          homeMsg("Встановлено нову версію — вона запрацює після перезапуску суфлера.");
      });
    });
  }).catch(() => { });
}
if (!window.isSecureContext) homeMsg("Відкрито не через https — мікрофон у браузері працювати не буде.", true);
