# 为纸印 Paperseal 贡献代码

首次参与可以先在本机打开一份示例 PDF，跑通盖章和导出流程。[返回项目首页](README.md)

## 在 Ubuntu 上运行

Ubuntu 以 22.04 x86-64 为构建基线。准备稳定版 Rust 和 Python 3，然后在仓库根目录运行下列命令。

```sh
sudo apt update
sudo apt install build-essential pkg-config libssl-dev libgtk-3-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev
python3 tools/prepare.py
cargo run --locked -p pdf-seal
```

`prepare.py` 首次下载固定版本的 PDF.js 并校验 SHA-512，之后复用缓存。修改 `ui/` 后重新运行该脚本。

## 测试与 Debian 打包

用下列命令测试盖章布局及 PDF 导出，并生成本机的 Debian 安装包。

```sh
cargo test --locked -p seal-core
cargo build --locked --release -p pdf-seal
bash tools/package-deb.sh
```

## 在 Windows 上构建

Windows 使用稳定版 Rust 的 MSVC 工具链、Visual Studio C++ Build Tools、Windows SDK、Python 3 和 WebView2。在仓库根目录运行以下命令，默认产物为 `target/release/pdf-seal.exe`。

```powershell
python tools/prepare.py
cargo build --locked --release -p pdf-seal
```

## 代码结构

[core/](core/) 包含骑缝分组、坐标换算与 PDF 导出，[desktop/](desktop/) 负责 Tauri 窗口和本地文件操作，[ui/](ui/) 提供 PDF.js 预览与印章交互。[导出测试](core/tests/export.rs) 覆盖分组交接页、旋转和裁剪后的页面等边界情况。

## 提交改动

提交拉取请求时，请说明改了什么、如何验证。涉及印章位置或骑缝分组时，注明样稿页数、所选页边和预期盖章位置，方便其他人复查。
