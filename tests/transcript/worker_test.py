"""Run from project root after installing apps/worker/requirements.txt.
ATTENTION_TOKEN=test python -m unittest discover -s tests/transcript -p '*_test.py'
"""
import io
import json
import unittest
from unittest import mock
import numpy as np
import soundfile as sf
from apps.worker import providers, stt
class WorkerTests(unittest.TestCase):
    def audio(self,rate=16000,channels=1,seconds=3):
        b=io.BytesIO();sf.write(b,np.zeros((rate*seconds,channels),dtype=np.float32),rate,format='WAV',subtype='PCM_16');return b.getvalue()
    def test_decode_pcm(self):
        self.assertEqual(len(stt.decode(self.audio())),48000)
    def test_silence_vad_skips_every_provider(self):
        fake=mock.Mock(name='provider')
        with mock.patch.object(stt,'stt',fake):
            result=stt.transcribe(stt.decode(self.audio()))
        self.assertEqual((result.text,result.provider),('','vad'))
        fake.transcribe.assert_not_called()
    def test_speech_goes_to_the_provider_chain(self):
        fake=mock.Mock(name='provider');fake.transcribe.return_value=providers.Transcript('olá','fake','m')
        with mock.patch.object(stt,'stt',fake),mock.patch.object(stt,'has_speech',return_value=True):
            self.assertEqual(stt.transcribe(np.zeros(16000,dtype=np.float32)).text,'olá')
        fake.transcribe.assert_called_once()
    def test_default_chain_is_local_only_and_lazy(self):
        chain=providers.from_env({})
        self.assertEqual([p.name for p in chain.providers],['faster-whisper'])
        self.assertIsNone(chain.providers[0].model)
    def test_invalid_rates(self):
        for rate in [8000,44100]:
            with self.assertRaises(ValueError):stt.decode(self.audio(rate))
    def test_stereo_rejected(self):
        with self.assertRaises(ValueError):stt.decode(self.audio(channels=2))
    def test_oversized_rejected(self):
        with self.assertRaises(ValueError):stt.decode(self.audio(seconds=11))
class ProviderTests(unittest.TestCase):
    class Failing:
        name='down'
        def transcribe(self,audio,rate):raise RuntimeError('boom')
    class Echo:
        def __init__(self,name):self.name=name
        def transcribe(self,audio,rate):return providers.Transcript('ok',self.name,'m')
    def test_fallback_uses_next_provider_and_reports(self):
        errors=[]
        chain=providers.FallbackSTT([self.Failing(),self.Echo('local')],lambda n,e:errors.append(n))
        self.assertEqual(chain.transcribe(np.zeros(10),16000).provider,'local')
        self.assertEqual(errors,['down'])
    def test_all_failing_raises(self):
        with self.assertRaises(RuntimeError):providers.FallbackSTT([self.Failing()]).transcribe(np.zeros(10),16000)
    def test_remote_request_shape(self):
        response=mock.Mock(status_code=200);response.json.return_value={'text':' olá mundo '}
        post=mock.Mock(return_value=response)
        p=providers.OpenAICompatibleSTT('groq','https://x/v1/','KEY','whisper-large-v3-turbo',post=post)
        result=p.transcribe(np.zeros(16000,dtype=np.float32),16000)
        self.assertEqual(result,providers.Transcript('olá mundo','groq','whisper-large-v3-turbo'))
        url=post.call_args.args[0];kw=post.call_args.kwargs
        self.assertEqual(url,'https://x/v1/audio/transcriptions')
        self.assertEqual(kw['headers'],{'Authorization':'Bearer KEY'})
        self.assertEqual(kw['data']['model'],'whisper-large-v3-turbo')
        self.assertEqual(kw['data']['language'],'pt')
        name,body,mime=kw['files']['file']
        self.assertEqual((name,mime),('audio.wav','audio/wav'))
        self.assertEqual(body[:4],b'RIFF')
    def test_remote_errors_raise(self):
        post=mock.Mock(return_value=mock.Mock(status_code=429))
        with self.assertRaises(RuntimeError):
            providers.OpenAICompatibleSTT('groq','u','k','m',post=post).transcribe(np.zeros(10,dtype=np.float32),16000)
    def test_env_chain_skips_remote_without_key(self):
        self.assertEqual([p.name for p in providers.from_env({'STT_PROVIDERS':'groq,faster-whisper'}).providers],['faster-whisper'])
        chain=providers.from_env({'STT_PROVIDERS':'groq,faster-whisper','GROQ_API_KEY':'k'})
        self.assertEqual([p.name for p in chain.providers],['groq','faster-whisper'])
    def test_env_rejects_unknown_and_empty(self):
        with self.assertRaises(ValueError):providers.from_env({'STT_PROVIDERS':'nope'})
        with self.assertRaises(ValueError):providers.from_env({'STT_PROVIDERS':'openai'})
    def test_failure_log_has_no_content(self):
        with mock.patch('builtins.print') as p:
            stt.log_failure('groq',RuntimeError('secret transcript text'))
        line=json.loads(p.call_args.args[0])
        self.assertEqual(line['provider'],'groq')
        self.assertNotIn('secret',json.dumps(line))
