"""Offline video renderer. Intended for Cloud Run Jobs with staged R2 objects."""
import argparse
import subprocess
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description="Render a 9:16 H.264/AAC Story")
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--watermark", default="", help="Optional attribution text")
    args = parser.parse_args()

    source = args.input.resolve(strict=True)
    target = args.output.resolve()
    if not source.is_file() or source == target:
        parser.error("Input must be a file distinct from output")
    target.parent.mkdir(parents=True, exist_ok=True)

    # One image only, with letterboxing; never duplicate or zoom the face.
    vf = (
        "scale=720:1280:force_original_aspect_ratio=decrease,"
        "pad=720:1280:(ow-iw)/2:(oh-ih)/2:color=black,"
        "setsar=1"
    )
    if args.watermark:
        # Use a textfile to avoid interpolation into FFmpeg filter expressions.
        label = target.with_suffix(".watermark.txt")
        label.write_text(args.watermark, encoding="utf-8")
        escaped = str(label).replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")
        vf += (
            f",drawtext=textfile='{escaped}':fontcolor=white:fontsize=26:"
            "box=1:boxcolor=black@0.45:boxborderw=10:x=24:y=h-th-40"
        )
    command = [
        "ffmpeg", "-hide_banner", "-nostdin", "-y", "-i", str(source),
        "-map", "0:v:0", "-map", "0:a:0?", "-vf", vf,
        "-c:v", "libx264", "-preset", "medium", "-crf", "22",
        "-pix_fmt", "yuv420p", "-r", "30",
        "-c:a", "aac", "-b:a", "160k", "-ar", "48000",
        "-af", "loudnorm=I=-16:TP=-1.5:LRA=11",
        "-movflags", "+faststart", str(target),
    ]
    subprocess.run(command, check=True, timeout=1800)


if __name__ == "__main__":
    main()
