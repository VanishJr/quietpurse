/**
 * pdfjs takes its `DOMMatrix` and `Path2D` from `@napi-rs/canvas`, and the production
 * image does not carry that package: 61 MiB of renderer for a parser that reads a
 * text layer and never draws (ROADMAP row 28). Without those two globals pdf.mjs does
 * not merely warn - `const SCALE_MATRIX = new DOMMatrix()` runs at module scope, so
 * the module fails to evaluate, and through the static chain app.ts -> statement.ts ->
 * pdf.ts that used to be a container that could not boot.
 *
 * Installing them before pdfjs loads is an ordering invariant, and this file is the
 * mechanism rather than the rule: an assignment written above a static import is held
 * by source order alone, which `tsc` cannot see and an import sorter reverses without
 * a single check going red. Here the order is a sequence of statements and the only
 * way to reach pdfjs is through the function that runs them, so the invariant cannot
 * be broken by moving a line - only by deleting one. test/canvasabsent.ts is what
 * watches that, in a process where the package is unresolvable.
 *
 * The stubs throw rather than answer. Nothing on the text path constructs a `Path2D`
 * or calls a `DOMMatrix` method - `SCALE_MATRIX` is read in one place, inside the
 * canvas renderer - so a stub that returned a plausible identity matrix would cost
 * nothing today and would turn the day some path does start rendering into a wrong
 * image rather than a crash.
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
 * present too - dev, CI and the image then run the same objects, and "any render path
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
