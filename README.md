# 纸印 Paperseal

离线桌面 PDF 盖章工具，面向 Ubuntu 和 Windows。打开 PDF，选择保存位置，从常用印章下拉框选章或首次导入 PNG/JPEG。顶部可同时选择普通章和骑缝章模式。默认是全合同加骑缝章、自定义页加普通章。在右侧翻到签章页，点击确定普通章位置，同页再次点击会移动该章。点击「盖章」一次生成副本。默认保存在源文件夹，同名副本自动编号。保存成功后，点击「打开输出文件夹」即可找到最近一次保存的副本。每份新合同单独记录页内点位；常用章、尺寸和骑缝设置会记住。

需要在同页盖多枚章时可打开「连续签章」。需要另一枚印章或签字图片时，展开「追加印章或签字图片」。选中追加的标记后，点「页码与外观」可设置全部、排除首页或尾页、奇偶页或指定页（例如 `1,3-6,9`）。各类标记均可旋转、设置切边、不透明度及白底透明容差。

骑缝章至少选两页。可选上、下、左、右页边，数值设定或拖动沿边位置。百分比以扣除章宽或章高后的可移动距离计，横边从左量，竖边从上量。默认每枚最多跨 8 个参与页，可调整。相邻组共用一页，两枚章沿同一页边交错排列，沿边百分比控制这对章的位置。15 页分为 1–8 页和 8–15 页，第 8 页同时保留两段章。超过上限时均衡分组，每组至少两页。

顶部「输出」默认叠加，保留原文字。选择「合并为图片」后，在「导出设置」中可指定 72、150、300 或 600 DPI，逐页合成图像，输出不再包含原文字层、表单或链接。带打开密码的 PDF 会在读取时询问密码；导出的副本默认沿用源文件保护，也可以显式选择不加密或设定新的 AES-256 打开密码。密码只在当前文档会话中使用。图片签字仅提供可见签字外观，盖章副本可能影响已有数字签名。

导入的图片会保存在当前电脑的用户图片库中。再次点击「添加印章」「签字图片」或「骑缝章」，可以从缩略图选取，也可点击「从文件选择…」导入新图。普通章与骑缝章共用印章库。图片库内的「移除」只清除缓存。

打开「连续签章」后，选择图片，在页面上每点一次就放置一枚，可翻页继续。已有选中的普通章或签字时，开启模式会沿用其图片和毫米宽度。按 Esc 退出。选中页面上的标记后按 Delete 删除，点击「撤销」可以恢复；删除骑缝章会移除整组切片。

## 安装

- Ubuntu x86-64：安装 release 目录中的 `.deb` 包，在应用菜单打开「纸印」。也可以运行 `sudo apt install ./release/paperseal_0.3.3_amd64.deb`。
- Windows x64：把 `release/Paperseal.exe` 复制到需要使用的电脑，双击即可启动。界面和 PDF 预览资源都已内置。电脑需要有 Microsoft Edge WebView2 运行时。

## 在 Ubuntu 开发

本机 WSL2 的主工作区位于 `~/projects/PDF-QFZ`。在 Ubuntu 终端进入该目录后运行 `source .local-tools/ubuntu-env.sh`，即可使用本机已安装的 Rust 工具链和 ext4 上的 Cargo 缓存。准备前端资源后，使用下面的 Cargo 命令开发、测试和打包。

以 Ubuntu 22.04 x86-64 为构建基线。安装当前稳定版 Rust、Python 3，以及桌面依赖：

```sh
sudo apt update
sudo apt install build-essential pkg-config libssl-dev libgtk-3-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev
python3 tools/prepare.py
cargo run --locked -p pdf-seal
```

修改 `ui/` 后重新执行 `python3 tools/prepare.py` 再编译。脚本首次下载固定版本的 PDF.js 并核对 SHA-512，随后复用本地缓存。发布的桌面端在本地读取 PDF、字体资源及印章图片。

```sh
cargo test --locked -p seal-core
cargo build --locked --release -p pdf-seal
bash tools/package-deb.sh
```

Windows 使用 MSVC、Windows SDK、WebView2 和同一套 Rust 源码。在项目根目录运行 `python tools/prepare.py` 和 `cargo build --locked --release -p pdf-seal`。生成的 `target/release/pdf-seal.exe` 可独立分发。推送到 `main`、提交拉取请求或在 Actions 中手动运行 **Desktop packages**，都会分别构建 Ubuntu 22.04、Ubuntu 24.04 和 Windows 11 x64 便携版。Windows 版由 GitHub 的 Windows Server 2022 x64 构建机生成。

在成功运行的 Artifacts 中按系统下载。Windows 解压后双击 EXE，使用系统 WebView2 运行时。Ubuntu 解开对应版本的 `.tar.gz` 后运行其中的 AppImage，压缩包保留可执行权限。若系统缺少 FUSE 2，可运行 `APPIMAGE_EXTRACT_AND_RUN=1 ./Paperseal-Ubuntu-22.04-x86_64.AppImage`（24.04 使用相应文件名）。

## 实现

- `core/` 计算毫米尺寸、页内位置及骑缝切片，并将图像与透明度蒙版写入 PDF。预览和导出使用同一布局算法。
- `desktop/` 管理原始文档、原生文件对话框和临时文件写入。完成后将临时文件替换为目标副本，拒绝覆盖当前源文件。
- `ui/` 通过内置 PDF.js 预览和翻页，把每页包含裁剪、旋转、用户单位的坐标变换交给 Rust。
- `core/tests/` 覆盖骑缝分组边界和真实 PDF 导出，包括继承资源、间接内容数组、透明图片、旋转和裁剪框。
