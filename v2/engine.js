// v2 rule engine. One engine for every layer: technical rules read metadata and signal
// measurements, content rules read model detections. The engine never calls a model; it
// only applies rules to evidence, so every verdict traces back to a rule and its source.
(function (root) {
  const LOW_CONFIDENCE = 0.6;

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

  const fmt = (s) => `${Number(s).toFixed(2).replace(/\.?0+$/, "")}s`;
  const span = (d) => `${fmt(d.start)}–${fmt(d.end)}`;

  function timecodeToSeconds(tc, fps = 25) {
    const m = /^(\d{2}):(\d{2}):(\d{2})[:;](\d{2})$/.exec(tc || "");
    return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / fps : null;
  }

  // Where the commercial itself starts. This is the cross-layer step: metadata timecode if the
  // file carries one, otherwise a slate seen by the model followed by black measured in the signal.
  function contentStart(asset, signal, detections) {
    const tc = timecodeToSeconds(asset.start_timecode, asset.frame_rate || 25);
    if (tc !== null && tc < 36000 && tc > 35900) {
      return { seconds: 36000 - tc, basis: `metadata start timecode ${asset.start_timecode} (programme starts at 10:00:00:00)` };
    }
    const slate = detections.find((d) => d.type === "slate");
    if (slate) {
      // Frame sampling makes the slate's end approximate, so take black that starts inside or just after it.
      const black = (signal?.black_segments || []).find((b) => b.start >= slate.start && b.start <= slate.end + 2);
      if (black) return { seconds: black.end, basis: `slate ${span(slate)} detected by model, then black ${span(black)} measured in the signal` };
      return { seconds: slate.end, basis: `slate ${span(slate)} detected by model` };
    }
    return { seconds: 0, basis: "no slate detected, file starts with the commercial" };
  }

  function matching(detections, params) {
    const needle = (params.text_contains || "").toLowerCase();
    return detections.filter((d) => d.type === params.type && (!needle || d.text.toLowerCase().includes(needle)));
  }

  function lowConfidence(found) {
    return found.some((d) => d.confidence < LOW_CONFIDENCE);
  }

  function evaluateContent(rule, ctx) {
    const p = rule.params;
    const found = matching(ctx.detections, p);
    const evidence = found.map((d) => ({ ...d }));
    const out = (result, detected, expected, extra = {}) => ({ result, detected, expected, evidence, ...extra });
    if (ctx.contentError) return out("NOT_EVALUATED", "Content analysis unavailable", "—");

    switch (rule.operator) {
      case "present":
        if (!found.length) return out("FAIL", "Not found", `${p.type} containing "${p.text_contains}"`);
        return out(lowConfidence(found) ? "REVIEW" : "PASS", `Found at ${found.map(span).join(", ")}`, "Present");

      case "min_on_screen": {
        if (!found.length) return out("FAIL", "Not found", `≥ ${p.seconds}s on screen`);
        const longest = Math.max(...found.map((d) => d.end - d.start));
        return out(longest >= p.seconds ? "PASS" : "FAIL", `${fmt(longest)} on screen`, `≥ ${p.seconds}s`);
      }

      case "inside_safe_area": {
        const boxed = found.filter((d) => d.box);
        if (!boxed.length) return out("NOT_EVALUATED", found.length ? "No position returned" : "Not found", `inside ${p.margin * 100}% margin`);
        const lo = p.margin, hi = 1 - p.margin;
        const outside = boxed.filter((d) => d.box.top < lo || d.box.left < lo || d.box.bottom > hi || d.box.right > hi);
        const worst = outside[0]?.box || boxed[0].box;
        const pos = `bottom edge at ${(worst.bottom * 100).toFixed(1)}% of frame height`;
        return out(outside.length ? "FAIL" : "PASS", pos, `within ${(lo * 100).toFixed(0)}%–${(hi * 100).toFixed(0)}% of frame`);
      }

      case "within_active_content": {
        if (!found.length) return out("FAIL", "Not found", "inside the commercial");
        const start = ctx.content.seconds;
        const inside = found.filter((d) => d.start >= start - 0.25);
        const where = found.map((d) => `${span(d)}${d.start < start - 0.25 ? " (before content start)" : ""}`).join(", ");
        return out(inside.length ? "PASS" : "FAIL", where, `after content start at ${fmt(start)}`, { basis: ctx.content.basis });
      }

      case "supers_hold": {
        // BCAP superimposed text guidance 8.2-8.3: 0.2s per word, plus 2s recognition for 9 words
        // or fewer, 3s for 10 or more. Signs such as "%" or "£" on their own are not words (8.5).
        const onScreen = found.filter((d) => d.source === "on_screen");
        if (!onScreen.length) return out("FAIL", "Not found", "on screen long enough to read");
        const d = onScreen.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a));
        const words = d.text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
        const required = Number((words * 0.2 + (words <= 9 ? 2 : 3)).toFixed(2));
        const held = d.end - d.start;
        return out(held >= required ? "PASS" : "FAIL", `${fmt(held)} on screen, ${words} words`,
          `≥ ${fmt(required)} (${words} × 0.2s + ${words <= 9 ? 2 : 3}s recognition)`);
      }

      case "min_text_height": {
        // BCAP superimposed text guidance 5.2-5.5: x-height in TV lines at 1080. 30 lines preferred,
        // 26 lines minimum only when the text sits on a single-colour opaque block.
        const measured = found.filter((d) => typeof d.x_height_lines === "number");
        if (!measured.length) return out("NOT_EVALUATED", found.length ? "Text height not measured" : "Not found", `≥ ${p.preferred} TV lines`);
        const lines = Math.min(...measured.map((d) => d.x_height_lines));
        const result = lines >= p.preferred ? "PASS" : lines >= p.minimum ? "REVIEW" : "FAIL";
        const note = result === "REVIEW" ? " (allowed only on a single-colour opaque block: check by eye)" : "";
        return out(result, `${lines} TV lines x-height${note}`, `≥ ${p.preferred} lines preferred, ${p.minimum} minimum on an opaque block`);
      }

      case "in_final_seconds": {
        if (!found.length) return out("FAIL", "Not found", `in the last ${p.seconds}s`);
        const from = ctx.duration - p.seconds;
        const hit = found.some((d) => d.end >= from);
        return out(hit ? "PASS" : "FAIL", found.map(span).join(", "), `overlapping ${fmt(from)}–${fmt(ctx.duration)}`);
      }

      case "claims_review":
        if (!found.length) return out("PASS", "No claims detected", "Claims need substantiation");
        return out("REVIEW", found.map((d) => `"${d.text}" (${d.source.replace("_", " ")}, ${span(d)})`).join("; "), "Evidence on file, approved by a person");

      default:
        return out("NOT_EVALUATED", "Unknown operator", rule.operator);
    }
  }

  function evaluateTechnical(rule, ctx) {
    let actual = ctx.asset[rule.attribute];
    if (rule.operator === "duration_offset_in") {
      actual = ctx.asset.duration != null && ctx.activeDuration != null ? Number((ctx.asset.duration - ctx.activeDuration).toFixed(3)) : null;
    }
    if (actual === null || actual === undefined) return { result: "NOT_EVALUATED", detected: null, expected: rule.value };
    const passed = rule.operator === "duration_offset_in" ? Array.isArray(rule.value) && rule.value.includes(Math.round(actual)) : compare(actual, rule.operator, rule.value);
    return { result: passed ? "PASS" : "FAIL", detected: actual, expected: rule.value };
  }

  function layerStatus(checks) {
    if (!checks.length) return "N/A";
    if (checks.some((c) => c.result === "FAIL" && c.severity === "error")) return "FIX";
    if (checks.some((c) => c.result === "REVIEW")) return "REVIEW";
    if (checks.some((c) => c.result === "FAIL")) return "WARN";
    if (checks.every((c) => c.result === "NOT_EVALUATED")) return "N/A";
    return "PASS";
  }

  // destinations: [{id, name, market, technical: [...rules], editorial: [...rules]}]; brand: [...rules]
  function verify({ asset, analysis, destinations, brand, activeDuration }) {
    const signal = analysis?.signal || null;
    const detections = analysis?.content?.detections || [];
    const merged = { ...asset };
    if (signal) {
      merged.integrated_loudness = signal.integrated_loudness;
      merged.true_peak = signal.true_peak;
    }
    const ctx = {
      asset: merged,
      activeDuration,
      detections,
      duration: merged.duration,
      contentError: !analysis || analysis.content?.error,
    };
    ctx.content = contentStart(merged, signal, detections);

    const run = (rule, layer) => {
      const r = layer === "technical" ? evaluateTechnical(rule, ctx) : evaluateContent(rule, ctx);
      const origin = layer === "technical"
        ? (["integrated_loudness", "true_peak"].includes(rule.attribute) ? "Signal measurement" : "File metadata")
        : "Model detection";
      return { ...r, id: rule.id, layer, origin, label: rule.attribute || rule.operator, severity: rule.severity,
               source: rule.source, source_url: rule.source_url, version: rule.version,
               illustrative: !!rule.illustrative, explanation: rule.explanation };
    };

    const results = destinations.map((dest) => {
      const layers = {
        technical: dest.technical.map((rule) => run(rule, "technical")),
        brand: brand.map((rule) => run(rule, "brand")),
        editorial: dest.editorial.map((rule) => run(rule, "editorial")),
        rights: [],
      };
      const status = Object.fromEntries(Object.entries(layers).map(([k, v]) => [k, layerStatus(v)]));
      const overall = Object.values(status).includes("FIX") ? "FIX" : Object.values(status).includes("REVIEW") ? "REVIEW" : "READY";
      return { id: dest.id, name: dest.name, market: dest.market, layers, status, overall };
    });
    return { asset: merged, content: ctx.content, detections, results };
  }

  const api = { verify, contentStart, compare, timecodeToSeconds };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Engine = api;
})(typeof window !== "undefined" ? window : globalThis);
