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
 * math — accepted trade. Only `$…$`/`$$…$$` are recognized; `\(…\)` and
 * `\[…\]` pass through as plain text (no normalization pass yet — add
 * one here, pre-parse, if those delimiters show up in real transcripts).
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
