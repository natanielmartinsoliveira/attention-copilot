"""Speech-to-text providers (§26). The worker's VAD runs before any of them, so
silence is never transcribed or sent anywhere. Local faster-whisper is the
default; remote providers send audio off the machine and are opt-in via env.
"""
from __future__ import annotations

import io
import os
import threading
from dataclasses import dataclass
from typing import Callable, Protocol

import numpy as np
import soundfile as sf


@dataclass(frozen=True)
class Transcript:
    text: str
    provider: str
    model: str


class SpeechToTextProvider(Protocol):
    name: str

    def transcribe(self, audio: np.ndarray, rate: int) -> Transcript: ...


class FasterWhisperProvider:
    """Local Whisper via CTranslate2; the model loads on first speech."""

    name = 'faster-whisper'

    def __init__(self, model: str = 'small', device: str = 'cpu', compute: str = 'int8', language: str = 'pt'):
        self.model_name, self.device, self.compute, self.language = model, device, compute, language
        self.model = None
        self._lock = threading.Lock()

    def _load(self):
        with self._lock:
            if self.model is None:
                from faster_whisper import WhisperModel
                self.model = WhisperModel(self.model_name, device=self.device, compute_type=self.compute)
        return self.model

    def transcribe(self, audio: np.ndarray, rate: int) -> Transcript:
        if rate != 16000:
            raise ValueError('faster-whisper expects 16 kHz audio')
        segments, _ = self._load().transcribe(
            audio, language=self.language, vad_filter=True, condition_on_previous_text=False, beam_size=1
        )
        text = ' '.join(s.text.strip() for s in segments if s.no_speech_prob < 0.65)
        return Transcript(text, self.name, self.model_name)


def wav_bytes(audio: np.ndarray, rate: int) -> bytes:
    buffer = io.BytesIO()
    sf.write(buffer, audio, rate, format='WAV', subtype='PCM_16')
    return buffer.getvalue()


class OpenAICompatibleSTT:
    """POST /audio/transcriptions in the OpenAI dialect (OpenAI, Groq)."""

    def __init__(self, name: str, base_url: str, api_key: str, model: str, language: str = 'pt',
                 timeout: float = 15.0, post: Callable | None = None):
        self.name, self.base_url, self.api_key, self.model = name, base_url.rstrip('/'), api_key, model
        self.language, self.timeout = language, timeout
        if post is None:
            import requests
            post = requests.post
        self._post = post

    def transcribe(self, audio: np.ndarray, rate: int) -> Transcript:
        response = self._post(
            f'{self.base_url}/audio/transcriptions',
            headers={'Authorization': f'Bearer {self.api_key}'},
            files={'file': ('audio.wav', wav_bytes(audio, rate), 'audio/wav')},
            data={'model': self.model, 'language': self.language, 'response_format': 'json', 'temperature': '0'},
            timeout=self.timeout,
        )
        if response.status_code != 200:
            raise RuntimeError(f'http_{response.status_code}')
        text = response.json().get('text')
        if not isinstance(text, str):
            raise RuntimeError('invalid_response')
        return Transcript(text.strip(), self.name, self.model)


class FallbackSTT:
    """Tries providers in order; the first answer wins (§39 applied to STT)."""

    def __init__(self, providers: list[SpeechToTextProvider], on_error: Callable[[str, Exception], None] | None = None):
        if not providers:
            raise ValueError('at least one STT provider is required')
        self.providers = providers
        self.on_error = on_error or (lambda name, error: None)
        self.name = '>'.join(p.name for p in providers)

    def transcribe(self, audio: np.ndarray, rate: int) -> Transcript:
        last: Exception | None = None
        for provider in self.providers:
            try:
                return provider.transcribe(audio, rate)
            except Exception as error:  # noqa: BLE001 - any provider failure moves on
                self.on_error(provider.name, error)
                last = error
        raise RuntimeError('all STT providers failed') from last


REMOTE = {
    'groq': ('https://api.groq.com/openai/v1', 'GROQ_API_KEY', 'whisper-large-v3-turbo'),
    'openai': ('https://api.openai.com/v1', 'OPENAI_API_KEY', 'whisper-1'),
}


def from_env(env=os.environ, on_error=None) -> FallbackSTT:
    """STT_PROVIDERS is an ordered chain, default 'faster-whisper' (local only).
    Example: STT_PROVIDERS=groq,faster-whisper sends audio to Groq and falls back
    to local Whisper. Remote entries without an API key are skipped."""
    chain: list[SpeechToTextProvider] = []
    language = env.get('STT_LANGUAGE', 'pt')
    for name in [n.strip().lower() for n in env.get('STT_PROVIDERS', 'faster-whisper').split(',') if n.strip()]:
        if name == 'faster-whisper':
            chain.append(FasterWhisperProvider(
                env.get('STT_MODEL', 'small'), env.get('STT_DEVICE', 'cpu'), env.get('STT_COMPUTE', 'int8'), language))
        elif name in REMOTE:
            base, key_var, default_model = REMOTE[name]
            key = env.get(key_var)
            if key:
                chain.append(OpenAICompatibleSTT(
                    name, base, key, env.get(f'{name.upper()}_STT_MODEL', default_model), language))
        else:
            raise ValueError(f'unknown STT provider: {name}')
    if not chain:
        raise ValueError('STT_PROVIDERS yielded no usable provider (missing API keys?)')
    return FallbackSTT(chain, on_error)
