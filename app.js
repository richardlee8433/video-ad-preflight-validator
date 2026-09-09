const RULE_FILES = [
  ["iab-digital", "IAB Digital Video", "Global", "/rules/iab-digital.json"],
  ["amazon-prime-video", "Amazon Prime Video", "UK", "/rules/amazon-prime-video.json"],
  ["clearcast-uk", "Clearcast UK", "UK", "/rules/clearcast-uk.json"],
];

const demoAssets = {
  digital: { filename:"city_digital.mp4",file_size:61300000,container:"mp4",video_codec:"h264",width:1920,height:1080,resolution:"1920x1080",aspect_ratio:1.7778,frame_rate:25,frame_rate_mode:"constant",scan_type:"progressive",video_bitrate:16000000,duration:30,audio_codec:"aac",audio_bitrate:192000,audio_sample_rate:48000,audio_channels:2,pixel_format:"yuv420p",colour_space:"bt709",operational_pattern:null,start_timecode:null,bits_per_sample:null,integrated_loudness:-23.2,true_peak:-2.1 },
  audio: { filename:"city_amazon_audio_fail.mp4",file_size:61300000,container:"mp4",video_codec:"h264",width:1920,height:1080,resolution:"1920x1080",aspect_ratio:1.7778,frame_rate:25,frame_rate_mode:"constant",scan_type:"progressive",video_bitrate:16000000,duration:30,audio_codec:"aac",audio_bitrate:160000,audio_sample_rate:48000,audio_channels:2,pixel_format:"yuv420p",colour_space:"bt709",operational_pattern:null,start_timecode:null,bits_per_sample:null,integrated_loudness:-23.2,true_peak:-2.1 },
  broadcast: { filename:"city_broadcast.mxf",file_size:302100000,container:"mxf",video_codec:"mpeg2video",width:1920,height:1080,resolution:"1920x1080",aspect_ratio:1.7778,frame_rate:25,frame_rate_mode:"constant",scan_type:"interlaced",video_bitrate:50000000,duration:45,audio_codec:"pcm_s24le",audio_bitrate:2304000,audio_sample_rate:48000,audio_channels:2,pixel_format:"yuv422p",colour_space:"bt709",operational_pattern:"op1a",start_timecode:"09:59:50:00",bits_per_sample:24,integrated_loudness:-23,true_peak:-2 },
};

let selectedFile = null;
let currentResult = null;
let selectedProfile = "iab-digital";
const rulesPromise = Promise.all(RULE_FILES.map(async ([id,name,market,url]) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load ${name} rules.`);
  const body = await response.json();
  return { id, name, market, rules: body.rules };
}));

const $ = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[char]));
const cssStatus = (status) => status === "PASS" ? "status-pass" : status === "WARNING" ? "status-warning" : "status-fail";
const statusIcon = (status) => status === "PASS" ? "✓" : status === "WARNING" ? "△" : "×";

function humanValue(attribute, value) {
  if (value === null || value === undefined || value === "") return "Unavailable";
  if (Array.isArray(value)) return value.map((item) => humanValue(attribute, item)).join(" · ");
  if (typeof value === "number") {
    const format = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 3 });
    if (attribute.includes("bitrate")) return `${format.format(value / 1000)} kbps`;
    if (attribute === "file_size") return `${format.format(value / 1024 / 1024)} MB`;
    if (attribute === "duration" || attribute === "delivery_packaging") return `${format.format(value)} sec`;
    if (attribute === "audio_sample_rate") return `${format.format(value / 1000)} kHz`;
    if (attribute === "frame_rate") return `${format.format(value)} fps`;
    if (attribute === "integrated_loudness") return `${format.format(value)} LUFS`;
    if (attribute === "true_peak") return `${format.format(value)} dBTP`;
    return format.format(value);
  }
  return String(value).replaceAll("_", " ");
}

function compare(actual, operator, expected) {
  if (operator === "==") return actual === expected;
  if (operator === "!=") return actual !== expected;
  if (operator === "in") return Array.isArray(expected) && expected.includes(actual);
  if (typeof actual !== "number") return false;
  if (operator === ">=") return actual >= Number(expected);
  if (operator === "<=") return actual <= Number(expected);
  if (operator === ">") return actual > Number(expected);
  if (operator === "<") return actual < Number(expected);
  if (operator === "between") return Array.isArray(expected) && actual >= Number(expected[0]) && actual <= Number(expected[1]);
  if (operator === "approx") return Array.isArray(expected) && Math.abs(actual - Number(expected[0])) <= Number(expected[1]);
  return false;
}

function validateProfile(profile, asset, activeDuration) {
  const checks = profile.rules.map((rule) => {
    let actual = asset[rule.attribute];
    if (rule.operator === "duration_offset_in") actual = asset.duration != null && activeDuration != null ? Number((asset.duration - activeDuration).toFixed(3)) : null;
    let outcome = "NOT_EVALUATED";
    if (actual !== null && actual !== undefined) {
      const passed = rule.operator === "duration_offset_in" ? Array.isArray(rule.value) && rule.value.includes(actual) : compare(actual, rule.operator, rule.value);
      outcome = passed ? "PASS" : "FAIL";
    }
    return { attribute:rule.attribute,detected_value:actual,expected_value:rule.value,result:outcome,severity:rule.severity,rule_id:rule.id,source:rule.source,source_url:rule.source_url,version:rule.version,explanation:rule.explanation };
  });
  const errors = checks.filter((check) => check.result === "FAIL" && check.severity === "error").length;
  const warnings = checks.filter((check) => check.result === "FAIL" && check.severity === "warning").length;
  return { ...profile, checks, errors, warnings, passed:checks.filter((check)=>check.result==="PASS").length, not_evaluated:checks.filter((check)=>check.result==="NOT_EVALUATED").length, status:errors ? "FAIL" : warnings ? "WARNING" : "PASS" };
}

async function buildResult(asset) {
  const profiles = await rulesPromise;
  const durationText = $("active-duration").value;
  const activeDuration = durationText ? Number(durationText) : null;
  const results = profiles.map((profile) => validateProfile(profile, asset, activeDuration));
  return { asset, profiles:results, ready_count:results.filter((profile)=>profile.status!=="FAIL").length, profile_count:results.length, not_evaluated:["Integrated loudness and true peak require signal analysis","Rights clearance","Brand safety","Editorial approval"] };
}

function render(result) {
  currentResult = result;
  const profile = result.profiles.find((item) => item.id === selectedProfile) || result.profiles[0];
  selectedProfile = profile.id;
  $("ready-count").textContent = result.ready_count;
  $("asset-name").textContent = result.asset.filename;
  $("profile-grid").innerHTML = result.profiles.map((item) => `<button type="button" role="tab" aria-selected="${item.id===selectedProfile}" data-profile="${item.id}" class="profile-card ${cssStatus(item.status)} ${item.id===selectedProfile?"selected":""}"><span class="profile-status">${statusIcon(item.status)} ${item.status}</span><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.market)} · ${item.errors} errors · ${item.warnings} warnings</small></button>`).join("");
  $("profile-grid").querySelectorAll("[data-profile]").forEach((button) => button.addEventListener("click", () => { selectedProfile=button.dataset.profile; render(currentResult); }));
  const metadata = [["Container",result.asset.container],["Video",result.asset.video_codec],["Resolution",result.asset.resolution],["Frame rate",result.asset.frame_rate?`${result.asset.frame_rate} fps`:null],["Scan",result.asset.scan_type],["Audio",result.asset.audio_codec]];
  $("metadata-strip").innerHTML = metadata.map(([label,value]) => `<div><span>${label}</span><strong>${escapeHtml(value ?? "—")}</strong></div>`).join("");
  $("detail-name").textContent = profile.name;
  $("detail-status").className = `large-status ${cssStatus(profile.status)}`;
  $("detail-status").textContent = `${statusIcon(profile.status)} ${profile.status}`;
  $("check-list").innerHTML = profile.checks.map((check) => {
    const rowClass = check.result.toLowerCase().replace("_","-");
    const icon = check.result === "PASS" ? "✓" : check.result === "NOT_EVALUATED" ? "?" : check.severity === "warning" ? "△" : "×";
    return `<article class="check-row check-${rowClass}"><div class="check-icon">${icon}</div><div class="check-copy"><div class="check-title"><h3>${escapeHtml(check.attribute.replaceAll("_"," "))}</h3><span>${escapeHtml(check.result.replaceAll("_"," "))}</span></div><p>${escapeHtml(check.explanation)}</p><div class="values"><span>Detected <strong>${escapeHtml(humanValue(check.attribute,check.detected_value))}</strong></span><span>Expected <strong>${escapeHtml(humanValue(check.attribute,check.expected_value))}</strong></span></div><a href="${escapeHtml(check.source_url)}" target="_blank" rel="noreferrer">${escapeHtml(check.source)} · ${escapeHtml(check.version)}</a></div></article>`;
  }).join("");
  $("not-evaluated").innerHTML = result.not_evaluated.map((item) => `<li><span aria-hidden="true">?</span>${escapeHtml(item)}</li>`).join("");
}

function asText(value) { return value === undefined || value === null ? "" : String(value); }
function asNumber(value) { const parsed=Number.parseFloat(asText(value).replaceAll(" ","")); return Number.isFinite(parsed)?parsed:null; }
function asInteger(value) { const parsed=asNumber(value); return parsed===null?null:Math.round(parsed); }
function formatName(track) { return `${asText(track?.Format)} ${asText(track?.Format_Profile)} ${asText(track?.CodecID)} ${asText(track?.CommercialName)}`.toLowerCase(); }
function containerOf(track,filename) { const value=formatName(track); if(value.includes("mxf")||filename.toLowerCase().endsWith(".mxf"))return"mxf"; if(value.includes("mpeg-4")||value.includes("isom")||filename.toLowerCase().endsWith(".mp4"))return"mp4"; return asText(track?.Format).toLowerCase()||null; }
function videoCodecOf(track) { const value=formatName(track); if(value.includes("avc")||value.includes("h.264")||value.includes("avc1"))return"h264"; if(value.includes("mpeg video")&&(value.includes("version 2")||value.includes("mpeg-2")))return"mpeg2video"; if(value.includes("mpeg-4 visual"))return"mpeg4"; if(value.includes("hevc")||value.includes("h.265"))return"hevc"; return asText(track?.Format).toLowerCase()||null; }
function audioCodecOf(track) { if(!track)return null; const value=formatName(track); if(value.includes("aac"))return"aac"; if(value.includes("pcm"))return(asInteger(track.BitDepth)||16)>=24?"pcm_s24le":"pcm_s16le"; return asText(track.Format).toLowerCase()||null; }
function pixelFormatOf(track) { const chroma=asText(track?.ChromaSubsampling); const depth=asInteger(track?.BitDepth); if(chroma.includes("4:2:2"))return depth>8?`yuv422p${depth}le`:"yuv422p"; if(chroma.includes("4:2:0"))return depth>8?`yuv420p${depth}le`:"yuv420p"; return null; }
function colourSpaceOf(track) { const value=`${asText(track?.colour_primaries)} ${asText(track?.MatrixCoefficients)} ${asText(track?.ColorSpace)}`.toLowerCase(); return value.includes("709")?"bt709":value.trim()||null; }

function toAsset(file, output) {
  const tracks=output?.media?.track||[];
  const general=tracks.find((track)=>track["@type"]==="General");
  const video=tracks.find((track)=>track["@type"]==="Video");
  const audio=tracks.find((track)=>track["@type"]==="Audio");
  if(!video)throw new Error("No video stream was found in this file.");
  const width=asInteger(video.Width),height=asInteger(video.Height),mode=asText(video.FrameRate_Mode).toLowerCase(),scan=asText(video.ScanType).toLowerCase(),op=formatName(general);
  const timecode=tracks.map((track)=>track.TimeCode_FirstFrame||track.TimeCode_FirstFrame_String||track.TimeCode).find(Boolean)||null;
  return { filename:file.name,file_size:file.size,container:containerOf(general,file.name),video_codec:videoCodecOf(video),width,height,resolution:width&&height?`${width}x${height}`:null,aspect_ratio:width&&height?Number((width/height).toFixed(4)):null,frame_rate:asNumber(video.FrameRate),frame_rate_mode:mode.includes("constant")||mode==="cfr"?"constant":mode.includes("variable")||mode==="vfr"?"variable":null,scan_type:scan.includes("progressive")?"progressive":scan.includes("interlaced")?"interlaced":null,video_bitrate:asInteger(video.BitRate),duration:asNumber(video.Duration)??asNumber(general?.Duration),audio_codec:audioCodecOf(audio),audio_bitrate:asInteger(audio?.BitRate),audio_sample_rate:asInteger(audio?.SamplingRate),audio_channels:asInteger(audio?.Channels),pixel_format:pixelFormatOf(video),colour_space:colourSpaceOf(video),operational_pattern:op.includes("op-1a")||op.includes("op1a")?"op1a":null,start_timecode:timecode,bits_per_sample:asInteger(audio?.BitDepth),integrated_loudness:null,true_peak:null };
}

async function inspectFile(file) {
  if(!window.MediaInfo?.default) throw new Error("The local media parser could not load. Check your connection and try again.");
  const mediaInfo=await new Promise((resolve,reject)=>{ const promise=window.MediaInfo.default({format:"object",chunkSize:1048576},resolve,reject); if(promise?.then)promise.then(resolve,reject); });
  try { const output=await mediaInfo.analyzeData(file.size,async(chunkSize,offset)=>new Uint8Array(await file.slice(offset,offset+chunkSize).arrayBuffer())); return toAsset(file,output); }
  finally { mediaInfo.close(); }
}

function showError(message) { $("error").textContent=message; $("error").hidden=false; }
function clearError() { $("error").hidden=true; $("error").textContent=""; }
function clearComplete() { $("complete").hidden=true; }
function acceptFile(file) {
  if(!file)return;
  const suffix=file.name.split(".").pop()?.toLowerCase();
  if(!["mp4","mxf"].includes(suffix)){showError("Choose an MP4 or MXF file.");return;}
  selectedFile=file; clearError(); clearComplete();
  $("file-name").textContent=file.name;
  $("file-meta").textContent=`${(file.size/1024/1024).toFixed(2)} MB · ready to inspect locally`;
  $("choose-file").textContent="Replace file";
  document.querySelectorAll(".fixture").forEach((button)=>button.classList.remove("active"));
}

$("choose-file").addEventListener("click",(event)=>{event.stopPropagation();$("file-input").click();});
$("drop-zone").addEventListener("click",()=>$("file-input").click());
$("drop-zone").addEventListener("keydown",(event)=>{if(event.key==="Enter"||event.key===" "){$("file-input").click();event.preventDefault();}});
$("file-input").addEventListener("change",(event)=>acceptFile(event.target.files?.[0]));
$("drop-zone").addEventListener("dragover",(event)=>{event.preventDefault();$("drop-zone").classList.add("is-dragging");});
$("drop-zone").addEventListener("dragleave",()=>$("drop-zone").classList.remove("is-dragging"));
$("drop-zone").addEventListener("drop",(event)=>{event.preventDefault();$("drop-zone").classList.remove("is-dragging");acceptFile(event.dataTransfer.files?.[0]);});

$("validate").addEventListener("click",async()=>{
  if(!selectedFile){$("file-input").click();return;}
  clearError(); $("validate").disabled=true; $("progress").hidden=false;
  try { const asset=await inspectFile(selectedFile); selectedProfile="iab-digital"; render(await buildResult(asset)); $("complete").hidden=false; }
  catch(error){showError(error instanceof Error?error.message:"Validation failed.");}
  finally{$("validate").disabled=false;$("progress").hidden=true;}
});

async function loadFixture(id) {
  selectedFile=null; selectedProfile="iab-digital"; clearError(); clearComplete();
  $("file-input").value=""; $("file-name").textContent="Drop one master here"; $("file-meta").textContent="MP4 or MXF · processed in your browser"; $("choose-file").textContent="Choose file";
  document.querySelectorAll(".fixture").forEach((button)=>button.classList.toggle("active",button.dataset.fixture===id));
  render(await buildResult(demoAssets[id]));
}
document.querySelectorAll(".fixture").forEach((button)=>button.addEventListener("click",()=>loadFixture(button.dataset.fixture)));
$("reset").addEventListener("click",()=>loadFixture("digital"));

loadFixture("digital").catch((error)=>showError(error.message));
