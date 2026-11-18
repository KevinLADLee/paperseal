#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
target=${CARGO_TARGET_DIR:-target}
version=$(sed -n 's/^version = "\([^"]*\)"/\1/p' desktop/Cargo.toml | head -1)
arch=$(dpkg --print-architecture)
pkg=$(mktemp -d)
trap 'rm -rf -- "$pkg"' EXIT
install -Dm755 "$target/release/pdf-seal" "$pkg/usr/bin/paperseal"
install -Dm644 desktop/icons/128x128.png "$pkg/usr/share/icons/hicolor/128x128/apps/paperseal.png"
mkdir -p "$pkg/DEBIAN" "$pkg/usr/share/applications" release
cat > "$pkg/DEBIAN/control" <<EOF
Package: paperseal
Version: $version
Architecture: $arch
Maintainer: Paperseal developers
Section: office
Priority: optional
Depends: libwebkit2gtk-4.1-0, libgtk-3-0, libc6, libgcc-s1, fonts-noto-cjk | fonts-wqy-zenhei
Description: Offline desktop PDF stamp and signature image editor
EOF
cat > "$pkg/usr/share/applications/paperseal.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Paperseal
Name[zh_CN]=纸印
Comment=PDF 盖章与签字
Icon=paperseal
Exec=paperseal
Terminal=false
Categories=Office;
EOF
dpkg-deb --root-owner-group --build "$pkg" "release/paperseal_${version}_${arch}.deb"
