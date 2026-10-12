/**
 * Installing `DOMMatrix` and `Path2D` before pdfjs loads is an ordering invariant, and
 * this file is the mechanism rather than the rule: an assignment written above a static
 * import is held by source order alone, which `tsc` cannot see and an import sorter
 * reverses without a single check going red. Here the order is a sequence of statements
 * and the only way to reach pdfjs is through the function that runs them, so the
 * invariant cannot be broken by moving a line, only by deleting one.
 * test/canvasabsent.ts is what watches that, in a process where @napi-rs/canvas is
 * unresolvable.
 *
 * The stubs throw rather than answer. Nothing on the text path constructs a `Path2D`
 * or calls a `DOMMatrix` method: `SCALE_MATRIX` is read only inside the canvas
 * renderer. So a stub that returned a plausible identity matrix would cost nothing
 * today, but on the day some path does start rendering it would produce a wrong image
 * rather than a crash.
 */

type Pdfjs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');

const unrenderable = (what: string): Error =>
  new Error(`${what} is a stub: this build reads the text layer of a PDF and cannot render`);

/**
 * Identity in the six fields `SCALE_MATRIX` is written and read through, and nothing
 * else. An argument means the caller wanted a real matrix: pdf.mjs constructs one
 * without arguments exactly once, at module scope, and every other construction of
 * either class sits inside a render call.
 */
class UnrenderableDOMMatrix {
  a = 1;
  b = 0;
  c = 0;
  d = 1;
  e = 0;
  f = 0;

  constructor(init?: unknown) {
    if (init !== undefined) throw unrenderable('DOMMatrix(init)');
  }

  multiplySelf(): never {
    throw unrenderable('DOMMatrix.multiplySelf');
  }

  preMultiplySelf(): never {
    throw unrenderable('DOMMatrix.preMultiplySelf');
  }

  invertSelf(): never {
    throw unrenderable('DOMMatrix.invertSelf');
  }

  translate(): never {
    throw unrenderable('DOMMatrix.translate');
  }

  scale(): never {
    throw unrenderable('DOMMatrix.scale');
  }
}

class UnrenderablePath2D {
  constructor() {
    throw unrenderable('Path2D');
  }
}

let loading: Promise<Pdfjs> | undefined;

/**
 * pdfjs, with the globals it would otherwise take from canvas already in place.
 * Memoised, so the one warning pdf.mjs prints when it cannot load the package is
 * printed once per process.
 *
 * The stubs go in unconditionally. pdfjs installs canvas's own only when the global
 * is unset (`if (!globalThis.DOMMatrix)`), so these win wherever the package is
 * present too. Dev, CI and the image then run the same objects, and "any render path
 * throws" is live in every test run rather than only where canvas is missing.
 *
 * The failed import is named because it now surfaces as one refused PDF import rather
 * than at boot, and `error_detail` would otherwise carry a bare ReferenceError from a
 * file the reader has never heard of.
 */
export function loadPdfjs(): Promise<Pdfjs> {
  if (!loading) {
    const globals = globalThis as unknown as Record<string, unknown>;
    globals.DOMMatrix = UnrenderableDOMMatrix;
    globals.Path2D = UnrenderablePath2D;
    loading = import('pdfjs-dist/legacy/build/pdf.mjs').catch((e: unknown) => {
      throw new Error(`the PDF reader did not load in this build: ${String(e)}`, { cause: e });
    });
  }
  return loading;
}
