// Text boxes from Apple's Vision OCR (macOS), used by the v3 pipeline to measure where on-screen
// text sits: the vision model says what the text is, this says exactly where it is.
//
// Usage: osascript -l JavaScript tools/ocr_boxes.js image.jpg [image.jpg ...]
// Prints a JSON list, one entry per image: {file, lines: [{text, confidence, top, left, bottom, right}]}
// Coordinates are fractions of the image, top-left origin.
ObjC.import("Vision");
ObjC.import("Foundation");

function run(argv) {
  return JSON.stringify(argv.map((path) => {
    const request = $.VNRecognizeTextRequest.alloc.init;
    request.recognitionLevel = 0; // accurate
    request.usesLanguageCorrection = false;
    const handler = $.VNImageRequestHandler.alloc.initWithURLOptions($.NSURL.fileURLWithPath(path), $({}));
    handler.performRequestsError($([request]), null);
    const lines = [];
    const results = request.results;
    for (let i = 0; i < results.count; i++) {
      const obs = results.objectAtIndex(i);
      const best = obs.topCandidates(1).objectAtIndex(0);
      const b = obs.boundingBox; // normalised, bottom-left origin
      lines.push({ text: best.string.js, confidence: best.confidence,
                   top: 1 - (b.origin.y + b.size.height), left: b.origin.x, bottom: 1 - b.origin.y, right: b.origin.x + b.size.width });
    }
    return { file: path, lines };
  }));
}
