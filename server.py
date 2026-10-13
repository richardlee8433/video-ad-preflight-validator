"""v2 backend: signal measurement + content detection for one uploaded file.

Technical metadata is still read in the browser (MediaInfo). This server adds
what the browser cannot do:
  - signal:  integrated loudness, true peak and black segments, measured by ffmpeg
  - content: disclaimers, logos, claims and slates with timecodes, detected by an OpenAI vision model from sampled frames plus a Whisper transcript

It never decides pass or fail. It returns measurements and detections; the rule
engine in the browser applies the destination rules to them.

Run: python3 server.py   (reads OPENAI_API_KEY from the environment or .env)
"""
import base64
import hashlib
import json
import os
import re
import subprocess
import tempfile
import time
from datetime import datetime, timezone

import imageio_ffmpeg
import uvicorn
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

ROOT = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(ROOT, "cache")
FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()

os.makedirs(CACHE, exist_ok=True)


def load_env():
    path = os.path.join(ROOT, ".env")
    if os.path.exists(path):
        for line in open(path):
            if "=" in line and not line.strip().startswith("#"):
                key, value = line.strip().split("=", 1)
                os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


load_env()


# ---------- signal ----------

def measure_signal(path):
    proc = subprocess.run(
        [FFMPEG, "-hide_banner", "-nostats", "-i", path,
         "-filter_complex", "[0:a:0]ebur128=peak=true[a]", "-map", "[a]", "-f", "null", "-",
         "-map", "0:v:0", "-vf", "blackdetect=d=0.5:pix_th=0.10", "-f", "null", "-"],
        capture_output=True, text=True,
    )
    log = proc.stderr
    summary = log[log.rfind("Summary:"):] if "Summary:" in log else ""
    loudness = re.search(r"I:\s+(-?[\d.]+) LUFS", summary)
    peak = re.search(r"True peak:\s+Peak:\s+(-?[\d.]+) dBFS", summary)
    black = [
        {"start": float(m.group(1)), "end": float(m.group(2))}
        for m in re.finditer(r"black_start:(-?[\d.]+) black_end:(-?[\d.]+)", log)
    ]
    return {
        "integrated_loudness": float(loudness.group(1)) if loudness else None,
        "true_peak": float(peak.group(1)) if peak else None,
        "black_segments": black,
        "method": "ffmpeg ebur128 (EBU R128 / ITU-R BS.1770) + blackdetect",
    }


# ---------- content ----------
# OpenAI vision models take images, not video. So: sample frames at a fixed rate with
# their timestamps, transcribe the audio with timestamps, and ask the model to report
# what it sees and hears. Timing comes from the sampled frames, not from the model.

MODEL = os.environ.get("OPENAI_VISION_MODEL", "gpt-4o")
TRANSCRIBE_MODEL = "whisper-1"
SAMPLE_FPS = 4
MAX_FRAMES = 24
# A frame counts as changed when enough pixels change sharply. Supers appearing are a small
# area changing a lot; slow camera or background drift is a large area changing a little.
PIXEL_DELTA = 30         # per-pixel greyscale change (0-255) that counts as sharp
CHANGED_SHARE = 0.004    # share of a 160x90 thumbnail that must change sharply
KEYFRAME_EVERY = 3.0     # also keep one frame every N seconds as a safety net
# The rate limiter estimates tokens per image regardless of size, so the lever is how many
# frames are sent. Supers and cards appear abruptly, so only frames where the picture
# changes are sent; each one stands for the interval until the next sent frame.
FRAME_SIZE = (910, 512)

PROMPT = """You are checking a video advertisement before delivery. You get the frames where the
picture changes, each labelled with its time and how long it stays unchanged, and a timestamped
transcript of the audio.
Report what is there. Do not judge whether anything is compliant.

Report every item of these types:
- "disclaimer": legal, responsibility, terms or safety text, on screen or spoken
- "logo": a brand logo or wordmark shown as a graphic mark
- "claim": ONLY a comparative, superlative, absolute, health or performance claim that would
  need evidence (e.g. "best", "No.1", "guaranteed", "proven", "healthiest", "number one").
  Descriptive lines, slogans and heritage statements ("brewed since 1921") are NOT claims.
- "slate": a technical clock or slate card that is not part of the ad itself
- "other_text": any other on-screen text

For each item:
- text: the exact words (for a logo, the brand name)
- source: "on_screen" or "spoken"
- first_seen, last_seen: for on-screen items, the labelled times of the first and last frame where
  it is visible. For spoken items, the start and end of the transcript segment.
- box: for on-screen items, [top, left, bottom, right] as fractions of frame height/width (0-1),
  tight around the item. null for spoken items.
- confidence: 0 to 1
For speech, report only disclaimers and claims, never ordinary narration.
If the same item disappears and comes back, report each interval separately.

Transcript:
{transcript}"""

SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "detections": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "type": {"type": "string", "enum": ["disclaimer", "logo", "claim", "slate", "other_text"]},
                    "text": {"type": "string"},
                    "source": {"type": "string", "enum": ["on_screen", "spoken"]},
                    "first_seen": {"type": "number"},
                    "last_seen": {"type": "number"},
                    "box": {"anyOf": [{"type": "array", "items": {"type": "number"}}, {"type": "null"}]},
                    "confidence": {"type": "number"},
                },
                "required": ["type", "text", "source", "first_seen", "last_seen", "box", "confidence"],
            },
        }
    },
    "required": ["detections"],
}


def duration_of(path):
    log = subprocess.run([FFMPEG, "-hide_banner", "-i", path], capture_output=True, text=True).stderr
    m = re.search(r"Duration: (\d+):(\d+):([\d.]+)", log)
    return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3)) if m else 30.0


def sample_frames(path, workdir):
    """Returns [(start, end, file)]: keyframes where the picture changes, each covering the
    interval until the next keyframe."""
    from PIL import Image, ImageChops

    duration = duration_of(path)
    w, h = FRAME_SIZE
    subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-i", path,
                    "-vf", f"fps={SAMPLE_FPS},scale={w}:{h}:force_original_aspect_ratio=decrease", "-q:v", "3",
                    os.path.join(workdir, "f%05d.jpg")], check=True)
    files = sorted(os.path.join(workdir, f) for f in os.listdir(workdir) if f.endswith(".jpg"))
    step = 1 / SAMPLE_FPS
    thumbs = [Image.open(f).convert("L").resize((160, 90)) for f in files]
    sharp = lambda a, b: sum(ImageChops.difference(a, b).point(lambda v: 255 if v > PIXEL_DELTA else 0)
                             .histogram()[255:]) / (160 * 90)
    diffs = [1.0] + [sharp(a, b) for a, b in zip(thumbs, thumbs[1:])]
    keep, last = [], -KEYFRAME_EVERY
    for i, d in enumerate(diffs):
        if d > CHANGED_SHARE or i * step - last >= KEYFRAME_EVERY:
            keep.append(i)
            last = i * step
    if len(keep) > MAX_FRAMES:
        # Busy footage: keep the biggest changes, always keep the first frame.
        keep = sorted([0] + sorted(keep[1:], key=lambda i: diffs[i], reverse=True)[:MAX_FRAMES - 1])
    bounds = [i * step for i in keep] + [duration]
    return [(round(bounds[n], 2), round(bounds[n + 1], 2), files[i]) for n, i in enumerate(keep)]


def refine_box(d, frames):
    """Model boxes are coarse. Measure the real edges from the pixels that change when the item
    appears: compare its first frame with the previous keyframe, inside a window around the
    model's estimate. Returns None when there is no previous frame or no clear change."""
    from PIL import Image, ImageChops

    starts = [round(f[0], 2) for f in frames]
    i = min(range(len(starts)), key=lambda k: abs(starts[k] - d["first_seen"]))
    if i == 0:
        return None
    cur = Image.open(frames[i][2]).convert("L")
    prev = Image.open(frames[i - 1][2]).convert("L")
    w, h = cur.size
    top, left, bottom, right = d["box"]
    y0, y1 = max(0, int((top - 0.15) * h)), min(h, int((bottom + 0.15) * h))
    x0, x1 = max(0, int((left - 0.1) * w)), min(w, int((right + 0.1) * w))
    if y1 <= y0 or x1 <= x0:
        return None
    diff = ImageChops.difference(cur, prev).crop((x0, y0, x1, y1)).point(lambda v: 255 if v > PIXEL_DELTA else 0)
    cw, ch = diff.size
    px = diff.load()
    rows = [y for y in range(ch) if sum(1 for x in range(cw) if px[x, y]) > 0.02 * cw]
    cols = [x for x in range(cw) if sum(1 for y in range(ch) if px[x, y]) > 0.02 * ch]
    if not rows or not cols:
        return None
    return {"top": round((y0 + rows[0]) / h, 3), "bottom": round((y0 + rows[-1] + 1) / h, 3),
            "left": round((x0 + cols[0]) / w, 3), "right": round((x0 + cols[-1] + 1) / w, 3)}


def measure_x_height(path, d, box):
    """Text size the way BCAP measures it (superimposed text guidance, section 5 and appendix 2):
    the x-height of lower-case letters in TV lines at 1080, ignoring risers, descenders and the
    weaker anti-aliased lines at the edges. Rows inside the x-height band carry ink in almost every
    letter; ascender and descender rows only in some, so the band is the densest run of rows."""
    from PIL import Image

    mid = (d["start"] + d["end"]) / 2
    with tempfile.TemporaryDirectory() as tmp:
        png = os.path.join(tmp, "f.png")
        subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-ss", f"{mid:.2f}", "-i", path, "-frames:v", "1",
                        "-vf", "scale=-2:1080", png], check=True)
        img = Image.open(png).convert("L")
    w, h = img.size
    pad = 0.01
    crop = img.crop((max(0, int((box["left"] - pad) * w)), max(0, int((box["top"] - pad) * h)),
                     min(w, int((box["right"] + pad) * w)), min(h, int((box["bottom"] + pad) * h))))
    cw, ch = crop.size
    if cw < 10 or ch < 5:
        return None
    px = list(crop.getdata())
    background = sorted(px)[len(px) // 2]  # most of a caption box is background
    full_strength = 90  # ignore faint anti-aliased edge lines
    counts = [sum(1 for x in range(cw) if abs(px[y * cw + x] - background) > full_strength) for y in range(ch)]
    peak = max(counts)
    if peak == 0:
        return None
    # Inside the x-height band, rows with horizontal strokes (tops and bottoms of letters) are dense and
    # rows with only vertical stems are about half as dense; ascender/descender rows are far sparser
    # (~10% of peak on real captions), so 35% of the peak separates the band from them.
    dense = [c >= 0.35 * peak for c in counts]
    best = run = 0
    for flag in dense:
        run = run + 1 if flag else 0
        best = max(best, run)
    return best


def transcribe(client, path, workdir):
    audio = os.path.join(workdir, "audio.mp3")
    proc = subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-i", path, "-vn", "-ac", "1", "-ar", "16000",
                           "-b:a", "48k", audio])
    if proc.returncode != 0 or not os.path.exists(audio):
        return []
    with open(audio, "rb") as f:
        result = client.audio.transcriptions.create(model=TRANSCRIBE_MODEL, file=f, response_format="verbose_json",
                                                    timestamp_granularities=["segment"])
    return [{"start": round(seg.start, 2), "end": round(seg.end, 2), "text": seg.text.strip()}
            for seg in (result.segments or [])]


def detect_content(path):
    from openai import OpenAI, RateLimitError

    if not os.environ.get("OPENAI_API_KEY"):
        return {"model": MODEL, "error": "OPENAI_API_KEY is not set", "detections": []}
    client = OpenAI()
    started = time.time()
    with tempfile.TemporaryDirectory() as workdir:
        frames = sample_frames(path, workdir)
        segments = transcribe(client, path, workdir)
        transcript = "\n".join(f"[{s['start']:.2f}-{s['end']:.2f}] {s['text']}" for s in segments) or "(no speech)"
        content = [{"type": "text", "text": PROMPT.format(transcript=transcript)}]
        for start, end, frame in frames:
            with open(frame, "rb") as f:
                b64 = base64.b64encode(f.read()).decode()
            content.append({"type": "text", "text": f"Frame at {start:.2f}s (picture unchanged until {end:.2f}s)"})
            content.append({"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}", "detail": "high"}})
        for attempt in range(3):
            try:
                response = client.chat.completions.create(
                    model=MODEL, temperature=0,
                    messages=[{"role": "user", "content": content}],
                    response_format={"type": "json_schema",
                                     "json_schema": {"name": "detections", "strict": True, "schema": SCHEMA}},
                )
                break
            except RateLimitError:
                # One video uses most of a 30k tokens-per-minute budget: wait for the window to reset.
                if attempt == 2:
                    raise
                time.sleep(65)
        raw = json.loads(response.choices[0].message.content)["detections"]
        refined = {}
        for n, d in enumerate(raw):
            if d["source"] == "on_screen" and d.get("box"):
                refined[n] = refine_box(d, frames)
    # Timing comes from the frames, not the model: map last_seen to the end of that frame's interval.
    frame_end = {round(start, 2): end for start, end, _ in frames}
    duration = frames[-1][1] if frames else 0
    detections = []
    for n, d in enumerate(raw):
        if d["first_seen"] >= duration:
            continue  # the model sometimes repeats a spoken line past the end of the file
        if d["source"] == "on_screen":
            last = min(frame_end, key=lambda t: abs(t - d["last_seen"]))
            start, end = d["first_seen"], frame_end[last]
        else:
            start, end = d["first_seen"], d["last_seen"]
        item = {"type": d["type"], "text": d["text"], "source": d["source"],
                "start": round(start, 2), "end": round(end, 2), "confidence": d["confidence"]}
        if refined.get(n):
            item["box"], item["box_method"] = refined[n], "pixel change around the model's estimate"
        elif d.get("box") and len(d["box"]) == 4:
            b = d["box"]
            item["box"], item["box_method"] = {"top": b[0], "left": b[1], "bottom": b[2], "right": b[3]}, "model estimate"
        if item["type"] == "disclaimer" and item.get("box") and item["source"] == "on_screen":
            item["x_height_lines"] = measure_x_height(path, item, item["box"])
        detections.append(item)
    return {"model": MODEL, "transcribe_model": TRANSCRIBE_MODEL, "sample_fps": SAMPLE_FPS,
            "frames": len(frames), "transcript": segments, "seconds": round(time.time() - started, 1),
            "detections": sorted(detections, key=lambda d: d["start"])}


# ---------- api ----------

app = FastAPI()


@app.post("/api/analyze")
async def analyze(file: UploadFile = File(...)):
    data = await file.read()
    if not data:
        raise HTTPException(400, "Empty file")
    digest = hashlib.sha256(data).hexdigest()
    cached = os.path.join(CACHE, digest + ".json")
    if os.path.exists(cached):
        result = json.load(open(cached))
        result["cached"] = True
        return result
    suffix = os.path.splitext(file.filename or "")[1].lower() or ".mp4"
    path = os.path.join(CACHE, digest + suffix)
    with open(path, "wb") as f:
        f.write(data)
    try:
        result = {
            "sha256": digest,
            "filename": file.filename,
            "analysed_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "signal": measure_signal(path),
            "content": detect_content(path),
        }
    finally:
        os.remove(path)
    if not result["content"].get("error"):
        json.dump(result, open(cached, "w"), indent=2)
    result["cached"] = False
    return result


# Same paths as the Netlify site: "/" is v1, "/v2/verify.html" is v2.
V1_FILES = {"index.html", "app.js", "styles.css", "static-overrides.css", "favicon.svg"}


@app.get("/")
def index():
    return FileResponse(os.path.join(ROOT, "index.html"))


@app.get("/{name}")
def v1_file(name: str):
    if name not in V1_FILES:
        raise HTTPException(404)
    return FileResponse(os.path.join(ROOT, name))


# Only these folders are public. Never mount ROOT: it holds .env.
app.mount("/v2", StaticFiles(directory=os.path.join(ROOT, "v2")), name="v2")
app.mount("/rules", StaticFiles(directory=os.path.join(ROOT, "rules")), name="rules")
app.mount("/fixtures", StaticFiles(directory=os.path.join(ROOT, "fixtures")), name="fixtures")

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("PORT", 8787)))
