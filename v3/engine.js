// v3 rule engine. One engine for every layer: technical rules read metadata and signal
// measurements, content rules read model detections. The engine never calls a model; it
// only applies rules to evidence, so every verdict traces back to a rule and its source.
//
// Changes from v2, found by running real ads through it:
//   - A rule can say which ads it applies to (applies_when: category, brand). The alcohol
//     disclaimer and the Northlight brand rules no longer fail every other ad: they are N/A.
//   - A rule that checks an item's timing, size or position has nothing to check when the
//     item is absent. That is N/A, not FAIL: whether the item must be there is the job of the
//     "present" rule, so an absent disclaimer is reported once, not five times.
//   - A position estimated by the model, not measured, is REVIEW rather than PASS or FAIL.
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
    const types = params.types || [params.type];
    return detections.filter((d) => types.includes(d.type) && (!needle || d.text.toLowerCase().includes(needle)));
  }

  const describe = (p) => `${(p.types || [p.type]).join(" or ")}${p.text_contains ? ` containing "${p.text_contains}"` : ""}`;

  // applies_when: { category: [...], brand: [...] }. Every listed key must match the declaration.
  function applicability(rule, declared) {
    const when = rule.applies_when;
    if (!when) return null;
    for (const [key, allowed] of Object.entries(when)) {
      const value = declared?.[key] || null;
      if (!allowed.includes(value)) {
        return `Not applicable: rule covers ${key} ${allowed.join(" / ")}; this ad is declared as ${value ? `${key} ${value}` : `no ${key}`}`;
      }
    }
    return null;
  }

  function lowConfidence(found) {
    return found.some((d) => d.confidence < LOW_CONFIDENCE);
  }

  function evaluateContent(rule, ctx) {
    const p = rule.params;
    const found = matching(ctx.detections, p);
    const evidence = found.map((d) => ({ ...d }));
    const out = (result, detected, expected, extra = {}) => ({ result, detected, expected, evidence, ...extra });
    const notApplicable = applicability(rule, ctx.declared);
    if (notApplicable) return out("N/A", notApplicable, "—");
    if (ctx.contentError) return out("NOT_EVALUATED", "Content analysis unavailable", "—");
    // Only "present" and "claims_review" judge absence; every other operator needs something to measure.
    if (!found.length && !["present", "claims_review"].includes(rule.operator)) {
      return out("N/A", `Nothing to check: no ${describe(p)} detected`, "—");
    }

    switch (rule.operator) {
      case "present":
        if (!found.length) return out("FAIL", "Not found", describe(p));
        return out(lowConfidence(found) ? "REVIEW" : "PASS", `Found at ${found.map(span).join(", ")}`, "Present");

      case "min_on_screen": {
        const longest = Math.max(...found.map((d) => d.end - d.start));
        return out(longest >= p.seconds ? "PASS" : "FAIL", `${fmt(longest)} on screen`, `≥ ${p.seconds}s`);
      }

      case "inside_safe_area": {
        const boxed = found.filter((d) => d.box);
        if (!boxed.length) return out("NOT_EVALUATED", "No position returned", `inside ${p.margin * 100}% margin`);
        const lo = p.margin, hi = 1 - p.margin;
        const isOutside = (d) => d.box.top < lo || d.box.left < lo || d.box.bottom > hi || d.box.right > hi;
        const estimated = (d) => (d.box_method || "model estimate") === "model estimate";
        const measured = boxed.filter((d) => !estimated(d));
        const outside = measured.filter(isOutside);
        const expected = `within ${(lo * 100).toFixed(0)}%–${(hi * 100).toFixed(0)}% of frame`;
        const at = (d) => `"${d.text}" bottom edge at ${(d.box.bottom * 100).toFixed(1)}% of frame height`;
        if (outside.length) return out("FAIL", `${at(outside[0])} (${outside[0].box_method})`, expected);
        if (measured.length < boxed.length) {
          // The model's own box is a rough estimate: not good enough to pass or fail a margin of a few percent.
          return out("REVIEW", `${boxed.length - measured.length} position(s) only estimated by the model, not measured`, expected);
        }
        return out("PASS", `${measured.length} measured, worst ${at(measured.reduce((a, b) => (b.box.bottom > a.box.bottom ? b : a)))}`, expected);
      }

      case "within_active_content": {
        const start = ctx.content.seconds;
        const inside = found.filter((d) => d.start >= start - 0.25);
        const where = found.map((d) => `${span(d)}${d.start < start - 0.25 ? " (before content start)" : ""}`).join(", ");
        return out(inside.length ? "PASS" : "FAIL", where, `after content start at ${fmt(start)}`, { basis: ctx.content.basis });
      }

      case "supers_hold": {
        // BCAP superimposed text guidance 8.2-8.3: 0.2s per word, plus 2s recognition for 9 words
        // or fewer, 3s for 10 or more. Signs such as "%" or "£" on their own are not words (8.5).
        // v2 checked only the longest-held item; v3 checks every super and reports the worst.
        const onScreen = found.filter((d) => d.source === "on_screen");
        if (!onScreen.length) return out("N/A", "Nothing to check: no on-screen text detected", "—");
        const checked = onScreen.map((d) => {
          const words = d.text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
          const required = Number((words * 0.2 + (words <= 9 ? 2 : 3)).toFixed(2));
          return { d, words, required, held: d.end - d.start, short: d.end - d.start - required };
        });
        const worst = checked.reduce((a, b) => (b.short < a.short ? b : a));
        const failing = checked.filter((c) => c.short < 0);
        const detail = `"${worst.d.text}": ${fmt(worst.held)} on screen, ${worst.words} words`;
        return out(failing.length ? "FAIL" : "PASS",
          failing.length ? `${failing.length} of ${checked.length} too short. Worst ${detail}` : `All ${checked.length} long enough. Tightest ${detail}`,
          `≥ ${fmt(worst.required)} for that one (${worst.words} × 0.2s + ${worst.words <= 9 ? 2 : 3}s recognition)`);
      }

      case "min_text_height": {
        // BCAP superimposed text guidance 5.2-5.5: x-height in TV lines at 1080. 30 lines preferred,
        // 26 lines minimum only when the text sits on a single-colour opaque block.
        const measured = found.filter((d) => typeof d.x_height_lines === "number");
        if (!measured.length) return out("NOT_EVALUATED", "Text height not measured", `≥ ${p.preferred} TV lines`);
        const smallest = measured.reduce((a, b) => (b.x_height_lines < a.x_height_lines ? b : a));
        const lines = smallest.x_height_lines;
        const expected = `≥ ${p.preferred} lines preferred, ${p.minimum} minimum on an opaque block`;
        let result = lines >= p.preferred ? "PASS" : lines >= p.minimum ? "REVIEW" : "FAIL";
        let note = result === "REVIEW" ? " (allowed only on a single-colour opaque block: check by eye)" : "";
        // Supers straight on footage have no flat background to measure against, and the lines of one
        // caption disagreeing shows when that went wrong. Below-threshold sizes from such text go to a person.
        const samples = smallest.x_height_samples || [lines];
        const spread = Math.max(...samples) / Math.min(...samples) > 1.3;
        if (result === "FAIL" && (smallest.type === "super" || spread)) {
          result = "REVIEW";
          note = ` measured on text over footage${spread ? `, lines disagree (${samples.join(", ")})` : ""}: check by eye`;
        }
        return out(result, `"${smallest.text}": ${lines} TV lines x-height${note}`, expected);
      }

      case "in_final_seconds": {
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
    const notApplicable = applicability(rule, ctx.declared);
    if (notApplicable) return { result: "N/A", detected: notApplicable, expected: rule.value };
    let actual = ctx.asset[rule.attribute];
    if (rule.operator === "duration_offset_in") {
      actual = ctx.asset.duration != null && ctx.activeDuration != null ? Number((ctx.asset.duration - ctx.activeDuration).toFixed(3)) : null;
    }
    if (actual === null || actual === undefined) return { result: "NOT_EVALUATED", detected: null, expected: rule.value };
    const passed = rule.operator === "duration_offset_in" ? Array.isArray(rule.value) && rule.value.includes(Math.round(actual)) : compare(actual, rule.operator, rule.value);
    return { result: passed ? "PASS" : "FAIL", detected: actual, expected: rule.value };
  }

  function layerStatus(all) {
    const checks = all.filter((c) => c.result !== "N/A");
    if (!checks.length) return "N/A";
    if (checks.some((c) => c.result === "FAIL" && c.severity === "error")) return "FIX";
    if (checks.some((c) => c.result === "REVIEW")) return "REVIEW";
    if (checks.some((c) => c.result === "FAIL")) return "WARN";
    if (checks.every((c) => c.result === "NOT_EVALUATED")) return "N/A";
    return "PASS";
  }

  // destinations: [{id, name, market, technical: [...rules], editorial: [...rules]}]; brand: [...rules]
  // declared: { brand, category } as stated by whoever submits the ad. Rules only apply to ads they cover.
  function verify({ asset, analysis, destinations, brand, activeDuration, declared = {} }) {
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
      declared,
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
    return { asset: merged, content: ctx.content, detections, results, declared };
  }

  const api = { verify, contentStart, compare, timecodeToSeconds, applicability };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Engine = api;
})(typeof window !== "undefined" ? window : globalThis);
