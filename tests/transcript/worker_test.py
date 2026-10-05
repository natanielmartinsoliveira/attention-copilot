"""Run from project root after installing apps/worker/requirements.txt.
ATTENTION_TOKEN=test python -m unittest discover -s tests/transcript -p '*_test.py'
"""
import io
import unittest
import numpy as np
import soundfile as sf
from apps.worker import stt
class WorkerTests(unittest.TestCase):
    def audio(self,rate=16000,channels=1,seconds=3):
        b=io.BytesIO();sf.write(b,np.zeros((rate*seconds,channels),dtype=np.float32),rate,format='WAV',subtype='PCM_16');return b.getvalue()
    def test_decode_pcm(self):
        self.assertEqual(len(stt.decode(self.audio())),48000)
    def test_silence_vad_skips_whisper(self):
        self.assertEqual(stt.transcribe(stt.decode(self.audio())), '')
        self.assertIsNone(stt.model)
    def test_invalid_rates(self):
        for rate in [8000,44100]:
            with self.assertRaises(ValueError):stt.decode(self.audio(rate))
    def test_stereo_rejected(self):
        with self.assertRaises(ValueError):stt.decode(self.audio(channels=2))
    def test_oversized_rejected(self):
        with self.assertRaises(ValueError):stt.decode(self.audio(seconds=11))
