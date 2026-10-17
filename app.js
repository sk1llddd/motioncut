const $ = id => document.getElementById(id);
const uid = () => Math.random().toString(36).slice(2, 12);
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const canvas = $("preview"), pctx = canvas.getContext("2d");
const TIMED = new Set(["video", "audio"]);           // clips that play a media file in time
const TRACK_H = { video: 56, audio: 44 };
const FPS = 30;

const defaultProject = () => ({
    w: 1280,
    h: 720,
    tracks: [                                         // top of the list draws in front
        { id: uid(), kind: "video", name: "V2", off: false },
        { id: uid(), kind: "video", name: "V1", off: false },
        { id: uid(), kind: "audio", name: "A1", off: false },
        { id: uid(), kind: "audio", name: "A2", off: false },
    ],
});

// clip = { id, track, type: video|audio|image|text, media, name, start, in, dur,
//          volume, opacity, x, y, scale, fadeIn, fadeOut, text, size, color }
let project = defaultProject();
let clips = new Map();
const media = new Map();       // id -> { id, name, type, mime, blob, url, duration, w, h, thumb, img }
let t = 0, playing = false, playFrom = 0, playStart = 0, exporting = null;
let sel = null, pps = 60;      // selected clip id, timeline pixels per second
let past = [], future = [];

const kindFor = type => type === "audio" ? "audio" : "video";
const trackOf = c => project.tracks.find(tr => tr.id === c.track);
const duration = () => Math.max(0, ...[...clips.values()].map(c => c.start + c.dur));
const isActive = (c, at = t) => at >= c.start && at < c.start + c.dur;

function fmt(s) {
    const m = Math.floor(s / 60), r = s - m * 60;
    return `${m}:${r.toFixed(2).padStart(5, "0")}`;
}

function flash(msg) {
    $("status").textContent = msg;
    clearTimeout(flash.timer);
    flash.timer = setTimeout(() => $("status").textContent = "", 3000);
}

function fade(c, at = t) {
    const into = at - c.start, left = c.start + c.dur - at;
    return Math.max(0, Math.min(1, c.fadeIn ? into / c.fadeIn : 1, c.fadeOut ? left / c.fadeOut : 1));
}

// ---------- history ----------

const snap = () => JSON.stringify({ project, clips: [...clips.values()] });

function restore(s) {
    const o = JSON.parse(s);
    project = o.project;
    clips = new Map(o.clips.map(c => [c.id, c]));
    if (sel && !clips.has(sel)) sel = null;
}

function change(fn) {
    past.push(snap());
    if (past.length > 100) past.shift();
    future = [];
    fn();
    afterChange();
}

function undo() {
    if (!past.length) return;
    future.push(snap());
    restore(past.pop());
    afterChange();
}

function redo() {
    if (!future.length) return;
    past.push(snap());
    restore(future.pop());
    afterChange();
}

function afterChange() {
    if (canvas.width !== project.w || canvas.height !== project.h) {
        canvas.width = project.w;
        canvas.height = project.h;
    }
    $("resolution").value = `${project.w}x${project.h}`;
    drawTimeline();
    drawProps();
    requestDraw();
    sync();
    scheduleSave();
}

// ---------- media ----------

const once = (el, ok, ms = 15000) => new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error("timeout")), ms);
    el.addEventListener(ok, () => { clearTimeout(timer); res(); }, { once: true });
    el.addEventListener("error", () => { clearTimeout(timer); rej(new Error("unsupported")); }, { once: true });
});

function thumbFrom(src, w, h) {
    const c = document.createElement("canvas");
    c.height = 90;
    c.width = Math.max(1, Math.round(90 * w / h));
    c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.7);
}

async function waveform(blob) {
    const audio = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(await blob.arrayBuffer());
    const data = audio.getChannelData(0), n = 800, step = Math.max(1, Math.floor(data.length / n));
    const c = document.createElement("canvas");
    c.width = n;
    c.height = 80;
    const g = c.getContext("2d");
    g.fillStyle = "#8fe0b0";
    for (let i = 0; i < n; i++) {
        let peak = 0;
        for (let j = i * step, end = j + step; j < end && j < data.length; j += 16) peak = Math.max(peak, Math.abs(data[j]));
        g.fillRect(i, 40 - peak * 38, 1, Math.max(1, peak * 76));
    }
    return c.toDataURL();
}

// Probes a media file (duration, size, thumbnail) and adds it to the bin.
async function addMedia(m) {
    if (media.has(m.id)) return media.get(m.id);
    m.url = URL.createObjectURL(m.blob);
    if (m.type === "image") {
        m.img = await createImageBitmap(m.blob);
        Object.assign(m, { w: m.img.width, h: m.img.height, duration: 5, thumb: thumbFrom(m.img, m.img.width, m.img.height) });
    } else {
        const el = document.createElement(m.type);
        el.muted = true;
        el.preload = "auto";
        el.src = m.url;
        await once(el, "loadedmetadata");
        if (!isFinite(el.duration)) {              // some recorded webm files don't know their length until scanned
            el.currentTime = 1e9;
            await once(el, "durationchange");
        }
        Object.assign(m, { duration: el.duration, w: el.videoWidth || 0, h: el.videoHeight || 0 });
        if (m.type === "video") {
            el.currentTime = Math.min(1, m.duration / 2);
            await once(el, "seeked");
            m.thumb = m.w ? thumbFrom(el, m.w, m.h) : "";
        } else {
            m.thumb = await waveform(m.blob).catch(() => "");
        }
    }
    media.set(m.id, m);
    saveMedia(m);
    drawBin();
    drawTimeline();
    requestDraw();
    return m;
}

async function importFiles(files, at) {
    for (const f of files) {
        const type = ["video", "audio", "image"].find(k => f.type.startsWith(k + "/"));
        if (!type) {
            flash(`Skipped ${f.name} (not video, audio or image)`);
            continue;
        }
        try {
            flash(`Importing ${f.name}…`);
            const m = await addMedia({ id: uid(), name: f.name, type, mime: f.type, blob: f });
            await sendMedia(m);                    // before the clip, so peers never wait on it
            if (at) addClip(m, at.track, at.time);
            flash(`Imported ${f.name}`);
        } catch {
            flash(`Couldn't open ${f.name}. This browser may not support that format.`);
        }
    }
}

// The track a new clip goes on: the one it was dropped on, else the first track of that kind
// that's empty for the clip's time span (V1 / A1 first, titles from the top), else a new track.
// Call inside change() since it may add a track.
function trackFor(c, preferred, fromTop) {
    const kind = kindFor(c.type);
    const pref = project.tracks.find(tr => tr.id === preferred && tr.kind === kind);
    if (pref) return pref.id;
    const busy = tr => [...clips.values()].some(o => o.track === tr.id && o.start < c.start + c.dur && c.start < o.start + o.dur);
    const list = project.tracks.filter(tr => tr.kind === kind);
    if (kind === "video" && !fromTop) list.reverse();
    const free = list.find(tr => !busy(tr));
    if (free) return free.id;
    const tr = { id: uid(), kind, name: (kind === "video" ? "V" : "A") + (list.length + 1), off: false };
    if (kind === "video") project.tracks.unshift(tr);
    else project.tracks.push(tr);
    return tr.id;
}

function addClip(m, trackId, start) {
    const c = {
        id: uid(), track: null, type: m.type, media: m.id, name: m.name,
        start: Math.max(0, start), in: 0, dur: m.duration,
        volume: 1, opacity: 1, x: 0, y: 0, scale: 1, fadeIn: 0, fadeOut: 0,
    };
    change(() => {
        c.track = trackFor(c, trackId);
        clips.set(c.id, c);
    });
    select(c.id);
}

function addText() {
    const c = {
        id: uid(), track: null, type: "text", media: null, name: "Text",
        start: t, in: 0, dur: 3, volume: 1, opacity: 1, x: 0, y: 0, scale: 1, fadeIn: 0, fadeOut: 0,
        text: "Your title", size: Math.round(project.h / 8), color: "#ffffff",
    };
    change(() => {
        c.track = trackFor(c, null, true);
        clips.set(c.id, c);
    });
    select(c.id);
}

function removeMedia(id) {
    const used = [...clips.values()].filter(c => c.media === id);
    if (used.length && !confirm(`This media is used by ${used.length} clip(s). Remove it and those clips?`)) return;
    change(() => used.forEach(c => clips.delete(c.id)));
    URL.revokeObjectURL(media.get(id).url);
    media.delete(id);
    idb("readwrite", "media", s => s.delete(id));
    drawBin();
}

function drawBin() {
    const box = $("media");
    box.innerHTML = "";
    for (const m of media.values()) {
        const b = document.createElement("div");
        b.className = "tile";
        b.draggable = true;
        b.tabIndex = 0;
        b.title = `${m.name}. Drag onto a track or double-click to add at the playhead`;
        b.innerHTML = `<div class="thumb"></div><div class="name"></div><div class="meta"></div><button class="rm" title="Remove" aria-label="Remove from project">✕</button>`;
        if (m.thumb) b.querySelector(".thumb").style.backgroundImage = `url(${m.thumb})`;
        b.querySelector(".name").textContent = m.name;
        b.querySelector(".meta").textContent = `${m.type}${m.type === "image" ? "" : " · " + fmt(m.duration)}`;
        b.ondragstart = e => e.dataTransfer.setData("text/x-motioncut-media", m.id);
        b.ondblclick = () => addClip(m, null, t);
        b.onkeydown = e => { if (e.key === "Enter") addClip(m, null, t); };
        b.querySelector(".rm").onclick = e => { e.stopPropagation(); removeMedia(m.id); };
        box.append(b);
    }
}

// One media element per clip, so two clips of the same file can play different moments.
const els = new Map();
function mediaEl(c) {
    const m = media.get(c.media);
    if (!m || !TIMED.has(c.type)) return null;
    let el = els.get(c.id);
    if (!el || el.dataset.src !== m.url) {
        el = document.createElement(c.type);
        el.preload = "auto";
        el.playsInline = true;
        el.src = el.dataset.src = m.url;
        el.addEventListener("seeked", () => { keepFrame(el); requestDraw(); });
        el.addEventListener("loadeddata", () => { keepFrame(el); requestDraw(); });
        els.set(c.id, el);
        connectAudio(el);
    }
    return el;
}

// ---------- audio ----------
// Everything plays through Web Audio so export can record the mix.

let actx = null, master = null, recDest = null;

function audioCtx() {
    if (!actx) {
        actx = new AudioContext();
        master = actx.createGain();
        master.connect(actx.destination);
        recDest = actx.createMediaStreamDestination();
        master.connect(recDest);
        for (const el of els.values()) connectAudio(el);
    }
    if (actx.state === "suspended") actx.resume();
    return actx;
}

function connectAudio(el) {
    if (!actx || el.gain) return;
    el.gain = actx.createGain();
    actx.createMediaElementSource(el).connect(el.gain).connect(master);
}

function setVolume(el, v) {
    if (el.gain) el.gain.gain.value = v;
    else el.volume = Math.min(1, v);
}

// ---------- playback ----------

function syncMedia() {
    for (const c of clips.values()) {
        if (!TIMED.has(c.type)) continue;
        const el = mediaEl(c);
        if (!el) continue;
        const target = t - c.start + c.in;
        if (!isActive(c)) {
            if (!el.paused) el.pause();
            // preroll: park the next clip on its first frame so the cut doesn't stall
            if (playing && c.start > t && c.start - t < 0.6 && Math.abs(el.currentTime - c.in) > 0.05) el.currentTime = c.in;
            continue;
        }
        setVolume(el, trackOf(c)?.off ? 0 : c.volume * fade(c));
        if (playing) {
            if (el.paused) {
                if (Math.abs(el.currentTime - target) > 0.05) el.currentTime = target;
                el.play().catch(() => {});
            } else if (Math.abs(el.currentTime - target) > 0.3) {
                el.currentTime = target;
            }
        } else {
            if (!el.paused) el.pause();
            if (Math.abs(el.currentTime - target) > 0.01) el.currentTime = target;
        }
    }
}

function play() {
    if (playing) return pause();
    audioCtx();
    if (t >= duration() - 0.01) t = 0;
    playing = true;
    playFrom = t;
    playStart = performance.now();
    $("playBtn").textContent = "⏸";
    $("playBtn").ariaLabel = "Pause";
    requestAnimationFrame(tick);
}

function pause() {
    playing = false;
    $("playBtn").textContent = "▶";
    $("playBtn").ariaLabel = "Play";
    syncMedia();
    requestDraw();
    if (exporting) finishExport();
}

function tick() {
    if (!playing) return;
    t = playFrom + (performance.now() - playStart) / 1000;
    if (t >= duration()) {
        t = duration();
        movePlayhead();
        return pause();
    }
    syncMedia();
    draw();
    movePlayhead(true);
    if (Date.now() - lastPresence > 500) sendPresence(true);
    if (exporting) $("exportBar").style.width = (t / duration() * 100) + "%";
    requestAnimationFrame(tick);
}

function seek(time) {
    t = Math.max(0, Math.min(time, Math.max(duration(), 0)));
    if (playing) {
        playFrom = t;
        playStart = performance.now();
    }
    syncMedia();
    movePlayhead();
    requestDraw();
    sendPresence();
}

// ---------- preview ----------

let drawQueued = 0;
function requestDraw() {
    if (!drawQueued && !playing) drawQueued = requestAnimationFrame(() => { drawQueued = 0; draw(); });
}

// While a video seeks it has no frame to draw; show the last one instead of flashing black.
function keepFrame(el) {
    if (!el.videoWidth || el.readyState < 2) return;
    el.still ??= document.createElement("canvas");
    el.still.width = el.videoWidth;
    el.still.height = el.videoHeight;
    el.still.getContext("2d").drawImage(el, 0, 0);
}

function srcOf(c) {
    if (c.type === "image") return media.get(c.media)?.img;
    const el = mediaEl(c);
    return !el ? null : el.readyState >= 2 && !el.seeking ? el : el.still;
}

// Where a visual clip sits on the canvas: fit inside, then scaled and offset.
function clipRect(c) {
    const W = project.w, H = project.h;
    let w, h;
    if (c.type === "text") {
        pctx.font = `bold ${c.size}px system-ui, sans-serif`;
        const lines = c.text.split("\n");
        w = Math.max(...lines.map(l => pctx.measureText(l).width), 10);
        h = lines.length * c.size * 1.2;
    } else {
        const m = media.get(c.media);
        if (!m || !m.w) return null;
        const s = Math.min(W / m.w, H / m.h);
        w = m.w * s;
        h = m.h * s;
    }
    return { cx: W / 2 + c.x, cy: H / 2 + c.y, w: w * c.scale, h: h * c.scale };
}

function visibleClips(at = t) {
    const list = [];
    for (const tr of project.tracks.filter(tr => tr.kind === "video" && !tr.off).reverse()) {   // back to front
        list.push(...[...clips.values()].filter(c => c.track === tr.id && c.type !== "audio" && isActive(c, at))
            .sort((a, b) => a.start - b.start));
    }
    return list;
}

function draw() {
    const g = pctx;
    g.globalAlpha = 1;
    g.shadowBlur = 0;
    g.fillStyle = "#000";
    g.fillRect(0, 0, project.w, project.h);
    for (const c of visibleClips()) {
        const r = clipRect(c);
        if (!r) continue;
        g.globalAlpha = c.opacity * fade(c);
        if (c.type === "text") {
            g.font = `bold ${c.size * c.scale}px system-ui, sans-serif`;
            g.fillStyle = c.color;
            g.textAlign = "center";
            g.textBaseline = "middle";
            g.shadowColor = "#0009";
            g.shadowBlur = 8;
            const lines = c.text.split("\n"), lh = c.size * c.scale * 1.2;
            lines.forEach((l, i) => g.fillText(l, r.cx, r.cy + (i - (lines.length - 1) / 2) * lh));
            g.shadowBlur = 0;
        } else {
            const src = srcOf(c);
            if (src) g.drawImage(src, r.cx - r.w / 2, r.cy - r.h / 2, r.w, r.h);
        }
    }
    g.globalAlpha = 1;
    const c = clips.get(sel);
    if (!exporting && c && c.type !== "audio" && isActive(c)) {
        const r = clipRect(c);
        if (r) {
            const lw = project.w / 400;
            g.strokeStyle = "#4a9eff";
            g.lineWidth = lw;
            g.setLineDash([lw * 4, lw * 3]);
            g.strokeRect(r.cx - r.w / 2, r.cy - r.h / 2, r.w, r.h);
            g.setLineDash([]);
            g.fillStyle = "#fff";
            for (const [a, b] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
                g.fillRect(r.cx + a * r.w / 2 - lw * 4, r.cy + b * r.h / 2 - lw * 4, lw * 8, lw * 8);
            }
        }
    }
}

// Drag on the preview: move the clip, or scale it from a corner.
let pdrag = null;
canvas.addEventListener("pointerdown", e => {
    if (e.button !== 0 || exporting) return;
    const rect = canvas.getBoundingClientRect(), k = project.w / rect.width;
    const p = { x: (e.clientX - rect.left) * k, y: (e.clientY - rect.top) * k };
    const hit = c => { const r = clipRect(c); return r && Math.abs(p.x - r.cx) <= r.w / 2 && Math.abs(p.y - r.cy) <= r.h / 2; };
    let c = clips.get(sel);
    const r = c && c.type !== "audio" && isActive(c) && clipRect(c);
    const corner = r && [[-1, -1], [1, -1], [-1, 1], [1, 1]].some(([a, b]) =>
        Math.hypot(p.x - (r.cx + a * r.w / 2), p.y - (r.cy + b * r.h / 2)) < 14 * k);
    if (!corner && !(c && r && hit(c))) {
        c = visibleClips().reverse().find(hit);
        if (!c) return select(null);
        select(c.id);
    }
    canvas.setPointerCapture(e.pointerId);
    const r0 = clipRect(c);
    pdrag = { id: c.id, before: snap(), p, x: c.x, y: c.y, scale: c.scale, d0: Math.hypot(p.x - r0.cx, p.y - r0.cy) || 1, corner, k, rect };
});

canvas.addEventListener("pointermove", e => {
    if (!pdrag) return;
    const c = clips.get(pdrag.id);
    if (!c) return pdrag = null;
    const q = { x: (e.clientX - pdrag.rect.left) * pdrag.k, y: (e.clientY - pdrag.rect.top) * pdrag.k };
    if (pdrag.corner) {
        const cx = project.w / 2 + c.x, cy = project.h / 2 + c.y;
        c.scale = Math.max(0.05, pdrag.scale * Math.hypot(q.x - cx, q.y - cy) / pdrag.d0);
    } else {
        c.x = Math.round(pdrag.x + q.x - pdrag.p.x);
        c.y = Math.round(pdrag.y + q.y - pdrag.p.y);
    }
    requestDraw();
});

canvas.addEventListener("pointerup", () => endDrag(pdrag) && (pdrag = null));

function endDrag(d) {
    if (!d) return true;
    if (snap() !== d.before) {
        past.push(d.before);
        future = [];
        afterChange();
    }
    return true;
}

// ---------- timeline ----------

const laneEls = new Map(), clipEls = new Map();
let trackSig = "";

const zoomToPps = v => 5 * Math.pow(80, v / 100);         // slider 0..100 -> 5..400 px per second
const ppsToZoom = p => Math.log(p / 5) / Math.log(80) * 100;

function drawTracks() {
    const sig = JSON.stringify(project.tracks);
    if (sig === trackSig) return;
    trackSig = sig;
    const heads = $("heads"), tracks = $("tracks");
    heads.innerHTML = '<div class="rulerpad"></div>';
    for (const tr of project.tracks) {
        const h = document.createElement("div");
        h.className = "head";
        h.style.height = TRACK_H[tr.kind] + "px";
        h.innerHTML = `<span></span><button class="toggle"></button><button class="rmtrack" title="Remove empty track" aria-label="Remove track">✕</button>`;
        h.querySelector("span").textContent = tr.name;
        const tog = h.querySelector(".toggle");
        tog.textContent = tr.kind === "video" ? "👁" : "🔊";
        tog.classList.toggle("off", tr.off);
        tog.title = tog.ariaLabel = tr.kind === "video" ? (tr.off ? "Show track" : "Hide track") : (tr.off ? "Unmute track" : "Mute track");
        tog.onclick = () => change(() => project.tracks.find(x => x.id === tr.id).off = !tr.off);
        h.querySelector(".rmtrack").onclick = () => {
            if ([...clips.values()].some(c => c.track === tr.id)) return flash("Move or delete this track's clips first");
            change(() => project.tracks = project.tracks.filter(x => x.id !== tr.id));
        };
        heads.append(h);

        let lane = laneEls.get(tr.id);
        if (!lane) {
            lane = document.createElement("div");
            lane.dataset.id = tr.id;
            laneEls.set(tr.id, lane);
        }
        lane.className = "lane " + tr.kind;
        lane.style.height = TRACK_H[tr.kind] + "px";
        tracks.append(lane);                 // re-appending keeps clip elements, just reorders
    }
    for (const [id, lane] of laneEls) {
        if (!project.tracks.some(tr => tr.id === id)) {
            lane.remove();
            laneEls.delete(id);
        }
    }
}

function placeClip(c) {
    let el = clipEls.get(c.id);
    if (!el) {
        el = document.createElement("div");
        el.dataset.id = c.id;
        el.innerHTML = '<i class="h l"></i><span class="label"></span><i class="h r"></i>';
        clipEls.set(c.id, el);
    }
    const lane = laneEls.get(c.track);
    if (!lane) return el.remove();
    if (el.parentNode !== lane) lane.append(el);
    const m = media.get(c.media);
    el.className = `clip ${c.type}` + (c.id === sel ? " sel" : "") + (c.media && !m ? " missing" : "");
    el.style.left = c.start * pps + "px";
    el.style.width = Math.max(4, c.dur * pps) + "px";
    el.querySelector(".label").textContent = c.type === "text" ? "T  " + c.text.split("\n")[0] : (m ? c.name : c.name + " (waiting for media…)");
    const bg = m?.thumb ? `url(${m.thumb})` : "";
    if (el.dataset.bg !== bg) {
        el.style.backgroundImage = bg;
        el.dataset.bg = bg;
    }
    if (c.type === "audio" && m) {                 // waveform spans the whole file; show the trimmed part
        el.style.backgroundSize = `${m.duration * pps}px 100%`;
        el.style.backgroundPosition = `${-c.in * pps}px 0`;
    }
    const who = [...peers.values()].find(p => p.sel === c.id);
    el.style.outline = who ? `2px solid ${who.color}` : "";
    el.title = who ? `${who.name} has this selected` : "";
}

function drawTimeline() {
    drawTracks();
    const wrap = $("lanesWrap");
    $("lanes").style.width = Math.max(wrap.clientWidth, (duration() + 30) * pps) + "px";
    for (const c of clips.values()) placeClip(c);
    for (const [id, el] of clipEls) {
        if (clips.has(id)) continue;
        el.remove();
        clipEls.delete(id);
        const m = els.get(id);
        if (m) {
            m.pause();
            m.removeAttribute("src");
            els.delete(id);
        }
    }
    drawRuler();
    movePlayhead();
    drawPresence();
}

function drawRuler() {
    const r = $("ruler"), wrap = $("lanesWrap"), w = wrap.clientWidth, dpr = devicePixelRatio || 1;
    if (r.width !== w * dpr) {
        r.width = w * dpr;
        r.height = 24 * dpr;
        r.style.width = w + "px";
    }
    const g = r.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, 24);
    const step = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600].find(s => s * pps >= 70) || 600;
    const minor = step / 5, t0 = wrap.scrollLeft / pps, t1 = t0 + w / pps;
    g.strokeStyle = "#555";
    g.fillStyle = "#999";
    g.font = "10px system-ui, sans-serif";
    g.beginPath();
    for (let i = Math.floor(t0 / minor); i * minor <= t1; i++) {
        const s = i * minor, x = Math.round((s - t0) * pps) + 0.5, major = i % 5 === 0;
        g.moveTo(x, major ? 8 : 17);
        g.lineTo(x, 24);
        if (major) g.fillText(step < 1 ? s.toFixed(1) + "s" : fmt(s).replace(/\.00$/, ""), x + 3, 10);
    }
    g.stroke();
}

function movePlayhead(follow) {
    $("playhead").style.transform = `translateX(${t * pps}px)`;
    $("timecode").textContent = `${fmt(t)} / ${fmt(duration())}`;
    if (follow) {
        const wrap = $("lanesWrap"), x = t * pps;
        if (x > wrap.scrollLeft + wrap.clientWidth - 40 || x < wrap.scrollLeft) wrap.scrollLeft = x - 40;
    }
}

const lanesEl = $("lanes");
const timeAt = e => Math.max(0, (e.clientX - lanesEl.getBoundingClientRect().left) / pps);

// Snap to 0, the playhead and other clips' edges when within 8px.
function snapTime(s, ignore) {
    const tol = 8 / pps;
    let best = s, bestD = tol;
    const pts = [0, t];
    for (const c of clips.values()) if (c.id !== ignore) pts.push(c.start, c.start + c.dur);
    for (const p of pts) if (Math.abs(p - s) < bestD) { best = p; bestD = Math.abs(p - s); }
    return best;
}

let tdrag = null;

lanesEl.addEventListener("pointerdown", e => {
    if (e.button !== 0 || exporting) return;
    try { lanesEl.setPointerCapture(e.pointerId); } catch {}
    const el = e.target.closest(".clip");
    if (!el) {
        if (e.target !== $("ruler")) select(null);
        tdrag = { scrub: true };
        return seek(timeAt(e));
    }
    const c = clips.get(el.dataset.id);
    select(c.id);
    const mode = e.target.classList.contains("l") ? "left" : e.target.classList.contains("r") ? "right" : "move";
    tdrag = { id: c.id, mode, x0: e.clientX, orig: { ...c }, before: snap() };
    el.style.cursor = mode === "move" ? "grabbing" : "";
});

lanesEl.addEventListener("pointermove", e => {
    hoverPresence(e);
    if (!tdrag) return;
    if (tdrag.scrub) return seek(timeAt(e));
    const c = clips.get(tdrag.id);
    if (!c) return tdrag = null;
    const o = tdrag.orig, dt = (e.clientX - tdrag.x0) / pps;
    const maxLen = TIMED.has(c.type) ? (media.get(c.media)?.duration ?? Infinity) : Infinity;
    if (tdrag.mode === "move") {
        let s = Math.max(0, o.start + dt);
        const a = snapTime(s, c.id) - s, b = snapTime(s + o.dur, c.id) - (s + o.dur);
        s += Math.abs(a) <= Math.abs(b) ? (a || b) : (b || a);
        c.start = Math.max(0, s);
        const lane = document.elementFromPoint(e.clientX, e.clientY)?.closest(".lane");
        const tr = lane && project.tracks.find(x => x.id === lane.dataset.id);
        if (tr && tr.kind === kindFor(c.type)) c.track = tr.id;
    } else if (tdrag.mode === "left") {
        let d = snapTime(o.start + dt, c.id) - o.start;
        d = Math.max(d, -o.start, TIMED.has(c.type) ? -o.in : -Infinity);
        d = Math.min(d, o.dur - 0.1);
        Object.assign(c, { start: o.start + d, in: o.in + d, dur: o.dur - d });
    } else {
        const end = snapTime(o.start + o.dur + dt, c.id);
        c.dur = Math.max(0.1, Math.min(end - o.start, maxLen - o.in));
    }
    placeClip(c);
    requestDraw();
});

function endTimelineDrag() {
    const d = tdrag;
    tdrag = null;
    if (!d || d.scrub) return;
    clipEls.get(d.id)?.style.removeProperty("cursor");
    endDrag(d);
}
lanesEl.addEventListener("pointerup", endTimelineDrag);
lanesEl.addEventListener("pointercancel", endTimelineDrag);

$("lanesWrap").addEventListener("scroll", drawRuler);
addEventListener("resize", () => { drawTimeline(); requestDraw(); });

function setZoom(p, anchorX) {
    const wrap = $("lanesWrap"), x = anchorX ?? wrap.clientWidth / 2;
    const at = (wrap.scrollLeft + x) / pps;
    pps = Math.max(5, Math.min(400, p));
    $("zoom").value = ppsToZoom(pps);
    drawTimeline();
    wrap.scrollLeft = at * pps - x;
}
$("zoom").oninput = () => setZoom(zoomToPps(+$("zoom").value));
$("lanesWrap").addEventListener("wheel", e => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const d = Math.max(-50, Math.min(50, e.deltaY * (e.deltaMode === 1 ? 16 : 1)));
    setZoom(pps * Math.exp(-d * 0.004), e.clientX - $("lanesWrap").getBoundingClientRect().left);
}, { passive: false });

// Dropping media tiles or files on a track.
lanesEl.addEventListener("dragover", e => {
    e.preventDefault();
    const lane = e.target.closest(".lane");
    for (const l of laneEls.values()) l.classList.toggle("drop", l === lane);
});
lanesEl.addEventListener("dragleave", e => { if (!lanesEl.contains(e.relatedTarget)) laneEls.forEach(l => l.classList.remove("drop")); });
lanesEl.addEventListener("drop", e => {
    e.preventDefault();
    laneEls.forEach(l => l.classList.remove("drop"));
    const lane = e.target.closest(".lane"), at = { track: lane?.dataset.id, time: timeAt(e) };
    const id = e.dataTransfer.getData("text/x-motioncut-media");
    if (id && media.has(id)) addClip(media.get(id), at.track, at.time);
    else if (e.dataTransfer.files.length) importFiles([...e.dataTransfer.files], at);
});

const bin = $("bin");
bin.addEventListener("dragover", e => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); bin.classList.add("dragover"); } });
bin.addEventListener("dragleave", () => bin.classList.remove("dragover"));
bin.addEventListener("drop", e => {
    e.preventDefault();
    bin.classList.remove("dragover");
    importFiles([...e.dataTransfer.files]);
});

// ---------- editing ----------

function select(id) {
    if (sel === id) return;
    const prev = sel;
    sel = id;
    for (const i of [prev, id]) if (clips.has(i)) placeClip(clips.get(i));
    drawProps();
    requestDraw();
    sendPresence();
}

// Splits the selected clip at the playhead, or every clip under it if none is selected.
function split() {
    const targets = [...clips.values()].filter(c => (sel ? c.id === sel : true) && t > c.start + 0.05 && t < c.start + c.dur - 0.05);
    if (!targets.length) return flash("Move the playhead over a clip to split it");
    change(() => {
        for (const c of targets) {
            const cut = t - c.start;
            const b = { ...c, id: uid(), start: t, in: c.in + cut, dur: c.dur - cut, fadeIn: 0 };
            Object.assign(c, { dur: cut, fadeOut: 0 });
            clips.set(b.id, b);
        }
    });
}

function deleteSel() {
    if (!sel) return;
    const id = sel;
    sel = null;
    change(() => clips.delete(id));
}

function duplicate() {
    const c = clips.get(sel);
    if (!c) return;
    const d = { ...c, id: uid(), start: c.start + c.dur };
    change(() => clips.set(d.id, d));
    select(d.id);
}

function addTrack(kind) {
    const n = project.tracks.filter(tr => tr.kind === kind).length + 1;
    const tr = { id: uid(), kind, name: (kind === "video" ? "V" : "A") + n, off: false };
    change(() => {
        if (kind === "video") project.tracks.unshift(tr);
        else project.tracks.push(tr);
    });
}

// ---------- properties ----------

let propsFor = undefined;

function drawProps() {
    const box = $("props"), c = clips.get(sel);
    if (box.contains(document.activeElement) && propsFor === sel) return;   // don't yank a field someone is typing in
    propsFor = sel;
    if (!c) {
        box.innerHTML = `<h2>Project</h2>
            <p class="hint">Select a clip to edit it.</p>
            <ul>
                <li><kbd>Space</kbd> play / pause</li>
                <li><kbd>S</kbd> split at playhead</li>
                <li><kbd>Delete</kbd> remove clip</li>
                <li><kbd>${isMac ? "⌘" : "Ctrl+"}D</kbd> duplicate</li>
                <li><kbd>${isMac ? "⌘" : "Ctrl+"}Z</kbd> undo</li>
                <li><kbd>←</kbd> <kbd>→</kbd> step one frame</li>
                <li>Drag clip edges to trim</li>
                <li>Drag on the preview to move, corners to scale</li>
                <li>${isMac ? "⌘" : "Ctrl"} + scroll on the timeline to zoom</li>
            </ul>`;
        return;
    }
    const visual = c.type !== "audio", hasSound = TIMED.has(c.type);
    const num = (key, label, k = 1, step = 1) =>
        `<label>${label}<input type="number" data-key="${key}" data-k="${k}" step="${step}" value="${Math.round(c[key] * k * 100) / 100}"></label>`;
    box.innerHTML = `<h2>${c.type} clip</h2>
        <div class="title"></div>
        <div class="grid2">
            ${num("start", "Start (s)", 1, 0.1)}
            ${num("dur", "Length (s)", 1, 0.1)}
            ${num("fadeIn", "Fade in (s)", 1, 0.1)}
            ${num("fadeOut", "Fade out (s)", 1, 0.1)}
            ${hasSound ? num("volume", "Volume %", 100) : ""}
            ${visual ? num("opacity", "Opacity %", 100) + num("scale", "Scale %", 100) + num("x", "X") + num("y", "Y") : ""}
            ${c.type === "text" ? num("size", "Font size") + `<label>Color<input type="color" data-key="color" value="${c.color}"></label>` : ""}
        </div>
        ${c.type === "text" ? '<label>Text<textarea data-key="text"></textarea></label>' : ""}
        <button id="resetPos">Reset position & size</button>`;
    box.querySelector(".title").textContent = c.name;
    if (c.type === "text") box.querySelector("textarea").value = c.text;
    if (!visual) box.querySelector("#resetPos").remove();
    else box.querySelector("#resetPos").onclick = () => change(() => Object.assign(clips.get(c.id), { x: 0, y: 0, scale: 1 }));
    box.onchange = e => {
        const key = e.target.dataset.key, cur = clips.get(c.id);
        if (!key || !cur) return;
        change(() => {
            if (key === "text" || key === "color") return cur[key] = e.target.value;
            let v = (+e.target.value || 0) / +e.target.dataset.k;
            if (key === "dur") v = Math.max(0.1, TIMED.has(cur.type) ? Math.min(v, (media.get(cur.media)?.duration ?? Infinity) - cur.in) : v);
            if (["start", "fadeIn", "fadeOut", "volume", "opacity", "scale", "size"].includes(key)) v = Math.max(key === "scale" ? 0.01 : 0, v);
            if (key === "opacity") v = Math.min(1, v);
            if (key === "volume") v = Math.min(2, v);
            cur[key] = v;
        });
    };
}

// ---------- export ----------

async function exportVideo() {
    if (!duration()) return flash("Add some clips to the timeline first");
    if (!window.MediaRecorder) return alert("This browser can't record video.");
    const type = ["video/mp4;codecs=avc1", "video/webm;codecs=vp9,opus", "video/webm", "video/mp4"].find(x => MediaRecorder.isTypeSupported(x));
    if (!type) return alert("This browser can't record video.");
    pause();
    select(null);
    audioCtx();
    const stream = new MediaStream([...canvas.captureStream(FPS).getVideoTracks(), ...recDest.stream.getAudioTracks()]);
    const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 8_000_000 });
    const chunks = [];
    rec.ondataavailable = e => e.data.size && chunks.push(e.data);
    exporting = { rec, chunks, type, cancelled: false };
    $("exportBar").style.width = "0";
    $("exportOverlay").hidden = false;
    seek(0);
    await new Promise(r => setTimeout(r, 400));        // let the first frames seek in
    rec.start(250);
    play();
}

function finishExport(cancelled) {
    const ex = exporting;
    exporting = null;
    $("exportOverlay").hidden = true;
    if (!ex) return;
    ex.rec.onstop = () => {
        if (cancelled) return flash("Export cancelled");
        const ext = ex.type.startsWith("video/mp4") ? "mp4" : "webm";
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob(ex.chunks, { type: ex.type.split(";")[0] }));
        a.download = "motioncut." + ext;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        flash("Export finished");
    };
    ex.rec.stop();
    requestDraw();
}

$("cancelExport").onclick = () => {
    const ex = exporting;
    finishExport(true);
    if (ex) pause();
};

// ---------- autosave (IndexedDB) ----------
// The project and its media survive reloads in this browser.

const db = new Promise((ok, fail) => {
    const r = indexedDB.open("motioncut", 1);
    r.onupgradeneeded = () => {
        r.result.createObjectStore("state");
        r.result.createObjectStore("media");
    };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
});

async function idb(mode, store, fn) {
    const tx = (await db).transaction(store, mode), req = fn(tx.objectStore(store));
    return new Promise((ok, fail) => {
        tx.oncomplete = () => ok(req && req.result);
        tx.onerror = tx.onabort = () => fail(tx.error);
    });
}

let saveTimer = 0;
function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => idb("readwrite", "state", s => s.put(snap(), "current")).catch(() => flash("Couldn't autosave (storage full?)")), 800);
}

function saveMedia(m) {
    idb("readwrite", "media", s => s.put({ id: m.id, name: m.name, type: m.type, mime: m.mime, blob: m.blob }, m.id)).catch(() => {});
}

async function loadSaved() {
    try {
        for (const m of await idb("readonly", "media", s => s.getAll())) await addMedia(m).catch(() => {});
        const s = await idb("readonly", "state", st => st.get("current"));
        if (s) restore(s);
    } catch {}
    afterChange();
}

function newProject() {
    if (clips.size && !confirm("Start a new project? The current one will be cleared.")) return;
    pause();
    for (const m of media.values()) URL.revokeObjectURL(m.url);
    media.clear();
    idb("readwrite", "media", s => s.clear()).catch(() => {});
    sel = null;
    change(() => {
        project = defaultProject();
        clips = new Map();
    });
    past = [];
    seek(0);
    drawBin();
}

// ---------- multiplayer ----------
// Same model as Motionly: only changed clips / project settings are sent, the host relays
// everything and echoes structural changes back so everyone applies edits in the host's order.
// Media files are sent once to each peer as binary.
// ponytail: the whole file goes in one message; very large videos (hundreds of MB) may be slow
// or fail over some connections. Chunked transfer with progress would be the upgrade.

let net = null;                              // { peer, conns, host, code, ready }
const sent = { doc: "", clips: new Map() }; // JSON every peer already has
const peers = new Map();                     // peer id -> { name, color, t, sel, hover, els }
let applying = Promise.resolve();

function delta(all) {
    const m = { clips: {} }, doc = JSON.stringify(project);
    if (all || doc !== sent.doc) m.doc = sent.doc = doc;
    for (const c of clips.values()) {
        const j = JSON.stringify(c);
        if (all || j !== sent.clips.get(c.id)) sent.clips.set(c.id, m.clips[c.id] = j);
    }
    if (!all) {
        for (const id of [...sent.clips.keys()]) {
            if (clips.has(id)) continue;
            m.clips[id] = null;
            sent.clips.delete(id);
        }
    }
    return m;
}

function broadcast(m, except) {
    if (!net) return;
    for (const c of net.conns) if (c !== except && c.open) c.send(m);
}

function sync() {
    if (!net || !net.conns.length) return;
    const m = delta(false);
    if (m.doc || Object.keys(m.clips).length) broadcast(m);
}

async function sendMedia(m, to) {
    if (!net || !net.conns.length) return;
    const msg = { media: { id: m.id, name: m.name, type: m.type, mime: m.mime }, buf: await m.blob.arrayBuffer() };
    if (to) to.send(msg);
    else broadcast(msg);
}

function receive(m, from) {
    if (m.from) {
        if (net.host) broadcast(m, from);
        return showPresence(m);
    }
    if (m.media) {
        if (net.host) broadcast(m, from);
        applying = applying.then(() => addMedia({ ...m.media, blob: new Blob([m.buf], { type: m.media.mime }) }))
            .catch(() => flash(`Couldn't open shared media ${m.media.name}`));
        return;
    }
    if (net.host) {
        broadcast(m, from);
        if (m.doc || Object.keys(m.clips).length) from.send(m);       // echo: settles conflicting edits in host order
    }
    applying = applying.then(() => applyState(m)).catch(() => flash("Couldn't apply a change from another user"));
}

function applyState(m) {
    if (m.full) {
        clips = new Map();
        sent.clips.clear();
        past = [];
        future = [];
    }
    if (m.doc) {
        project = JSON.parse(m.doc);
        sent.doc = m.doc;
    }
    for (const [id, j] of Object.entries(m.clips)) {
        if (j === null) {
            clips.delete(id);
            sent.clips.delete(id);
        } else {
            clips.set(id, JSON.parse(j));
            sent.clips.set(id, j);
        }
    }
    if (sel && !clips.has(sel)) sel = null;
    afterChange();
    if (!playing) syncMedia();
}

function newPeer(id) {
    if (!window.Peer) {
        alert("Couldn't load the multiplayer library. Check your internet connection.");
        return null;
    }
    const peer = new Peer(id);
    peer.on("error", e => {
        alert(e.type === "peer-unavailable" ? "No session found with that code."
            : e.type === "unavailable-id" ? "That code is already in use. Try hosting again."
            : "Connection problem: " + e.message);
        leave();
    });
    return peer;
}

function hostSession() {
    const code = Array.from({ length: 6 }, () => "ABCDEFGHJKMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 31)]).join("");
    const peer = newPeer("motioncut-" + code);
    if (!peer) return;
    net = { peer, conns: [], host: true, code, ready: false };
    peer.on("open", () => { net.ready = true; showShare(); });
    peer.on("connection", c => {
        c.on("open", async () => {
            net.conns.push(c);
            for (const m of media.values()) await sendMedia(m, c);      // media first, then the timeline
            c.send({ ...delta(true), full: true });
            flash("Someone joined");
            sendPresence(true);
            showShare();
        });
        c.on("data", m => receive(m, c));
        c.on("close", () => {
            if (!net) return;
            net.conns = net.conns.filter(o => o !== c);
            const gone = { from: c.peer, gone: true };
            showPresence(gone);
            broadcast(gone);
            flash("Someone left");
            showShare();
        });
    });
    showShare();
}

function joinSession(code) {
    code = code.trim().toUpperCase();
    if (!code) return;
    if (clips.size && !confirm("Joining replaces your current project with the shared one. Continue?")) return;
    const peer = newPeer();
    if (!peer) return;
    net = { peer, conns: [], host: false, code, ready: false };
    peer.on("open", () => {
        const c = peer.connect("motioncut-" + code, { reliable: true });
        c.on("open", () => {
            net.conns.push(c);
            net.ready = true;
            flash("Joined session " + code + ". Receiving media…");
            sendPresence(true);
            showShare();
        });
        c.on("data", m => receive(m, c));
        c.on("close", () => {
            if (net) flash("Disconnected from the session");
            leave();
        });
    });
    showShare();
}

function leave() {
    if (!net) return;
    const n = net;
    net = null;
    n.peer.destroy();
    sent.doc = "";
    sent.clips.clear();
    for (const id of [...peers.keys()]) showPresence({ from: id, gone: true });
    showShare();
}

function showShare() {
    $("netOff").hidden = !!net;
    $("netOn").hidden = !net;
    $("shareBtn").classList.toggle("live", !!net && net.ready);
    if (!net) return $("shareBtn").textContent = "Share";
    const n = net.conns.length;
    $("shareBtn").textContent = !net.ready ? "Connecting…" : net.host ? `● Live · ${n + 1}` : "● Live";
    $("codeOut").textContent = net.code;
    $("netInfo").textContent = !net.ready ? "Connecting…"
        : net.host ? `${n} ${n === 1 ? "person has" : "people have"} joined. Send the code to invite others.`
        : "Connected. Edits sync live.";
}

// ---------- presence: other people's playheads, pointers and selections ----------

function colorOf(id) {
    let h = 0;
    for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return `hsl(${h} 80% 60%)`;
}

const myName = () => $("myName").value.trim() || "Guest";
let myHover = null, lastPresence = 0;

function sendPresence(force) {
    if (!net || !net.conns.length) return;
    if (!force && Date.now() - lastPresence < 50) return;
    lastPresence = Date.now();
    broadcast({ from: net.peer.id, name: myName(), t, sel, hover: myHover });
}

function hoverPresence(e) {
    const lane = e.target.closest?.(".lane");
    myHover = lane ? { time: timeAt(e), track: lane.dataset.id, y: (e.clientY - lane.getBoundingClientRect().top) / lane.offsetHeight } : null;
    sendPresence();
}
lanesEl.addEventListener("pointerleave", () => { myHover = null; sendPresence(true); });
setInterval(() => sendPresence(true), 5000);

function showPresence(m) {
    const p = peers.get(m.from);
    if (m.gone) {
        if (p) p.head.remove(), p.dot.remove();
        peers.delete(m.from);
    } else {
        const q = p || { color: colorOf(m.from), head: document.createElement("div"), dot: document.createElement("div") };
        if (!p) {
            q.head.className = "peerhead";
            q.dot.className = "peerdot";
            q.head.innerHTML = q.dot.innerHTML = "<span></span>";
            q.head.style.borderColor = q.dot.style.background = q.head.firstChild.style.background = q.dot.firstChild.style.background = q.color;
            peers.set(m.from, q);
        }
        const prevSel = q.sel;
        Object.assign(q, { name: m.name, t: m.t, sel: m.sel, hover: m.hover });
        for (const id of [prevSel, q.sel]) if (clips.has(id)) placeClip(clips.get(id));
    }
    drawPresence();
}

function drawPresence() {
    for (const p of peers.values()) {
        if (!p.head.isConnected) lanesEl.append(p.head, p.dot);
        p.head.style.left = p.t * pps + "px";
        p.head.firstChild.textContent = p.name;
        const lane = p.hover && laneEls.get(p.hover.track);
        p.dot.hidden = !lane;
        if (lane) {
            p.dot.style.left = p.hover.time * pps + "px";
            p.dot.style.top = lane.offsetTop + p.hover.y * lane.offsetHeight + "px";
            p.dot.firstChild.textContent = p.name;
        }
    }
    const box = $("people");
    box.innerHTML = "";
    for (const p of peers.values()) {
        const b = document.createElement("button");
        b.className = "person";
        b.style.borderColor = p.color;
        b.textContent = `${p.name} · ${fmt(p.t)}`;
        b.title = `Jump to where ${p.name} is`;
        b.onclick = () => {
            seek(p.t);
            if (clips.has(p.sel)) select(p.sel);
        };
        box.append(b);
    }
}

$("shareBtn").onclick = () => { showShare(); $("shareDlg").showModal(); };
$("hostBtn").onclick = hostSession;
$("joinBtn").onclick = () => joinSession($("joinCode").value);
$("joinCode").onkeydown = e => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    joinSession($("joinCode").value);
};
$("copyCodeBtn").onclick = () => navigator.clipboard.writeText(net.code).then(() => flash("Code copied"));
$("leaveBtn").onclick = leave;
addEventListener("pagehide", leave);

try { $("myName").value = localStorage.getItem("motioncut-name") || ""; } catch {}
if (!$("myName").value) $("myName").value = "Guest " + Math.floor(Math.random() * 90 + 10);
$("myName").onchange = () => {
    try { localStorage.setItem("motioncut-name", myName()); } catch {}
    sendPresence(true);
};

// ---------- wiring ----------

$("newBtn").onclick = newProject;
$("importBtn").onclick = () => $("fileInput").click();
$("fileInput").onchange = e => { importFiles([...e.target.files]); e.target.value = ""; };
$("textBtn").onclick = addText;
$("undoBtn").onclick = undo;
$("redoBtn").onclick = redo;
$("splitBtn").onclick = split;
$("dupBtn").onclick = duplicate;
$("delBtn").onclick = deleteSel;
$("exportBtn").onclick = exportVideo;
$("playBtn").onclick = play;
$("startBtn").onclick = () => seek(0);
$("backBtn").onclick = () => seek(Math.round(t * FPS - 1) / FPS);
$("fwdBtn").onclick = () => seek(Math.round(t * FPS + 1) / FPS);
$("addVideoTrack").onclick = () => addTrack("video");
$("addAudioTrack").onclick = () => addTrack("audio");
$("resolution").onchange = e => {
    const [w, h] = e.target.value.split("x").map(Number);
    change(() => Object.assign(project, { w, h }));
};

document.addEventListener("keydown", e => {
    if (document.querySelector("dialog[open]") || exporting) return;
    if (e.target.matches("input:not([type=range]):not([type=checkbox]), textarea, select")) return;
    const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
    const run = fn => { e.preventDefault(); fn(); };
    if (mod && k === "z") run(e.shiftKey ? redo : undo);
    else if (mod && k === "y") run(redo);
    else if (mod && k === "d") run(duplicate);
    else if (mod) return;
    else if (e.key === " ") run(play);
    else if (k === "s") run(split);
    else if (e.key === "Delete" || e.key === "Backspace") run(deleteSel);
    else if (e.key === "ArrowLeft") run(() => seek(Math.round(t * FPS - 1) / FPS));
    else if (e.key === "ArrowRight") run(() => seek(Math.round(t * FPS + 1) / FPS));
    else if (e.key === "Home") run(() => seek(0));
    else if (e.key === "End") run(() => seek(duration()));
    else if (e.key === "Escape") run(() => select(null));
});

setZoom(zoomToPps(+$("zoom").value));
drawBin();
loadSaved();
