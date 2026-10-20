const DESTINATIONS = [
  { id: "iab-digital", name: "IAB Digital Video", market: "Global · in-stream" },
  { id: "amazon-prime-video", name: "Amazon Prime Video", market: "UK · CTV" },
  { id: "clearcast-uk", name: "Clearcast UK", market: "UK · broadcast" },
];
const FIXTURES = [
  ["ad_pass", "Clean spot"],
  ["ad_short_disclaimer", "Short disclaimer"],
  ["ad_unsafe_area", "Disclaimer off-safe"],
  ["ad_small_disclaimer", "Small disclaimer"],
  ["ad_claim_no_logo", "Claims, no logo"],
  ["ad_broadcast_slate", "Broadcast slate"],
];
// Runs recorded with the local server (v3/recorded/<id>.json), replayed through the same engine without a server.
const RECORDED_REAL = [
  ["real_afn_2026", "Navy-Marine Corps Relief Society, 2026 · 60 s"],
  ["real_ca_covid_2020", "California COVID-19 PSA, 2020 · 30 s"],
];
const RECORDED_TEST = FIXTURES;
const LAYERS = ["technical", "brand", "editorial", "rights"];
const LAYER_NAMES = { technical: "Technical", brand: "Brand", editorial: "Editorial", rights: "Rights" };

const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]));
const pill = (s) => `<span class="pill ${s === "N/A" ? "NA" : s}">${s === "NOT_EVALUATED" ? "NOT EVALUATED" : s}</span>`;

let file = null, truth = null, verdict = null, selected = "clearcast-uk";

const rulesReady = (async () => {
  const get = async (url) => { const r = await fetch(url); if (!r.ok) throw new Error(`Could not load ${url}`); return r.json(); };
  const brand = (await get("/v3/rules/content/brand-northlight.json")).rules;
  const destinations = await Promise.all(DESTINATIONS.map(async (d) => ({
    ...d,
    technical: (await get(`/rules/${d.id}.json`)).rules,
    editorial: (await get(`/v3/rules/content/editorial-${d.id}.json`)).rules,
  })));
  return { brand, destinations };
})();

// ---------- metadata (same extraction as v1, runs in the browser) ----------
const asText = (v) => (v === undefined || v === null ? "" : String(v));
const asNumber = (v) => { const n = Number.parseFloat(asText(v).replaceAll(" ", "")); return Number.isFinite(n) ? n : null; };
const asInt = (v) => { const n = asNumber(v); return n === null ? null : Math.round(n); };
const fmtName = (t) => `${asText(t?.Format)} ${asText(t?.Format_Profile)} ${asText(t?.CodecID)} ${asText(t?.CommercialName)}`.toLowerCase();

function toAsset(f, output) {
  const tracks = output?.media?.track || [];
  const general = tracks.find((t) => t["@type"] === "General");
  const video = tracks.find((t) => t["@type"] === "Video");
  const audio = tracks.find((t) => t["@type"] === "Audio");
  if (!video) throw new Error("No video stream was found in this file.");
  const w = asInt(video.Width), h = asInt(video.Height);
  const vname = fmtName(video), aname = fmtName(audio), gname = fmtName(general);
  const mode = asText(video.FrameRate_Mode).toLowerCase(), scan = asText(video.ScanType).toLowerCase();
  const chroma = asText(video.ChromaSubsampling), depth = asInt(video.BitDepth);
  const colour = `${asText(video.colour_primaries)} ${asText(video.MatrixCoefficients)}`.toLowerCase();
  return {
    filename: f.name, file_size: f.size,
    container: gname.includes("mxf") || f.name.toLowerCase().endsWith(".mxf") ? "mxf" : gname.includes("mpeg-4") || f.name.toLowerCase().endsWith(".mp4") ? "mp4" : asText(general?.Format).toLowerCase(),
    video_codec: vname.includes("avc") ? "h264" : vname.includes("mpeg video") ? "mpeg2video" : vname.includes("hevc") ? "hevc" : asText(video.Format).toLowerCase(),
    width: w, height: h, resolution: w && h ? `${w}x${h}` : null, aspect_ratio: w && h ? Number((w / h).toFixed(4)) : null,
    frame_rate: asNumber(video.FrameRate),
    frame_rate_mode: mode.includes("constant") || mode === "cfr" ? "constant" : mode.includes("variable") || mode === "vfr" ? "variable" : null,
    scan_type: scan.includes("progressive") ? "progressive" : scan.includes("interlaced") ? "interlaced" : scan ? scan : "progressive",
    video_bitrate: asInt(video.BitRate), duration: asNumber(video.Duration) ?? asNumber(general?.Duration),
    audio_codec: !audio ? null : aname.includes("aac") ? "aac" : aname.includes("pcm") ? ((asInt(audio.BitDepth) || 16) >= 24 ? "pcm_s24le" : "pcm_s16le") : asText(audio.Format).toLowerCase(),
    audio_bitrate: asInt(audio?.BitRate), audio_sample_rate: asInt(audio?.SamplingRate), audio_channels: asInt(audio?.Channels),
    pixel_format: chroma.includes("4:2:2") ? "yuv422p" : chroma.includes("4:2:0") ? (depth > 8 ? `yuv420p${depth}le` : "yuv420p") : null,
    colour_space: colour.includes("709") ? "bt709" : null,
    operational_pattern: gname.includes("op-1a") || gname.includes("op1a") ? "op1a" : null,
    start_timecode: tracks.map((t) => t.TimeCode_FirstFrame || t.TimeCode_FirstFrame_String).find(Boolean) || null,
    bits_per_sample: asInt(audio?.BitDepth), integrated_loudness: null, true_peak: null,
  };
}

async function inspect(f) {
  if (!window.MediaInfo?.default) throw new Error("The metadata parser could not load. Check the connection and try again.");
  const mi = await window.MediaInfo.default({ format: "object", chunkSize: 1048576 });
  try {
    const out = await mi.analyzeData(f.size, async (size, offset) => new Uint8Array(await f.slice(offset, offset + size).arrayBuffer()));
    return toAsset(f, out);
  } finally { mi.close(); }
}

// ---------- flow ----------
function step(name, state) {
  document.querySelectorAll("#steps li").forEach((li) => {
    if (li.dataset.step === name) li.className = state;
  });
}

function choose(f, fixtureTruth = null) {
  file = f; truth = fixtureTruth;
  $("file-name").textContent = f.name;
  $("file-meta").textContent = `${(f.size / 1048576).toFixed(1)} MB`;
  $("error").hidden = true;
}

async function run() {
  if (!file) { $("file").click(); return; }
  $("run").disabled = true; $("error").hidden = true; $("steps").hidden = false;
  document.querySelectorAll("#steps li").forEach((li) => (li.className = ""));
  try {
    step("meta", "doing");
    const asset = await inspect(file);
    step("meta", "done"); step("server", "doing");
    const form = new FormData(); form.append("file", file);
    let analysis;
    try {
      const res = await fetch("/api/v3/analyze", { method: "POST", body: form });
      if (!res.ok) throw new Error(String(res.status));
      analysis = await res.json();
    } catch {
      // Static hosting (e.g. Netlify) has no analysis server: keep the metadata checks, say what is missing.
      analysis = { signal: null, content: { error: "analysis server not running on this host. Run server.py locally for loudness, black and content checks" } };
    }
    step("server", "done"); step("rules", "doing");
    const { brand, destinations } = await rulesReady;
    const declared = { brand: $("brand").value || null, category: $("category").value || null };
    verdict = Engine.verify({ asset, analysis, destinations, brand, activeDuration: Number($("active").value) || null, declared });
    verdict.analysis = analysis;
    step("rules", "done");
    render();
  } catch (e) {
    $("error").textContent = e.message; $("error").hidden = false;
  } finally { $("run").disabled = false; }
}

// ---------- render ----------
function timeline() {
  const dur = verdict.asset.duration || 1;
  const pct = (s) => `${Math.max(0, Math.min(100, (s / dur) * 100))}%`;
  const seg = (d, cls, label, color) =>
    `<div class="seg ${cls}" title="${esc(label)}" style="STYLE_SLOT left:${pct(d.start)};width:calc(${pct(d.end - d.start)} + 2px);${color ? `background:${color}` : ""}">${esc(label)}</div>`.replace("STYLE_SLOT ", "");
  // v2 drew only these four types, so subtitles, captions and other text the model found were invisible.
  const types = ["slate", "disclaimer", "logo", "claim", "super", "other_text"];
  const lane = (label, items, rows = 1) => `<div class="track"><div class="track-label">${label}</div><div class="lane" style="height:${rows * 24 + 2}px">${items}</div></div>`;
  // Overlapping items (a disclaimer on a slate) get their own row instead of hiding each other.
  const stacked = (items, labelOf) => {
    const ends = [];
    const html = [...items].sort((a, b) => a.start - b.start).map((d) => {
      let row = ends.findIndex((e) => e <= d.start + 0.01);
      if (row === -1) { row = ends.length; ends.push(0); }
      ends[row] = d.end;
      return seg(d, "", labelOf(d), color(d.type)).replace('style="', `style="top:${row * 24 + 3}px;bottom:auto;height:20px;`);
    }).join("");
    return [html, Math.max(1, ends.length)];
  };
  const color = (t) => `var(--c-${t})`;
  const det = verdict.detections.filter((d) => types.includes(d.type));
  let html = lane("Model detected", ...stacked(det, (d) => `${d.type}: ${d.text}${d.merged_from ? ` (joined from ${d.merged_from})` : ""}`));
  if (truth) {
    html += lane("Ground truth", ...stacked(truth.objects.filter((o) => types.includes(o.type)), (o) => `${o.type}${o.text ? ": " + o.text : ""}`));
  }
  const black = verdict.analysis.signal?.black_segments || [];
  html += lane("Signal: black", black.map((b) => seg(b, "black", "black")).join(""));
  html += lane("Commercial", seg({ start: verdict.content.seconds, end: dur }, "content", `content from ${verdict.content.seconds.toFixed(2)}s`));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => `<span>${(f * dur).toFixed(0)}s</span>`).join("");
  html += `<div class="axis"><span></span><div>${ticks}</div></div>`;
  html += `<div class="legend">${types.map((t) => `<span><i style="background:${color(t)}"></i>${t.replace("_", " ")}</span>`).join("")}<span><i style="background:#111"></i>black (measured)</span></div>`;
  $("timeline").innerHTML = html;
}

function value(v) {
  if (v === null || v === undefined || v === "") return "Unavailable";
  if (Array.isArray(v)) return v.join(" · ");
  return String(v);
}

function detail() {
  const r = verdict.results.find((x) => x.id === selected);
  let html = `<div class="result-head"><div><p class="eyebrow">Selected destination</p><h2>${esc(r.name)}</h2><p class="muted">${esc(r.market)}</p></div>${pill(r.overall)}</div>`;
  const rank = { FIX: 0, REVIEW: 1, WARN: 2, PASS: 3, "N/A": 4 };
  const d = verdict.declared;
  html += `<p class="muted">Declared: ${d.brand ? `brand ${esc(d.brand)}` : "no brand"}, ${d.category ? `category ${esc(d.category)}` : "category other"}. Rules for other brands or categories are N/A.</p>`;
  // On a tie, content layers first: they are what v2 adds.
  for (const layer of ["editorial", "brand", "technical", "rights"].sort((a, b) => rank[r.status[a]] - rank[r.status[b]])) {
    const checks = r.layers[layer];
    html += `<div class="layer"><h3>${LAYER_NAMES[layer]} ${pill(r.status[layer])}</h3>`;
    if (!checks.length) {
      html += `<p class="muted">Not evaluated. Rights are not in the video: this layer needs the usage-rights record held against the asset (territory, channel, window).</p></div>`;
      continue;
    }
    // Failures and reviews first: the person reading this wants what needs action.
    const order = { FAIL: 0, REVIEW: 1, NOT_EVALUATED: 2, PASS: 3, "N/A": 4 };
    for (const c of [...checks].sort((a, b) => order[a.result] - order[b.result])) {
      const conf = c.evidence?.length ? ` · confidence ${Math.min(...c.evidence.map((e) => e.confidence)).toFixed(2)}` : "";
      const methods = [...new Set((c.evidence || []).filter((e) => e.box_method).map((e) => e.box_method))];
      html += `<div class="check"><div>${pill(c.result)}</div><div>
        <div class="what">${esc(c.label.replaceAll("_", " "))}</div>
        <p>${esc(c.explanation || "")}</p>
        <div class="vals"><span>Detected <b>${esc(value(c.detected))}</b></span><span>Expected <b>${esc(value(c.expected))}</b></span></div>
        ${c.basis ? `<p>Content start: ${esc(c.basis)}</p>` : ""}
        <div class="meta"><span class="tag">${esc(c.origin)}${c.origin === "Model detection" ? esc(conf) : ""}</span>
          ${c.label === "inside_safe_area" && methods.length ? `<span class="tag">Position: ${esc(methods.join(", "))}</span>` : ""}
          ${c.illustrative ? `<span class="tag ill">Illustrative rule</span>` : c.source_url ? `<a href="${esc(c.source_url)}" target="_blank" rel="noreferrer">${esc(c.source)} · ${esc(c.version)}</a>` : `<span>${esc(c.source || "")}</span>`}
        </div></div></div>`;
    }
    html += `</div>`;
  }
  $("detail").innerHTML = html;
}

function render() {
  const a = verdict.asset, an = verdict.analysis, c = an.content || {};
  $("results").hidden = false;
  $("asset-title").textContent = a.filename;
  $("asset-sub").textContent = [a.container?.toUpperCase(), a.resolution, a.frame_rate && `${a.frame_rate} fps`, a.duration && `${a.duration.toFixed(2)} s`,
    an.signal?.integrated_loudness != null && `${an.signal.integrated_loudness} LUFS`, an.signal?.true_peak != null && `${an.signal.true_peak} dBTP`].filter(Boolean).join(" · ");
  const rec = verdict.recorded;
  $("origin").classList.toggle("replay", Boolean(rec));
  $("origin").textContent = rec ? `Recorded ${fmtDate(rec.recorded_at)} with the local server, replayed here · OCR + ${c.model} on ${c.frames ?? "?"} frames + ${c.transcribe_model || "transcript"}`
    : c.error ? `Content analysis unavailable: ${c.error}`
    : `${an.cached ? "Cached result from " + an.analysed_at.replace("T", " ").replace("+00:00", " UTC") : "Live analysis"} · OCR + ${c.model} on ${c.frames ?? "?"} frames + ${c.transcribe_model || "transcript"}`;
  $("recorded-info").hidden = !rec;
  $("recorded-info").innerHTML = !rec ? "" : `${rec.preview ? `<img src="/v3/recorded/${esc(rec.preview)}" alt="Frame at ${esc(rec.preview_at)} s of ${esc(rec.title)}">` : ""}<div>
    <p><b>${esc(rec.title)}</b>${rec.by ? ` · ${esc(rec.by)}` : ""}</p>
    <p>${esc(rec.licence)}.${rec.source_url ? ` <a href="${esc(rec.source_url)}" target="_blank" rel="noreferrer">Source</a>` : ""}${rec.note ? ` ${esc(rec.note)}` : ""}</p>
    <p>Recorded ${esc(fmtDate(rec.recorded_at))} with the local server (${esc(rec.pipeline)}). The measurements and detections are that run's; the rules and verdicts are computed now, in this browser.</p>
    <p>Declared: ${verdict.declared.brand ? `brand ${esc(verdict.declared.brand)}` : "no brand"}, ${verdict.declared.category ? `category ${esc(verdict.declared.category)}` : "category other"} · commercial length ${esc(rec.activeDuration)} s · file SHA-256 ${esc(rec.sha256.slice(0, 12))}…</p>
  </div>`;
  $("content-basis").innerHTML = `<b>Commercial starts at ${verdict.content.seconds.toFixed(2)}s.</b> Basis: ${esc(verdict.content.basis)}.`;
  timeline();
  $("rows").innerHTML = verdict.results.map((r) => `<tr class="row ${r.id === selected ? "sel" : ""}" data-id="${r.id}">
    <td class="dest"><b>${esc(r.name)}</b><span>${esc(r.market)}</span></td>
    ${LAYERS.map((l) => `<td>${pill(r.status[l])}</td>`).join("")}
    <td>${pill(r.overall)}</td></tr>`).join("");
  document.querySelectorAll("tr.row").forEach((tr) => tr.addEventListener("click", () => { selected = tr.dataset.id; render(); }));
  detail();
}

// ---------- recorded runs ----------
const fmtDate = (iso) => String(iso || "").replace("T", " ").replace(/:\d\d\+00:00$/, " UTC");

async function replay(id) {
  $("error").hidden = true; $("steps").hidden = true;
  try {
    const res = await fetch(`/v3/recorded/${id}.json`);
    if (!res.ok) throw new Error(`Could not load the recorded run for ${id}.`);
    const rec = await res.json();
    const t = rec.meta.truth ? await fetch(rec.meta.truth).then((r) => (r.ok ? r.json() : null)).catch(() => null) : null;
    const { brand, destinations } = await rulesReady;
    // Mirror the form so the page shows what this run was judged with.
    $("active").value = rec.activeDuration ?? "";
    $("brand").value = rec.declared.brand || ""; $("category").value = rec.declared.category || "";
    $("file-name").textContent = `${rec.asset.filename} (recorded run)`;
    $("file-meta").textContent = `${(rec.asset.file_size / 1048576).toFixed(1)} MB · not uploaded`;
    file = null; truth = t;
    verdict = Engine.verify({ asset: rec.asset, analysis: rec.analysis, destinations, brand, activeDuration: rec.activeDuration, declared: rec.declared });
    verdict.analysis = rec.analysis;
    verdict.recorded = { ...rec.meta, activeDuration: rec.activeDuration };
    render();
  } catch (e) {
    $("error").textContent = e.message; $("error").hidden = false;
  }
}

function recordedButtons(el, list) {
  $(el).innerHTML = list.map(([id, label]) => `<button type="button" data-id="${id}">${esc(label)}</button>`).join("");
}
recordedButtons("recorded-real", RECORDED_REAL);
recordedButtons("recorded-test", RECORDED_TEST);
document.querySelectorAll(".recorded button").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll("#fixtures button, .recorded button").forEach((x) => x.classList.toggle("on", x === b));
  replay(b.dataset.id);
}));

// ---------- wiring ----------
$("fixtures").innerHTML = FIXTURES.map(([id, label]) => `<button type="button" data-id="${id}">${label}</button>`).join("");
document.querySelectorAll("#fixtures button").forEach((b) => b.addEventListener("click", async () => {
  document.querySelectorAll("#fixtures button, .recorded button").forEach((x) => x.classList.toggle("on", x === b));
  const id = b.dataset.id;
  const video = await fetch(`/fixtures/${id}.mp4`);
  if (!video.ok) { $("error").textContent = "Test ads are generated locally (python3 tools/make_fixtures.py) and are not published with the site."; $("error").hidden = false; return; }
  const [blob, t] = await Promise.all([video.blob(), fetch(`/fixtures/${id}.truth.json`).then((r) => r.json())]);
  $("active").value = 30;
  // The test ads are Northlight beer ads, so the brand and alcohol rules cover them.
  $("brand").value = "northlight"; $("category").value = "alcohol";
  choose(new File([blob], `${id}.mp4`, { type: "video/mp4" }), t);
  run();
}));
$("drop").addEventListener("click", (e) => { if (!e.target.closest("button,input,label")) $("file").click(); });
$("run").addEventListener("click", run);
$("file").addEventListener("change", (e) => { const f = e.target.files?.[0]; if (f) { document.querySelectorAll("#fixtures button, .recorded button").forEach((x) => x.classList.remove("on")); choose(f); } });
$("drop").addEventListener("dragover", (e) => { e.preventDefault(); $("drop").classList.add("dragging"); });
$("drop").addEventListener("dragleave", () => $("drop").classList.remove("dragging"));
$("drop").addEventListener("drop", (e) => { e.preventDefault(); $("drop").classList.remove("dragging"); const f = e.dataTransfer.files?.[0]; if (f) choose(f); });
