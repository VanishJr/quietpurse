/**
 * The same parse as the parent, in a process where `@napi-rs/canvas` cannot be
 * resolved - which is the production image (ROADMAP row 28) and is a state no test
 * running in the suite's own process can reach: canvas is installed on every machine
 * the suite runs on, and pdfjs is loaded once per process.
 *
 * The hook has to be installed before anything imports pdf.mjs, so this file imports
 * nothing above it. One JSON line on stdout; pdfjs's own warning goes to stderr,
 * where canvasabsent.test.ts counts it.
 */
import Module from 'node:module';

type Resolve = (this: unknown, request: string, ...rest: unknown[]) => string;
const loader = Module as unknown as { _resolveFilename: Resolve };
const resolveFilename = loader._resolveFilename;
loader._resolveFilename = function (request, ...rest) {
  if (request === '@napi-rs/canvas') {
    const e: NodeJS.ErrnoException = new Error("Cannot find module '@napi-rs/canvas'");
    e.code = 'MODULE_NOT_FOUND';
    throw e;
  }
  return resolveFilename.call(this, request, ...rest);
};

async function main(): Promise<void> {
  const { parseWithoutCanvas } = await import('./canvasabsent');
  process.stdout.write(`${JSON.stringify(await parseWithoutCanvas())}\n`);
}

void main();
