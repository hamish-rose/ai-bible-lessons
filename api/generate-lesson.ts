import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Octokit } from '@octokit/rest';
import fetch from 'node-fetch';
import { Resend } from 'resend';

interface ProgressState {
  plan: string;
  completed_passages: string[];
  total_lessons: number;
  last_generated: string | null;
  preferences: {
    email: string;
    verses_per_lesson: string;
    focus_themes: string[];
  };
}

interface GrokResponse {
  reference: string;
  lesson_html: string;
}

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const resend = new Resend(process.env.RESEND_API_KEY!);

const REPO_OWNER = 'hamish-rose';
const REPO_NAME = 'ai-bible-lessons';
const FILE_PATH = 'progress.json';
const GROK_API_URL = 'https://api.x.ai/v1/chat/completions';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    // 1. Fetch state
    const { data } = await octokit.repos.getContent({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      path: FILE_PATH,
    });

    const content = Buffer.from((data as any).content, 'base64').toString();
    const state: ProgressState = JSON.parse(content);

    // 2. Build prompt
    const completedList = state.completed_passages.join(', ') || 'none';
    const prompt = `
You are generating a daily Bible lesson from the NIV.
Rules:
- Select ONE insightful passage (1–5 verses) from ANY book.
- NEVER repeat: ${completedList}
- Return JSON only:
{
  "reference": "Book Chapter:Start-End",
  "lesson_html": "<h2>...</h2>..."
}
`;

    // 3. Call Grok API
    const grokRes = await fetch(GROK_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROK_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'grok-3',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.8,
        response_format: { type: 'json_object' },
      }),
    });

    const grokData: any = await grokRes.json();
    const result: GrokResponse = JSON.parse(grokData.choices[0].message.content);

    // 4. Send email
    await resend.emails.send({
      from: 'Bible Lessons <no-reply@yourdomain.com>',
      to: state.preferences.email,
      subject: `Daily Insight: ${result.reference}`,
      html: result.lesson_html,
    });

    const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN!;
    const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID!;

    // 4.2 Send telegram bot notification
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: `*Daily Insight: ${result.reference}*\n\n${result.lesson_html.replace(/<[^>]*>/g, '')}`,
        parse_mode: 'Markdown',
        disable_web_page_preview: true
      }),
    });

    // 5. Update state
    state.completed_passages.push(result.reference);
    state.total_lessons = state.completed_passages.length;
    state.last_generated = new Date().toISOString().split('T')[0];

    await octokit.repos.createOrUpdateFileContents({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      path: FILE_PATH,
      message: `Lesson: ${result.reference}`,
      content: Buffer.from(JSON.stringify(state, null, 2)).toString('base64'),
      sha: (data as any).sha,
    });

    res.status(200).json({ success: true, reference: result.reference });
  } catch (error: any) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
}