/* Script parsing + voice tracking.
 *
 * How tracking works (the same idea pro voice prompters use):
 * the last ~12 heard words are aligned against the script around the current
 * position as a whole sequence (local alignment, like comparing two DNA strings),
 * not word by word. A position wins only when a run of words agrees with it, so
 * one similar-looking word can never pull the text to another line.
 * Jumps need more evidence the farther they go; going back needs a lot.
 */
(function (root) {
  "use strict";

  const NOTE_OPEN = /^[\[\{‹(]/;
  const NOTE_CLOSE = /[\]\}›)][.,:;!?…]*$/;
  const CYR = /[а-яёіїєґ]/;

  /* one canonical form for matching: lower case, ё→е, ґ→г, no apostrophes/punctuation */
  function norm(w) {
    return String(w).toLowerCase()
      .replace(/ё/g, "е").replace(/ґ/g, "г")
      .replace(/[’'ʼ`´­]/g, "")
      .replace(/[^\p{L}\p{N}]/gu, "");
  }

  /* split a token into the parts a recognizer would say separately */
  function parts(tok) {
    return String(tok).split(/[-‐‑–—\/]+/).map(norm).filter(Boolean);
  }

  /* ---------------- script parsing ---------------- */
  /* Paragraphs as they should look on the prompter. Text copied from a document
     often has line breaks in the middle of a sentence; on a big font such a line
     ends up as a single word on its own line. A line is glued to the next one when
     it stops mid-sentence (no . ! ? … : ;) and the next line clearly continues it
     (starts lowercase, or the line ended with a comma/dash). Empty lines, notes in
     brackets and list items always stay separate. */
  function paragraphs(text) {
    const out = [];
    let cur = null;
    for (const line of String(text).replace(/\r/g, "").split("\n")) {
      const t = line.trim().replace(/\s+/g, " ");
      if (!t) { cur = null; continue; }
      const isNote = NOTE_OPEN.test(t) && NOTE_CLOSE.test(t);
      const isList = /^([-–—•*]|\d+[.)])\s/.test(t);
      const continues = cur && !cur.note && !isNote && !isList &&
        !/[.!?…:;]["»”)]*$/.test(cur.text) &&
        (/^[a-zа-яёіїєґ]/.test(t) || /[,–—-]$/.test(cur.text));
      if (continues) cur.text += " " + t;
      else { cur = { text: t, note: isNote }; out.push(cur); }
    }
    return out.map((p) => p.text);
  }

  function parseScript(text) {
    const tokens = [];   // every visible word: {raw, para, sent, note, spokenFrom, spokenTo}
    const spoken = [];   // matchable words: {norm, tok, w}
    const paras = [];    // [startTok, endTok)
    let sent = 0, para = 0, inNote = false;
    for (const line of paragraphs(text)) {
      const toks = line.split(/\s+/).filter(Boolean);
      if (!toks.length) continue;
      const start = tokens.length;
      for (const raw of toks) {
        if (NOTE_OPEN.test(raw)) inNote = true;
        const note = inNote;
        if (NOTE_CLOSE.test(raw)) inNote = false;
        const t = { raw, para, sent, note, spokenFrom: spoken.length, spokenTo: spoken.length };
        if (!note) {
          for (const p of parts(raw)) {
            /* only words the recognizer can actually say: cyrillic, 2+ letters */
            if (p.length >= 2 && CYR.test(p)) spoken.push({ norm: p, tok: tokens.length, w: 0 });
          }
        }
        t.spokenTo = spoken.length;
        tokens.push(t);
        if (/[.!?…]["»”)]*$/.test(raw)) sent++;
      }
      inNote = false;            // a note never runs past the end of a paragraph
      paras.push([start, tokens.length]);
      para++; sent++;
    }
    /* word weights: long and rare words are strong evidence, short/common ones weak */
    const freq = new Map();
    for (const s of spoken) freq.set(s.norm, (freq.get(s.norm) || 0) + 1);
    for (const s of spoken) {
      const L = s.norm.length;
      const base = L <= 2 ? 0.2 : L === 3 ? 0.45 : L === 4 ? 0.7 : L === 5 ? 0.9 : 1;
      const f = freq.get(s.norm);
      s.w = base / (1 + 0.3 * Math.log2(f));
    }
    return { tokens, spoken, paras };
  }

  /* words for the recognizer's restricted vocabulary (Vosk "grammar") */
  function grammarWords(text) {
    const out = new Set();
    const { tokens } = parseScript(text);
    for (const t of tokens) {
      if (t.note) continue;
      for (const piece of String(t.raw).toLowerCase().split(/[-‐‑–—\/]+/)) {
        const clean = piece.replace(/[^\p{L}\p{N}’'ʼ`]/gu, "");
        if (!clean || !CYR.test(clean)) continue;
        const ap = clean.replace(/[’ʼ`]/g, "'");
        const variants = [ap, ap.replace(/'/g, ""), ap.replace(/'/g, "’")];
        for (const v of variants) {
          out.add(v);
          if (v.includes("ё")) out.add(v.replace(/ё/g, "е"));
          if (v.includes("ґ")) out.add(v.replace(/ґ/g, "г"));
        }
      }
    }
    out.add("[unk]");
    return [...out];
  }

  /* ---------------- word similarity ---------------- */
  function lev(a, b, max) {
    const m = a.length, n = b.length;
    if (Math.abs(m - n) > max) return max + 1;
    let prev = new Array(n + 1), cur = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
      cur[0] = i; let rowMin = i;
      for (let j = 1; j <= n; j++) {
        const c = a[i - 1] === b[j - 1] ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + c);
        if (cur[j] < rowMin) rowMin = cur[j];
      }
      if (rowMin > max) return max + 1;
      [prev, cur] = [cur, prev];
    }
    return prev[n];
  }

  /* 1 = same word, ~0.8 = same word with another ending, 0 = different */
  function sim(a, b) {
    if (a === b) return 1;
    const la = a.length, lb = b.length, minL = Math.min(la, lb), maxL = Math.max(la, lb);
    if (minL < 3) return 0;
    let cp = 0; while (cp < minL && a[cp] === b[cp]) cp++;
    /* same stem, different ending: потрібно/потрібні, але не переконати/перевірити */
    if (cp >= 4 && cp >= minL - 2 && maxL - cp <= 4) return 0.8;
    if (minL >= 4) {
      const d = lev(a, b, 2);
      if (d === 1) return 0.7;
      if (d === 2 && minL >= 6) return 0.5;
    }
    return 0;
  }

  /* ---------------- the tracker ---------------- */
  const BACK = 40, AHEAD = 100;
  const GAP_HEARD = 0.3;       // a heard word that is not in the script (ad-lib, misheard)
  const MISMATCH = 0.4;        // heard word aligned against a different script word

  function Tracker(script) {
    this.s = script.spoken;
    this.pos = 0;              // index (in spoken words) of the next word to be read
    this.spent = 0;            // heard words before this running number are used up
    this.simCache = new Map();
  }

  Tracker.prototype.simAt = function (h, j) {
    const key = h + "\u0001" + j;
    let v = this.simCache.get(key);
    if (v === undefined) {
      v = sim(h, this.s[j].norm);
      if (this.simCache.size > 50000) this.simCache.clear();
      this.simCache.set(key, v);
    }
    return v;
  };

  /* Local alignment of the heard words against script words [lo, hi].
     Returns, for every script word k, the best score of an alignment that ends
     by matching word k with one of the 3 most recent heard words (endS), and how
     many words matched in that run (endN). */
  Tracker.prototype.align = function (heard, lo, hi) {
    const n = heard.length, W = hi - lo + 1;
    let pS = new Float64Array(W), cS = new Float64Array(W);
    let pN = new Int32Array(W), cN = new Int32Array(W);
    const endS = new Float64Array(W).fill(-1), endN = new Int32Array(W);
    for (let i = 1; i <= n; i++) {
      const h = heard[i - 1], tail = n - i;
      for (let k = 0; k < W; k++) {
        const w = this.s[lo + k].w;
        const s = h ? this.simAt(h, lo + k) : 0;
        const dS = k > 0 ? pS[k - 1] : 0, dN = k > 0 ? pN[k - 1] : 0;
        let bS = 0, bN = 0;                       // may restart anywhere (local)
        if (s > 0) {
          const v = dS + s * w;
          if (v > bS) { bS = v; bN = dN + 1; }
          if (tail <= 2) {
            const e = v - tail * GAP_HEARD;
            if (e > endS[k]) { endS[k] = e; endN[k] = dN + 1; }
          }
        } else if (dS - MISMATCH > bS) { bS = dS - MISMATCH; bN = dN; }
        if (pS[k] - GAP_HEARD > bS) { bS = pS[k] - GAP_HEARD; bN = pN[k]; }
        if (k > 0) {
          const left = cS[k - 1] - (0.08 + 0.3 * w);
          if (left > bS) { bS = left; bN = cN[k - 1]; }
        }
        cS[k] = bS; cN[k] = bN;
      }
      [pS, cS] = [cS, pS]; [pN, cN] = [cN, pN];
    }
    return { endS, endN };
  };

  /* heard: the most recent normalized words, oldest first ("" = unknown word);
     heardStart: running number of heard[0] in the whole session.
     Every heard word may move the text only once: words that already moved it
     are "spent", so a phrase that repeats further in the script (що потрібно
     зробити…) can never drag the text there a second time.
     Returns the new position or -1 if it should stay. */
  Tracker.prototype.update = function (heardAll, heardStart) {
    const S = this.s.length;
    if (heardStart === undefined) heardStart = 0;
    const heard = heardAll.slice(Math.max(0, this.spent - heardStart));
    if (!S || !heard.length) return -1;
    const pos = this.pos;
    const spend = () => { this.spent = heardStart + heardAll.length; };

    /* the same fresh words aligned against the text already read */
    let behind = null, bestBehind = -Infinity;
    if (pos >= 2) {
      const lo = Math.max(0, pos - BACK), hi = Math.min(S - 1, pos + 1);
      behind = { lo, r: this.align(heard, lo, hi) };
      /* people re-read what they have just said, so a match close behind counts
         much more than a similar phrase two sentences back */
      for (let k = 0; k < behind.r.endS.length; k++) {
        if (lo + k >= pos || behind.r.endS[k] <= 0) continue;
        const v = behind.r.endS[k] - (0.3 + 0.05 * (pos - lo - k));
        if (v > bestBehind) bestBehind = v;
      }
    }

    /* forward: evidence only from the text at/after the reader, so a good run
       of words already read can never pay for a jump ahead */
    if (pos < S) {
      const hi = Math.min(S - 1, pos + AHEAD);
      const f = this.align(heard, pos, hi);
      let bk = -1, bAdj = -Infinity;
      for (let k = 0; k < f.endS.length; k++) {
        if (f.endS[k] <= 0) continue;
        const d = k + 1;
        const adj = f.endS[k] - 0.015 * Math.max(0, d - 4);
        if (adj > bAdj) { bAdj = adj; bk = k; }
      }
      if (bk >= 0) {
        const d = bk + 1, sc = f.endS[bk], m = f.endN[bk];
        let ok = d <= 2 ? sc >= 0.4
          : d <= 6 ? sc >= 0.65 && (m >= 2 || (d <= 3 && sc >= 0.9))
          : d <= 20 ? sc >= 1.2 && m >= 2
          : sc >= 2.2 && m >= 3;
        /* a phrase that fits the text just read as well as a similar phrase
           further on (re-reading "що потрібно зробити…") is not a reason to jump */
        if (ok && d > 4 && bestBehind >= sc - 0.015 * (d - 4) - 0.25) ok = false;
        if (ok) { this.pos = pos + d; spend(); return this.pos; }
      }
    }

    /* rescue: the reader has been talking for a while and nothing nearby fits
       (a jump far ahead, or the text got lost). Search the WHOLE script, but
       only accept a long run of words that fits one place clearly better than
       any other place. */
    let freshWords = 0;
    for (const h of heard) if (h) freshWords++;
    if (freshWords >= 7) {
      const g = this.align(heard, 0, S - 1);
      let bk = -1;
      for (let k = 0; k < g.endS.length; k++) if (bk < 0 || g.endS[k] > g.endS[bk]) bk = k;
      if (bk >= 0 && g.endS[bk] >= 3.0 && g.endN[bk] >= 4 && Math.abs(bk + 1 - pos) > 3) {
        let second = 0;
        for (let k = 0; k < g.endS.length; k++) if (Math.abs(k - bk) > 25 && g.endS[k] > second) second = g.endS[k];
        if (g.endS[bk] >= second + 1.0) { this.pos = bk + 1; spend(); return this.pos; }
      }
    }

    /* backward (reader went back / re-reads): needs a long clear run that
       explains the speech much better than the current place does */
    if (behind) {
      const { lo, r: b } = behind;
      let near = 0, bk = -1, bS = -Infinity;
      for (let k = 0; k < b.endS.length; k++) {
        const d = lo + k + 1 - pos;
        if (d >= -1) { if (b.endS[k] > near) near = b.endS[k]; continue; }
        const adj = b.endS[k] - 0.06 * -d;
        if (adj > bS) { bS = adj; bk = k; }
      }
      if (bk >= 0 && b.endS[bk] >= 2.0 && b.endN[bk] >= 3 && b.endS[bk] >= near + 1.0) {
        this.pos = lo + bk + 1;
        spend();
        return this.pos;
      }
    }
    return -1;
  };

  /* manual jump (finger, remote): everything heard so far is spent */
  Tracker.prototype.setPos = function (p, heardTotal) {
    this.pos = Math.max(0, Math.min(this.s.length, p | 0));
    if (heardTotal !== undefined) this.spent = heardTotal;
  };

  /* What the recognizer said, numbered across the whole session.
     Vosk sends "partial" results that grow and change while you speak and a
     "final" result at each pause; the partial words are replaced each time. */
  function Heard() { this.final = []; this.base = 0; this.partial = []; }
  Heard.prototype.split = function (text) {
    const out = [];
    let unk = 0;
    for (const raw of String(text).split(/\s+/)) {
      if (!raw) continue;
      if (raw === "[unk]" || raw === "<UNK>" || raw === "<unk>") { if (++unk <= 2) out.push(""); continue; }
      unk = 0;
      for (const p of parts(raw)) out.push(p);
    }
    return out;
  };
  Heard.prototype.push = function (text, isFinal) {
    const words = this.split(text);
    if (isFinal) {
      this.final.push(...words); this.partial = [];
      if (this.final.length > 60) { const cut = this.final.length - 30; this.final.splice(0, cut); this.base += cut; }
    } else this.partial = words;
  };
  Heard.prototype.total = function () { return this.base + this.final.length + this.partial.length; };
  Heard.prototype.window = function (n) {
    const all = this.final.concat(this.partial);
    const start = Math.max(0, all.length - n);
    return { words: all.slice(start), start: this.base + start };
  };

  const api = { norm, parts, paragraphs, parseScript, grammarWords, sim, Tracker, Heard };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PrompterTracker = api;
})(typeof self !== "undefined" ? self : this);
