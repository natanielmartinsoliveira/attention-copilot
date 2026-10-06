"""Explicit browser audio -> in-memory WAV -> Silero VAD -> SpeechToTextProvider.
No audio files or transcript contents are logged. Configure the same token as API.
Provider chain from STT_PROVIDERS (default: local faster-whisper only).
"""
import asyncio
import io
import json
import os
import secrets
import time
from fastapi import FastAPI, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import soundfile as sf
from faster_whisper.vad import get_speech_timestamps, VadOptions
from apps.worker import providers

app = FastAPI()
app.add_middleware(CORSMiddleware,allow_origins=['http://127.0.0.1:5173','http://localhost:5173','http://127.0.0.1:4317','http://localhost:4317'],allow_methods=['POST','GET'],allow_headers=['Authorization','Content-Type'])
semaphore = asyncio.Semaphore(2)
token = os.environ.get('ATTENTION_TOKEN', '')
if not token:
    raise RuntimeError('Set ATTENTION_TOKEN to the same token used by the API.')

def log_failure(name, error):
    # Provider name and error class only: never audio or text.
    print(json.dumps({'timestamp':round(time.time()*1000),'type':'stt_provider_failure','provider':name,'error':type(error).__name__}),flush=True)

stt = providers.from_env(on_error=log_failure)

def decode(raw: bytes):
    audio, rate = sf.read(io.BytesIO(raw), dtype='float32', always_2d=True)
    if rate != 16000 or audio.shape[1] != 1 or len(audio) > 16000 * 10 or not len(audio):
        raise ValueError('Expected mono PCM WAV, 16 kHz, max 10 seconds.')
    return audio[:, 0]

def has_speech(audio) -> bool:
    return bool(get_speech_timestamps(audio, VadOptions(min_silence_duration_ms=300)))

def transcribe(audio) -> providers.Transcript:
    # VAD is the gate: silence never reaches a provider, local or remote (§25).
    if not has_speech(audio):
        return providers.Transcript('', 'vad', 'silero')
    return stt.transcribe(audio, 16000)

@app.get('/health')
def health():
    local = [p for p in stt.providers if isinstance(p, providers.FasterWhisperProvider)]
    return {'ok':True,'providers':[p.name for p in stt.providers],'modelLoaded':any(p.model is not None for p in local),'storesAudio':False,
            'sendsAudioOffMachine':any(not isinstance(p, providers.FasterWhisperProvider) for p in stt.providers)}

@app.post('/transcribe')
async def endpoint(request:Request):
    given=request.headers.get('authorization','').removeprefix('Bearer ')
    if not secrets.compare_digest(given,token):
        raise HTTPException(401,'Unauthorized')
    # Bound body incrementally instead of trusting Content-Length.
    body=bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body)>400000:
            raise HTTPException(413,'Audio too large')
    try:
        audio=decode(bytes(body))
    except Exception:
        raise HTTPException(400,'Invalid WAV: mono 16 kHz, maximum 10 seconds')
    if semaphore.locked():
        raise HTTPException(429,'STT busy; retry with next chunk')
    start=time.monotonic()
    async with semaphore:
        try:
            result=await asyncio.to_thread(transcribe,audio)
        except RuntimeError:
            raise HTTPException(503,'No STT provider available')
    return {'text':result.text,'speaker':'unknown','latencyMs':round((time.monotonic()-start)*1000),'provider':result.provider,'model':result.model}
