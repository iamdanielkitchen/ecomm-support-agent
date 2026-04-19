/**
 * Chunk the Fieldstone help-center corpus for retrieval.
 *
 * Reads data/corpus/raw/{category}/{slug}.md, strips YAML frontmatter,
 * splits each body on H2 boundaries, and windows any section longer than
 * ~400 tokens into paragraphs with ~50-token overlap. Emits
 * data/corpus/chunks.json: an array of {chunk_id, slug, title, category,
 * section_heading, text, tokens}.
 *
 * Token counting uses a character/4 heuristic — accurate within ~15% for
 * English prose and dependency-free. Exact token counts do not matter for
 * retrieval quality; chunk-size uniformity does, and this heuristic is
 * uniform by construction.
 *
 * Usage:  pnpm corpus:chunk
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const ROOT = join(dirname(__filename), "..");

const MAX_CHUNK_TOKENS = 400;
const OVERLAP_TOKENS = 50;

// ── types ──────────────────────────────────────────────────────────────

type Chunk = {
  chunk_id: string;
  slug: string;
  title: string;
  category: string;
  section_heading: string | null;
  text: string;
  tokens: number;
};

type Frontmatter = {
  title: string;
  category: string;
  slug: string;
  body: string;
};

type Section = {
  heading: string | null;
  paragraphs: string[];
};

// ── helpers ────────────────────────────────────────────────────────────

function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

function parseFrontmatter(text: string, path: string): Frontmatter {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match || match[1] === undefined || match[2] === undefined) {
    throw new Error(`no frontmatter block in ${path}`);
  }
  const fm = match[1];
  const body = match[2];

  const pick = (key: string): string => {
    const m = fm.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    if (!m || m[1] === undefined) {
      throw new Error(`frontmatter missing "${key}" in ${path}`);
    }
    // YAML scalars our generator emits are unquoted; strip optional quotes
    // defensively in case a future run decides to quote titles with colons.
    return m[1].trim().replace(/^["']|["']$/g, "");
  };

  return { title: pick("title"), category: pick("category"), slug: pick("slug"), body };
}

function splitBodyIntoSections(body: string): Section[] {
  // Drop the H1 line — the title lives in frontmatter and we reinject it
  // into each chunk's text below.
  const stripped = body.replace(/^\s*#\s+[^\n]+\r?\n+/, "").trim();
  const lines = stripped.split(/\r?\n/);
  const sections: Section[] = [];
  let heading: string | null = null;
  let buffer: string[] = [];

  const flush = () => {
    const joined = buffer.join("\n");
    const paragraphs = joined
      .split(/\r?\n\s*\r?\n/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    if (paragraphs.length > 0 || heading !== null) {
      sections.push({ heading, paragraphs });
    }
    buffer = [];
  };

  for (const line of lines) {
    const h2 = line.match(/^##\s+(.+?)\s*$/);
    if (h2 && h2[1] !== undefined) {
      flush();
      heading = h2[1].trim();
    } else {
      buffer.push(line);
    }
  }
  flush();
  return sections;
}

function windowParagraphs(paragraphs: string[]): string[] {
  // Greedy paragraph-level packing. If a single paragraph already exceeds
  // MAX_CHUNK_TOKENS we let it stand alone — sentence-level splitting is a
  // future optimization, and our articles are 300–700 words so paragraphs
  // rarely approach 400 tokens.
  const windows: string[] = [];
  let current: string[] = [];
  let currentTokens = 0;

  for (const p of paragraphs) {
    const pTokens = estimateTokens(p);
    if (currentTokens + pTokens > MAX_CHUNK_TOKENS && current.length > 0) {
      windows.push(current.join("\n\n"));
      const overlap: string[] = [];
      let overlapTokens = 0;
      for (let i = current.length - 1; i >= 0; i--) {
        const tok = estimateTokens(current[i] ?? "");
        overlap.unshift(current[i] ?? "");
        overlapTokens += tok;
        if (overlapTokens >= OVERLAP_TOKENS) break;
      }
      current = overlap;
      currentTokens = overlapTokens;
    }
    current.push(p);
    currentTokens += pTokens;
  }
  if (current.length > 0) windows.push(current.join("\n\n"));
  return windows;
}

function chunkArticle(fm: Frontmatter): Chunk[] {
  const sections = splitBodyIntoSections(fm.body);
  const chunks: Chunk[] = [];
  let idx = 0;

  for (const section of sections) {
    if (section.paragraphs.length === 0) continue;
    const fullText = section.paragraphs.join("\n\n");
    const windows = estimateTokens(fullText) > MAX_CHUNK_TOKENS
      ? windowParagraphs(section.paragraphs)
      : [fullText];

    for (const win of windows) {
      const text = section.heading
        ? `# ${fm.title}\n\n## ${section.heading}\n\n${win}`
        : `# ${fm.title}\n\n${win}`;
      chunks.push({
        chunk_id: `${fm.slug}#${idx}`,
        slug: fm.slug,
        title: fm.title,
        category: fm.category,
        section_heading: section.heading,
        text,
        tokens: estimateTokens(text),
      });
      idx++;
    }
  }

  return chunks;
}

function* walkMarkdown(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkMarkdown(full);
    else if (entry.isFile() && entry.name.endsWith(".md")) yield full;
  }
}

// ── stats ──────────────────────────────────────────────────────────────

type Stats = {
  total: number;
  perCategory: Record<string, number>;
  tokens: { min: number; median: number; max: number; mean: number };
  singletonArticles: string[];
  bloatedArticles: Array<{ slug: string; count: number }>;
};

function computeStats(chunks: Chunk[]): Stats {
  const perCategory: Record<string, number> = {};
  const perSlug: Record<string, number> = {};
  const tokenCounts: number[] = [];

  for (const c of chunks) {
    perCategory[c.category] = (perCategory[c.category] ?? 0) + 1;
    perSlug[c.slug] = (perSlug[c.slug] ?? 0) + 1;
    tokenCounts.push(c.tokens);
  }

  tokenCounts.sort((a, b) => a - b);
  const median = tokenCounts.length === 0
    ? 0
    : tokenCounts.length % 2 === 1
      ? tokenCounts[(tokenCounts.length - 1) / 2] ?? 0
      : Math.round(((tokenCounts[tokenCounts.length / 2 - 1] ?? 0) + (tokenCounts[tokenCounts.length / 2] ?? 0)) / 2);
  const mean = tokenCounts.length === 0
    ? 0
    : Math.round(tokenCounts.reduce((a, b) => a + b, 0) / tokenCounts.length);

  const singletonArticles = Object.entries(perSlug)
    .filter(([, n]) => n === 1)
    .map(([slug]) => slug)
    .sort();
  const bloatedArticles = Object.entries(perSlug)
    .filter(([, n]) => n > 8)
    .map(([slug, count]) => ({ slug, count }))
    .sort((a, b) => b.count - a.count);

  return {
    total: chunks.length,
    perCategory,
    tokens: {
      min: tokenCounts[0] ?? 0,
      median,
      max: tokenCounts[tokenCounts.length - 1] ?? 0,
      mean,
    },
    singletonArticles,
    bloatedArticles,
  };
}

// ── main ───────────────────────────────────────────────────────────────

function main() {
  const rawDir = join(ROOT, "data/corpus/raw");
  const outPath = join(ROOT, "data/corpus/chunks.json");

  const allChunks: Chunk[] = [];
  let articleCount = 0;

  for (const path of walkMarkdown(rawDir)) {
    const text = readFileSync(path, "utf8");
    const fm = parseFrontmatter(text, path);
    const chunks = chunkArticle(fm);
    allChunks.push(...chunks);
    articleCount++;
  }

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(allChunks, null, 2) + "\n");

  const stats = computeStats(allChunks);
  process.stdout.write(`Chunked ${articleCount} articles into ${stats.total} chunks.\n`);
  process.stdout.write(`Wrote ${outPath}\n\n`);
  process.stdout.write(`Chunks per category:\n`);
  for (const [cat, n] of Object.entries(stats.perCategory).sort()) {
    process.stdout.write(`  ${cat.padEnd(22)} ${n}\n`);
  }
  process.stdout.write(`\nToken distribution (char/4 heuristic):\n`);
  process.stdout.write(`  min    ${stats.tokens.min}\n`);
  process.stdout.write(`  median ${stats.tokens.median}\n`);
  process.stdout.write(`  max    ${stats.tokens.max}\n`);
  process.stdout.write(`  mean   ${stats.tokens.mean}\n`);

  if (stats.singletonArticles.length > 0) {
    process.stdout.write(`\n${stats.singletonArticles.length} article(s) produced only 1 chunk (possible structural gap):\n`);
    for (const slug of stats.singletonArticles) {
      process.stdout.write(`  - ${slug}\n`);
    }
  } else {
    process.stdout.write(`\nNo singleton articles.\n`);
  }

  if (stats.bloatedArticles.length > 0) {
    process.stdout.write(`\n${stats.bloatedArticles.length} article(s) produced >8 chunks (possible bloat):\n`);
    for (const { slug, count } of stats.bloatedArticles) {
      process.stdout.write(`  - ${slug} (${count} chunks)\n`);
    }
  } else {
    process.stdout.write(`\nNo bloated articles (>8 chunks).\n`);
  }
}

try {
  main();
} catch (err) {
  process.stderr.write(String(err instanceof Error ? err.stack : err) + "\n");
  process.exit(1);
}
