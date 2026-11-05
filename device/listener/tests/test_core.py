"""聞き役の、音声を使わない部分の試験。vosk・sounddevice が無くても回せる。
実行（device/listener フォルダで）: python3 -m unittest discover -s tests
"""

import io
import sys
import unittest
import wave
from array import array
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from listener_core import (  # noqa: E402
    GRAMMAR,
    RATE,
    Endpointer,
    beep_pcm,
    is_wake,
    multipart,
    pick_device,
    rms,
    wav_bytes,
)


def vosk(*pairs):
    """Vosk の最終結果の形（SetWords(True)）。"""
    return {
        "result": [{"word": w, "conf": c, "start": i * 0.3, "end": i * 0.3 + 0.3} for i, (w, c) in enumerate(pairs)],
        "text": " ".join(w for w, _ in pairs),
    }


class WakeTest(unittest.TestCase):
    def test_grammarは決めた形(self):
        self.assertEqual(GRAMMAR, ["んだ クロード", "[unk]"])

    def test_両語が続けて出て両方conf以上なら起動(self):
        self.assertTrue(is_wake(vosk(("んだ", 0.98), ("クロード", 0.95))))
        self.assertTrue(is_wake(vosk(("んだ", 0.9), ("クロード", 0.9))))
        # 前後に別の語があっても、続けて出ていればよい
        self.assertTrue(is_wake(vosk(("[unk]", 0.5), ("んだ", 0.99), ("クロード", 0.99))))

    def test_confが足りない語があれば起動しない(self):
        self.assertFalse(is_wake(vosk(("んだ", 0.89), ("クロード", 0.99))))
        self.assertFalse(is_wake(vosk(("んだ", 0.99), ("クロード", 0.5))))
        # 「なんだ、クローゼットか」の誤検出の形（conf 0.65）
        self.assertFalse(is_wake(vosk(("んだ", 0.65), ("んだ", 0.65), ("クロード", 0.65))))

    def test_閾値は変えられる(self):
        r = vosk(("んだ", 0.8), ("クロード", 0.8))
        self.assertFalse(is_wake(r))
        self.assertTrue(is_wake(r, min_conf=0.75))

    def test_片方だけ_順が逆_間に別の語があれば起動しない(self):
        self.assertFalse(is_wake(vosk(("クロード", 0.99))))
        self.assertFalse(is_wake(vosk(("んだ", 0.99))))
        self.assertFalse(is_wake(vosk(("クロード", 0.99), ("んだ", 0.99))))
        self.assertFalse(is_wake(vosk(("んだ", 0.99), ("[unk]", 0.99), ("クロード", 0.99))))

    def test_resultが無い_壊れているなら起動しない(self):
        self.assertFalse(is_wake({"text": "んだ クロード"}))
        self.assertFalse(is_wake({"result": "んだ クロード"}))
        self.assertFalse(is_wake({"result": [{"word": "んだ"}, {"word": "クロード", "conf": 1.0}]}))
        self.assertFalse(is_wake({"result": [None, None]}))
        self.assertFalse(is_wake({}))


def pcm_of(value, sec):
    return array("h", [value] * int(RATE * sec)).tobytes()


class EndpointerTest(unittest.TestCase):
    def feed(self, ep, levels, sec=0.1):
        for i, lv in enumerate(levels):
            if ep.feed(lv, sec):
                return i
        return None

    def test_声の後に無音が続いたら止める(self):
        ep = Endpointer(silence_rms=500, silence_sec=1.5)
        stop = self.feed(ep, [1000] * 10 + [100] * 30)
        self.assertEqual(stop, 10 + 15 - 1)
        self.assertTrue(ep.spoke)

    def test_無音の途中で声が戻れば数え直す(self):
        ep = Endpointer(silence_rms=500, silence_sec=1.5)
        stop = self.feed(ep, [1000] * 5 + [100] * 10 + [1000] * 5 + [100] * 30)
        self.assertEqual(stop, 5 + 10 + 5 + 15 - 1)

    def test_話し続けても最大の秒数で止める(self):
        ep = Endpointer(silence_rms=500, max_sec=30)
        stop = self.feed(ep, [1000] * 400)
        self.assertEqual(stop, 299)
        self.assertTrue(ep.spoke)

    def test_声が出ないまま待ちの秒数を過ぎたら止めて_送らない印(self):
        ep = Endpointer(silence_rms=500, first_voice_sec=5)
        stop = self.feed(ep, [100] * 100)
        self.assertEqual(stop, 49)
        self.assertFalse(ep.spoke)

    def test_合図の後すぐ話さなくても_声が出る前の無音では止めない(self):
        ep = Endpointer(silence_rms=500, silence_sec=1.5, first_voice_sec=5)
        stop = self.feed(ep, [100] * 30 + [1000] * 5 + [100] * 20)
        self.assertEqual(stop, 30 + 5 + 15 - 1)


class AudioTest(unittest.TestCase):
    def test_rms(self):
        self.assertEqual(rms(b""), 0.0)
        self.assertAlmostEqual(rms(pcm_of(1000, 0.1)), 1000.0)
        self.assertAlmostEqual(rms(pcm_of(-300, 0.1)), 300.0)
        self.assertEqual(rms(b"\x01"), 0.0)

    def test_wavは16kHzモノラル16bitでPCMがそのまま入る(self):
        pcm = pcm_of(123, 0.5)
        data = wav_bytes(pcm)
        with wave.open(io.BytesIO(data)) as w:
            self.assertEqual((w.getnchannels(), w.getsampwidth(), w.getframerate()), (1, 2, 16000))
            self.assertEqual(w.readframes(w.getnframes()), pcm)

    def test_合図音は短く_音割れしない(self):
        a = array("h")
        a.frombytes(beep_pcm())
        self.assertEqual(len(a), int(RATE * 0.15))
        self.assertLess(max(abs(x) for x in a), 32767 * 0.31)
        self.assertGreater(max(abs(x) for x in a), 1000)
        self.assertLess(abs(a[0]), 10)
        self.assertLess(abs(a[-1]), 10)


class MultipartTest(unittest.TestCase):
    def test_vendorとfileが入る(self):
        import email.parser
        import email.policy

        body, ctype = multipart({"vendor": "scribe"}, "file", "voice.wav", "audio/wav", b"RIFF\x00\x01")
        msg = email.parser.BytesParser(policy=email.policy.HTTP).parsebytes(
            b"Content-Type: " + ctype.encode() + b"\r\n\r\n" + body
        )
        parts = list(msg.iter_parts())
        self.assertEqual(len(parts), 2)
        self.assertEqual(parts[0].get_param("name", header="content-disposition"), "vendor")
        self.assertEqual(parts[0].get_content(), "scribe")
        self.assertEqual(parts[1].get_param("name", header="content-disposition"), "file")
        self.assertEqual(parts[1].get_filename(), "voice.wav")
        self.assertEqual(parts[1].get_content_type(), "audio/wav")
        self.assertEqual(parts[1].get_payload(decode=True), b"RIFF\x00\x01")


DEVICES = [
    {"name": "MacBook Pro Microphone", "max_input_channels": 1, "max_output_channels": 0},
    {"name": "MacBook Pro Speakers", "max_input_channels": 0, "max_output_channels": 2},
    {"name": "Jabra SPEAK 510 USB", "max_input_channels": 1, "max_output_channels": 2},
]


class PickDeviceTest(unittest.TestCase):
    def test_指定が無ければ既定(self):
        self.assertIsNone(pick_device(DEVICES, None))
        self.assertIsNone(pick_device(DEVICES, ""))

    def test_名前の部分一致_大文字小文字を問わない(self):
        self.assertEqual(pick_device(DEVICES, "jabra"), 2)
        self.assertEqual(pick_device(DEVICES, "Jabra", "output"), 2)
        self.assertEqual(pick_device(DEVICES, "MacBook"), 0)
        self.assertEqual(pick_device(DEVICES, "MacBook", "output"), 1)

    def test_当たりが無ければ既定に戻さず失敗(self):
        with self.assertRaises(ValueError):
            pick_device(DEVICES, "Speakers")  # 出力しかない
        with self.assertRaises(ValueError):
            pick_device(DEVICES, "USB Audio")
        with self.assertRaises(ValueError):
            pick_device(DEVICES, "Jabra", "both")


if __name__ == "__main__":
    unittest.main()
