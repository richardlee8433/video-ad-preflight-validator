"""v2 backend: signal measurement + content detection for one uploaded file.

Technical metadata is still read in the browser (MediaInfo). This server adds
what the browser cannot do:
  - signal:  integrated loudness, true peak and black segments, measured by ffmpeg
  - content: disclaimers, logos, claims and slates with timecodes, detected by Gemini

It never decides pass or fail. It returns measurements and detections; the rule
engine in the browser applies the destination rules to them.

Run: python3 server.py   (reads GEMINI_API_KEY from the environment or .env)
"""
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
MODEL = "gemini-2.5-flash"
SAMPLE_FPS = 4

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

PROMPT = """You are checking a video advertisement before delivery. Report what is in the video.
Do not judge whether anything is compliant. Only detect and time it precisely.

Report every item of these types:
- "disclaimer": legal, responsibility, terms or safety text, on screen or spoken
- "logo": a brand logo or wordmark shown as a graphic mark
- "claim": a comparative, superlative, health or performance claim about the product
  (e.g. "best", "No.1", "guaranteed"), on screen or spoken
- "slate": a technical clock or slate card that is not part of the ad itself
- "other_text": any other on-screen text

For each item give:
- text: the exact words (for a logo, the brand name)
- source: "on_screen" or "spoken"
- start, end: seconds from the start of the file, to the nearest 0.25 s. Use the first and
  last frame where it is visible (or audible).
- box_2d: for on-screen items, [ymin, xmin, ymax, xmax] normalised to 0-1000, tight around the
  item. Omit for spoken items.
- confidence: 0 to 1
If the same text appears in two separate intervals, report it twice."""

SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "detections": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "type": {"type": "STRING", "enum": ["disclaimer", "logo", "claim", "slate", "other_text"]},
                    "text": {"type": "STRING"},
                    "source": {"type": "STRING", "enum": ["on_screen", "spoken"]},
                    "start": {"type": "NUMBER"},
                    "end": {"type": "NUMBER"},
                    "box_2d": {"type": "ARRAY", "items": {"type": "NUMBER"}},
                    "confidence": {"type": "NUMBER"},
                },
                "required": ["type", "text", "source", "start", "end", "confidence"],
            },
        }
    },
    "required": ["detections"],
}


def proxy_for_model(path):
    """Send the model a small 720p H.264 proxy: Gemini cannot read MXF, and a
    delivery master at broadcast bitrate is slow to upload for no gain in detection."""
    tmp = tempfile.NamedTemporaryFile(suffix=".mp4", delete=False).name
    subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-i", path, "-vf", "scale=-2:720",
                    "-c:v", "libx264", "-crf", "23", "-c:a", "aac", tmp], check=True)
    return tmp, tmp


def detect_content(path):
    from google import genai
    from google.genai import types

    key = os.environ.get("GEMINI_API_KEY")
    if not key:
        return {"model": MODEL, "error": "GEMINI_API_KEY is not set", "detections": []}
    client = genai.Client(api_key=key)
    model_path, cleanup = proxy_for_model(path)
    started = time.time()
    try:
        uploaded = client.files.upload(file=model_path, config={"mime_type": "video/mp4"})
        while uploaded.state and uploaded.state.name == "PROCESSING":
            time.sleep(2)
            uploaded = client.files.get(name=uploaded.name)
        response = client.models.generate_content(
            model=MODEL,
            contents=[types.Content(parts=[
                types.Part(file_data=types.FileData(file_uri=uploaded.uri, mime_type="video/mp4"),
                           video_metadata=types.VideoMetadata(fps=SAMPLE_FPS)),
                types.Part(text=PROMPT),
            ])],
            config=types.GenerateContentConfig(
                temperature=0, response_mime_type="application/json", response_schema=SCHEMA),
        )
        detections = json.loads(response.text)["detections"]
        try:
            client.files.delete(name=uploaded.name)
        except Exception:
            pass
    finally:
        if cleanup:
            os.remove(cleanup)
    for d in detections:
        box = d.get("box_2d")
        if box and len(box) == 4:
            d["box"] = {"top": box[0] / 1000, "left": box[1] / 1000, "bottom": box[2] / 1000, "right": box[3] / 1000}
        d.pop("box_2d", None)
    return {"model": MODEL, "sample_fps": SAMPLE_FPS, "seconds": round(time.time() - started, 1),
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
