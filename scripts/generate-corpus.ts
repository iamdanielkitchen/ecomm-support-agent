/**
 * Generate the Fieldstone help-center corpus.
 *
 * Reads data/corpus/taxonomy.json + data/store.json, calls Claude per
 * article, writes Markdown to data/corpus/raw/{category}/{slug}.md,
 * logs per-article token usage to logs/corpus-build.jsonl.
 *
 * Usage:
 *   pnpm corpus:generate                    # all 50 articles, skip existing
 *   pnpm corpus:generate -- --sample        # ~10 articles spanning all categories
 *   pnpm corpus:generate -- --only tracking-your-order
 *   pnpm corpus:generate -- --limit 5
 *   pnpm corpus:generate -- --force         # overwrite existing files
 *
 * Env: ANTHROPIC_API_KEY required. Use `--env-file=.env.local` or export it.
 */

import Anthropic from "@anthropic-ai/sdk";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  appendFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const ROOT = join(dirname(__filename), "..");

// Keeping scripts independent of lib/anthropic.ts so they can run outside
// the Next build context. The model id is duplicated intentionally — same
// rationale as lib/anthropic.ts: one literal, one line to flip.
const MODEL = "claude-sonnet-4-5";
const MAX_TOKENS = 2000;
const LAST_UPDATED = "2026-04-19";

// ── types ──────────────────────────────────────────────────────────────

type CatalogItem = {
  sku: string;
  name: string;
  price: number;
  final_sale: boolean;
};

type StoreJson = {
  customers: unknown[];
  catalog: CatalogItem[];
  orders: unknown[];
  returns: unknown[];
};

type Article = {
  slug: string;
  title: string;
  angle: string;
  related: string[];
};

type Category = {
  slug: string;
  title: string;
  description: string;
  articles: Article[];
};

type Taxonomy = {
  categories: Category[];
};

type Args = {
  sample: boolean;
  force: boolean;
  only: string | null;
  limit: number | null;
};

type Selection = {
  category: Category;
  article: Article;
  siblings: Article[];
};

// ── arg parsing ────────────────────────────────────────────────────────

function parseArgs(argv: string[]): Args {
  const args: Args = { sample: false, force: false, only: null, limit: null };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i++];
    if (a === undefined) continue;
    if (a === "--") continue; // pnpm injects this separator
    if (a === "--sample") {
      args.sample = true;
    } else if (a === "--force") {
      args.force = true;
    } else if (a === "--only") {
      const v = argv[i++];
      if (!v) throw new Error("--only requires a slug argument");
      args.only = v;
    } else if (a === "--limit") {
      const v = argv[i++];
      if (!v) throw new Error("--limit requires a number argument");
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`--limit must be a positive number, got "${v}"`);
      }
      args.limit = n;
    } else if (a.startsWith("--")) {
      throw new Error(`Unknown flag: ${a}`);
    }
  }
  return args;
}

// ── prompt construction ────────────────────────────────────────────────

function policyBlock(store: StoreJson): string {
  const finalSaleSkus = store.catalog.filter((c) => c.final_sale).map((c) => c.sku);
  const standardSkus = store.catalog.filter((c) => !c.final_sale).map((c) => c.sku);
  const catalogTable = store.catalog
    .map(
      (c) =>
        `  - ${c.sku} — ${c.name} — $${c.price.toFixed(2)} — final_sale=${c.final_sale}`,
    )
    .join("\n");

  return `FIELDSTONE POLICIES (authoritative — do not contradict):
- Return window: 30 days from delivery.
- Returns are free for unopened items. Opened items in original condition have a $7.95 return shipping fee.
- Final-sale items (marked in catalog) cannot be returned.
- Refunds land on the original payment method within 5–7 business days of warehouse receipt.
- Shipping methods: standard 3–5 business days, expedited 1–2 business days. No same-day delivery.
- Identity verification uses email + order number (format FG-NNNNNN). No user accounts in this build.

FIELDSTONE CATALOG (use only these SKUs and names when referencing products):
${catalogTable}

Final-sale SKUs: ${finalSaleSkus.join(", ") || "none"}
Standard-return SKUs: ${standardSkus.join(", ")}`;
}

function buildSystemPrompt(store: StoreJson): string {
  return `You are a senior technical writer for Fieldstone Goods, writing help-center
articles that customers read after an order question or return question.

Voice: warm, brief, specific. Present tense for policy. Imperative for
instructions. No corporate filler ("we sincerely apologize", "we value
your business", "rest assured"). Use "cannot" not "can't" when stating a
hard rule; contractions are fine elsewhere.

Length: 300 to 700 words, body only (not frontmatter). Target about 450.

Output format: Markdown with YAML frontmatter. Frontmatter MUST include,
in this order:
  - title
  - category (use the category slug, not the title)
  - slug
  - last_updated
  - related_articles (YAML list of slugs)

Body MUST have:
  - exactly one H1 that matches the title exactly
  - an intro paragraph (2–3 sentences) that answers the question at a glance
  - 2–4 H2 sections
  - optionally an "## FAQ" block at the end with 2–3 bolded question/answer pairs

Headings are sentence case with no terminal punctuation. Do not use bold
or italic in H1 or H2.

Hard rules:
- Do NOT contradict any fact in the policy block below.
- Do NOT invent SKUs, customers, order numbers, promo codes, or phone numbers.
- Do NOT promise refunds, exceptions, or timelines outside the policy block.
- Do NOT use emoji. At most one exclamation point per article.
- If a topic (promos, gift cards, corporate orders, billing disputes) falls
  outside what the support agent Ember can resolve directly, the article may
  mention that a human specialist will help — do not fabricate a specific
  team name or email address.

${policyBlock(store)}

Output the complete Markdown article only. No preamble, no explanation,
no code fences wrapping the whole document.`;
}

function buildUserPrompt(sel: Selection): string {
  const { category, article, siblings } = sel;
  const relatedWithTitles = article.related
    .map((slug) => {
      const s = siblings.find((x) => x.slug === slug);
      return s ? `  - ${slug} — "${s.title}"` : `  - ${slug}`;
    })
    .join("\n");

  return `Write the help-center article for:

Title: ${article.title}
Slug: ${article.slug}
Category: ${category.title} (slug: ${category.slug})
Category description: ${category.description}

Angle (what this article uniquely answers, not covered by siblings):
${article.angle}

Related articles — include these slugs in the frontmatter \`related_articles\`
list, and mention 1–2 of them by title in the body where it flows naturally
("See our guide on X for more."):
${relatedWithTitles}

last_updated value: ${LAST_UPDATED}

Output the complete Markdown article only.`;
}

// ── generation ─────────────────────────────────────────────────────────

function stripWrappingFence(text: string): string {
  const trimmed = text.trim();
  const fence = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/;
  const m = trimmed.match(fence);
  if (m && m[1] !== undefined) return m[1];
  return trimmed;
}

type GenerateResult = {
  markdown: string;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
};

async function generateArticle(
  client: Anthropic,
  store: StoreJson,
  sel: Selection,
): Promise<GenerateResult> {
  const start = Date.now();
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: buildSystemPrompt(store),
    messages: [{ role: "user", content: buildUserPrompt(sel) }],
  });
  const latency_ms = Date.now() - start;

  let text = "";
  for (const block of response.content) {
    if (block.type === "text") text += block.text;
  }
  if (!text) {
    throw new Error("model returned no text blocks");
  }

  return {
    markdown: stripWrappingFence(text),
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
    latency_ms,
  };
}

// ── selection ──────────────────────────────────────────────────────────

function selectArticles(taxonomy: Taxonomy, args: Args): Selection[] {
  const all: Selection[] = [];
  for (const category of taxonomy.categories) {
    for (const article of category.articles) {
      all.push({ category, article, siblings: category.articles });
    }
  }

  if (args.only) {
    const filtered = all.filter((x) => x.article.slug === args.only);
    if (!filtered.length) {
      throw new Error(`--only slug "${args.only}" not found in taxonomy`);
    }
    return filtered;
  }

  if (args.sample) {
    // One from each category (first slot) plus a second from the two
    // categories the agent hits hardest — gives a ~10-article cross-section
    // that covers every category while over-sampling the load-bearing ones.
    const sample: Selection[] = [];
    for (const c of taxonomy.categories) {
      const first = c.articles[0];
      if (first) sample.push({ category: c, article: first, siblings: c.articles });
    }
    for (const c of taxonomy.categories) {
      if (c.slug === "returns-exchanges" || c.slug === "product-care") {
        const second = c.articles[1];
        if (second) sample.push({ category: c, article: second, siblings: c.articles });
      }
    }
    return sample;
  }

  return args.limit ? all.slice(0, args.limit) : all;
}

// ── main ───────────────────────────────────────────────────────────────

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY not set. Run with `tsx --env-file=.env.local scripts/generate-corpus.ts` or export the var.",
    );
  }

  const args = parseArgs(process.argv.slice(2));
  const store = JSON.parse(
    readFileSync(join(ROOT, "data/store.json"), "utf8"),
  ) as StoreJson;
  const taxonomy = JSON.parse(
    readFileSync(join(ROOT, "data/corpus/taxonomy.json"), "utf8"),
  ) as Taxonomy;

  const selected = selectArticles(taxonomy, args);
  const client = new Anthropic({ apiKey });

  const logPath = join(ROOT, "logs/corpus-build.jsonl");
  mkdirSync(dirname(logPath), { recursive: true });

  let written = 0;
  let skipped = 0;
  let failed = 0;
  let totalIn = 0;
  let totalOut = 0;

  process.stdout.write(
    `Generating ${selected.length} article(s) with ${MODEL}...\n\n`,
  );

  for (const sel of selected) {
    const { category, article } = sel;
    const outDir = join(ROOT, "data/corpus/raw", category.slug);
    const outPath = join(outDir, `${article.slug}.md`);
    mkdirSync(outDir, { recursive: true });

    if (existsSync(outPath) && !args.force) {
      process.stdout.write(
        `  [skip] ${category.slug}/${article.slug}.md (exists; use --force to overwrite)\n`,
      );
      skipped++;
      continue;
    }

    try {
      const result = await generateArticle(client, store, sel);
      writeFileSync(outPath, result.markdown + "\n");
      appendFileSync(
        logPath,
        JSON.stringify({
          ts: new Date().toISOString(),
          model: MODEL,
          category: category.slug,
          slug: article.slug,
          tokens_in: result.input_tokens,
          tokens_out: result.output_tokens,
          latency_ms: result.latency_ms,
          path: `data/corpus/raw/${category.slug}/${article.slug}.md`,
        }) + "\n",
      );
      process.stdout.write(
        `  [ok]   ${category.slug}/${article.slug}.md ` +
          `(${result.input_tokens}→${result.output_tokens}t, ${result.latency_ms}ms)\n`,
      );
      written++;
      totalIn += result.input_tokens;
      totalOut += result.output_tokens;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      appendFileSync(
        logPath,
        JSON.stringify({
          ts: new Date().toISOString(),
          model: MODEL,
          category: category.slug,
          slug: article.slug,
          error: message,
        }) + "\n",
      );
      process.stdout.write(
        `  [fail] ${category.slug}/${article.slug}.md — ${message}\n`,
      );
      failed++;
    }
  }

  process.stdout.write(
    `\nDone. ${written} written, ${skipped} skipped, ${failed} failed. ` +
      `Tokens: ${totalIn} in, ${totalOut} out.\n`,
  );
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  process.stderr.write(
    String(err instanceof Error ? err.stack : err) + "\n",
  );
  process.exit(1);
});
