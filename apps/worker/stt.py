"""Explicit browser audio -> in-memory WAV -> Silero VAD -> local Whisper.
No audio files or transcript contents are logged. Configure the same token as API.
"""
import asyncio
import io
import os
import secrets
import time
import threading
from fastapi import FastAPI, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import numpy as np
import soundfile as sf
from faster_whisper import WhisperModel
from faster_whisper.vad import get_speech_timestamps, VadOptions

app = FastAPI()
app.add_middleware(CORSMiddleware,allow_origins=['http://127.0.0.1:5173','http://localhost:5173','http://127.0.0.1:4317','http://localhost:4317'],allow_methods=['POST','GET'],allow_headers=['Authorization','Content-Type'])
model = None
model_lock = threading.Lock()
semaphore = asyncio.Semaphore(2)
token = os.environ.get('ATTENTION_TOKEN', '')
if not token:
    raise RuntimeError('Set ATTENTION_TOKEN to the same token used by the API.')

def decode(raw: bytes):
    audio, rate = sf.read(io.BytesIO(raw), dtype='float32', always_2d=True)
    if rate != 16000 or audio.shape[1] != 1 or len(audio) > 16000 * 10 or not len(audio):
        raise ValueError('Expected mono PCM WAV, 16 kHz, max 10 seconds.')
    return audio[:, 0]

def transcribe(audio):
    global model
    speech = get_speech_timestamps(audio, VadOptions(min_silence_duration_ms=300))
    if not speech:
        return ''
    with model_lock:
        if model is None:
            model = WhisperModel(os.environ.get('STT_MODEL','small'),device=os.environ.get('STT_DEVICE','cpu'),compute_type=os.environ.get('STT_COMPUTE','int8'))
    segments, info = model.transcribe(audio,language='pt',vad_filter=True,condition_on_previous_text=False,beam_size=1)
    return ' '.join(s.text.strip() for s in segments if s.no_speech_prob < 0.65)

@app.get('/health')
def health():
    return {'ok':True,'modelLoaded':model is not None,'storesAudio':False}

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
        text=await asyncio.to_thread(transcribe,audio)
    return {'text':text,'speaker':'unknown','latencyMs':round((time.monotonic()-start)*1000),'provider':'faster-whisper-local'}
