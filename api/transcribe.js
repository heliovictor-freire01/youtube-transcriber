const { YoutubeTranscript } = require('youtube-transcript');

// ── Helpers ──────────────────────────────────────────────────────────────────

function extractVideoId(url) {
  if (!url) return null;
  const patterns = [
    /[?&]v=([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

async function getVideoMetadata(videoUrl) {
  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(videoUrl)}&format=json`;
    const res = await fetch(oembedUrl, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const d = await res.json();
    return {
      title:     d.title       || null,
      channel:   d.author_name || null,
      thumbnail: d.thumbnail_url || null,
    };
  } catch {
    return null;
  }
}

async function generateInsights(transcript, title) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });

  const prompt = `Você é um especialista em síntese de conteúdo. Analise a transcrição do vídeo "${title}" e retorne um JSON com exatamente esta estrutura (sem markdown, sem texto extra — apenas JSON puro):

{
  "summary": "Resumo em 3 frases curtas separadas por ponto, capturando a essência do conteúdo.",
  "learnings": [
    "Aprendizado 1 explicado em 1-2 linhas.",
    "Aprendizado 2...",
    "..."
  ],
  "quotes": [
    "Citação ou frase marcante do vídeo.",
    "..."
  ]
}

Inclua 5 a 7 aprendizados e 3 a 5 citações. Use o idioma da transcrição.

Transcrição:
${transcript.substring(0, 10000)}`;

  const msg = await client.messages.create({
    model:      'claude-opus-4-5',
    max_tokens: 1500,
    messages:   [{ role: 'user', content: prompt }],
  });

  const text = msg.content[0].text.trim();
  // strip markdown code fences if Claude wrapped it
  const clean = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
  return JSON.parse(clean);
}

// ── Handler ───────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Método não permitido.' });

  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'URL é obrigatória.' });

  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: 'URL inválida. Use um link do YouTube válido.' });

  try {
    // Fetch metadata and transcript in parallel
    const [metadata, transcriptSegments] = await Promise.all([
      getVideoMetadata(url),
      YoutubeTranscript.fetchTranscript(videoId),
    ]);

    const transcript = transcriptSegments
      .map(s => s.text)
      .join(' ')
      .replace(/\[.*?\]/g, '')   // remove [Music], [Applause] etc.
      .replace(/\s+/g, ' ')
      .trim();

    const wordCount = transcript.split(/\s+/).filter(Boolean).length;

    // Generate AI insights if key is available
    let insights   = null;
    const aiEnabled = !!process.env.ANTHROPIC_API_KEY;

    if (aiEnabled && metadata?.title) {
      try {
        insights = await generateInsights(transcript, metadata.title);
      } catch (e) {
        console.error('[insights error]', e.message);
        // insights stays null — transcript is still returned
      }
    }

    return res.status(200).json({
      videoId,
      title:     metadata?.title     || 'Vídeo do YouTube',
      channel:   metadata?.channel   || 'Canal desconhecido',
      thumbnail: metadata?.thumbnail || null,
      transcript,
      wordCount,
      insights,
      aiEnabled,
    });

  } catch (err) {
    console.error('[transcribe error]', err.message);

    const msg = err.message || '';
    if (
      msg.includes('Could not get transcripts') ||
      msg.includes('No transcripts') ||
      msg.includes('Transcript is disabled')
    ) {
      return res.status(404).json({
        error: 'Este vídeo não possui transcrição/legendas disponíveis. Tente outro vídeo.',
      });
    }

    return res.status(500).json({
      error: 'Não foi possível processar o vídeo. Tente novamente.',
    });
  }
};
