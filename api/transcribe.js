const { YoutubeTranscript } = require('youtube-transcript');

// ── Helpers ───────────────────────────────────────────────────────────────────

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
      title:     d.title        || null,
      channel:   d.author_name  || null,
      thumbnail: d.thumbnail_url || null,
    };
  } catch {
    return null;
  }
}

async function getYouTubeAudioUrl(videoId) {
  // Invidious: frontends públicos do YouTube que expõem a URL de áudio
  const instances = [
    'https://inv.tux.pizza',
    'https://invidious.privacydev.net',
    'https://yt.artemislena.eu',
    'https://invidious.lunar.icu',
    'https://iv.melmac.space',
    'https://invidious.fdn.fr',
    'https://invidious.nerdvpn.de',
    'https://invidious.kavin.rocks',
    'https://y.com.sb',
  ];

  for (const base of instances) {
    try {
      console.log('[audio] tentando Invidious:', base);
      const res = await fetch(`${base}/api/v1/videos/${videoId}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Transcriber/1.0)' },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) { console.log('[audio]', base, 'HTTP', res.status); continue; }

      const data = await res.json();
      const fmts = (data.adaptiveFormats || [])
        .filter(f => f.type?.startsWith('audio/'))
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

      if (fmts[0]?.url) {
        console.log('[audio] OK:', base);
        return fmts[0].url;
      }
      console.log('[audio]', base, 'sem formato de áudio');
    } catch (e) {
      console.log('[audio]', base, 'erro:', e.message);
    }
  }

  throw new Error('Não foi possível obter o áudio deste vídeo. Tente outro link.');
}

async function generateInsights(transcript, title) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client    = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });

  const prompt = `Você é um especialista em síntese de conteúdo. Analise a transcrição do vídeo "${title}" e retorne um JSON com exatamente esta estrutura (sem markdown, sem texto extra — apenas JSON puro):

{
  "summary": "Resumo em 3 frases curtas separadas por ponto.",
  "learnings": ["Aprendizado 1...", "Aprendizado 2...", "..."],
  "quotes": ["Citação ou frase marcante 1.", "..."]
}

Inclua 5 a 7 aprendizados e 3 a 5 citações. Use o idioma da transcrição.

Transcrição:
${transcript.substring(0, 10000)}`;

  const msg   = await client.messages.create({
    model:      'claude-opus-4-5',
    max_tokens: 1500,
    messages:   [{ role: 'user', content: prompt }],
  });
  const clean = msg.content[0].text
    .trim()
    .replace(/^```(?:json)?\n?/, '')
    .replace(/\n?```$/, '')
    .trim();
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

  // Fetch metadata (always)
  const metadata = await getVideoMetadata(url);

  // ── Path 1: youtube-transcript (fast, free) ───────────────────────────────
  try {
    const segments = await YoutubeTranscript.fetchTranscript(videoId);
    const transcript = segments
      .map(s => s.text)
      .join(' ')
      .replace(/\[.*?\]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    const wordCount  = transcript.split(/\s+/).filter(Boolean).length;
    const aiEnabled  = !!process.env.ANTHROPIC_API_KEY;
    let   insights   = null;

    if (aiEnabled && metadata?.title) {
      try { insights = await generateInsights(transcript, metadata.title); }
      catch (e) { console.error('[insights error]', e.message); }
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
      source: 'captions',
    });

  } catch (captionErr) {
    console.log('[captions failed]', captionErr.message, '— trying AssemblyAI fallback');
  }

  // ── Path 2: AssemblyAI fallback (audio transcription) ────────────────────
  if (!process.env.ASSEMBLYAI_API_KEY) {
    return res.status(404).json({
      error: 'Este vídeo não possui legendas disponíveis. Ative a transcrição por áudio adicionando a chave ASSEMBLYAI_API_KEY no Vercel.',
    });
  }

  try {
    const audioUrl = await getYouTubeAudioUrl(videoId);
    const { AssemblyAI } = require('assemblyai');
    const client = new AssemblyAI({ apiKey: process.env.ASSEMBLYAI_API_KEY });

    const job = await client.transcripts.submit({
      audio_url:          audioUrl,
      language_detection: true,
    });

    // Return 202 Accepted — client will poll /api/status
    return res.status(202).json({
      jobId:     job.id,
      fallback:  'assemblyai',
      videoId,
      title:     metadata?.title     || 'Vídeo do YouTube',
      channel:   metadata?.channel   || 'Canal desconhecido',
      thumbnail: metadata?.thumbnail || null,
      aiEnabled: !!process.env.ANTHROPIC_API_KEY,
    });

  } catch (err) {
    console.error('[assemblyai submit error]', err.message);
    return res.status(500).json({
      error: 'Não foi possível processar o vídeo. Tente novamente.',
    });
  }
};
