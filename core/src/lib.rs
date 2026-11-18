use anyhow::{anyhow, bail, ensure, Context, Result};
use flate2::{write::ZlibEncoder, Compression};
use lopdf::{
    content::{Content, Operation},
    dictionary, Dictionary, Document, Object, ObjectId, Stream,
};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, io::Write};

// Display coordinates are physical PDF points, measured from the visible top left.
// PDF.js supplies the scale-one viewport (including CropBox, Rotate and UserUnit).
#[derive(Clone, Deserialize)]
pub struct Page {
    pub width: f64,
    pub height: f64,
    pub transform: [f64; 6],
}

#[derive(Clone, Deserialize)]
pub struct Mark {
    pub asset: usize,
    pub page: usize, // zero based
    pub seam: bool,
    pub x: f64, // fraction of available travel after subtracting the mark's size
    pub y: f64,
    pub mm: f64,
    pub aspect: f64,
    #[serde(flatten)]
    pub settings: LayoutSettings,
}

#[derive(Clone, Copy, Default, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Edge {
    Left,
    #[default]
    Right,
    Top,
    Bottom,
}

#[derive(Clone, Deserialize)]
#[serde(default)]
pub struct LayoutSettings {
    pub targets: Option<Vec<usize>>,
    pub edge: Edge,
    pub limit: usize,
    pub scale: f64,
    pub positions: HashMap<String, [f64; 2]>,
}
impl Default for LayoutSettings {
    fn default() -> Self {
        Self {
            targets: None,
            edge: Edge::Right,
            limit: 8,
            scale: 1.,
            positions: HashMap::new(),
        }
    }
}

#[derive(Clone, Serialize)]
pub struct Placement {
    pub mark: usize,
    pub page: usize,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub start: f64,
    pub end: f64,
    pub vertical_slice: bool,
    pub group: usize,
    // Along-edge distance between the two stamp positions, in PDF points.
    pub lane_step: f64,
}

pub fn layout(pages: &[Page], marks: &[Mark]) -> Result<Vec<Placement>> {
    ensure!(!pages.is_empty(), "PDF 没有可用页面");
    for p in pages {
        ensure!(
            p.width.is_finite() && p.width > 0.0 && p.height.is_finite() && p.height > 0.0,
            "PDF 页面尺寸无效"
        );
    }
    let mut out = Vec::new();
    for (i, m) in marks.iter().enumerate() {
        ensure!(
            m.page < pages.len()
                && (1.0..=300.0).contains(&m.mm)
                && m.aspect.is_finite()
                && m.aspect > 0.0,
            "印章尺寸或页码无效"
        );
        ensure!(
            (0.0..=1.0).contains(&m.x) && (0.0..=1.0).contains(&m.y),
            "印章位置超出页面"
        );
        ensure!(!m.seam || pages.len() >= 2, "骑缝章至少需要两页");
        let s = &m.settings;
        let targets = s.targets.clone().unwrap_or_else(|| {
            if m.seam {
                (0..pages.len()).collect()
            } else {
                vec![m.page]
            }
        });
        ensure!(
            !targets.is_empty()
                && targets.iter().all(|&n| n < pages.len())
                && targets.windows(2).all(|w| w[0] < w[1]),
            "页码必须在文档范围内且不重复"
        );
        ensure!(!m.seam || targets.len() >= 2, "骑缝章至少需要两个目标页");
        ensure!(
            s.limit >= 2 && s.scale.is_finite() && s.scale > 0.,
            "分割数或印章比例无效"
        );
        let full = m.mm * 72.0 / 25.4 * s.scale;
        // Partition the gaps between consecutive target pages. Neighbouring groups
        // share the page at their boundary, including for odd/even or custom targets.
        let gaps = targets.len() - 1;
        let groups = if m.seam {
            gaps.div_ceil(s.limit - 1)
        } else {
            1
        };
        for group in 0..groups {
            let first = group * gaps / groups;
            let last = (group + 1) * gaps / groups;
            let count = last - first + 1;
            for (index, &n) in targets[first..=last].iter().enumerate() {
                let p = &pages[n];
                let (start, end) = if m.seam {
                    let boundary = |k: usize| match k {
                        0 => 0.0,
                        k if k == count => 1.0,
                        k => 1.0 / 3.0 + (k - 1) as f64 * (2.0 / 3.0) / (count - 1) as f64,
                    };
                    (boundary(index), boundary(index + 1))
                } else {
                    (0.0, 1.0)
                };
                let vertical_slice = m.seam && matches!(s.edge, Edge::Top | Edge::Bottom);
                let width = if vertical_slice {
                    full
                } else {
                    full * (end - start)
                };
                let height = full / m.aspect * if vertical_slice { end - start } else { 1. };
                let [mut x, mut y] = s
                    .positions
                    .get(&n.to_string())
                    .copied()
                    .unwrap_or([m.x, m.y]);
                if m.seam {
                    match s.edge {
                        Edge::Left => x = 0.,
                        Edge::Right => x = 1.,
                        Edge::Top => y = 0.,
                        Edge::Bottom => y = 1.,
                    }
                }
                ensure!(
                    (0.0..=1.0).contains(&x) && (0.0..=1.0).contains(&y),
                    "页内位置超出范围"
                );
                ensure!(
                    width <= p.width && height <= p.height,
                    "印章超过第 {} 页，请减小宽度",
                    n + 1
                );
                let (extent, travel) = if vertical_slice {
                    (width, p.width - width)
                } else {
                    (height, p.height - height)
                };
                let lane_step = if groups > 1 {
                    let shared =
                        (index == 0 && group > 0) || (index + 1 == count && group + 1 < groups);
                    ensure!(
                        !shared || travel >= extent,
                        "第 {} 页的页边放不下两段交接章，请减小印章尺寸或更换页边",
                        n + 1
                    );
                    (extent + 2.0 * 72.0 / 25.4).min(travel)
                } else {
                    0.0
                };
                let (mut left, mut top) = ((p.width - width) * x, (p.height - height) * y);
                if groups > 1 {
                    let offset = (group % 2) as f64 * lane_step;
                    if vertical_slice {
                        left = offset + x * (travel - lane_step);
                    } else {
                        top = offset + y * (travel - lane_step);
                    }
                }
                out.push(Placement {
                    mark: i,
                    page: n,
                    x: left,
                    y: top,
                    width,
                    height,
                    start,
                    end,
                    vertical_slice,
                    group,
                    lane_step,
                });
            }
        }
    }
    Ok(out)
}

fn compressed(bytes: &[u8]) -> Result<Vec<u8>> {
    let mut z = ZlibEncoder::new(Vec::new(), Compression::fast());
    z.write_all(bytes)?;
    Ok(z.finish()?)
}

fn add_image(doc: &mut Document, bytes: &[u8]) -> Result<(ObjectId, f64)> {
    let image = image::load_from_memory(bytes)
        .context("无法读取印章图片")?
        .to_rgba8();
    let (w, h) = image.dimensions();
    let mut rgb = Vec::new();
    let mut alpha = Vec::new();
    for px in image.pixels() {
        rgb.extend_from_slice(&px.0[..3]);
        alpha.push(px.0[3]);
    }
    let mut info = dictionary! { "Type"=>"XObject", "Subtype"=>"Image", "Width"=>i64::from(w),
    "Height"=>i64::from(h), "BitsPerComponent"=>8, "Filter"=>"FlateDecode", "ColorSpace"=>"DeviceGray" };
    if alpha.iter().any(|&v| v != 255) {
        let mask = doc.add_object(Stream::new(info.clone(), compressed(&alpha)?));
        info.set("SMask", mask);
    }
    info.set("ColorSpace", "DeviceRGB");
    Ok((
        doc.add_object(Stream::new(info, compressed(&rgb)?)),
        w as f64 / h as f64,
    ))
}

fn resources(doc: &Document, mut id: ObjectId) -> Result<Dictionary> {
    let mut seen = std::collections::HashSet::new();
    while seen.insert(id) {
        let dict = doc.get_dictionary(id)?;
        if let Ok(res) = dict.get(b"Resources") {
            return Ok(doc.dereference(res)?.1.as_dict()?.clone());
        }
        match dict.get(b"Parent") {
            Ok(parent) => id = parent.as_reference()?,
            Err(_) => return Ok(Dictionary::new()),
        }
    }
    bail!("PDF 页面树包含循环引用")
}

fn numbers(values: &[f64]) -> Vec<Object> {
    values.iter().map(|v| Object::Real(*v as f32)).collect()
}

pub fn export(
    source: &[u8],
    pages: &[Page],
    marks: &[Mark],
    assets: &[Vec<u8>],
) -> Result<Vec<u8>> {
    export_copy(
        source,
        pages,
        marks,
        assets,
        &OutputOptions::default(),
        None,
    )
}

#[derive(Default, Deserialize)]
#[serde(default)]
pub struct OutputOptions {
    pub input_password: String,
    pub new_password: Option<String>, // None keeps the input's protection; empty explicitly removes it.
}

pub fn export_copy(
    source: &[u8],
    pages: &[Page],
    marks: &[Mark],
    assets: &[Vec<u8>],
    options: &OutputOptions,
    raster: Option<&[Vec<u8>]>,
) -> Result<Vec<u8>> {
    let placement = layout(pages, marks)?;
    ensure!(!placement.is_empty(), "请先放置印章或签字图片");
    let mut doc = Document::load_mem_with_options(
        source,
        lopdf::LoadOptions::with_password(&options.input_password),
    )
    .context("无法读取 PDF，请检查密码和文件")?;
    ensure!(!doc.is_encrypted(), "PDF 密码错误或加密方式不受支持");
    let ids: Vec<_> = doc.get_pages().into_values().collect();
    ensure!(
        ids.len() == pages.len(),
        "预览页数与源文件不一致，请重新打开"
    );
    let protection = doc.encryption_state.take();
    if let Some(jpegs) = raster {
        let file_id = doc.trailer.get(b"ID").ok().cloned();
        let mut flat = raster_document(pages, jpegs)?;
        if doc.version == "2.0" {
            flat.version = doc.version.clone();
        }
        if let Some(id) = file_id {
            flat.trailer.set("ID", id);
        }
        return finish(flat, protection, options);
    }
    let mut images = HashMap::new();
    for m in marks {
        if let std::collections::hash_map::Entry::Vacant(slot) = images.entry(m.asset) {
            slot.insert(add_image(
                &mut doc,
                assets.get(m.asset).context("印章素材缺失")?,
            )?);
        }
        ensure!(
            (images[&m.asset].1 / m.aspect - 1.0).abs() < 0.001,
            "印章预览尺寸与原图不一致"
        );
    }
    let mut per_page = vec![Vec::new(); pages.len()];
    for item in placement {
        per_page[item.page].push(item);
    }
    for (index, items) in per_page.iter().enumerate().filter(|(_, v)| !v.is_empty()) {
        let id = ids[index];
        let mut res = resources(&doc, id)?;
        let mut objects = match res.get(b"XObject") {
            Ok(v) => doc.dereference(v)?.1.as_dict()?.clone(),
            Err(_) => Dictionary::new(),
        };
        let [a, b, c, d, e, f] = pages[index].transform;
        let det = a * d - b * c;
        ensure!(det.is_finite() && det.abs() > 1e-12, "PDF 页面变换无效");
        let inverse = [
            d / det,
            -b / det,
            -c / det,
            a / det,
            (c * f - d * e) / det,
            (b * e - a * f) / det,
        ];
        let mut ops = vec![Operation::new("Q", vec![])]; // Restore state saved before the original streams.
        for p in items {
            let asset = marks[p.mark].asset;
            let mut name = format!("Paperseal{asset}");
            while objects.has(name.as_bytes()) {
                name.push('_');
            }
            objects.set(name.as_bytes(), images[&asset].0);
            let fraction = p.end - p.start;
            let (width, height, left, top) = if p.vertical_slice {
                let height = p.height / fraction;
                (p.width, height, p.x, p.y - height * p.start)
            } else {
                let width = p.width / fraction;
                (width, p.height, p.x - width * p.start, p.y)
            };
            ops.extend([
                Operation::new("q", vec![]),
                Operation::new("cm", numbers(&inverse)),
                Operation::new("re", numbers(&[p.x, p.y, p.width, p.height])),
                Operation::new("W", vec![]),
                Operation::new("n", vec![]),
                Operation::new(
                    "cm",
                    numbers(&[width, 0.0, 0.0, -height, left, top + height]),
                ),
                Operation::new("Do", vec![Object::Name(name.into_bytes())]),
                Operation::new("Q", vec![]),
            ]);
        }
        res.set("XObject", objects);
        let mut streams = vec![Object::Reference(
            doc.add_object(Stream::new(Dictionary::new(), b"q\n".to_vec())),
        )];
        if let Ok(original) = doc.get_dictionary(id)?.get(b"Contents") {
            match doc.dereference(original)?.1 {
                Object::Array(array) => streams.extend(array.clone()),
                Object::Stream(_) => streams.push(original.clone()),
                Object::Null => (),
                _ => return Err(anyhow!("第 {} 页内容流无效", index + 1)),
            }
        }
        let overlay = doc.add_object(Stream::new(
            Dictionary::new(),
            Content { operations: ops }.encode()?,
        ));
        streams.push(overlay.into());
        let page = doc.get_dictionary_mut(id)?;
        page.set("Resources", res);
        page.set("Contents", streams);
    }
    finish(doc, protection, options)
}

fn raster_document(pages: &[Page], jpegs: &[Vec<u8>]) -> Result<Document> {
    ensure!(jpegs.len() == pages.len(), "图片页数量不符");
    let mut doc = Document::with_version("1.7");
    let parent = doc.new_object_id();
    let mut kids = Vec::<Object>::new();
    for (page, jpeg) in pages.iter().zip(jpegs) {
        let (w, h) =
            image::ImageReader::with_format(std::io::Cursor::new(jpeg), image::ImageFormat::Jpeg)
                .into_dimensions()?;
        let image=doc.add_object(Stream::new(dictionary!{"Type"=>"XObject","Subtype"=>"Image","ColorSpace"=>"DeviceRGB","BitsPerComponent"=>8,"Filter"=>"DCTDecode","Width"=>i64::from(w),"Height"=>i64::from(h)},jpeg.clone()));
        let content = Content {
            operations: vec![
                Operation::new("cm", numbers(&[page.width, 0., 0., page.height, 0., 0.])),
                Operation::new("Do", vec![Object::Name(b"PageImage".to_vec())]),
            ],
        };
        let contents = doc.add_object(Stream::new(Dictionary::new(), content.encode()?));
        kids.push(doc.add_object(dictionary!{"Type"=>"Page","Parent"=>parent,"MediaBox"=>numbers(&[0.,0.,page.width,page.height]),"Resources"=>dictionary!{"XObject"=>dictionary!{"PageImage"=>image}},"Contents"=>contents}).into());
    }
    doc.objects.insert(
        parent,
        dictionary! {"Type"=>"Pages","Count"=>kids.len() as i64,"Kids"=>kids}.into(),
    );
    let root = doc.add_object(dictionary! {"Type"=>"Catalog","Pages"=>parent});
    doc.trailer.set("Root", root);
    Ok(doc)
}

fn finish(
    mut doc: Document,
    original: Option<lopdf::EncryptionState>,
    options: &OutputOptions,
) -> Result<Vec<u8>> {
    use lopdf::{
        encryption::crypt_filters::{Aes256CryptFilter, CryptFilter},
        EncryptionState, EncryptionVersion, Permissions,
    };
    use std::{collections::BTreeMap, sync::Arc};
    let protection = match &options.new_password {
        None => original,
        Some(password) if password.is_empty() => None,
        Some(password) => {
            ensure!(password.len() <= 127, "PDF 密码最多 127 个 UTF-8 字节");
            let mut key = [0u8; 32];
            getrandom::fill(&mut key).map_err(|_| anyhow!("无法生成加密密钥"))?;
            let filter: Arc<dyn CryptFilter> = Arc::new(Aes256CryptFilter);
            doc.version = "2.0".into();
            if !doc.trailer.has(b"ID") {
                let mut id = [0u8; 16];
                getrandom::fill(&mut id).map_err(|_| anyhow!("无法生成文件标识"))?;
                let id = Object::String(id.to_vec(), lopdf::StringFormat::Hexadecimal);
                doc.trailer.set("ID", vec![id.clone(), id]);
            }
            Some(EncryptionState::try_from(EncryptionVersion::V5 {
                encrypt_metadata: true,
                crypt_filters: BTreeMap::from([(b"StdCF".to_vec(), filter)]),
                file_encryption_key: &key,
                stream_filter: b"StdCF".to_vec(),
                string_filter: b"StdCF".to_vec(),
                owner_password: password,
                user_password: password,
                permissions: original
                    .as_ref()
                    .map(|p| p.permissions())
                    .unwrap_or(Permissions::all()),
            })?)
        }
    };
    if let Some(state) = protection {
        doc.encrypt(&state)?;
    }
    let mut bytes = Vec::new();
    doc.save_to(&mut bytes)?;
    Ok(bytes)
}
