# 吉他扒谱助手

本地 Electron 工作台：用 Demucs 的实验性 htdemucs_6s 模型尝试提取吉他轨，再用 Basic Pitch 输出可人工校对的 MIDI 草稿和音符事件 CSV。

> 分轨和转录都会有串音、漏音与节奏误差；结果是扒谱起点，不是成品谱。

## 环境

- Node.js 20+
- Python 3.10 或 3.11。当前项目中的 Python 3.13 不受 Basic Pitch 官方支持。
- Windows 上建议安装 FFmpeg 并放入 PATH，以保证 MP3、M4A 等格式可被 Demucs 读取。

创建一个独立的 Python 3.11 环境后，安装引擎：

    py -3.11 -m venv .engine
    .\.engine\Scripts\Activate.ps1
    python -m pip install --upgrade pip
    pip install -r backend\requirements.txt

安装 Electron 依赖并启动：

    npm install
    npm start

在“引擎设置”中填写 .engine\Scripts\python.exe 的绝对路径，然后点击“检查 AI 引擎”。

## 工作流

1. 导入自己有权使用的本地音频。
2. 应用使用 htdemucs_6s 生成 guitar.wav。
3. Basic Pitch 将吉他轨转换为 MIDI 与 CSV。
4. 在应用内打开“查看 TAB 草稿”，根据 CSV 自动查看六线谱草稿。
5. 在输出目录中对照 guitar.wav 人工修正 MIDI 和 TAB。

TAB 以标准吉他调弦（E A D G B e）和 0–24 品范围自动推断弦位；同一音高可能有多个可演奏位置，节奏、指法、推弦和不在标准音域内的音符仍需人工校对。

首次处理时 Demucs 会下载模型。CPU 处理时间与曲目长度接近；有兼容 CUDA 环境时可在界面切换至 GPU。

## 打包

    npm run dist

安装包不内置 Python、模型或 FFmpeg；它们由用户指定的本地 Python 环境运行。
