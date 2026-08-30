import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import type { Options } from 'react-markdown';

/**
 * Shared plugin sets for every ReactMarkdown surface (answer blocks,
 * activity thoughts/thinking, markdown file previews) so math support
 * can't drift between them.
 *
 * Single-dollar inline math stays ON (remark-math's default): Claude
 * routinely emits `$\pi_\theta$`-style inline math with single dollars.
 * The cost is that prose like "$5 and then $10" can false-positive as
 * math — accepted trade. remark-math recognizes only `$…$`/`$$…$$`, so
 * Codex's `\(…\)`/`\[…\]` are folded into those by
 * `normalizeMathDelimiters` below — call it on the source before
 * handing it to ReactMarkdown, alongside these plugin sets.
 *
 * The app's `katex` dependency (whose CSS index.css imports) MUST stay
 * on the same minor as the `katex` rehype-katex resolves to generate
 * the markup — the markup/CSS contract shifts between 0.x minors, and a
 * mismatch renders every sub/superscript vertically collapsed (glyphs
 * overlapping). rehype-katex@7 pins `katex ^0.16`, so ours is `^0.16.x`
 * too; when bumping rehype-katex, re-align and eyeball an equation.
 */
export const markdownRemarkPlugins: Options['remarkPlugins'] = [remarkGfm, remarkMath];
export const markdownRehypePlugins: Options['rehypePlugins'] = [rehypeKatex];

/**
 * Rewrites LaTeX bracket delimiters into the dollar forms remark-math
 * understands: `\[…\]` → `$$…$$` (display) and `\(…\)` → `$…$` (inline).
 *
 * Claude emits dollars; **Codex emits brackets** — a survey of 2232 real
 * Codex answers found 24 display spans (11 answers) and 13 inline spans
 * (6 answers). Untouched, they don't merely render as literal brackets:
 * markdown pairs the `_` subscripts inside them as emphasis, so
 * `R = w_a R_\text{aesthetic} + … + w_c R_\text{legibility}` loses its
 * underscores and italicizes the middle. Normalizing pre-parse is the
 * pass the comment above used to defer.
 *
 * Conservative by construction — a span is rewritten only when all hold:
 * - the closer exists (an unclosed `\[` mid-stream stays raw and snaps
 *   into math when the closer streams in, matching `$$`'s behavior);
 * - the content is non-blank and holds no `$` (a rewrite would collide
 *   with the delimiters it generates) and no blank line (which would
 *   split the markdown block);
 * - it sits outside ``` / ~~~ fences and outside backtick code spans.
 *
 * Requiring a *pair* is what protects CommonMark's escaped brackets:
 * a lone `\[` meaning a literal `[` is left alone. All four conditions
 * cost nothing on the surveyed corpus (0 spans with `$`, 0 with blank
 * lines, 0 unpaired openers) — they're insurance, not filters.
 *
 * iOS counterpart: ArgusKit `Engine/MathDelimiters.swift`, same rules.
 */
export function normalizeMathDelimiters(src: string): string {
  if (!src.includes('\\[') && !src.includes('\\(')) return src;

  // Fenced code is masked off line-wise (a fence body may contain
  // anything); spans may cross lines, so each unfenced run is rewritten
  // as one joined region.
  const lines = src.split('\n');
  const fenced = new Array<boolean>(lines.length).fill(false);
  let open: { char: string; len: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(lines[i]);
    if (open) {
      fenced[i] = true;
      if (marker && marker[1][0] === open.char && marker[1].length >= open.len && lines[i].trim() === marker[1]) {
        open = null;
      }
    } else if (marker) {
      open = { char: marker[1][0], len: marker[1].length };
      fenced[i] = true;
    }
  }

  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (fenced[i]) {
      out.push(lines[i]);
      i += 1;
      continue;
    }
    let j = i;
    while (j < lines.length && !fenced[j]) j += 1;
    out.push(rewriteRegion(lines.slice(i, j).join('\n')));
    i = j;
  }
  return out.join('\n');
}

/** Index of `closer` at or after `from`, honoring `\\` escape pairs, else -1. */
function findCloser(text: string, from: number, closer: string): number {
  let i = from;
  while (i < text.length) {
    if (text[i] === '\\') {
      if (text.startsWith(closer, i)) return i;
      i += 2; // an escape pair — `\\]` is a literal backslash, not a closer
      continue;
    }
    i += 1;
  }
  return -1;
}

/** Rewrite bracket math in one fence-free region. */
function rewriteRegion(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const char = text[i];

    if (char === '`') {
      // Code span: copy through to the matching equal-length backtick
      // run, so `` `\(x\)` `` stays code. An unmatched opener is literal.
      const start = i;
      while (i < text.length && text[i] === '`') i += 1;
      const length = i - start;
      let j = i;
      let closed = false;
      while (j < text.length) {
        if (text[j] === '`') {
          const runStart = j;
          while (j < text.length && text[j] === '`') j += 1;
          if (j - runStart === length) {
            closed = true;
            break;
          }
        } else {
          j += 1;
        }
      }
      out += text.slice(start, closed ? j : i);
      if (closed) i = j;
      continue;
    }

    if (char === '\\') {
      const next = text[i + 1];
      if (next === '[' || next === '(') {
        const display = next === '[';
        const end = findCloser(text, i + 2, display ? '\\]' : '\\)');
        if (end >= 0) {
          const content = text.slice(i + 2, end);
          if (content.trim() !== '' && !content.includes('$') && !/\n[ \t]*\n/.test(content)) {
            const delimiter = display ? '$$' : '$';
            out += delimiter + content + delimiter;
            i = end + 2;
            continue;
          }
        }
      }
      // Any other escape (`\\`, `\_`, a lone `\[` with no closer) is verbatim.
      out += next === undefined ? char : char + next;
      i += next === undefined ? 1 : 2;
      continue;
    }

    out += char;
    i += 1;
  }
  return out;
}
