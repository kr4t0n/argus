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
 */
export const markdownRemarkPlugins: Options['remarkPlugins'] = [remarkGfm, remarkMath];
export const markdownRehypePlugins: Options['rehypePlugins'] = [rehypeKatex];
