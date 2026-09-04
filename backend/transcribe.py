#!/usr/bin/env python3
"""Demucs 吉他分轨 + Basic Pitch MIDI 转录后端。"""
from __future__ import annotations

import argparse
import csv
import json
import sys
import traceback
from pathlib import Path


def emit(event_type: str, message: str = "", **extra: object) -> None:
    print(json.dumps({"type": event_type, "message": message, **extra}, ensure_ascii=False), flush=True)


def check_dependencies():
    if sys.version_info[:2] not in {(3, 10), (3, 11)}:
        raise RuntimeError(
            "当前 Python 为 " + sys.version.split()[0] + "。请使用 Python 3.10 或 3.11。"
        )
    try:
        import demucs.separate
        from basic_pitch.inference import predict
    except ImportError as exc:
        raise RuntimeError(
            "AI 引擎缺少模块 "
            + (exc.name or "unknown")
            + "。请在 Python 3.11 环境中运行：pip install -r backend/requirements.txt"
        ) from exc
    return demucs.separate, predict


def find_guitar_stem(stems_root: Path, track_stem: str) -> Path:
    expected = stems_root / "htdemucs_6s" / track_stem / "guitar.wav"
    if expected.exists():
        return expected
    matches = list(stems_root.glob("**/guitar.wav"))
    if matches:
        return matches[0]
    raise RuntimeError("Demucs 没有生成 guitar.wav。请确认 htdemucs_6s 模型下载完成。")


def write_note_events(path: Path, note_events) -> None:
    with path.open("w", newline="", encoding="utf-8") as output:
        writer = csv.writer(output)
        writer.writerow(["start_seconds", "end_seconds", "midi_note", "amplitude", "pitch_bend"])
        writer.writerows(note_events)


def run(input_path: Path, output_path: Path, device: str) -> None:
    demucs_separate, basic_pitch_predict = check_dependencies()
    if device == "cuda":
        import torch
        if not torch.cuda.is_available():
            emit("log", "未检测到可用 CUDA PyTorch，已自动切换到 CPU。")
            device = "cpu"
    output_path.mkdir(parents=True, exist_ok=True)
    stems_root = output_path / "stems"
    midi_root = output_path / "midi"
    midi_root.mkdir(exist_ok=True)

    emit("progress", "正在使用 Demucs 6-stem 模型提取吉他轨…", percent=5)
    # htdemucs_6s 是 Demucs 的实验性吉他/钢琴 6 轨模型。
    demucs_separate.main([
        "-n", "htdemucs_6s",
        "--device", device,
        "--out", str(stems_root),
        str(input_path),
    ])
    guitar_path = find_guitar_stem(stems_root, input_path.stem)

    emit("progress", "吉他分轨完成，正在用 Basic Pitch 识别复音与推弦…", percent=72)
    _model_output, midi_data, note_events = basic_pitch_predict(
        str(guitar_path),
        minimum_frequency=75.0,
        maximum_frequency=1320.0,
    )
    midi_path = midi_root / (input_path.stem + "_guitar.mid")
    notes_path = midi_root / (input_path.stem + "_guitar_notes.csv")
    midi_data.write(str(midi_path))
    write_note_events(notes_path, note_events)
    emit(
        "result",
        "已生成吉他分轨、MIDI 草稿和音符事件表。请进行人工校对。",
        percent=100,
        guitarPath=str(guitar_path),
        midiPath=str(midi_path),
        notesPath=str(notes_path),
        outputPath=str(output_path),
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--input")
    parser.add_argument("--output")
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
    args = parser.parse_args()
    try:
        check_dependencies()
        if args.check:
            emit("ready", "Python、Demucs 和 Basic Pitch 已就绪。")
            return 0
        if not args.input or not args.output:
            raise RuntimeError("缺少 --input 或 --output 参数。")
        run(Path(args.input).expanduser().resolve(), Path(args.output).expanduser().resolve(), args.device)
        return 0
    except Exception as exc:
        emit("error", str(exc))
        traceback.print_exc(file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
