# Same Ad, Different Truths

A browser-based technical pre-flight validator for video advertising masters.

One master file. Three delivery destinations. Three different verdicts.

## The problem

A finished ad rarely goes to one place. The same creative is delivered to UK broadcast,
to a CTV platform, and to digital in-stream — each with its own technical specification.

The specifications disagree. Broadcast wants interlaced MXF OP1a at 50 Mbps with a
`09:59:50:00` start timecode. Digital wants progressive MP4 with H.264 and AAC. A CTV
platform wants a duration drawn from a fixed set of slots. A master that is perfectly
correct for one destination is rejected by another.

Today, finding that out usually means submitting the file and waiting for a rejection.

This tool answers the question before delivery: *for each destination, does this file pass,
and if not, exactly which rule failed and where does that rule come from?*

## What it does

Drop in an MP4 or MXF. The file is parsed **locally in the browser** using
[MediaInfo](https://mediaarea.net/en/MediaInfo) compiled to WebAssembly — nothing is uploaded,
which matters when the asset is an unreleased creative. Extracted metadata is then evaluated
against three destination profiles simultaneously.

| Profile | Market | Represents |
| --- | --- | --- |
| IAB Digital Video | Global | Digital in-stream, ready-to-serve MP4 |
| Amazon Prime Video | UK | CTV / streaming TV delivery |
| Clearcast | UK | UK broadcast library delivery |

Each check reports the detected value, the expected value, the severity, and a link to the
source specification it came from.

## Architecture

Rules are **data, not code**. Each profile is a JSON file in [`rules/`](rules/) containing
declarative rules evaluated by a small generic engine:

```json
{
  "id": "clearcast-start-timecode",
  "attribute": "start_timecode",
  "operator": "==",
  "value": "09:59:50:00",
  "severity": "error",
  "source": "Clearcast Library Technical Specification",
  "source_url": "...",
  "version": "...",
  "explanation": "..."
}
```

Supported operators: `==`, `!=`, `in`, `>=`, `<=`, `>`, `<`, `between`, `approx`
(value ± tolerance), and `duration_offset_in` (delivery packaging length relative to the
active creative duration).

Two consequences of this shape:

- **Adding a destination is a JSON file, not a code change.** The engine does not know what
  Clearcast is.
- **Every verdict is auditable.** A rule carries its own provenance — source document, version,
  and URL — so a failure can be traced back to the specification that caused it, which is what
  a compliance conversation actually needs.

## What this deliberately does *not* do

File metadata can answer some questions and not others. The tool states its own boundary
rather than implying broader coverage:

- **Integrated loudness and true peak** require signal-level audio analysis. The rules exist
  (Clearcast requires −23 LUFS ±1 and a true peak at or below −1 dBTP) but on a real uploaded
  file these report `NOT EVALUATED` rather than guessing. The bundled demo assets carry
  loudness values so the rules can be seen working.
- **Rights clearance, brand safety and editorial approval** need evidence and human judgement.
  They are named in the interface as out of scope, not silently omitted.

A validator that quietly skips what it cannot measure is worse than one that says so.

## Running locally

The app fetches its rule files from absolute paths, so it needs to be served from the
directory root rather than opened as a `file://` URL:

```bash
python -m http.server 8000
```

Then open `http://localhost:8000`.

Three deterministic demo assets are built in — a passing digital master, a master that fails a
single audio bitrate rule, and a broadcast MXF — so the behaviour can be seen without
supplying a file.

## Status and caveats

This is a prototype built to explore the problem, not a production validator.

Rule values are derived from publicly available specification documents and are pinned to the
version noted on each rule. Published ad specifications change, and some source documents are
several years old; a production system would need explicit specification version management
and a review process rather than hand-maintained JSON. The intent here is to demonstrate the
shape of the problem and a workable engine design, not to be authoritative on any
destination's current requirements.
