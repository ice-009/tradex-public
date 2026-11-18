// A minimal headless DOM + canvas for benchmarking the chart engine in Node.
//
// The 2D context records nothing and rasterises nothing: every drawing call is
// a counted no-op. So the chart benchmarks measure the engine's own work per
// frame — layout, autoscale, tick placement, indicator maths and building the
// paths — which is what a code change can make slower. They don't measure the
// browser's rasterisation/compositing (GPU, fonts), which needs a real browser.
// `ops` (canvas calls + path segments per frame) is a deterministic proxy for
// that part: if it jumps, the browser has more to draw.

type Callback = (time: number) => void;

let ops = 0;
const noop = () => {
  ops += 1;
};

class FakePath2D {
  moveTo = noop;
  lineTo = noop;
  rect = noop;
  arc = noop;
  closePath = noop;
  quadraticCurveTo = noop;
  bezierCurveTo = noop;
  roundRect = noop;
}

function fakeContext() {
  const gradient = { addColorStop: noop };
  const methods: Record<string, unknown> = {
    measureText: (text: string) => {
      ops += 1;
      return { width: String(text).length * 6.6, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 };
    },
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    getLineDash: () => [],
  };
  // Any other method (fillRect, stroke, setLineDash, …) is a counted no-op; properties (fillStyle, font, …) just store.
  return new Proxy(methods, {
    get(target, key: string) {
      if (key in target) return target[key];
      return noop;
    },
    set(target, key: string, value) {
      target[key] = value;
      return true;
    },
  });
}

function fakeCanvas() {
  return {
    width: 0,
    height: 0,
    style: {} as Record<string, string>,
    getContext: () => fakeContext(),
    addEventListener() {},
    removeEventListener() {},
    setPointerCapture() {},
    releasePointerCapture() {},
    hasPointerCapture: () => false,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 }),
    remove() {},
    toDataURL: () => "",
  };
}

const frames = new Map<number, Callback>();
let frameId = 0;

/** Install the fake globals the engine touches (idempotent). */
export function installDom() {
  const g = globalThis as Record<string, unknown>;
  g.window ??= { devicePixelRatio: 2 };
  g.document ??= { createElement: () => fakeCanvas() };
  g.Path2D ??= FakePath2D;
  g.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
  };
  g.requestAnimationFrame = (callback: Callback) => {
    frameId += 1;
    frames.set(frameId, callback);
    return frameId;
  };
  g.cancelAnimationFrame = (id: number) => frames.delete(id);
}

/** A container element of the given size for `new ChartEngine(container)`. */
export function fakeContainer(width: number, height: number): HTMLElement {
  return {
    appendChild() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, right: width, bottom: height, width, height, x: 0, y: 0 }),
  } as unknown as HTMLElement;
}

/** Run every queued animation frame (the engine renders in one). Returns the canvas calls made. */
export function flushFrames(): number {
  const before = ops;
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) callback(performance.now());
  return ops - before;
}
