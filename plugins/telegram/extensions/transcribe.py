import argparse
import json

from faster_whisper import WhisperModel


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="small")
    parser.add_argument("--language", default=None)
    parser.add_argument("--download-only", action="store_true")
    parser.add_argument("audio", nargs="?")
    args = parser.parse_args()

    model = WhisperModel(args.model, device="cpu", compute_type="int8")

    if args.download_only:
        print(json.dumps({"ok": True}))
        return

    segments, info = model.transcribe(
        args.audio, language=args.language, vad_filter=True, beam_size=5
    )
    text = " ".join(segment.text.strip() for segment in segments).strip()

    print(json.dumps({"text": text, "duration": info.duration}, ensure_ascii=False))


if __name__ == "__main__":
    main()
