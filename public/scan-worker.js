/* Waraq scanner worker: loads OpenCV.js 4.9 off the main thread and runs
 * document detection + perspective warp + enhancement filters.
 *
 * Messages in:
 *   {type:"init"}
 *   {id, type:"detect", width, height, buffer}            small RGBA frame (transferred), live preview
 *   {id, type:"detectBitmap", bitmap}                      full photo (ImageBitmap): thorough detection,
 *                                                          sub-pixel corner refinement, orientation guess
 *   {id, type:"process", bitmap, quad, rotation, filter, maxEdge, quality, deskew?}
 *                                                          deskew: fold a residual-skew fix (< 5 deg, from text
 *                                                          lines / rulings) into the same warp
 * Messages out:
 *   {type:"progress", loaded, total} | {type:"ready"} | {type:"error", error}
 *   {id, ok:true, ms, ...result} | {id, ok:false, error}      ms: worker time for the message
 *   ready carries {timings: {cached, jsMs, wasmMs, streaming, readyMs}} (scanner diagnostics)
 *
 * detectBitmap result: {quad (0..1, tl,tr,br,bl), score, support, refined}
 *   with {orient:true} also rotation?: 0|90|180|270 (clockwise, text-upright guess; experimental,
 *   unreliable on Arabic pages so the app does not apply it) and orientation (debug info).
 * process result: {blob, width, height, sourceWidth, sourceHeight, skew}
 *   skew: residual angle (deg) removed by the deskew pass (0 when not applied).
 */
/* eslint-disable */
"use strict";

// OpenCV 4.9.0 split out of the single-file opencv.js build (scripts/split-opencv.mjs): the JS glue (~220 KB) and
// the raw wasm (7.5 MB; 2.3 MB gzip vs 3.4 MB for the base64-embedded copy). Both are fetched once into Cache
// Storage ("scanner-opencv-<ver>", same-origin, outside the service worker's per-build caches), so the website and
// the Android app (no service worker there) start the scanner from disk alike, across deploys, and the wasm is
// compiled with WebAssembly.instantiateStreaming (compiles while downloading; Chrome can reuse the compiled code).
var OPENCV_VERSION = "4.9.0";
var OPENCV_JS = "/vendor/opencv-" + OPENCV_VERSION + ".js";
var OPENCV_WASM = "/vendor/opencv-" + OPENCV_VERSION + ".wasm";
var OPENCV_WASM_SIZE = 7526321;
var OPENCV_JS_SIZE = 222193;
var VENDOR_CACHE = "scanner-opencv-" + OPENCV_VERSION;
var cvReady = null;
/** Start-up timings for the scanner diagnostics (ms since the worker got "init"). */
var initTimings = null;

function post(msg, transfer) {
  self.postMessage(msg, transfer || []);
}

function now() {
  return self.performance && performance.now ? performance.now() : Date.now();
}

async function vendorCache() {
  try {
    if (!self.caches) return null;
    var c = await caches.open(VENDOR_CACHE);
    // drop other OpenCV versions
    caches
      .keys()
      .then(function (names) {
        names.forEach(function (n) {
          if (n.indexOf("scanner-opencv-") === 0 && n !== VENDOR_CACHE) caches.delete(n);
        });
      })
      .catch(function () {});
    return c;
  } catch (e) {
    return null; // opaque origins, storage disabled, quota: plain network
  }
}

/** Cache-first: {res, cached}. A network response is stored in the background (the body is teed). */
async function vendorResponse(cache, url) {
  if (cache) {
    try {
      var hit = await cache.match(url);
      if (hit && hit.ok) return { res: hit, cached: true };
    } catch (e) {}
  }
  var res = await fetch(url, { credentials: "same-origin" });
  if (!res.ok) throw new Error("Could not download OpenCV (" + res.status + ")");
  if (cache) cache.put(url, res.clone()).catch(function () {});
  return { res: res, cached: false };
}

/** Reads a response body, reporting progress against `base` bytes already loaded (of `total`). */
async function readAll(res, base, total) {
  if (!res.body || !res.body.getReader) return new Uint8Array(await res.arrayBuffer());
  var reader = res.body.getReader();
  var chunks = [];
  var loaded = 0;
  var lastPost = 0;
  for (;;) {
    var r = await reader.read();
    if (r.done) break;
    chunks.push(r.value);
    loaded += r.value.byteLength;
    var t = Date.now();
    if (total && t - lastPost > 80) {
      lastPost = t;
      post({ type: "progress", loaded: Math.min(base + loaded, total), total: total });
    }
  }
  var out = new Uint8Array(loaded);
  var off = 0;
  for (var i = 0; i < chunks.length; i++) {
    out.set(chunks[i], off);
    off += chunks[i].byteLength;
  }
  return out;
}

/** Counts bytes of a teed copy of the wasm download for the progress bar (only when it comes from the network). */
function trackProgress(res, base, total) {
  try {
    readAll(res, base, total).catch(function () {});
  } catch (e) {}
}

function loadOpenCV() {
  if (cvReady) return cvReady;
  cvReady = (async function () {
    var t0 = now();
    var total = OPENCV_JS_SIZE + OPENCV_WASM_SIZE;
    var cache = await vendorCache();
    // wasm request first: it is the big one and compiles while the glue loads
    var wasmP = vendorResponse(cache, OPENCV_WASM);
    var js = await vendorResponse(cache, OPENCV_JS);
    var jsBytes = await readAll(js.res, 0, js.cached ? 0 : total);
    var tJs = now();
    var wasm = await wasmP;
    var timings = { cached: js.cached && wasm.cached, jsMs: Math.round(tJs - t0), streaming: false };
    if (!wasm.cached) trackProgress(wasm.res.clone(), OPENCV_JS_SIZE, total);

    var wasmFail = null;
    var wasmFailed = new Promise(function (_, reject) {
      wasmFail = reject;
    });
    var instantiateWasm = function (info, receiveInstance) {
      var fromBytes = function (r) {
        return r.arrayBuffer().then(function (buf) {
          return WebAssembly.instantiate(buf, info);
        });
      };
      var p;
      if (typeof WebAssembly.instantiateStreaming === "function") {
        timings.streaming = true;
        p = WebAssembly.instantiateStreaming(wasm.res, info).catch(function () {
          // wrong MIME type from a proxy, or no streaming support: compile from the bytes
          timings.streaming = false;
          return vendorResponse(cache, OPENCV_WASM).then(function (again) {
            return fromBytes(again.res);
          });
        });
      } else {
        p = fromBytes(wasm.res);
      }
      p.then(
        function (out) {
          timings.wasmMs = Math.round(now() - t0);
          receiveInstance(out.instance, out.module);
        },
        function (e) {
          // a damaged cached copy must not break every later start
          if (cache) {
            cache.delete(OPENCV_WASM).catch(function () {});
            cache.delete(OPENCV_JS).catch(function () {});
          }
          wasmFail(new Error("OpenCV failed to compile: " + ((e && e.message) || e)));
        },
      );
      return {}; // exports arrive through receiveInstance
    };

    // opencv.js builds its Emscripten module from a global `Module`
    self.Module = { instantiateWasm: instantiateWasm };
    var url = URL.createObjectURL(new Blob([jsBytes], { type: "text/javascript" }));
    try {
      importScripts(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    // OpenCV 4.9 returns an Emscripten Module that is "thenable"; never await it
    // directly (its then() resolves with itself). Wait for onRuntimeInitialized.
    var runtime = new Promise(function (resolve, reject) {
      var done = false;
      function ok() {
        if (done) return;
        done = true;
        resolve();
      }
      var m = self.cv;
      if (!m) return reject(new Error("OpenCV failed to initialise"));
      if (m.Mat) return ok();
      m.onRuntimeInitialized = ok;
      var started = Date.now();
      var iv = setInterval(function () {
        if (self.cv && self.cv.Mat) {
          clearInterval(iv);
          ok();
        } else if (Date.now() - started > 90000) {
          clearInterval(iv);
          if (!done) reject(new Error("OpenCV initialisation timed out"));
        }
      }, 60);
    });
    await Promise.race([runtime, wasmFailed]);
    timings.readyMs = Math.round(now() - t0);
    initTimings = timings;
    post({ type: "progress", loaded: total, total: total });
  })();
  cvReady.catch(function () {
    cvReady = null;
  });
  return cvReady;
}

/* ----------------------------- geometry ---------------------------------- */

function orderQuad(pts) {
  // pts: [[x,y] x4] -> [tl, tr, br, bl] (image coords, y down).
  // Sort clockwise around the centroid (robust for any rotation, unlike the
  // sum/diff trick which breaks near 45deg), then start at the corner that
  // is the top-left one: smallest x+y.
  var cx = 0;
  var cy = 0;
  for (var i = 0; i < 4; i++) {
    cx += pts[i][0] / 4;
    cy += pts[i][1] / 4;
  }
  var cw = pts.slice().sort(function (a, b) {
    return Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx);
  });
  var start = 0;
  for (var k = 1; k < 4; k++) if (cw[k][0] + cw[k][1] < cw[start][0] + cw[start][1]) start = k;
  return [cw[start], cw[(start + 1) % 4], cw[(start + 2) % 4], cw[(start + 3) % 4]];
}

function isConvexQuad(q) {
  var sign = 0;
  for (var i = 0; i < 4; i++) {
    var a = q[i];
    var b = q[(i + 1) % 4];
    var c = q[(i + 2) % 4];
    var cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cross) < 1e-9) continue;
    var sg = cross > 0 ? 1 : -1;
    if (!sign) sign = sg;
    else if (sg !== sign) return false;
  }
  return true;
}

/** Interior angles of an ordered quad, degrees. */
function quadAngles(q) {
  var out = [];
  for (var i = 0; i < 4; i++) {
    var p = q[(i + 3) % 4];
    var c = q[i];
    var n = q[(i + 1) % 4];
    var a1 = Math.atan2(p[1] - c[1], p[0] - c[0]);
    var a2 = Math.atan2(n[1] - c[1], n[0] - c[0]);
    var d = Math.abs(a1 - a2) * (180 / Math.PI);
    if (d > 180) d = 360 - d;
    out.push(d);
  }
  return out;
}

function bilinear(gray, w, h, x, y) {
  if (x < 0 || y < 0 || x > w - 1.001 || y > h - 1.001) return -1;
  var x0 = Math.floor(x);
  var y0 = Math.floor(y);
  var fx = x - x0;
  var fy = y - y0;
  var o = y0 * w + x0;
  return gray[o] * (1 - fx) * (1 - fy) + gray[o + 1] * fx * (1 - fy) + gray[o + w] * (1 - fx) * fy + gray[o + w + 1] * fx * fy;
}

/**
 * Snap each side of a coarse quad onto the strongest straight edge nearby, at
 * a higher resolution than detection ran at: sample points along the side,
 * search along its normal for the largest brightness step (either polarity:
 * white paper on a dark desk, or a dark card on a white table; the polarity
 * with more votes wins per side), fit a line with outlier rejection,
 * intersect neighbours. Sides lying on the image border (page partly out of
 * frame) are kept as they are.
 * gray: Uint8 array (w*h). quad in pixels of that image. radius: search
 * distance as a fraction of the long edge. Returns a new quad or null.
 */
function refineQuad(gray, w, h, quad, radius) {
  var R = Math.max(4, Math.round(Math.max(w, h) * (radius || 0.018)));
  var cx = 0;
  var cy = 0;
  for (var i = 0; i < 4; i++) {
    cx += quad[i][0] / 4;
    cy += quad[i][1] / 4;
  }
  var border = Math.max(3, Math.max(w, h) * 0.004);
  var lines = [];
  var moved = 0;
  for (var sIdx = 0; sIdx < 4; sIdx++) {
    var p = quad[sIdx];
    var q = quad[(sIdx + 1) % 4];
    var dx = q[0] - p[0];
    var dy = q[1] - p[1];
    var len = Math.hypot(dx, dy);
    if (len < 20) return null;
    var ux = dx / len;
    var uy = dy / len;
    var nx = -uy;
    var ny = ux;
    // normal pointing inwards
    var mx = (p[0] + q[0]) / 2;
    var my = (p[1] + q[1]) / 2;
    if ((cx - mx) * nx + (cy - my) * ny < 0) {
      nx = -nx;
      ny = -ny;
    }
    var onBorder =
      (Math.abs(p[0]) < border && Math.abs(q[0]) < border) ||
      (Math.abs(p[1]) < border && Math.abs(q[1]) < border) ||
      (Math.abs(p[0] - w) < border && Math.abs(q[0] - w) < border) ||
      (Math.abs(p[1] - h) < border && Math.abs(q[1] - h) < border);
    if (onBorder) {
      lines.push({ px: p[0], py: p[1], dx: ux, dy: uy, border: true });
      continue;
    }
    var pos = [];
    var neg = [];
    var N = 56;
    var step = R > 40 ? 1 : 0.5;
    for (var t = 1; t < N; t++) {
      var f = 0.06 + (0.88 * t) / N;
      var bx = p[0] + dx * f;
      var by = p[1] + dy * f;
      var bestP = 0;
      var bestPS = null;
      var bestN = 0;
      var bestNS = null;
      for (var sv = -R; sv <= R; sv += step) {
        var a = bilinear(gray, w, h, bx + nx * (sv - 1.5), by + ny * (sv - 1.5));
        var b = bilinear(gray, w, h, bx + nx * (sv + 1.5), by + ny * (sv + 1.5));
        if (a < 0 || b < 0) continue;
        // prefer steps close to the coarse line a little (ties -> nearest)
        var g = (b - a) * (1 - (0.35 * Math.abs(sv)) / R);
        if (g > bestP) {
          bestP = g;
          bestPS = sv;
        }
        if (-g > bestN) {
          bestN = -g;
          bestNS = sv;
        }
      }
      if (bestPS !== null && bestP > 7) pos.push([bx + nx * bestPS, by + ny * bestPS, bestP, f]);
      if (bestNS !== null && bestN > 7) neg.push([bx + nx * bestNS, by + ny * bestNS, bestN, f]);
    }
    // polarity: the one with more (and stronger) votes
    var sp = 0;
    var sn = 0;
    for (var k1 = 0; k1 < pos.length; k1++) sp += pos[k1][2];
    for (var k2 = 0; k2 < neg.length; k2++) sn += neg[k2][2];
    var found = sp >= sn ? pos : neg;
    if (found.length < N * 0.35) return null;
    var line = fitLine(found);
    if (!line) return null;
    // Curled sheets bow; then the corners are better found from the side's
    // ends than from one straight fit through the bulge.
    line.head = null;
    line.tail = null;
    var dev = 0;
    for (var k3 = 0; k3 < found.length; k3++) {
      var r0 = (found[k3][0] - line.px) * -line.dy + (found[k3][1] - line.py) * line.dx;
      var wgt = Math.sin(Math.PI * found[k3][3]);
      dev += r0 * (wgt - 0.64);
    }
    dev = Math.abs(dev / Math.max(1, found.length));
    if (dev > 0.25) {
      var headPts = found.filter(function (pp) {
        return pp[3] < 0.38;
      });
      var tailPts = found.filter(function (pp) {
        return pp[3] > 0.62;
      });
      if (headPts.length >= 8) line.head = fitLine(headPts);
      if (tailPts.length >= 8) line.tail = fitLine(tailPts);
    }
    lines.push(line);
  }
  var out = [];
  for (var c = 0; c < 4; c++) {
    var Lin = lines[(c + 3) % 4];
    var Lout = lines[c];
    var pt = intersect(Lin.tail || Lin, Lout.head || Lout);
    if (!pt) return null;
    var d = Math.hypot(pt[0] - quad[c][0], pt[1] - quad[c][1]);
    if (d > R * 2.5) return null;
    moved = Math.max(moved, d);
    out.push([Math.max(0, Math.min(w, pt[0])), Math.max(0, Math.min(h, pt[1]))]);
  }
  return isConvexQuad(out) ? out : null;
}

/** Least-squares line through points with two rounds of outlier rejection. */
function fitLine(pts) {
  function fit(ps) {
    var n = ps.length;
    var mx = 0;
    var my = 0;
    for (var i = 0; i < n; i++) {
      mx += ps[i][0] / n;
      my += ps[i][1] / n;
    }
    var sxx = 0;
    var syy = 0;
    var sxy = 0;
    for (var j = 0; j < n; j++) {
      var dx = ps[j][0] - mx;
      var dy = ps[j][1] - my;
      sxx += dx * dx;
      syy += dy * dy;
      sxy += dx * dy;
    }
    var ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    return { px: mx, py: my, dx: Math.cos(ang), dy: Math.sin(ang) };
  }
  var l = fit(pts);
  var keep = pts;
  for (var round = 0; round < 2; round++) {
    var res = keep.map(function (p) {
      return Math.abs((p[0] - l.px) * -l.dy + (p[1] - l.py) * l.dx);
    });
    var sorted = res.slice().sort(function (a, b) {
      return a - b;
    });
    var cut = Math.max(1.2, sorted[Math.floor(sorted.length * 0.6)] * 2.5);
    var next = keep.filter(function (_, i) {
      return res[i] <= cut;
    });
    if (next.length < 6) return null;
    keep = next;
    l = fit(keep);
  }
  return l;
}

function intersect(a, b) {
  var den = a.dx * b.dy - a.dy * b.dx;
  if (Math.abs(den) < 1e-6) return null;
  var t = ((b.px - a.px) * b.dy - (b.py - a.py) * b.dx) / den;
  return [a.px + a.dx * t, a.py + a.dy * t];
}

/**
 * Real width/height ratio of the rectangle seen as quad q (tl,tr,br,bl) by a
 * pinhole camera with the principal point at the image centre (Zhang & He,
 * "Whiteboard scanning and image enhancement"). Corrects the foreshortening
 * that the max-of-opposite-sides guess leaves in tilted shots. Returns null
 * when the estimate is unreliable (near-parallel sides or implausible focal).
 */
function estimateAspect(q, imgW, imgH) {
  var u0 = imgW / 2;
  var v0 = imgH / 2;
  // paper notation: m1=tl, m2=tr, m3=bl, m4=br (homogeneous)
  var m1 = [q[0][0], q[0][1], 1];
  var m2 = [q[1][0], q[1][1], 1];
  var m3 = [q[3][0], q[3][1], 1];
  var m4 = [q[2][0], q[2][1], 1];
  function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  }
  function dot(a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  }
  var c14 = cross(m1, m4);
  var k2 = dot(c14, m3) / dot(cross(m2, m4), m3);
  var k3 = dot(c14, m2) / dot(cross(m3, m4), m2);
  var n2 = [k2 * m2[0] - m1[0], k2 * m2[1] - m1[1], k2 * m2[2] - m1[2]];
  var n3 = [k3 * m3[0] - m1[0], k3 * m3[1] - m1[1], k3 * m3[2] - m1[2]];
  var diag = Math.hypot(imgW, imgH);
  // Nearly fronto-parallel: perspective terms vanish, affine ratio is exact.
  if (Math.abs(n2[2]) < 1e-3 || Math.abs(n3[2]) < 1e-3 || Math.abs(n2[2] * n3[2]) < 1e-6) return null;
  var f2 =
    -(
      n2[0] * n3[0] -
      (n2[0] * n3[2] + n2[2] * n3[0]) * u0 +
      n2[2] * n3[2] * u0 * u0 +
      (n2[1] * n3[1] - (n2[1] * n3[2] + n2[2] * n3[1]) * v0 + n2[2] * n3[2] * v0 * v0)
    ) /
    (n2[2] * n3[2]);
  if (!(f2 > 0)) return null;
  var fl = Math.sqrt(f2);
  if (fl < 0.35 * diag || fl > 6 * diag) return null; // not a plausible phone lens
  function norm(n) {
    // n^T (A^-T A^-1) n with A = [[f,0,u0],[0,f,v0],[0,0,1]]
    var a = n[0] - u0 * n[2];
    var b = n[1] - v0 * n[2];
    return (a * a + b * b) / f2 + n[2] * n[2];
  }
  var r = Math.sqrt(norm(n2) / norm(n3));
  return isFinite(r) && r > 0 ? r : null;
}

function polyArea(q) {
  var a = 0;
  for (var i = 0; i < q.length; i++) {
    var j = (i + 1) % q.length;
    a += q[i][0] * q[j][1] - q[j][0] * q[i][1];
  }
  return Math.abs(a) / 2;
}

function dist(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function matToPoints(m) {
  var out = [];
  var d = m.data32S;
  for (var i = 0; i < m.rows; i++) out.push([d[i * 2], d[i * 2 + 1]]);
  return out;
}

function medianOf(gray) {
  return percentileOf(gray.data, 0.5);
}

function percentileOf(d, p, stride, offset) {
  var hist = new Uint32Array(256);
  stride = stride || 1;
  offset = offset || 0;
  var n = 0;
  for (var i = offset; i < d.length; i += stride) {
    hist[d[i]]++;
    n++;
  }
  var target = n * p;
  var acc = 0;
  for (var v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= target) return v;
  }
  return 255;
}

function lineThrough(a, b) {
  var dx = b[0] - a[0];
  var dy = b[1] - a[1];
  var l = Math.hypot(dx, dy) || 1;
  return { px: a[0], py: a[1], dx: dx / l, dy: dy / l };
}

/* ------------------------------ detection -------------------------------- */

/**
 * Quads from a polygon with 4..8 vertices: a 4-gon as is; for 5-8 vertices
 * (a corner cut by the frame, a dog-ear, a thumb) try every choice of 4 sides
 * and intersect them; keep convex results that cover the polygon well.
 */
function quadsFromPoly(poly, w, h) {
  var n = poly.length;
  if (n === 4) return [poly];
  if (n < 4 || n > 8) return [];
  var area = polyArea(poly);
  var sides = [];
  for (var i = 0; i < n; i++) sides.push({ i: i, len: dist(poly[i], poly[(i + 1) % n]), line: lineThrough(poly[i], poly[(i + 1) % n]) });
  var out = [];
  for (var a = 0; a < n; a++)
    for (var b = a + 1; b < n; b++)
      for (var c = b + 1; c < n; c++)
        for (var d = c + 1; d < n; d++) {
          var ss = [sides[a], sides[b], sides[c], sides[d]];
          var q = [];
          var ok = true;
          for (var k = 0; k < 4 && ok; k++) {
            var pt = intersect(ss[k].line, ss[(k + 1) % 4].line);
            if (!pt || pt[0] < -0.25 * w || pt[0] > 1.25 * w || pt[1] < -0.25 * h || pt[1] > 1.25 * h) ok = false;
            else q.push(pt);
          }
          if (!ok || !isConvexQuad(q)) continue;
          var qa = polyArea(q);
          if (qa < area * 0.97 || qa > area * 1.25) continue;
          out.push(q);
        }
  return out;
}

/** Collect quad candidates from the contours of a binary/edge image. */
function collectQuads(cv, bin, minArea, mode, w, h, out) {
  var contours = new cv.MatVector();
  var hier = new cv.Mat();
  cv.findContours(bin, contours, hier, mode, cv.CHAIN_APPROX_SIMPLE);
  var n = contours.size();
  // only the biggest few contours matter
  var items = [];
  for (var i = 0; i < n; i++) {
    var c = contours.get(i);
    var area = cv.contourArea(c);
    if (area >= minArea) items.push({ c: c, area: area });
    else c.delete();
  }
  items.sort(function (a, b) {
    return b.area - a.area;
  });
  for (var j = 0; j < items.length; j++) {
    var it = items[j];
    if (j < 8) {
      var hull = new cv.Mat();
      cv.convexHull(it.c, hull, false, true);
      var peri = cv.arcLength(hull, true);
      var eps = [0.006, 0.012, 0.02, 0.035, 0.06];
      var seen = 0;
      for (var k = 0; k < eps.length; k++) {
        var approx = new cv.Mat();
        cv.approxPolyDP(hull, approx, eps[k] * peri, true);
        if (approx.rows >= 4 && approx.rows <= 8) {
          var qs = quadsFromPoly(matToPoints(approx), w, h);
          for (var m = 0; m < qs.length; m++) out.push(qs[m]);
          if (approx.rows === 4) seen++;
        }
        approx.delete();
        if (seen >= 3) break;
      }
      hull.delete();
    }
    it.c.delete();
  }
  contours.delete();
  hier.delete();
}

/** Merge HoughLinesP segments into long lines and build quads from 2+2 of them. */
function quadsFromLines(cv, edges, w, h, out) {
  var lines = new cv.Mat();
  var minLen = Math.min(w, h) * 0.12;
  cv.HoughLinesP(edges, lines, 1, Math.PI / 180, Math.round(Math.min(w, h) * 0.08), minLen, Math.max(w, h) * 0.02);
  var segs = [];
  var d = lines.data32S;
  for (var i = 0; i < lines.rows; i++) {
    var x1 = d[i * 4];
    var y1 = d[i * 4 + 1];
    var x2 = d[i * 4 + 2];
    var y2 = d[i * 4 + 3];
    var th = Math.atan2(y2 - y1, x2 - x1);
    if (th < 0) th += Math.PI;
    if (th >= Math.PI) th -= Math.PI;
    var nx = -Math.sin(th);
    var ny = Math.cos(th);
    segs.push({ th: th, rho: x1 * nx + y1 * ny, len: Math.hypot(x2 - x1, y2 - y1), a: [x1, y1], b: [x2, y2] });
  }
  lines.delete();
  // cluster collinear segments
  segs.sort(function (a, b) {
    return b.len - a.len;
  });
  var groups = [];
  for (var s = 0; s < segs.length; s++) {
    var g = null;
    for (var k = 0; k < groups.length && !g; k++) {
      var G = groups[k];
      var dth = Math.abs(G.th - segs[s].th);
      dth = Math.min(dth, Math.PI - dth);
      if (dth > (4 * Math.PI) / 180) continue;
      // distance of the segment midpoint to the group line
      var mx = (segs[s].a[0] + segs[s].b[0]) / 2;
      var my = (segs[s].a[1] + segs[s].b[1]) / 2;
      var dd = Math.abs((mx - G.px) * -Math.sin(G.th) + (my - G.py) * Math.cos(G.th));
      if (dd < Math.max(w, h) * 0.012) g = G;
    }
    if (g) {
      g.len += segs[s].len;
      g.pts.push(segs[s].a, segs[s].b);
    } else
      groups.push({
        th: segs[s].th,
        px: (segs[s].a[0] + segs[s].b[0]) / 2,
        py: (segs[s].a[1] + segs[s].b[1]) / 2,
        len: segs[s].len,
        pts: [segs[s].a, segs[s].b],
      });
  }
  groups.sort(function (a, b) {
    return b.len - a.len;
  });
  groups = groups.slice(0, 20).map(function (G) {
    return { th: G.th, line: { px: G.px, py: G.py, dx: Math.cos(G.th), dy: Math.sin(G.th) } };
  });
  var minSep = Math.min(w, h) * 0.18;
  var pairs = [];
  for (var a = 0; a < groups.length; a++)
    for (var b = a + 1; b < groups.length; b++) {
      var dt = Math.abs(groups[a].th - groups[b].th);
      dt = Math.min(dt, Math.PI - dt);
      if (dt > (30 * Math.PI) / 180) continue;
      var L1 = groups[a].line;
      var L2 = groups[b].line;
      var sep = Math.abs((L2.px - L1.px) * -L1.dy + (L2.py - L1.py) * L1.dx);
      if (sep < minSep) continue;
      pairs.push([groups[a], groups[b]]);
    }
  for (var p = 0; p < pairs.length; p++)
    for (var q = p + 1; q < pairs.length; q++) {
      var A = pairs[p];
      var B = pairs[q];
      var dAB = Math.abs(A[0].th - B[0].th);
      dAB = Math.min(dAB, Math.PI - dAB);
      if (dAB < (45 * Math.PI) / 180) continue;
      if (A[0] === B[0] || A[0] === B[1] || A[1] === B[0] || A[1] === B[1]) continue;
      var pts = [
        intersect(A[0].line, B[0].line),
        intersect(A[0].line, B[1].line),
        intersect(A[1].line, B[0].line),
        intersect(A[1].line, B[1].line),
      ];
      var ok = true;
      for (var z = 0; z < 4; z++) {
        var P = pts[z];
        if (!P || P[0] < -0.2 * w || P[0] > 1.2 * w || P[1] < -0.2 * h || P[1] > 1.2 * h) ok = false;
      }
      if (!ok) continue;
      out.push(orderQuad(pts));
    }
}

/** True when every corner of `inner` lies inside convex `outer` (tolerance px). */
function containsQuad(outer, inner, tol) {
  var o = isClockwise(outer) ? outer : outer.slice().reverse();
  for (var i = 0; i < 4; i++) {
    var p = inner[i];
    for (var k = 0; k < 4; k++) {
      var a = o[k];
      var b = o[(k + 1) % 4];
      var len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      // signed distance, positive = inside for a clockwise (y-down) polygon
      var sd = ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) / len;
      if (sd < -tol) return false;
    }
  }
  return true;
}

/** How many sides of `outer` keep at least `gap` px away from all of `inner`. */
function sidesClear(outer, inner, gap) {
  var o = isClockwise(outer) ? outer : outer.slice().reverse();
  var n = 0;
  for (var k = 0; k < 4; k++) {
    var a = o[k];
    var b = o[(k + 1) % 4];
    var len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    var mn = Infinity;
    for (var i = 0; i < 4; i++) {
      var p = inner[i];
      mn = Math.min(mn, ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) / len);
    }
    if (mn >= gap) n++;
  }
  return n;
}

function isClockwise(q) {
  var a = 0;
  for (var i = 0; i < q.length; i++) {
    var j = (i + 1) % q.length;
    a += q[i][0] * q[j][1] - q[j][0] * q[i][1];
  }
  return a > 0;
}

/**
 * Bring a quad that pokes out of the frame (page partly out of shot) inside
 * it: each outside corner slides along one of its sides to the frame border
 * (the side that gives the larger result), else it is clamped.
 */
function fitToFrame(q, w, h) {
  function inF(p) {
    return p[0] >= -0.5 && p[1] >= -0.5 && p[0] <= w + 0.5 && p[1] <= h + 0.5;
  }
  function toBorder(a, b) {
    // point on segment a(outside)->b(inside) where it enters the frame
    var lo = 0;
    var hi = 1;
    for (var it = 0; it < 30; it++) {
      var m = (lo + hi) / 2;
      var p = [a[0] + (b[0] - a[0]) * m, a[1] + (b[1] - a[1]) * m];
      if (inF(p)) hi = m;
      else lo = m;
    }
    return [a[0] + (b[0] - a[0]) * hi, a[1] + (b[1] - a[1]) * hi];
  }
  var out = q.map(function (p) {
    return p.slice();
  });
  for (var i = 0; i < 4; i++) {
    if (inF(q[i])) continue;
    var prev = q[(i + 3) % 4];
    var next = q[(i + 1) % 4];
    var opts = [];
    if (inF(prev)) opts.push(toBorder(q[i], prev));
    if (inF(next)) opts.push(toBorder(q[i], next));
    var bestP = null;
    var bestA = -1;
    for (var k = 0; k < opts.length; k++) {
      var t = out.slice();
      t[i] = opts[k];
      var a = polyArea(t);
      if (a > bestA) {
        bestA = a;
        bestP = opts[k];
      }
    }
    out[i] = bestP || [Math.max(0, Math.min(w, q[i][0])), Math.max(0, Math.min(h, q[i][1]))];
  }
  return out.map(function (p) {
    return [Math.max(0, Math.min(w, p[0])), Math.max(0, Math.min(h, p[1]))];
  });
}

/**
 * Score a candidate: how much of its outline lies on image edges, weighted
 * by size. Sides on the frame border count partially (page out of frame).
 */
function scoreQuad(q, edge, w, h, grad) {
  if (!isConvexQuad(q)) return null;
  var area = polyArea(q);
  var inside = polyArea(fitToFrame(q, w, h));
  // a page partly out of frame is fine, a quad mostly outside is not
  if (inside < area * 0.8) return null;
  var frac = inside / (w * h);
  if (frac < 0.04 || frac > 0.985) return null;
  var ang = quadAngles(q);
  for (var i = 0; i < 4; i++) if (ang[i] < 38 || ang[i] > 142) return null;
  // opposite sides should not be wildly different (strong perspective is ok)
  var s0 = dist(q[0], q[1]);
  var s1 = dist(q[1], q[2]);
  var s2 = dist(q[2], q[3]);
  var s3 = dist(q[3], q[0]);
  if (Math.min(s0, s2) / Math.max(s0, s2) < 0.4 || Math.min(s1, s3) / Math.max(s1, s3) < 0.4) return null;
  if (Math.min(s0, s1, s2, s3) < Math.min(w, h) * 0.1) return null;
  var d = edge.data;
  var bd = Math.max(2, Math.round(Math.max(w, h) * 0.006));
  var tolR = Math.max(2, Math.round(Math.max(w, h) * 0.009));
  var sideSupport = [];
  var borderSides = 0;
  for (var sIdx = 0; sIdx < 4; sIdx++) {
    var a = q[sIdx];
    var b = q[(sIdx + 1) % 4];
    var sl = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    var nx = -(b[1] - a[1]) / sl;
    var ny = (b[0] - a[0]) / sl;
    var N = 40;
    var hit = 0;
    var border = 0;
    // an edge pixel counts when its gradient is (roughly) across the side,
    // so textured backgrounds (wood grain, clutter) do not vote for any line
    var aligned = function (xx, yy) {
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) return false;
      var o2 = yy * w + xx;
      if (!d[o2]) return false;
      if (!grad) return true;
      var gx = grad.gx[o2];
      var gy = grad.gy[o2];
      var m = Math.abs(gx) + Math.abs(gy);
      if (m < 4) return true;
      return Math.abs(gx * nx + gy * ny) >= 0.8 * Math.hypot(gx, gy);
    };
    for (var t = 0; t < N; t++) {
      var f = 0.05 + (0.9 * (t + 0.5)) / N;
      var x = Math.round(a[0] + (b[0] - a[0]) * f);
      var y = Math.round(a[1] + (b[1] - a[1]) * f);
      if (x <= bd || y <= bd || x >= w - 1 - bd || y >= h - 1 - bd) {
        // on or beyond the frame border: no evidence either way
        border++;
        continue;
      }
      // tolerate slightly bowed (curled) sides: look a few px along the normal
      var hv = 0;
      for (var o = 0; o <= tolR && !hv; o++) {
        var xa = Math.round(x + nx * o);
        var ya = Math.round(y + ny * o);
        var xb = Math.round(x - nx * o);
        var yb = Math.round(y - ny * o);
        if (aligned(xa, ya) || aligned(xb, yb)) hv = o <= 1 ? 1 : 1 - (0.5 * (o - 1)) / tolR;
      }
      hit += hv;
    }
    if (border > N * 0.6) {
      borderSides++;
      sideSupport.push(0.55);
    } else sideSupport.push(hit / Math.max(1, N - border));
  }
  if (borderSides > 2) return null;
  var mean = (sideSupport[0] + sideSupport[1] + sideSupport[2] + sideSupport[3]) / 4;
  var min = Math.min(sideSupport[0], sideSupport[1], sideSupport[2], sideSupport[3]);
  var support = 0.6 * mean + 0.4 * min;
  if (support < 0.35) return null;
  // right-ish angles are more likely for a photographed page
  var angPen = 0;
  for (var j = 0; j < 4; j++) angPen += Math.abs(ang[j] - 90);
  var angF = 1 - Math.min(0.25, angPen / 4 / 200);
  var vis = 0;
  for (var v = 0; v < 4; v++) vis += sideSupport[v] === 0.55 && borderSides ? 0 : sideSupport[v];
  vis /= 4 - borderSides;
  return { support: support, vis: vis, min: min, sides: sideSupport, border: borderSides, frac: frac, score: support * support * Math.sqrt(frac) * angF };
}

/**
 * Detect a document quad in an RGBA image (ideally 360..640 px long edge).
 * opts.thorough: run every pass (still photos); otherwise stop after the
 * cheap passes when a confident candidate was found (live preview).
 * Returns {quad (normalised), score, support} or null.
 */
function detectQuad(cv, data, width, height, opts) {
  opts = opts || {};
  var thorough = !!opts.thorough;
  var src = new cv.Mat(height, width, cv.CV_8UC4);
  src.data.set(data);
  var mats = [];
  function M() {
    var m = new cv.Mat();
    mats.push(m);
    return m;
  }
  var kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
  var cands = [];
  var best = null;
  var w = width;
  var h = height;
  var minArea = w * h * 0.04;
  try {
    var rgb = M();
    cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
    var gray = M();
    cv.cvtColor(rgb, gray, cv.COLOR_RGB2GRAY);
    var blur = M();
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);

    // Scoring edge map: low-threshold Canny on gray + saturation, slightly thickened.
    var hsv = M();
    cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
    var ch = new cv.MatVector();
    cv.split(hsv, ch);
    var sat = M();
    ch.get(1).copyTo(sat);
    ch.delete();
    cv.GaussianBlur(sat, sat, new cv.Size(5, 5), 0);
    var scoreEdges = M();
    cv.Canny(blur, scoreEdges, 12, 36);
    var satEdges = M();
    cv.Canny(sat, satEdges, 16, 48);
    cv.bitwise_or(scoreEdges, satEdges, scoreEdges);
    cv.dilate(scoreEdges, scoreEdges, kernel, new cv.Point(-1, -1), 1);
    var gxM = M();
    var gyM = M();
    cv.Sobel(blur, gxM, cv.CV_16S, 1, 0, 3);
    cv.Sobel(blur, gyM, cv.CV_16S, 0, 1, 3);
    // copies: views into the WASM heap detach when later allocations grow it
    var grad = { gx: new Int16Array(gxM.data16S), gy: new Int16Array(gyM.data16S) };

    var scored = [];
    function evaluate(start) {
      for (var i = start; i < cands.length; i++) {
        var q = orderQuad(cands[i]);
        var s = scoreQuad(q, scoreEdges, w, h, grad);
        if (!s) continue;
        var c = { quad: q, score: s.score, support: s.support, vis: s.vis, frac: s.frac, min: s.min, sides: s.sides, border: s.border };
        scored.push(c);
        if (!best || c.score > best.score) best = c;
      }
      // A page with a printed border / table / grid gives a perfect inner
      // rectangle; the real sheet edge around it wins if it is supported.
      for (var guard = 0; best && guard < 4; guard++) {
        var outer = null;
        for (var k = 0; k < scored.length; k++) {
          var o = scored[k];
          if (o.frac < best.frac * 1.06 || o.vis < Math.max(0.6, best.support * 0.8) || o.score < best.score * 0.45) continue;
          var sideOk = true;
          for (var sd = 0; sd < 4; sd++) if (o.sides[sd] !== 0.55 && o.sides[sd] < 0.5) sideOk = false;
          if (!sideOk) continue;
          if (o.border > 1 && o.border > best.border) continue;
          if (o.border > 0 && !best.border) {
            // a sheet running out of frame: its visible sides must be clean
            var strong = true;
            for (var sb = 0; sb < 4; sb++) if (o.sides[sb] !== 0.55 && o.sides[sb] < 0.8) strong = false;
            if (!strong) continue;
          }
          // strictly around it (all four sides), not the same box with one
          // side extended along some background line
          if (!containsQuad(o.quad, best.quad, Math.max(w, h) * 0.01)) continue;
          if (sidesClear(o.quad, best.quad, Math.max(w, h) * 0.012) < 2) continue;
          if (!outer || o.score > outer.score) outer = o;
        }
        if (!outer) break;
        best = outer;
      }
      return cands.length;
    }
    function edgePass(img, lo, hi, iters) {
      var e = M();
      cv.Canny(img, e, lo, hi);
      cv.morphologyEx(e, e, cv.MORPH_CLOSE, kernel, new cv.Point(-1, -1), iters || 2);
      collectQuads(cv, e, minArea, cv.RETR_LIST, w, h, cands);
      return e;
    }
    var done = 0;
    // 1) Canny with auto thresholds from the median
    var med = medianOf(blur);
    var lo = Math.max(10, 0.66 * med);
    var hi = Math.min(255, Math.max(lo + 30, 1.33 * med));
    var e1 = edgePass(blur, lo, hi, 2);
    // 2) Otsu (bright paper on a darker background, or the reverse)
    var bin = M();
    cv.threshold(blur, bin, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    cv.morphologyEx(bin, bin, cv.MORPH_CLOSE, kernel, new cv.Point(-1, -1), 2);
    collectQuads(cv, bin, minArea, cv.RETR_EXTERNAL, w, h, cands);
    done = evaluate(done);
    if (!thorough && best && best.support > 0.8 && best.frac > 0.12) return finish();

    // 3) low thresholds (white page on a light table)
    var e3 = edgePass(blur, 8, 24, 2);
    // 4) saturation edges (white paper on a coloured/wooden surface)
    edgePass(sat, 14, 42, 2);
    // 5) whiteness: bright and unsaturated
    var white = M();
    cv.subtract(blur, sat, white);
    var binW = M();
    cv.threshold(white, binW, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    cv.morphologyEx(binW, binW, cv.MORPH_OPEN, kernel, new cv.Point(-1, -1), 2);
    collectQuads(cv, binW, minArea, cv.RETR_EXTERNAL, w, h, cands);
    done = evaluate(done);
    if (!thorough && best && best.support > 0.7) return finish();

    // 6) adaptive threshold on a heavy blur: local brightness steps
    var blur2 = M();
    cv.GaussianBlur(gray, blur2, new cv.Size(9, 9), 0);
    var ad = M();
    cv.adaptiveThreshold(blur2, ad, 255, cv.ADAPTIVE_THRESH_MEAN_C, cv.THRESH_BINARY, odd(Math.max(w, h) / 6), -4);
    cv.morphologyEx(ad, ad, cv.MORPH_OPEN, kernel, new cv.Point(-1, -1), 2);
    collectQuads(cv, ad, minArea, cv.RETR_EXTERNAL, w, h, cands);
    // 7) high thresholds (busy background: only strong edges)
    edgePass(blur, 60, 160, 1);
    done = evaluate(done);

    // 8) line fit: intersect 4 dominant lines when contours are broken
    if (thorough || !best || best.support < 0.6) {
      var lineEdges = M();
      cv.bitwise_or(e1, e3, lineEdges);
      quadsFromLines(cv, lineEdges, w, h, cands);
      done = evaluate(done);
    }
    return finish();
  } finally {
    src.delete();
    kernel.delete();
    for (var i = 0; i < mats.length; i++) mats[i].delete();
  }
  function finish() {
    if (opts.debug) opts.debug.scored = scored;
    if (!best) return null;
    return {
      quad: orderQuad(fitToFrame(best.quad, w, h)).map(function (p) {
        return [p[0] / w, p[1] / h];
      }),
      score: best.score,
      support: best.support,
    };
  }
}

/* ------------------------------- filters --------------------------------- */

function odd(n) {
  n = Math.max(3, Math.round(n));
  return n % 2 === 0 ? n + 1 : n;
}

/*
 * All filters share one model: photo = paper(x,y) * reflectance(x,y), where
 * "paper" is the light falling on blank paper (shadows, vignetting, colour
 * cast). It is estimated once on a ~360 px copy and the full-size image is
 * divided by it in a single fused JS pass (OpenCV.js has no SIMD/threads, a
 * plain typed-array loop is several times faster than chaining cv ops on a
 * 12 MP page).
 */
var BG_EDGE = 360;

/**
 * Paper background of an RGBA page at ~BG_EDGE px: {bg: Float32Array(sw*sh*3),
 * w, h, small: Uint8Array RGB, paper: [r,g,b]}. Ink is removed with a grey
 * dilation; areas that are not paper (photos, colour blocks, black bars) get
 * a low weight from brightness / chroma / texture cues and are filled in
 * from the surrounding paper by multi-scale normalised convolution, so they
 * are not flattened. Smooth shadows keep paper chroma and are followed,
 * which is what removes them.
 */
function estimatePaper(cv, rgba) {
  var f = BG_EDGE / Math.max(rgba.cols, rgba.rows);
  var sw = Math.max(16, Math.round(rgba.cols * f));
  var sh = Math.max(16, Math.round(rgba.rows * f));
  // block average from a 4x4 grid of samples per cell (INTER_AREA on 12 MP
  // costs ~150 ms in OpenCV.js; this is a few ms and just as good here)
  var rgb = new cv.Mat(sh, sw, cv.CV_8UC3);
  var rd = rgb.data;
  var sd0 = rgba.data;
  var SW = rgba.cols;
  var SH = rgba.rows;
  for (var cy = 0; cy < sh; cy++) {
    for (var cx = 0; cx < sw; cx++) {
      var ar = 0;
      var ag = 0;
      var ab = 0;
      for (var sy = 0; sy < 4; sy++) {
        var py = Math.min(SH - 1, Math.floor(((cy + (sy + 0.5) / 4) * SH) / sh));
        for (var sx = 0; sx < 4; sx++) {
          var px = Math.min(SW - 1, Math.floor(((cx + (sx + 0.5) / 4) * SW) / sw));
          var so = (py * SW + px) * 4;
          ar += sd0[so];
          ag += sd0[so + 1];
          ab += sd0[so + 2];
        }
      }
      var ro = (cy * sw + cx) * 3;
      rd[ro] = ar >> 4;
      rd[ro + 1] = ag >> 4;
      rd[ro + 2] = ab >> 4;
    }
  }
  // remove ink: dilation (max filter) wider than strokes, then smooth
  var D = new cv.Mat();
  var k = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(odd(BG_EDGE / 45), odd(BG_EDGE / 45)));
  cv.dilate(rgb, D, k);
  k.delete();
  cv.medianBlur(D, D, 5);
  var n = sw * sh;
  var dd = new Uint8Array(D.data);
  // local texture of the background estimate (photos are busy, paper is not)
  var g = new cv.Mat();
  cv.cvtColor(D, g, cv.COLOR_RGB2GRAY);
  var gf = new cv.Mat();
  g.convertTo(gf, cv.CV_32F);
  var mean = new cv.Mat();
  var sq = new cv.Mat();
  var mean2 = new cv.Mat();
  cv.blur(gf, mean, new cv.Size(7, 7));
  cv.multiply(gf, gf, sq);
  cv.blur(sq, mean2, new cv.Size(7, 7));
  // large-scale max brightness for the darkness guard
  var bigK = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(odd(BG_EDGE / 6), odd(BG_EDGE / 6)));
  var lm = new cv.Mat();
  cv.dilate(g, lm, bigK);
  bigK.delete();
  cv.blur(lm, lm, new cv.Size(odd(BG_EDGE / 10), odd(BG_EDGE / 10)));
  // paper chromaticity: median chroma of the brightest third of the page
  var gd = new Uint8Array(g.data);
  var thrBright = percentileOf(gd, 0.6);
  var cr = [];
  var cg = [];
  for (var i0 = 0; i0 < n; i0 += 2) {
    if (gd[i0] < thrBright) continue;
    var s0 = dd[i0 * 3] + dd[i0 * 3 + 1] + dd[i0 * 3 + 2] + 1;
    cr.push(dd[i0 * 3] / s0);
    cg.push(dd[i0 * 3 + 1] / s0);
  }
  cr.sort(function (a, b) {
    return a - b;
  });
  cg.sort(function (a, b) {
    return a - b;
  });
  var pr = cr.length ? cr[cr.length >> 1] : 1 / 3;
  var pg = cg.length ? cg[cg.length >> 1] : 1 / 3;
  var W = new Float32Array(n);
  var md = mean.data32F;
  var m2d = mean2.data32F;
  var lmd = new Uint8Array(lm.data);
  md = new Float32Array(md);
  m2d = new Float32Array(m2d);
  for (var i = 0; i < n; i++) {
    var v = m2d[i] - md[i] * md[i];
    var sdv = v > 0 ? Math.sqrt(v) : 0;
    var smooth = 1 / (1 + (sdv / 7) * (sdv / 7));
    var r = gd[i] / Math.max(1, lmd[i]);
    var dark = r > 0.45 ? 1 : Math.max(0, (r - 0.25) / 0.2);
    var s = dd[i * 3] + dd[i * 3 + 1] + dd[i * 3 + 2] + 1;
    var dc = Math.hypot(dd[i * 3] / s - pr, dd[i * 3 + 1] / s - pg);
    // shadows shift chroma a little (bluish), photos / colour blocks a lot
    var chroma = 1 / (1 + Math.pow(Math.max(0, dc - 0.012) / 0.018, 2));
    W[i] = 0.002 + smooth * dark * chroma;
  }
  g.delete();
  gf.delete();
  mean.delete();
  sq.delete();
  mean2.delete();
  lm.delete();
  // normalised convolution at 3 scales: fine where paper is dense, coarse
  // where it has to bridge a photo or a block
  var Wm = cv.matFromArray(sh, sw, cv.CV_32F, W);
  var num = new cv.Mat(sh, sw, cv.CV_32FC3);
  var nd = num.data32F; // no allocation until the loop is done
  for (var j = 0; j < n; j++) {
    nd[j * 3] = dd[j * 3] * W[j];
    nd[j * 3 + 1] = dd[j * 3 + 1] * W[j];
    nd[j * 3 + 2] = dd[j * 3 + 2] * W[j];
  }
  var sig = [BG_EDGE / 120, BG_EDGE / 30, BG_EDGE / 8];
  var outs = [];
  var dens = [];
  for (var sI = 0; sI < sig.length; sI++) {
    var n1 = new cv.Mat();
    var d1 = new cv.Mat();
    gaussLike(cv, num, n1, sig[sI]);
    gaussLike(cv, Wm, d1, sig[sI]);
    outs.push(n1);
    dens.push(d1);
  }
  var bg = new Float32Array(n * 3);
  var o0 = outs[0].data32F;
  var o1 = outs[1].data32F;
  var o2 = outs[2].data32F;
  var e0 = dens[0].data32F;
  var e1 = dens[1].data32F;
  var e2 = dens[2].data32F;
  for (var p = 0; p < n; p++) {
    var a0 = Math.min(1, e0[p] / 0.45);
    var a1 = Math.min(1, e1[p] / 0.3);
    for (var c = 0; c < 3; c++) {
      var q = p * 3 + c;
      var v2 = o2[q] / Math.max(1e-6, e2[p]);
      var v1 = e1[p] > 1e-6 ? o1[q] / e1[p] : v2;
      var v0 = e0[p] > 1e-6 ? o0[q] / e0[p] : v1;
      bg[q] = Math.max(24, a0 * v0 + (1 - a0) * (a1 * v1 + (1 - a1) * v2));
    }
  }
  for (var z = 0; z < 3; z++) {
    outs[z].delete();
    dens[z].delete();
  }
  num.delete();
  Wm.delete();
  D.delete();
  var smallRGB = new Uint8Array(rgb.data);
  rgb.delete();
  return { bg: bg, w: sw, h: sh, small: smallRGB };
}

/** Gaussian blur; large sigmas via three box blurs (O(1) per pixel). */
function gaussLike(cv, src, dst, sigma) {
  if (sigma < 4) {
    cv.GaussianBlur(src, dst, new cv.Size(0, 0), sigma, sigma, cv.BORDER_REFLECT);
    return;
  }
  var w = Math.max(3, Math.round(Math.sqrt(4 * sigma * sigma + 1)));
  if (w % 2 === 0) w++;
  var k = new cv.Size(w, w);
  var a = new cv.Point(-1, -1);
  cv.blur(src, dst, k, a, cv.BORDER_REFLECT);
  cv.blur(dst, dst, k, a, cv.BORDER_REFLECT);
  cv.blur(dst, dst, k, a, cv.BORDER_REFLECT);
}

/**
 * Row-wise bilinear upsampler for the small background: fill(y, row) writes
 * 3 reciprocal values (K / bg) per output pixel of row y into row
 * (Float32Array(W*3)). Cheap: one lerp per value.
 */
function bgSampler(paper, W, H, K, sqrt) {
  var sw = paper.w;
  var sh = paper.h;
  var bg = paper.bg;
  var x0 = new Int32Array(W);
  var wx = new Float32Array(W);
  for (var x = 0; x < W; x++) {
    var fx = ((x + 0.5) * sw) / W - 0.5;
    if (fx < 0) fx = 0;
    if (fx > sw - 1) fx = sw - 1;
    var i = Math.min(sw - 2, Math.floor(fx));
    x0[x] = i < 0 ? 0 : i;
    wx[x] = sw > 1 ? fx - x0[x] : 0;
  }
  var srow = new Float32Array(sw * 3);
  // the background is smooth over >= 30 full-res px: recompute every few rows
  var every = Math.max(1, Math.min(4, Math.floor(H / sh / 3)));
  var last = -1;
  return function (y, row) {
    var yq = y - (y % every);
    if (yq === last) return;
    last = yq;
    var fy = ((yq + every / 2) * sh) / H - 0.5;
    if (fy < 0) fy = 0;
    if (fy > sh - 1) fy = sh - 1;
    var y0 = Math.min(sh - 2, Math.floor(fy));
    if (y0 < 0) y0 = 0;
    var wy = sh > 1 ? fy - y0 : 0;
    var a = y0 * sw * 3;
    var b = Math.min(sh - 1, y0 + 1) * sw * 3;
    for (var k = 0; k < sw * 3; k++) srow[k] = bg[a + k] * (1 - wy) + bg[b + k] * wy;
    if (sqrt) for (var k2 = 0; k2 < sw * 3; k2++) srow[k2] = Math.sqrt(srow[k2]);
    for (var xx = 0; xx < W; xx++) {
      var s = x0[xx] * 3;
      var t = wx[xx];
      var u = 1 - t;
      var s2 = sw > 1 ? s + 3 : s;
      row[xx * 3] = K / (srow[s] * u + srow[s2] * t);
      row[xx * 3 + 1] = K / (srow[s + 1] * u + srow[s2 + 1] * t);
      row[xx * 3 + 2] = K / (srow[s + 2] * u + srow[s2 + 2] * t);
    }
  };
}

/** Tone curve over flattened values 0..1023 (=0..255.75): black/white point + gamma. */
function toneTable(black, white, gamma) {
  var t = new Uint8Array(1024);
  for (var i = 0; i < 1024; i++) {
    var v = i / 4;
    var x = (v - black) / Math.max(1, white - black);
    x = x <= 0 ? 0 : x >= 1 ? 1 : Math.pow(x, gamma);
    t[i] = Math.round(255 * x);
  }
  return t;
}

/** Percentiles [0.5%, 50%, 75%] of flattened luminance (small copy). */
function flatStats(paper) {
  var d = paper.small;
  var b = paper.bg;
  var n = paper.w * paper.h;
  var vals = new Uint8Array(n);
  for (var i = 0; i < n; i++) {
    var y = 0.299 * d[i * 3] + 0.587 * d[i * 3 + 1] + 0.114 * d[i * 3 + 2];
    var by = 0.299 * b[i * 3] + 0.587 * b[i * 3 + 1] + 0.114 * b[i * 3 + 2];
    vals[i] = Math.max(0, Math.min(255, (255 * y) / Math.max(1, by)));
  }
  return [percentileOf(vals, 0.005), percentileOf(vals, 0.5), percentileOf(vals, 0.75)];
}

/**
 * In-place unsharp mask on the luminance of an RGBA buffer (3x3 binomial
 * blur), the same delta added to R, G and B so colours do not fringe.
 * Small deltas (paper grain / JPEG noise) are ignored.
 */
function sharpenLuma(d, W, H, amount, thresh) {
  var Y = new Uint8Array(W * H);
  for (var i = 0, j = 0; j < W * H; i += 4, j++) Y[j] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
  var amt = Math.round(amount * 256);
  for (var y = 1; y < H - 1; y++) {
    var r0 = (y - 1) * W;
    var r1 = y * W;
    var r2 = (y + 1) * W;
    for (var x = 1; x < W - 1; x++) {
      var blur =
        (Y[r0 + x - 1] + 2 * Y[r0 + x] + Y[r0 + x + 1] + 2 * Y[r1 + x - 1] + 4 * Y[r1 + x] + 2 * Y[r1 + x + 1] + Y[r2 + x - 1] + 2 * Y[r2 + x] + Y[r2 + x + 1]) >>
        4;
      var delta = Y[r1 + x] - blur;
      if (delta < thresh && delta > -thresh) continue;
      var add = (delta * amt) >> 8;
      var o = (r1 + x) * 4;
      var v0 = d[o] + add;
      var v1 = d[o + 1] + add;
      var v2 = d[o + 2] + add;
      d[o] = v0 < 0 ? 0 : v0 > 255 ? 255 : v0;
      d[o + 1] = v1 < 0 ? 0 : v1 > 255 ? 255 : v1;
      d[o + 2] = v2 < 0 ? 0 : v2 > 255 ? 255 : v2;
    }
  }
}

/* Hot full-resolution loops, kept in small functions so V8 optimises them. */
function magicPass(src, d, W, H, fill, T, satK) {
  d = new Uint8ClampedArray(d.buffer, d.byteOffset, d.length);
  var inv = new Float32Array(W * 3);
  for (var y = 0; y < H; y++) {
    fill(y, inv);
    var o = y * W * 4;
    for (var x = 0; x < W; x++, o += 4) {
      var r = (src[o] * inv[x * 3]) | 0;
      var g = (src[o + 1] * inv[x * 3 + 1]) | 0;
      var b = (src[o + 2] * inv[x * 3 + 2]) | 0;
      r = T[r > 1023 ? 1023 : r];
      g = T[g > 1023 ? 1023 : g];
      b = T[b > 1023 ? 1023 : b];
      var Yv = (r * 77 + g * 150 + b * 29) >> 8;
      // saturation boost, tapered for already vivid colours (no neon)
      var mx = r > g ? (r > b ? r : b) : g > b ? g : b;
      var mn = r < g ? (r < b ? r : b) : g < b ? g : b;
      var k = satK - ((satK - 1) * (mx - mn)) / 255;
      d[o] = Yv + (r - Yv) * k;
      d[o + 1] = Yv + (g - Yv) * k;
      d[o + 2] = Yv + (b - Yv) * k;
      d[o + 3] = 255;
    }
  }
}

function grayPass(src, d, W, H, fill, T) {
  d = new Uint8ClampedArray(d.buffer, d.byteOffset, d.length);
  var inv = new Float32Array(W * 3);
  for (var y = 0; y < H; y++) {
    fill(y, inv);
    var o = y * W * 4;
    for (var x = 0; x < W; x++, o += 4) {
      var v = (src[o] * inv[x * 3] * 0.299 + src[o + 1] * inv[x * 3 + 1] * 0.587 + src[o + 2] * inv[x * 3 + 2] * 0.114) | 0;
      v = T[v > 1023 ? 1023 : v];
      d[o] = v;
      d[o + 1] = v;
      d[o + 2] = v;
      d[o + 3] = 255;
    }
  }
}

function lutPass(src, d, W, H, fill, T) {
  d = new Uint8ClampedArray(d.buffer, d.byteOffset, d.length);
  var inv = new Float32Array(W * 3);
  for (var y = 0; y < H; y++) {
    fill(y, inv);
    var o = y * W * 4;
    for (var x = 0; x < W; x++, o += 4) {
      var v0 = (src[o] * inv[x * 3]) | 0;
      var v1 = (src[o + 1] * inv[x * 3 + 1]) | 0;
      var v2 = (src[o + 2] * inv[x * 3 + 2]) | 0;
      d[o] = T[v0 > 1023 ? 1023 : v0];
      d[o + 1] = T[v1 > 1023 ? 1023 : v1];
      d[o + 2] = T[v2 > 1023 ? 1023 : v2];
      d[o + 3] = 255;
    }
  }
}

function flatPass(src, fd, W, H, fill) {
  var inv = new Float32Array(W * 3);
  for (var y = 0; y < H; y++) {
    fill(y, inv);
    var o = y * W * 4;
    var p = y * W;
    for (var x = 0; x < W; x++, o += 4) {
      var fv = src[o] * inv[x * 3] * 0.299 + src[o + 1] * inv[x * 3 + 1] * 0.587 + src[o + 2] * inv[x * 3 + 2] * 0.114;
      fd[p + x] = fv > 255 ? 255 : fv;
    }
  }
}

/** mask = soft step of (flat - threshold), threshold bilinearly upsampled from (qw x qh). */
function softThreshold(fd, mask, W, H, thr, qw, qh) {
  var row = new Float32Array(W);
  var srow = new Float32Array(qw);
  var x0 = new Int32Array(W);
  var wx = new Float32Array(W);
  for (var x = 0; x < W; x++) {
    var fx = ((x + 0.5) * qw) / W - 0.5;
    if (fx < 0) fx = 0;
    if (fx > qw - 1) fx = qw - 1;
    var i = Math.min(qw - 2, Math.floor(fx));
    x0[x] = i;
    wx[x] = fx - i;
  }
  for (var y = 0; y < H; y++) {
    var fy = ((y + 0.5) * qh) / H - 0.5;
    if (fy < 0) fy = 0;
    if (fy > qh - 1) fy = qh - 1;
    var y0 = Math.min(qh - 2, Math.floor(fy));
    var wy = fy - y0;
    var a = y0 * qw;
    var b = a + qw;
    for (var k = 0; k < qw; k++) srow[k] = thr[a + k] * (1 - wy) + thr[b + k] * wy;
    for (var x2 = 0; x2 < W; x2++) row[x2] = srow[x0[x2]] * (1 - wx[x2]) + srow[x0[x2] + 1] * wx[x2];
    var o = y * W;
    for (var x3 = 0; x3 < W; x3++) {
      // ~6 grey levels of transition on either side of the threshold
      var v = 128 + (fd[o + x3] - row[x3]) * 21;
      mask[o + x3] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }
}

/** Despeckle a soft mask: lone dark pixels -> white, lone pinholes in ink -> black. */
function despeckleSoft(m, W, H) {
  var src = new Uint8Array(m);
  for (var y = 1; y < H - 1; y++) {
    var r0 = (y - 1) * W;
    var r1 = y * W;
    var r2 = (y + 1) * W;
    for (var x = 1; x < W - 1; x++) {
      var ink =
        (src[r0 + x - 1] < 128) +
        (src[r0 + x] < 128) +
        (src[r0 + x + 1] < 128) +
        (src[r1 + x - 1] < 128) +
        (src[r1 + x + 1] < 128) +
        (src[r2 + x - 1] < 128) +
        (src[r2 + x] < 128) +
        (src[r2 + x + 1] < 128);
      if (src[r1 + x] < 128) {
        if (ink <= 1) m[r1 + x] = 255;
      } else if (ink >= 7) m[r1 + x] = 0;
    }
  }
}

/**
 * Apply a filter to an RGBA mat. Returns a new RGBA mat (the input is
 * deleted) or the input itself for "original".
 *   magic     : shadow-free white paper, ink darkened, colours kept (gently boosted)
 *   bw        : shadow-free adaptive binarisation, despeckled
 *   grayscale : shadow-free grey with contrast stretch
 *   lighten   : brighter, shadows softened, colours untouched
 */
function applyFilter(cv, rgba, filter) {
  if (filter === "original" || !filter) return rgba;
  if (filter !== "magic" && filter !== "bw" && filter !== "grayscale" && filter !== "lighten") return rgba;
  var W = rgba.cols;
  var H = rgba.rows;
  var paper = estimatePaper(cv, rgba);
  var st = flatStats(paper);
  var out = new cv.Mat(H, W, cv.CV_8UC4);
  // Heap views go stale when OpenCV grows the WASM memory: fetch them only
  // after the last allocation before each loop.
  var src = rgba.data;
  var d = out.data;
  var fill;
  var sharp = Math.max(W, H) > 1400;
  if (filter === "magic") {
    // paper -> 255 (after dividing, paper sits at ~st[2]); ink black point from
    // the darkest ink; gamma > 1 deepens mid-tone strokes without blocking.
    fill = bgSampler(paper, W, H, 255 * 4);
    var white = Math.max(200, Math.min(246, st[2] - 6));
    var black = Math.min(80, Math.max(0, st[0] * 0.9));
    var T = toneTable(black, white, 1.2);
    var satK = 1.08;
    magicPass(src, d, W, H, fill, T, satK);
    if (sharp) sharpenLuma(d, W, H, 0.6, 3);
  } else if (filter === "grayscale") {
    fill = bgSampler(paper, W, H, 255 * 4);
    var whiteG = Math.max(200, Math.min(246, st[2] - 4));
    var TG = toneTable(Math.min(70, st[0] * 0.85), whiteG, 1.12);
    grayPass(src, d, W, H, fill, TG);
    if (sharp) sharpenLuma(d, W, H, 0.45, 3);
  } else if (filter === "lighten") {
    // half-way shadow removal, then a gentle lift; hue untouched
    // gain = sqrt(paperWhite / bg): shadows lifted half-way (in log terms)
    fill = bgSampler(paper, W, H, 4 * 1.04 * Math.sqrt(250), true);
    var TL = new Uint8Array(1024);
    for (var t = 0; t < 1024; t++) TL[t] = Math.min(255, Math.round(255 * Math.pow(Math.min(1, t / 4 / 246), 0.85)));
    lutPass(src, d, W, H, fill, TL);
  } else {
    // bw: flatten -> local mean threshold, guarded by global "clearly paper"
    // and "clearly ink" levels -> despeckle
    fill = bgSampler(paper, W, H, 255);
    var flat = new cv.Mat(H, W, cv.CV_8UC1);
    flatPass(rgba.data, flat.data, W, H, fill);
    // Sauvola threshold t = m * (1 + k * (s / R - 1)) from the local mean m
    // and deviation s, computed on a 1/4-size copy (they are smooth at the
    // block scale) and upsampled per row; soft edges keep strokes smooth
    // instead of jagged, and the threshold sits between paper and ink so
    // strokes do not fatten.
    var q = 4;
    var qw = Math.max(8, Math.round(W / q));
    var qh = Math.max(8, Math.round(H / q));
    var fs = new cv.Mat();
    cv.resize(flat, fs, new cv.Size(qw, qh), 0, 0, cv.INTER_AREA);
    var ff = new cv.Mat();
    fs.convertTo(ff, cv.CV_32F);
    fs.delete();
    var ff2 = new cv.Mat();
    cv.multiply(ff, ff, ff2);
    var blk = odd(Math.max(qw, qh) / 22);
    var mm = new cv.Mat();
    var mm2 = new cv.Mat();
    var ksz = new cv.Size(blk, blk);
    cv.blur(ff, mm, ksz, new cv.Point(-1, -1), cv.BORDER_REFLECT);
    cv.blur(ff2, mm2, ksz, new cv.Point(-1, -1), cv.BORDER_REFLECT);
    ff.delete();
    ff2.delete();
    var paperLvl = Math.max(150, st[2]);
    var thrSmall = new Float32Array(qw * qh);
    var md = mm.data32F;
    var m2 = mm2.data32F;
    var faint = paperLvl * 0.9;
    for (var ti = 0; ti < thrSmall.length; ti++) {
      var m0 = md[ti];
      var vv = m2[ti] - m0 * m0;
      var sd = vv > 0 ? Math.sqrt(vv) : 0;
      var t0 = m0 * (1 + 0.24 * (sd / 128 - 1));
      // never call clean paper ink, never call clearly dark pixels paper
      thrSmall[ti] = Math.max(paperLvl * 0.42, Math.min(faint, t0));
    }
    mm.delete();
    mm2.delete();
    var mask = new Uint8Array(W * H);
    softThreshold(flat.data, mask, W, H, thrSmall, qw, qh);
    flat.delete();
    despeckleSoft(mask, W, H);
    d = out.data;
    for (var i2 = 0, o5 = 0; i2 < W * H; i2++, o5 += 4) {
      var mv = mask[i2];
      d[o5] = mv;
      d[o5 + 1] = mv;
      d[o5 + 2] = mv;
      d[o5 + 3] = 255;
    }
  }
  rgba.delete();
  return out;
}

/* ------------------------- deskew + orientation -------------------------- */

/** Ink mask (255 = ink) of a grey page at its size, flattened locally. */
function inkMask(cv, gray) {
  var ink = new cv.Mat();
  var block = odd(Math.max(gray.cols, gray.rows) / 30);
  cv.adaptiveThreshold(gray, ink, 255, cv.ADAPTIVE_THRESH_MEAN_C, cv.THRESH_BINARY_INV, block, 12);
  return ink;
}

function profileSharpness(cv, ink, angle, horizontal) {
  var rot = new cv.Mat();
  var c = new cv.Point(ink.cols / 2, ink.rows / 2);
  var M = cv.getRotationMatrix2D(c, angle, 1);
  cv.warpAffine(ink, rot, M, new cv.Size(ink.cols, ink.rows), cv.INTER_NEAREST, cv.BORDER_CONSTANT, new cv.Scalar(0));
  M.delete();
  var prof = new cv.Mat();
  cv.reduce(rot, prof, horizontal ? 1 : 0, cv.REDUCE_SUM, cv.CV_32F);
  rot.delete();
  var d = prof.data32F;
  var s = 0;
  for (var i = 1; i < d.length; i++) {
    var diff = d[i] - d[i - 1];
    s += diff * diff;
  }
  prof.delete();
  return s;
}

/**
 * Residual skew of a flattened page (degrees, positive = content rotated
 * clockwise) from the text-line / ruling projection profile. Returns
 * {angle, confidence, horizontal} where horizontal says whether the dominant
 * lines run left-right (true) or top-bottom (false).
 */
function estimateSkew(cv, gray) {
  var sc = Math.min(1, 700 / Math.max(gray.cols, gray.rows));
  var g2 = gray;
  if (sc < 1) {
    g2 = new cv.Mat();
    cv.resize(gray, g2, new cv.Size(Math.round(gray.cols * sc), Math.round(gray.rows * sc)), 0, 0, cv.INTER_AREA);
  }
  var ink = inkMask(cv, g2);
  if (g2 !== gray) g2.delete();
  // ignore a margin (page edges / leftover desk)
  var mx = Math.round(ink.cols * 0.04);
  var my = Math.round(ink.rows * 0.04);
  var roi = ink.roi(new cv.Rect(mx, my, ink.cols - 2 * mx, ink.rows - 2 * my));
  var inner = roi.clone();
  roi.delete();
  ink.delete();
  var cnt = cv.countNonZero(inner);
  var res = { angle: 0, confidence: 0, horizontal: true, ratio: 1 };
  if (cnt < inner.cols * inner.rows * 0.004) {
    inner.delete();
    return res;
  }
  // coarse 1 deg steps for both line directions, then 0.25 / 0.1 deg
  // refinement around the winner only
  function coarse(horizontal) {
    var best = -1;
    var bestA = 0;
    var vals = [];
    for (var a = -6; a <= 6.001; a += 1) {
      var s = profileSharpness(cv, inner, a, horizontal);
      vals.push(s);
      if (s > best) {
        best = s;
        bestA = a;
      }
    }
    vals.sort(function (x, y) {
      return x - y;
    });
    return { angle: bestA, best: best, median: vals[Math.floor(vals.length / 2)] };
  }
  function refine(r, horizontal) {
    var steps = [0.5, 0.25, 0.1];
    for (var k = 0; k < steps.length; k++) {
      var c = r.angle;
      for (var sgn = -1; sgn <= 1; sgn += 2) {
        var b = c + sgn * steps[k];
        if (b < -6.5 || b > 6.5) continue;
        var s2 = profileSharpness(cv, inner, b, horizontal);
        if (s2 > r.best) {
          r.best = s2;
          r.angle = b;
        }
      }
    }
    return r;
  }
  var hz = coarse(true);
  var vt = coarse(false);
  var useH = hz.best >= vt.best;
  var r = refine(useH ? hz : vt, useH);
  inner.delete();
  res.horizontal = useH;
  res.ratio = hz.best / Math.max(1, vt.best);
  // cv rotation matrix angle is CCW-positive in image coords; content skewed
  // clockwise by x is fixed by rotating counter-clockwise by x.
  res.angle = r.angle;
  res.confidence = r.median > 0 ? r.best / r.median - 1 : 0;
  return res;
}

/**
 * Upright guess for a flattened page with horizontal text lines: in Latin
 * and Arabic alike the densest row of a text line (x-height band / baseline
 * stroke) sits below the line's middle. Returns {flip: bool, confidence}.
 */
function upsideDown(cv, gray) {
  var ink = inkMask(cv, gray);
  var prof = new cv.Mat();
  cv.reduce(ink, prof, 1, cv.REDUCE_SUM, cv.CV_32F);
  var p = Array.from(prof.data32F);
  prof.delete();
  var W = ink.cols;
  // per-line analysis needs the row profile restricted to text columns
  var n = p.length;
  var sm = p.map(function (_, i) {
    var s = 0;
    var c = 0;
    for (var k = -1; k <= 1; k++)
      if (p[i + k] !== undefined) {
        s += p[i + k];
        c++;
      }
    return s / c;
  });
  var max = 0;
  for (var i = 0; i < n; i++) max = Math.max(max, sm[i]);
  var thr = max * 0.12;
  var votes = 0;
  var weight = 0;
  var lines = 0;
  var start = -1;
  for (var y = 0; y <= n; y++) {
    var on = y < n && sm[y] > thr;
    if (on && start < 0) start = y;
    if (!on && start >= 0) {
      var hgt = y - start;
      if (hgt >= 5 && hgt <= n * 0.08) {
        var peak = start;
        for (var k2 = start; k2 < y; k2++) if (sm[k2] > sm[peak]) peak = k2;
        // centre of mass vs peak
        var mass = 0;
        var mom = 0;
        for (var k3 = start; k3 < y; k3++) {
          mass += sm[k3];
          mom += sm[k3] * k3;
        }
        var com = mom / Math.max(1, mass);
        var rel = (peak - com) / hgt; // >0: peak below centre of mass (upright)
        var wgt = Math.min(1, mass / (W * 255 * hgt * 0.05));
        votes += Math.max(-0.5, Math.min(0.5, rel)) * wgt;
        weight += wgt;
        lines++;
      }
      start = -1;
    }
  }
  ink.delete();
  if (lines < 4 || weight <= 0) return { flip: false, confidence: 0, lines: lines };
  var m = votes / weight;
  return { flip: m < 0, confidence: Math.abs(m) * Math.sqrt(lines), lines: lines, mean: m };
}

/**
 * Suggested clockwise rotation (0/90/180/270) for a flattened grey page,
 * or null when not confident.
 */
function orientPage(cv, gray) {
  var sk = estimateSkew(cv, gray);
  var info = { skew: sk.angle, skewConf: sk.confidence, ratio: sk.ratio, horizontal: sk.horizontal };
  if (sk.confidence < 0.6) return { rotation: null, info: info };
  var g = gray;
  var rotated = null;
  var base = 0;
  if (!sk.horizontal) {
    if (sk.ratio > 0.7) return { rotation: null, info: info };
    rotated = new cv.Mat();
    cv.rotate(gray, rotated, cv.ROTATE_90_CLOCKWISE);
    g = rotated;
    base = 90;
  } else if (sk.ratio < 1.4) return { rotation: null, info: info };
  var ud = upsideDown(cv, g);
  if (rotated) rotated.delete();
  info.ud = ud;
  var rot = base;
  if (ud.confidence >= 0.35) rot = ud.flip ? (base + 180) % 360 : base;
  else if (base === 0) rot = 0;
  else return { rotation: null, info: info };
  return { rotation: rot, info: info };
}

/* ------------------------------- warping --------------------------------- */

/** Output size + homography for quad q (pixels of an image w x h). */
function warpGeometry(cv, q, imgW, imgH, maxEdge) {
  var wTop = dist(q[0], q[1]);
  var wBot = dist(q[3], q[2]);
  var hL = dist(q[0], q[3]);
  var hR = dist(q[1], q[2]);
  var W = Math.max(wTop, wBot);
  var H = Math.max(hL, hR);
  // Undo foreshortening: keep the longer measured side, derive the other
  // from the camera-model aspect ratio when it is trustworthy.
  var ar = estimateAspect(q, imgW, imgH);
  if (ar && ar / (W / H) > 0.6 && ar / (W / H) < 1.65) {
    if (W >= H) H = W / ar;
    else W = H * ar;
  }
  var s = Math.min(1, maxEdge / Math.max(W, H));
  W = Math.max(16, Math.round(W * s));
  H = Math.max(16, Math.round(H * s));
  return { W: W, H: H };
}

function perspective(cv, q, W, H) {
  var srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [q[0][0], q[0][1], q[1][0], q[1][1], q[2][0], q[2][1], q[3][0], q[3][1]]);
  var dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, W, 0, W, H, 0, H]);
  var M = cv.getPerspectiveTransform(srcTri, dstTri);
  srcTri.delete();
  dstTri.delete();
  return M;
}

/** M' = A * M for a 2x3 affine A (row-major array of 6) and a 3x3 CV_64F M. */
function composeAffine(cv, A, M) {
  var m = M.data64F;
  var a = [A[0], A[1], A[2], A[3], A[4], A[5], 0, 0, 1];
  var out = [];
  for (var r = 0; r < 3; r++)
    for (var c = 0; c < 3; c++) out.push(a[r * 3] * m[c] + a[r * 3 + 1] * m[3 + c] + a[r * 3 + 2] * m[6 + c]);
  return cv.matFromArray(3, 3, cv.CV_64F, out);
}

/**
 * Warp quad (in source pixel coords) to a rectangle and apply filter.
 * opts.deskew: estimate the residual skew on a small warp first and fold the
 * correcting rotation into the same perspective transform (one resampling).
 * Returns the RGBA mat; sets opts.skew to the applied angle.
 */
function warpAndFilter(cv, src, quad, rotation, filter, maxEdge, opts) {
  opts = opts || {};
  // Normalise to tl,tr,br,bl so the warp can never mirror or spin the page.
  var q = isConvexQuad(quad) ? orderQuad(quad) : quad;
  var geo = warpGeometry(cv, q, src.cols, src.rows, maxEdge);
  var W = geo.W;
  var H = geo.H;
  var M = perspective(cv, q, W, H);
  var border = cv.BORDER_REPLICATE;
  var fill = new cv.Scalar();
  opts.skew = 0;
  if (opts.deskew) {
    var ss = Math.min(1, 900 / Math.max(W, H));
    var sw = Math.max(16, Math.round(W * ss));
    var sh = Math.max(16, Math.round(H * ss));
    var Ms = composeAffine(cv, [ss, 0, 0, 0, ss, 0], M);
    var small = new cv.Mat();
    cv.warpPerspective(src, small, Ms, new cv.Size(sw, sh), cv.INTER_AREA, cv.BORDER_REPLICATE, new cv.Scalar());
    Ms.delete();
    var g = new cv.Mat();
    cv.cvtColor(small, g, cv.COLOR_RGBA2GRAY);
    var sk = estimateSkew(cv, g);
    g.delete();
    // measured on real scans: confidence < 1.5 is mostly noise (blank or
    // photo pages); the profile peak is otherwise within ~0.3 deg
    if (sk.confidence >= 1.5 && Math.abs(sk.angle) >= 0.3 && Math.abs(sk.angle) <= 5) {
      // paper colour for the corner wedges the rotation exposes
      var bw = Math.max(2, Math.round(Math.min(sw, sh) * 0.03));
      var inner = small.roi(new cv.Rect(bw, bw, sw - 2 * bw, sh - 2 * bw));
      var tmp = inner.clone();
      inner.delete();
      var col = [0, 0, 0];
      for (var c = 0; c < 3; c++) col[c] = percentileOf(tmp.data, 0.9, 4, c);
      tmp.delete();
      fill = new cv.Scalar(col[0], col[1], col[2], 255);
      border = cv.BORDER_CONSTANT;
      var R = cv.getRotationMatrix2D(new cv.Point(W / 2, H / 2), sk.angle, 1);
      var r = R.data64F;
      var M2 = composeAffine(cv, [r[0], r[1], r[2], r[3], r[4], r[5]], M);
      R.delete();
      M.delete();
      M = M2;
      opts.skew = Math.round(sk.angle * 100) / 100;
    }
    small.delete();
  }
  var dst = new cv.Mat();
  // cubic for normal pages, linear for huge ones (3x faster in OpenCV.js; the
  // filters' sharpening hides the difference)
  var interp = W * H > 7e6 ? cv.INTER_LINEAR : cv.INTER_CUBIC;
  cv.warpPerspective(src, dst, M, new cv.Size(W, H), interp, border, fill);
  M.delete();
  var out = applyFilter(cv, dst, filter);
  var rr = ((rotation % 360) + 360) % 360;
  if (rr) {
    var rot = new cv.Mat();
    var code = rr === 90 ? cv.ROTATE_90_CLOCKWISE : rr === 180 ? cv.ROTATE_180 : cv.ROTATE_90_COUNTERCLOCKWISE;
    cv.rotate(out, rot, code);
    out.delete();
    out = rot;
  }
  return out;
}

/* --------------------------- still detection ----------------------------- */

function grayOf(cv, px) {
  var src = new cv.Mat(px.height, px.width, cv.CV_8UC4);
  src.data.set(px.data);
  var gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  cv.GaussianBlur(gray, gray, new cv.Size(3, 3), 0);
  var out = new Uint8Array(gray.data);
  src.delete();
  gray.delete();
  return out;
}

/**
 * Full still-photo pipeline on pre-scaled RGBA copies of one photo:
 * small (~640 px) -> thorough multi-pass detection; mid (~1600 px) -> snap
 * sides onto the paper edges; fine (optional, ~2800 px) -> sub-pixel pass
 * with a small search radius; then an orientation guess on a small warp.
 */
function detectDocument(cv, small, mid, fine, opts) {
  opts = opts || {};
  var r = detectQuad(cv, small.data, small.width, small.height, { thorough: true });
  if (!r) return null;
  var levels = [
    [mid, 0.01],
    [fine, 0.004],
  ];
  for (var i = 0; i < levels.length; i++) {
    var L = levels[i][0];
    if (!L) continue;
    var g = grayOf(cv, L);
    var coarse = r.quad.map(function (p) {
      return [p[0] * L.width, p[1] * L.height];
    });
    var ref = refineQuad(g, L.width, L.height, coarse, levels[i][1]);
    if (ref) {
      r.quad = orderQuad(ref).map(function (p) {
        return [p[0] / L.width, p[1] / L.height];
      });
      r.refined = (r.refined || 0) + 1;
    }
  }
  if (opts.orient === true && mid) {
    try {
      var src = new cv.Mat(mid.height, mid.width, cv.CV_8UC4);
      src.data.set(mid.data);
      var q = r.quad.map(function (p) {
        return [p[0] * mid.width, p[1] * mid.height];
      });
      var geo = warpGeometry(cv, q, mid.width, mid.height, 1000);
      var M = perspective(cv, q, geo.W, geo.H);
      var warped = new cv.Mat();
      cv.warpPerspective(src, warped, M, new cv.Size(geo.W, geo.H), cv.INTER_AREA, cv.BORDER_REPLICATE, new cv.Scalar());
      M.delete();
      src.delete();
      var gray = new cv.Mat();
      cv.cvtColor(warped, gray, cv.COLOR_RGBA2GRAY);
      warped.delete();
      var o = orientPage(cv, gray);
      gray.delete();
      if (o.rotation !== null && o.rotation !== undefined) r.rotation = o.rotation;
      r.orientation = o.info;
    } catch (e) {
      /* orientation is a nicety */
    }
  }
  return r;
}

/* ----------------------------- worker glue ------------------------------- */

function bitmapToRGBA(bitmap, maxEdge) {
  var s = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  var w = Math.max(1, Math.round(bitmap.width * s));
  var h = Math.max(1, Math.round(bitmap.height * s));
  var c = new OffscreenCanvas(w, h);
  var ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, w, h);
  var img = ctx.getImageData(0, 0, w, h);
  return { data: img.data, width: w, height: h, scale: s };
}

async function encode(cv, mat, quality) {
  var w = mat.cols;
  var h = mat.rows;
  var c = new OffscreenCanvas(w, h);
  var ctx = c.getContext("2d");
  var img = new ImageData(new Uint8ClampedArray(mat.data), w, h);
  ctx.putImageData(img, 0, 0);
  var blob = await c.convertToBlob({ type: "image/jpeg", quality: quality });
  return { blob: blob, width: w, height: h };
}

async function handle(msg) {
  var cv;
  if (msg.type === "init") {
    await loadOpenCV();
    return { ready: true };
  }
  await loadOpenCV();
  cv = self.cv;
  if (msg.type === "detect") {
    var data = new Uint8ClampedArray(msg.buffer);
    return { result: detectQuad(cv, data, msg.width, msg.height, { thorough: false }) };
  }
  if (msg.type === "detectBitmap") {
    var bm = msg.bitmap;
    var w0 = bm.width;
    var h0 = bm.height;
    var small = bitmapToRGBA(bm, 640);
    var mid = bitmapToRGBA(bm, 1600);
    var fine = Math.max(w0, h0) > 2000 ? bitmapToRGBA(bm, 2800) : null;
    bm.close();
    var r = detectDocument(cv, small, mid, fine, { orient: msg.orient === true });
    return { result: r, width: w0, height: h0 };
  }
  if (msg.type === "process") {
    var bmp = msg.bitmap;
    var srcMax = Math.max(msg.maxEdge * 1.4, 1600);
    var px = bitmapToRGBA(bmp, Math.min(4200, srcMax));
    var origW = bmp.width;
    var origH = bmp.height;
    bmp.close();
    var src = new cv.Mat(px.height, px.width, cv.CV_8UC4);
    src.data.set(px.data);
    px = null;
    var quad = msg.quad
      ? msg.quad.map(function (p) {
          return [p[0] * src.cols, p[1] * src.rows];
        })
      : [
          [0, 0],
          [src.cols, 0],
          [src.cols, src.rows],
          [0, src.rows],
        ];
    var out;
    var wopts = { deskew: !!msg.deskew };
    try {
      out = warpAndFilter(cv, src, quad, msg.rotation || 0, msg.filter || "original", msg.maxEdge || 3000, wopts);
    } finally {
      src.delete();
    }
    try {
      var enc = await encode(cv, out, msg.quality || 0.85);
      return { blob: enc.blob, width: enc.width, height: enc.height, sourceWidth: origW, sourceHeight: origH, skew: wopts.skew || 0 };
    } finally {
      out.delete();
    }
  }
  throw new Error("Unknown message " + msg.type);
}

if (typeof importScripts === "function" && typeof self !== "undefined") {
  self.onmessage = function (e) {
    var msg = e.data;
    var t0 = now();
    handle(msg).then(
      function (res) {
        if (msg.type === "init") post({ type: "ready", timings: initTimings });
        else post(Object.assign({ id: msg.id, ok: true, ms: Math.round(now() - t0) }, res));
      },
      function (err) {
        var error = (err && err.message) || String(err);
        if (msg.type === "init") post({ type: "error", error: error });
        else post({ id: msg.id, ok: false, error: error });
      },
    );
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    detectQuad: detectQuad,
    detectDocument: detectDocument,
    warpAndFilter: warpAndFilter,
    applyFilter: applyFilter,
    orderQuad: orderQuad,
    refineQuad: refineQuad,
    estimateAspect: estimateAspect,
    estimateSkew: estimateSkew,
    orientPage: orientPage,
    upsideDown: upsideDown,
    grayOf: grayOf,
    scoreQuad: scoreQuad,
    estimatePaper: estimatePaper,
    sharpenLuma: sharpenLuma,
    collectQuads: collectQuads,
    quadsFromLines: quadsFromLines,
  };
}
