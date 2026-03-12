/**
 * Debate Engine — Autonomous AI vs AI debate pipeline
 *
 * 1. RSS Ingestion: Pulls from credible AI news sources
 * 2. Debate Generation: Uses Claude to generate structured Blue/Red team debates
 * 3. Publishing: Stores and serves to the Academy frontend
 */

import Anthropic from '@anthropic-ai/sdk';
import { v4 as uuidv4 } from 'uuid';
import {
  insertDebateSource,
  getUnusedSources,
  markSourceUsed,
  insertDebate,
  clearFeaturedDebates,
} from '../db/database';

// ─── RSS Feed Sources ────────────────────────────────────────────────────────

interface FeedSource {
  name: string;
  url: string;
  type: 'rss' | 'atom';
}

const RSS_FEEDS: FeedSource[] = [
  { name: 'MIT Technology Review — AI', url: 'https://www.technologyreview.com/feed/', type: 'rss' },
  { name: 'TechCrunch — AI', url: 'https://techcrunch.com/category/artificial-intelligence/feed/', type: 'rss' },
  { name: 'The Verge — AI', url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml', type: 'rss' },
  { name: 'Wired — AI', url: 'https://www.wired.com/feed/tag/ai/latest/rss', type: 'rss' },
  { name: 'Ars Technica — AI', url: 'https://feeds.arstechnica.com/arstechnica/technology-lab', type: 'rss' },
  { name: 'VentureBeat — AI', url: 'https://venturebeat.com/category/ai/feed/', type: 'rss' },
];

// ─── RSS Parsing (lightweight, no dependency) ────────────────────────────────

interface ParsedArticle {
  title: string;
  summary: string;
  url: string;
  author?: string;
  published_at?: number;
}

function extractTag(xml: string, tag: string): string {
  // Handle CDATA sections
  const cdataPattern = new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`, 'i');
  const cdataMatch = xml.match(cdataPattern);
  if (cdataMatch) return cdataMatch[1].trim();

  const pattern = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  const match = xml.match(pattern);
  return match ? match[1].trim().replace(/<[^>]+>/g, '').trim() : '';
}

function extractAttr(xml: string, tag: string, attr: string): string {
  const pattern = new RegExp(`<${tag}[^>]*${attr}="([^"]*)"`, 'i');
  const match = xml.match(pattern);
  return match ? match[1] : '';
}

function parseRSSItems(xml: string): ParsedArticle[] {
  const articles: ParsedArticle[] = [];

  // RSS 2.0: <item>...</item>
  const items = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];

  for (const item of items.slice(0, 10)) {
    const title = extractTag(item, 'title');
    const link = extractTag(item, 'link') || extractAttr(item, 'link', 'href');
    const description = extractTag(item, 'description') || extractTag(item, 'summary') || extractTag(item, 'content');
    const author = extractTag(item, 'dc:creator') || extractTag(item, 'author');
    const pubDate = extractTag(item, 'pubDate') || extractTag(item, 'published') || extractTag(item, 'updated');

    if (title && link) {
      // Strip HTML from description and limit to 500 chars
      const cleanDesc = description
        .replace(/<[^>]+>/g, '')
        .replace(/&[^;]+;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, 500);

      articles.push({
        title: title.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#8217;/g, "'").replace(/&#8220;/g, '"').replace(/&#8221;/g, '"'),
        summary: cleanDesc,
        url: link.trim(),
        author: author || undefined,
        published_at: pubDate ? new Date(pubDate).getTime() : undefined,
      });
    }
  }

  // Atom: <entry>...</entry>
  if (articles.length === 0) {
    const entries = xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
    for (const entry of entries.slice(0, 10)) {
      const title = extractTag(entry, 'title');
      const link = extractAttr(entry, 'link', 'href') || extractTag(entry, 'link');
      const summary = extractTag(entry, 'summary') || extractTag(entry, 'content');
      const author = extractTag(entry, 'name');
      const updated = extractTag(entry, 'updated') || extractTag(entry, 'published');

      if (title && link) {
        const cleanDesc = summary.replace(/<[^>]+>/g, '').replace(/&[^;]+;/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 500);
        articles.push({
          title: title.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'),
          summary: cleanDesc,
          url: link.trim(),
          author: author || undefined,
          published_at: updated ? new Date(updated).getTime() : undefined,
        });
      }
    }
  }

  return articles;
}

// ─── RSS Ingestion ───────────────────────────────────────────────────────────

export async function ingestRSSFeeds(): Promise<{ total: number; new_articles: number; errors: string[] }> {
  let total = 0;
  let newArticles = 0;
  const errors: string[] = [];

  for (const feed of RSS_FEEDS) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

      const response = await fetch(feed.url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'BorealisAcademy/1.0 (AI News Aggregator)',
          'Accept': 'application/rss+xml, application/xml, text/xml',
        },
      });

      clearTimeout(timeout);

      if (!response.ok) {
        errors.push(`${feed.name}: HTTP ${response.status}`);
        continue;
      }

      const xml = await response.text();
      const articles = parseRSSItems(xml);
      total += articles.length;

      for (const article of articles) {
        // Filter for AI-relevant content
        const isAIRelated = isArticleAIRelated(article.title + ' ' + article.summary);
        if (!isAIRelated) continue;

        const inserted = insertDebateSource({
          id: uuidv4(),
          title: article.title,
          summary: article.summary,
          source_url: article.url,
          source_name: feed.name,
          author: article.author,
          published_at: article.published_at,
          topic_tags: extractTopicTags(article.title + ' ' + article.summary),
        });

        if (inserted) newArticles++;
      }
    } catch (err: any) {
      errors.push(`${feed.name}: ${err.message || 'Unknown error'}`);
    }
  }

  return { total, new_articles: newArticles, errors };
}

// ─── AI Relevance Filter ─────────────────────────────────────────────────────

const AI_KEYWORDS = [
  'artificial intelligence', 'machine learning', 'deep learning', 'neural network',
  'large language model', 'llm', 'chatgpt', 'gpt-4', 'gpt-5', 'claude', 'gemini',
  'openai', 'anthropic', 'google ai', 'meta ai', 'ai model', 'ai safety',
  'ai regulation', 'ai ethics', 'ai governance', 'ai bias', 'generative ai',
  'ai agent', 'autonomous ai', 'ai alignment', 'agi', 'superintelligence',
  'transformer', 'diffusion model', 'ai training', 'ai chip', 'nvidia',
  'ai startup', 'ai funding', 'ai copyright', 'ai job', 'ai replace',
  'deepfake', 'synthetic media', 'ai art', 'ai music', 'ai code',
  'robot', 'automation', 'computer vision', 'natural language',
  'ai trust', 'ai accountability', 'ai transparency', 'ai audit',
];

function isArticleAIRelated(text: string): boolean {
  const lower = text.toLowerCase();
  let matchCount = 0;
  for (const kw of AI_KEYWORDS) {
    if (lower.includes(kw)) matchCount++;
  }
  return matchCount >= 1;
}

function extractTopicTags(text: string): string[] {
  const lower = text.toLowerCase();
  const tags: string[] = [];
  const tagMap: Record<string, string[]> = {
    'safety': ['ai safety', 'ai alignment', 'ai risk', 'existential'],
    'regulation': ['ai regulation', 'ai governance', 'ai policy', 'ai law', 'eu ai act'],
    'ethics': ['ai ethics', 'ai bias', 'fairness', 'ai rights'],
    'business': ['ai startup', 'ai funding', 'ai revenue', 'ai market', 'ai company'],
    'creative': ['ai art', 'ai music', 'ai writing', 'generative', 'creative ai'],
    'jobs': ['ai job', 'ai replace', 'automation', 'workforce', 'employment'],
    'research': ['ai model', 'transformer', 'training', 'benchmark', 'paper'],
    'trust': ['ai trust', 'ai accountability', 'ai transparency', 'ai audit', 'deepfake'],
  };

  for (const [tag, keywords] of Object.entries(tagMap)) {
    if (keywords.some(kw => lower.includes(kw))) {
      tags.push(tag);
    }
  }
  return tags.length > 0 ? tags : ['general'];
}

// ─── Debate Generation via Claude ────────────────────────────────────────────

const DEBATE_SYSTEM_PROMPT = `You are a structured debate generator for Borealis Academy, an AI trust education platform.

Your job: Given a real AI news article, generate a balanced, factual debate between two perspectives.

RULES:
- Blue Team argues the OPTIMISTIC/PRO position
- Red Team argues the SKEPTICAL/CAUTIOUS position
- Each argument MUST reference specific facts from the source article
- Each argument should be 2-3 sentences, substantive but concise
- Generate exactly 3 exchanges (6 total messages, alternating Blue/Red)
- The question should be a genuine, debatable question derived from the article
- DO NOT hallucinate facts — only cite what the article actually says
- Keep arguments accessible to a general audience, not just AI experts
- Each argument should build on or rebut the previous one

OUTPUT FORMAT (strict JSON, no markdown):
{
  "question": "The debate question derived from the article",
  "topic": "2-3 word topic label (e.g. 'AI Regulation', 'Creative AI', 'AI Jobs')",
  "summary": "One sentence summary of what this debate is about",
  "exchanges": [
    {"team": "blue", "name": "Blue Team", "argument": "The argument text...", "citation": "Brief source reference"},
    {"team": "red", "name": "Red Team", "argument": "The argument text...", "citation": "Brief source reference"},
    {"team": "blue", "name": "Blue Team", "argument": "The argument text...", "citation": "Brief source reference"},
    {"team": "red", "name": "Red Team", "argument": "The argument text...", "citation": "Brief source reference"},
    {"team": "blue", "name": "Blue Team", "argument": "The argument text...", "citation": "Brief source reference"},
    {"team": "red", "name": "Red Team", "argument": "The argument text...", "citation": "Brief source reference"}
  ]
}`;

export async function generateDebate(sourceId?: string): Promise<{ success: boolean; debate_id?: string; error?: string }> {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return { success: false, error: 'ANTHROPIC_API_KEY not configured' };
    }

    // Pick a source article
    const sources = getUnusedSources(5);
    if (sources.length === 0) {
      return { success: false, error: 'No unused source articles available. Run RSS ingestion first.' };
    }

    // Use specified source or pick the most recent one
    const source = sourceId
      ? sources.find((s: any) => s.id === sourceId) || sources[0]
      : sources[0];

    const client = new Anthropic({ apiKey });

    const message = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      system: DEBATE_SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: `Generate a debate based on this article:\n\nTitle: ${source.title}\nSource: ${source.source_name}\nURL: ${source.source_url}\n\nSummary: ${source.summary}`,
      }],
    });

    // Extract text content
    const responseText = message.content
      .filter((block: any) => block.type === 'text')
      .map((block: any) => block.text)
      .join('');

    // Parse the JSON response
    let debateData: any;
    try {
      // Try to extract JSON from the response (handle potential markdown wrapping)
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON found in response');
      debateData = JSON.parse(jsonMatch[0]);
    } catch (parseErr: any) {
      return { success: false, error: `Failed to parse debate response: ${parseErr.message}` };
    }

    // Validate structure
    if (!debateData.question || !debateData.exchanges || !Array.isArray(debateData.exchanges)) {
      return { success: false, error: 'Invalid debate structure from AI' };
    }

    // Store the debate
    const debateId = uuidv4();

    // Clear previous featured debate and set new one
    clearFeaturedDebates();

    insertDebate({
      id: debateId,
      topic: debateData.topic || 'AI',
      question: debateData.question,
      summary: debateData.summary || null,
      source_article_id: source.id,
      source_url: source.source_url,
      source_name: source.source_name,
      source_title: source.title,
      exchanges: debateData.exchanges,
      status: 'published',
      published: 1,
      featured: 1,
    });

    // Mark the source as used
    markSourceUsed(source.id);

    return { success: true, debate_id: debateId };

  } catch (err: any) {
    return { success: false, error: err.message || 'Unknown error during debate generation' };
  }
}
