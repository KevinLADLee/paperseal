use image::{DynamicImage, Rgba, RgbaImage};
use lopdf::{dictionary, Dictionary, Document, Object, Stream};
use seal_core::{export, layout, Mark, Page};
use std::io::Cursor;

fn page(width: f64, height: f64, transform: [f64; 6]) -> Page {
    Page {
        width,
        height,
        transform,
    }
}

fn mark(asset: usize, page: usize, seam: bool) -> Mark {
    Mark {
        asset,
        page,
        seam,
        x: 0.25,
        y: 0.5,
        mm: 25.4,
        aspect: 2.0,
        settings: Default::default(),
    }
}

#[test]
fn every_group_reassembles_the_full_seal_without_gaps() {
    for limit in [2, 6, 7, 8, 20] {
        for page_count in 2..=50 {
            let pages = vec![page(360., 480., [1., 0., 0., -1., 0., 480.]); page_count];
            let mut m = mark(0, 0, true);
            m.settings.limit = limit;
            let parts = layout(&pages, &[m]).unwrap();
            let groups = (page_count - 1).div_ceil(limit - 1);
            assert_eq!(parts.len(), page_count + groups - 1);
            assert_eq!(parts.first().unwrap().page, 0);
            assert_eq!(parts.last().unwrap().page, page_count - 1);
            for (idx, group) in parts.chunk_by(|a, b| a.group == b.group).enumerate() {
                assert!((2..=limit).contains(&group.len()));
                assert_eq!(group[0].group, idx);
                assert_eq!(group[0].start, 0.);
                assert_eq!(group.last().unwrap().end, 1.);
                assert!(group.windows(2).all(|p| p[0].page + 1 == p[1].page
                    && p[0].end == p[1].start
                    && p[0].y == p[1].y));
            }
            for pair in parts.windows(2).filter(|p| p[0].group != p[1].group) {
                let (a, b) = (&pair[0], &pair[1]);
                assert_eq!(a.page, b.page);
                assert!(a.y + a.height <= b.y + 1e-8 || b.y + b.height <= a.y + 1e-8);
            }
            assert!(parts
                .iter()
                .all(|p| (p.x + p.width - 360.).abs() < 1e-8 && p.start < p.end));
        }
    }
}

#[test]
fn selected_pages_edges_and_per_page_positions() {
    use seal_core::Edge;
    let pages = vec![page(400., 500., [1., 0., 0., -1., 0., 500.]); 32];
    let mut m = mark(0, 0, true);
    let odd: Vec<usize> = (0..32).step_by(2).collect();
    m.settings.targets = Some(odd.clone());
    for edge in [Edge::Left, Edge::Right, Edge::Top, Edge::Bottom] {
        m.settings.edge = edge;
        let plan = layout(&pages, &[m.clone()]).unwrap();
        let mut actual: Vec<_> = plan.iter().map(|p| p.page).collect();
        actual.dedup();
        assert_eq!(actual, odd);
        assert_eq!(plan.iter().filter(|p| p.start == 0.).count(), 3);
        for pair in plan.windows(2).filter(|p| p[0].page == p[1].page) {
            let (a, b) = (&pair[0], &pair[1]);
            if a.vertical_slice {
                assert!(a.x + a.width <= b.x + 1e-8 || b.x + b.width <= a.x + 1e-8);
            } else {
                assert!(a.y + a.height <= b.y + 1e-8 || b.y + b.height <= a.y + 1e-8);
            }
        }
        for p in plan {
            assert!(match edge {
                Edge::Left => p.x == 0.,
                Edge::Right => (p.x + p.width - 400.).abs() < 1e-8,
                Edge::Top => p.y == 0. && p.vertical_slice,
                Edge::Bottom => (p.y + p.height - 500.).abs() < 1e-8 && p.vertical_slice,
            });
        }
    }
    m.settings.limit = 2;
    m.settings.targets = Some(vec![0, 2, 4]);
    assert!(layout(&pages, &[m.clone()])
        .unwrap()
        .iter()
        .all(|p| p.width.is_finite() && p.height.is_finite()));
    m.seam = false;
    m.settings.positions.insert("2".into(), [0.0, 1.0]);
    let plan = layout(&pages, &[m]).unwrap();
    assert_eq!(plan[1].x, 0.);
    assert_eq!(plan[1].y + plan[1].height, 500.);
    assert!(plan[0].x > 0.);
}

#[test]
fn export_preserves_source_text_resources_transparency_and_page_rotation() {
    let mut doc = Document::with_version("1.5");
    let root = doc.new_object_id();
    let font =
        doc.add_object(dictionary! {"Type"=>"Font","Subtype"=>"Type1","BaseFont"=>"Helvetica"});
    let parent = doc.new_object_id();
    let mut kids = Vec::new();
    for angle in [0, 90, 180, 270] {
        // Leave a transformed graphics state at the end of the original page.
        let content = doc.add_object(Stream::new(
            Dictionary::new(),
            b"BT /F1 14 Tf 60 390 Td (Paperseal fixture) Tj ET 2 0 0 2 18 11 cm".to_vec(),
        ));
        let indirect_array = doc.add_object(Object::Array(vec![content.into()]));
        kids.push(doc.add_object(dictionary! {"Type"=>"Page","Parent"=>parent,"Rotate"=>angle,
            "CropBox"=>vec![20.into(),30.into(),380.into(),510.into()], "Contents"=>indirect_array}).into());
    }
    doc.objects.insert(
        parent,
        dictionary! {"Type"=>"Pages","Count"=>4,"Kids"=>kids,
        "Resources"=>dictionary! {"Font"=>dictionary!{"F1"=>font}},
        "MediaBox"=>vec![0.into(),0.into(),400.into(),540.into()]}
        .into(),
    );
    doc.objects
        .insert(root, dictionary! {"Type"=>"Catalog","Pages"=>parent}.into());
    doc.trailer.set("Root", root);
    let mut source = Vec::new();
    doc.save_to(&mut source).unwrap();
    let pages = vec![
        page(360., 480., [1., 0., 0., -1., -20., 510.]),
        page(480., 360., [0., 1., 1., 0., -30., -20.]),
        page(360., 480., [-1., 0., 0., 1., 380., -30.]),
        page(480., 360., [0., -1., -1., 0., 510., 380.]),
    ];
    let image = RgbaImage::from_fn(120, 60, |x, y| {
        if y < 6 {
            Rgba([10, 20, 30, 0])
        } else if x < 40 {
            Rgba([220, 0, 0, 255])
        } else {
            Rgba([0, 65, 180, 255])
        }
    });
    let mut png = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(image)
        .write_to(&mut png, image::ImageFormat::Png)
        .unwrap();
    let marks = [mark(0, 0, false), mark(0, 1, false), mark(0, 0, true)];
    let assets = vec![png.into_inner()];
    let result = export(&source, &pages, &marks, &assets).unwrap();
    let encrypted = seal_core::export_copy(
        &source,
        &pages,
        &marks,
        &assets,
        &seal_core::OutputOptions {
            input_password: String::new(),
            new_password: Some("paperseal-test".into()),
        },
        None,
    )
    .unwrap();
    let keep = seal_core::OutputOptions {
        input_password: "paperseal-test".into(),
        new_password: None,
    };
    let protected_copy =
        seal_core::export_copy(&encrypted, &pages, &marks, &assets, &keep, None).unwrap();
    let roundtrip = Document::load_mem_with_options(
        &protected_copy,
        lopdf::LoadOptions::with_password("paperseal-test"),
    )
    .unwrap();
    assert!(roundtrip.encryption_state.is_some());
    assert!(roundtrip
        .extract_text(&[1])
        .unwrap()
        .contains("Paperseal fixture"));
    assert!(seal_core::export_copy(
        &encrypted,
        &pages,
        &marks,
        &assets,
        &seal_core::OutputOptions::default(),
        None
    )
    .is_err());
    let output = Document::load_mem(&result).unwrap();
    for (n, id) in output.get_pages() {
        assert!(output
            .extract_text(&[n])
            .unwrap()
            .contains("Paperseal fixture"));
        let dict = output.get_dictionary(id).unwrap();
        assert_eq!(
            dict.get(b"Rotate").unwrap().as_i64().unwrap(),
            (n as i64 - 1) * 90
        );
        let images = output.get_page_images(id).unwrap();
        assert!(!images.is_empty());
        assert!(images[0].origin_dict.has(b"SMask"));
    }
    if let Some(folder) = std::env::var_os("PAPERSEAL_QA_DIR") {
        let dir = std::path::Path::new(&folder);
        std::fs::create_dir_all(dir).unwrap();
        for (name, data) in [
            ("protected.pdf", &encrypted),
            ("input.pdf", &source),
            ("export.pdf", &result),
            ("mark.png", &assets[0]),
        ] {
            std::fs::write(dir.join(name), data).unwrap();
        }
    }
}
