"""
POST /api/transcribe-audio
Usa yt-dlp com cliente Android para obter a URL de áudio do YouTube
(bypassa bot detection) e submete ao AssemblyAI para transcrição.
Retorna { jobId } para polling via /api/status.
"""

from http.server import BaseHTTPRequestHandler
import json
import os
import urllib.request
import yt_dlp


def get_audio_url(video_url: str) -> str:
    """Extrai URL de áudio usando yt-dlp com player Android."""
    ydl_opts = {
        "format": "bestaudio/best",
        "quiet": True,
        "no_warnings": True,
        "extractor_args": {
            # Android client é tratado diferente pelo YouTube
            # — passa pela detecção de bots mais facilmente
            "youtube": {"player_client": ["android"]}
        },
    }

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(video_url, download=False)

        # Formato direto
        if info.get("url"):
            return info["url"]

        # Lista de formatos — pega melhor áudio
        formats = info.get("formats", [])
        audio = [
            f for f in formats
            if f.get("acodec") != "none" and f.get("vcodec") == "none"
        ]
        if not audio:
            audio = [f for f in formats if f.get("acodec") != "none"]
        if not audio:
            raise ValueError("Nenhum formato de áudio encontrado")

        audio.sort(key=lambda f: f.get("abr") or 0, reverse=True)
        return audio[0]["url"]


def submit_to_assemblyai(audio_url: str) -> str:
    """Envia URL de áudio ao AssemblyAI e retorna o job ID."""
    api_key = os.environ.get("ASSEMBLYAI_API_KEY", "")
    if not api_key:
        raise ValueError("ASSEMBLYAI_API_KEY não configurada")

    payload = json.dumps({
        "audio_url": audio_url,
        "language_detection": True,
    }).encode()

    req = urllib.request.Request(
        "https://api.assemblyai.com/v2/transcript",
        data=payload,
        headers={
            "Authorization": api_key,
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read())["id"]


class handler(BaseHTTPRequestHandler):

    def log_message(self, fmt, *args):  # silencia logs HTTP padrão
        pass

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json(self, code: int, data: dict):
        body = json.dumps(data).encode()
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(200)
        self._cors()
        self.end_headers()

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            body   = json.loads(self.rfile.read(length))
            url    = body.get("url", "")

            if not url:
                return self._json(400, {"error": "URL é obrigatória."})

            print(f"[yt-dlp] buscando áudio: {url}")
            audio_url = get_audio_url(url)
            print(f"[yt-dlp] URL obtida, submetendo ao AssemblyAI")

            job_id = submit_to_assemblyai(audio_url)
            print(f"[yt-dlp] job AssemblyAI: {job_id}")

            self._json(200, {
                "jobId":     job_id,
                "aiEnabled": bool(os.environ.get("ANTHROPIC_API_KEY")),
            })

        except Exception as exc:
            print(f"[yt-dlp error] {exc}")
            self._json(500, {"error": f"Não foi possível processar o áudio: {exc}"})
