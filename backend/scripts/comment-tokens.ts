/**
 * Two readings of one parse of one source text: the leaf-token stream that says
 * whether a change was comment-only, and the comment list that the census folds into
 * how much of a file is comment and that the holder in specs.test.ts reads for what a
 * comment may not say. Separate from comment-check.ts because a test that imported the
 * entry would drag in argv, the filesystem and `git show` to reach one walk: nothing
 * here may run at import time or reach a module but `typescript`, and
 * comment-tokens.test.ts holds both.
 */
import ts from 'typescript';

export type Token = { kind: string; text: string };

export type Verdict =
  | { same: true; count: number }
  | { same: false; index: number; base?: Token; work?: Token };

export type Census = { commentLines: number; nonBlank: number; blocks: number };

export type Comment = { pos: number; end: number; line: number; lineEnd: number; text: string };

/** `parseDiagnostics` is not on the public type; the refusal below is the only reader. */
type Parsed = ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] };

export const scriptKindOf = (fileName: string): ts.ScriptKind =>
  fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;

/**
 * A throw and not a verdict a caller may ignore: the parser is error-tolerant, so it
 * never signals recovery on its own, and two sides parsed under the same wrong kind
 * agree with each other. A `.tsx` read as `.ts` is a full stream of recovery tokens
 * that compares IDENTICAL with another one.
 */
export function parseSource(fileName: string, text: string): ts.SourceFile {
  const source = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKindOf(fileName),
  ) as Parsed;
  const diagnostics = source.parseDiagnostics ?? [];
  if (diagnostics.length > 0) {
    const first = ts.flattenDiagnosticMessageText(diagnostics[0].messageText, ' ');
    throw new Error(
      `${fileName} did not parse: ${diagnostics.length} parse diagnostic(s), the first is "${first}"`,
    );
  }
  return source;
}

export function tokensOf(fileName: string, text: string): Token[] {
  const source = parseSource(fileName, text);
  const tokens: Token[] = [];
  const skipped = (node: ts.Node): boolean =>
    node.kind === ts.SyntaxKind.JSDoc ||
    (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) ||
    (ts.isJsxExpression(node) && node.expression === undefined);
  const walk = (node: ts.Node): void => {
    if (skipped(node)) return;
    const children = node.getChildren(source);
    if (children.length > 0) {
      for (const child of children) walk(child);
      return;
    }
    if (node.kind === ts.SyntaxKind.JsxText) {
      /** getText() skips leading trivia, and a JsxText's whitespace IS the token. */
      const raw = text.slice(node.pos, node.end);
      /**
       * Dropped rather than normalised: deleting a bare JSX comment merges the
       * JsxText either side into one, so two normalised tokens face one and the
       * streams differ in length. The newline-free case is not dropped — it is a
       * rendered space between two children, and its loss must read DIFFERENT.
       */
      if (raw.trim() === '' && raw.includes('\n')) return;
      tokens.push({ kind: 'JsxText', text: raw });
      return;
    }
    tokens.push({ kind: ts.SyntaxKind[node.kind], text: node.getText(source) });
  };
  walk(source);
  return tokens;
}

export function compareSources(fileName: string, base: string, work: string): Verdict {
  const left = tokensOf(fileName, base);
  const right = tokensOf(fileName, work);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (!a || !b || a.kind !== b.kind || a.text !== b.text) {
      return { same: false, index, base: a, work: b };
    }
  }
  return { same: true, count: left.length };
}

/**
 * Every comment range once, in file order, delimiters included: `text` is the raw
 * slice, so a reader matching against it sees `//` and `/*` and nothing here decides
 * what a comment is a second time. `line` and `lineEnd` are 1-based.
 */
export function commentsOf(fileName: string, text: string): Comment[] {
  const source = parseSource(fileName, text);
  const found = new Map<number, Comment>();
  const add = (range: ts.CommentRange): void => {
    if (found.has(range.pos)) return;
    found.set(range.pos, {
      pos: range.pos,
      end: range.end,
      line: source.getLineAndCharacterOfPosition(range.pos).line + 1,
      lineEnd: source.getLineAndCharacterOfPosition(range.end).line + 1,
      text: text.slice(range.pos, range.end),
    });
  };
  const walk = (node: ts.Node): void => {
    if (node.kind !== ts.SyntaxKind.SourceFile) {
      for (const range of ts.getLeadingCommentRanges(text, node.pos) ?? []) add(range);
      /** A comment sharing a line with the code before it is a leading range of nothing. */
      for (const range of ts.getTrailingCommentRanges(text, node.end) ?? []) add(range);
    }
    for (const child of node.getChildren(source)) walk(child);
  };
  walk(source);
  return [...found.values()].sort((a, b) => a.pos - b.pos);
}

/**
 * A comment line is a source line any part of a comment range occupies; the answer is
 * the distinct such lines, the file's non-blank lines and the distinct ranges. The
 * share those make is not a partition — a line carrying code and a trailing comment
 * is in both numerator and denominator — so it is a floor on lines touched by a
 * comment and never the fraction of a file that is prose.
 */
export function censusOf(fileName: string, text: string): Census {
  const comments = commentsOf(fileName, text);
  const lines = new Set<number>();
  for (const c of comments) for (let line = c.line; line <= c.lineEnd; line += 1) lines.add(line);
  const nonBlank = text.split(/\r?\n/).filter((line) => line.trim() !== '').length;
  return { commentLines: lines.size, nonBlank, blocks: comments.length };
}
