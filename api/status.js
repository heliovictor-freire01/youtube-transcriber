// GET /api/status?jobId=xxx
// Polls AssemblyAI for transcription status.
// When complete, also generates AI insights if ANTHROPIC_API_KEY is set.

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

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')    return res.status(405).json({ error: 'Método não permitido.' });

  const { jobId, title } = req.query;
  if (!jobId) return res.status(400).json({ error: 'jobId é obrigatório.' });

  if (!process.env.ASSEMBLYAI_API_KEY) {
    return res.status(500).json({ error: 'ASSEMBLYAI_API_KEY não configurada.' });
  }

  try {
    const { AssemblyAI } = require('assemblyai');
    const client = new AssemblyAI({ apiKey: process.env.ASSEMBLYAI_API_KEY });
    const job    = await client.transcripts.get(jobId);

    if (job.status === 'error') {
      return res.status(500).json({ status: 'error', error: 'Falha na transcrição do áudio.' });
    }

    if (job.status !== 'completed') {
      return res.status(200).json({ status: job.status }); // 'queued' or 'processing'
    }

    // Completed — clean up transcript
    const transcript = (job.text || '').replace(/\s+/g, ' ').trim();
    const wordCount  = transcript.split(/\s+/).filter(Boolean).length;
    const aiEnabled  = !!process.env.ANTHROPIC_API_KEY;
    let   insights   = null;

    if (aiEnabled && title) {
      try { insights = await generateInsights(transcript, decodeURIComponent(title)); }
      catch (e) { console.error('[insights error]', e.message); }
    }

    return res.status(200).json({
      status: 'completed',
      transcript,
      wordCount,
      insights,
      aiEnabled,
      source: 'audio',
    });

  } catch (err) {
    console.error('[status error]', err.message);
    return res.status(500).json({ error: 'Erro ao verificar status. Tente novamente.' });
  }
};
