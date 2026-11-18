import { getDocument, GlobalWorkerOptions } from "./vendor/pdf.min.mjs";
import { listImages, rememberImage, forgetImage } from "./library.js";
import {targetPages, horizontalEdge, defaultStyle, styledImage, rasterPages} from "./stamp-options.js";
import {defaults, emptyPageSettings, scopePages, makeStamp, documentStamps} from "./classic.js";

GlobalWorkerOptions.workerSrc = new URL("./vendor/pdf.worker.min.mjs", import.meta.url).href;
const invoke = (cmd, args) => window.__TAURI__.core.invoke(cmd, args);
const $ = id => document.getElementById(id);
const labels = { stamp: "印章", signature: "签字图片", seam: "骑缝章" };
const clamp = n => Math.max(0, Math.min(1, n));
let pdf = null, sourceId = null, pages = [], current = 0, assets = [], marks = [], placements = [];
let selected = -1, history = [], savedState = "[]", busy = false, signedFields = false;
let renderVersion = 0, rendering = null, tool = "stamp", drag = null;
let inputPassword = "";
let libraryImages = [], repeat = false, brush = null;
const pendingClicks = [];
let placingClicks = false;
let hasSavedCopy = false;
let preferences = {};
try { preferences = JSON.parse(localStorage.getItem("paperseal.setup")) || {}; } catch {}
// Older releases saved their 20-page default along with every image choice.
if (!preferences.seamGrouping && preferences.cfg?.seamLimit === 20) preferences.cfg.seamLimit = defaults.seamLimit;
let classic = {cfg:{...defaults,...preferences.cfg}, image:null, ...emptyPageSettings()};
let folderPath = "", destination = "source";

function rememberSetup() {
  try { localStorage.setItem("paperseal.setup",JSON.stringify({seamGrouping:1,cfg:classic.cfg,image:classic.image?.id,output:$("outputMode").value})); } catch {}
}
function syncSetup() {
  for (const key of Object.keys(defaults)) {
    const el = $(key);
    if (el.type === "checkbox") el.checked = classic.cfg[key]; else el.value = classic.cfg[key];
    el.disabled = busy;
  }
  $("classicTolerance").hidden = !classic.cfg.stampWhite;
  $("seamPickRow").hidden = classic.cfg.seamMode !== "custom";
  $("seamPick").disabled = !pdf || busy;
  $("seamPick").checked = classic.seamPages.includes(current);
  $("pickCount").textContent = "（已选 "+classic.seamPages.length+" 页，至少两页）";
  $("activeSeal").value = classic.image ? String(classic.image.id) : "";
  for (const key of ["importSeal","activeSeal","folder","destination","outputMode"]) $(key).disabled = busy;
  $("destination").value = destination;
  $("folderPath").hidden = destination !== "folder";
  $("folderPath").textContent = $("folderPath").title = folderPath;
  $("classicHint").textContent = !classic.image ? "从印章图片列表选择常用章，或点「导入」。"
    : classic.cfg.normalMode === "custom" ? "在预览中点击盖章位置。同页再点可移位，双击普通章可清除本页点位。"
    : classic.cfg.normalMode === "none" ? "普通章已关闭。可翻页检查骑缝章。" : "点击预览可调整普通章位置。已单独定位的页会保留各自的位置。";
}
async function applySetup(next, focusKind, record=true) {
  if (pdf) {
    const automatic = await documentStamps(next,pages.length,assets);
    const focus = automatic.findIndex(m=>m.kind===focusKind);
    await change([...automatic,...marks.filter(m=>!m.classic)],focus,record,next);
  } else { classic=next; controls(); }
  if (repeat && (!brush || brush.classic)) brush=next.image ? await makeStamp(next,assets) : null;
  rememberSetup();
}
for (const key of Object.keys(defaults)) $(key).onchange = e => {
  const el=e.target;
  if (!el.reportValidity()) { syncSetup(); return; }
  const value=el.type==="checkbox"?el.checked:el.type==="number"?el.valueAsNumber:el.value;
  work(()=>applySetup({...classic,cfg:{...classic.cfg,[key]:value}}));
};
$("seamPick").onchange = e => {
  const seamPages = classic.seamPages.filter(n=>n!==current);
  if (e.target.checked) seamPages.push(current);
  work(()=>applySetup({...classic,seamPages},"seam"));
};
async function chooseFolder() {
  const picked=await invoke("choose_output_dir");
  if (picked) { folderPath=picked; destination="folder"; }
}
$("folder").onclick=()=>work(chooseFolder);
$("destination").onchange=e=>{
  const value=e.target.value;
  if (value==="folder" && !folderPath) work(chooseFolder);
  else {destination=value; controls();}
};

function status(message, error = false) {
  $("status").textContent = message;
  $("status").title = message;
  $("status").classList.toggle("error", error);
}
async function work(fn) {
  if (busy) return;
  busy = true; controls();
  try { await fn(); } catch (e) { status(String(e.message || e), true); }
  finally { busy = false; controls(); }
}
function controls() {
  syncSetup();
  const active = Boolean(pdf) && !busy;
  for (const id of ["open", "openEmpty"]) $(id).disabled = busy;
  for (const id of ["stamp", "signature", "page"]) $(id).disabled = !active;
  $("seam").disabled = !active || pages.length < 2;
  $("seam").title = "添加后可设置页边、页码、沿边位置和最大分割数";
  $("save").disabled = !active || !marks.length;
  $("openOutput").disabled = busy || !hasSavedCopy;
  $("undo").disabled = !active || !history.length;
  $("repeat").disabled = !active;
  $("repeat").setAttribute("aria-pressed", String(repeat));
  $("repeat").textContent = repeat ? "退出连续签章" : "连续签章";
  $("repeatHint").hidden = !repeat;
  $("repeatHint").textContent = brush ? "每点击一次放置一枚" + labels[brush.kind] + "，可翻页。Esc 退出。" : "请选择印章或签字图片，再点击页面。Esc 退出。";
  $("overlays").classList.toggle("repeating", repeat && Boolean(brush));
  $("first").disabled = $("prev").disabled = !active || current === 0;
  $("last").disabled = $("next").disabled = !active || current + 1 === pages.length;
  $("total").textContent = pdf ? pages.length : "—";
  $("page").value = current + 1;
  $("page").max = pages.length;
  const seam = marks.find(m=>m.classic && m.seam), regular = marks.find(m=>m.classic && !m.seam);
  const extras = marks.filter(m=>!m.classic).length;
  $("count").textContent = pdf ? "普通章 "+(regular?.targets.length||0)+" 页 · 骑缝章 "+(seam?.targets.length||0)+" 页"+(extras?" · 追加 "+extras+" 项":"") : "";
  if (seam) {
    const index = marks.indexOf(seam);
    const here = placements.filter(p=>p.mark===index && p.page===current);
    if (here.length === 2) $("count").textContent += " · 本页衔接第 "+(here[0].group+1)+"、"+(here[1].group+1)+" 组";
  }
  const mark = marks[selected];
  $("selection").hidden = !mark || mark.classic;
  if (mark && !mark.classic) {
    $("selectedTitle").textContent = labels[mark.kind];
    $("mm").value = mark.mm;
    $("mm").disabled = $("remove").disabled = $("settings").disabled = !active;
    $("moveHint").hidden = repeat;
    $("moveHint").textContent = mark.seam ? "沿页边拖动可调整整组位置；宽度指原始完整印章。" : "拖动标记可调整当前页的位置。";
  }
}
function drawOverlays() {
  const layer = $("overlays");
  layer.replaceChildren();
  if (!pdf) return;
  const page = pages[current];
  for (const p of placements.filter(p => p.page === current)) {
    const el = document.createElement("div");
    el.className = "mark" + (selected === p.mark ? " selected" : "");
    el.dataset.mark = p.mark;
    el.placement = p;
    el.setAttribute("aria-label", labels[marks[p.mark].kind]);
    Object.assign(el.style, { left: 100*p.x/page.width+"%", top: 100*p.y/page.height+"%",
      width: 100*p.width/page.width+"%", height: 100*p.height/page.height+"%" });
    const img = document.createElement("img");
    img.alt = ""; img.draggable = false; img.src = assets[marks[p.mark].asset].url;
    if(p.vertical_slice) {
      img.style.width="100%"; img.style.height=100/(p.end-p.start)+"%";
      img.style.top=-100*p.start/(p.end-p.start)+"%"; img.style.left="0";
    } else {
      img.style.width = 100/(p.end-p.start)+"%";
      img.style.left = -100*p.start/(p.end-p.start)+"%";
    }
    el.append(img); layer.append(el);
  }
}
async function change(next, focus, record = true, nextSetup = classic) {
  const plan = await invoke("plan", { pages, marks: next });
  if (record) {
    history.push({ marks, selected, current, classic });
    if (history.length > 100) history.shift();
  }
  marks = next; placements = plan; selected = focus; classic = nextSetup;
  drawOverlays(); controls();
}
async function render() {
  if (!pdf) return;
  const version = ++renderVersion;
  rendering?.cancel();
  try {
    const page = await pdf.getPage(current + 1);
    if (version !== renderVersion) return;
    const meta = pages[current], stage = $("stage");
    const scale = Math.min((stage.clientWidth-68)/meta.width,(stage.clientHeight-54)/meta.height);
    const displayScale = Math.max(0.05, scale);
    const paper = $("paper");
    paper.dataset.page = current;
    paper.hidden = false; $("empty").hidden = true;
    paper.style.width = meta.width * displayScale + "px";
    paper.style.height = meta.height * displayScale + "px";
    // A separate canvas also isolates cancelled renders while rapidly paging.
    const canvas = document.createElement("canvas");
    canvas.id = "canvas";
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const viewport = page.getViewport({ scale: displayScale * ratio });
    canvas.width = Math.max(1, Math.ceil(viewport.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height));
    $("canvas").replaceWith(canvas);
    drawOverlays();
    const task = page.render({ canvasContext: canvas.getContext("2d"), viewport });
    rendering = task;
    await task.promise;
  } catch (e) { if (version === renderVersion && e.name !== "RenderingCancelledException") status("预览失败：" + e.message, true); }
}
async function openPdf() {
  if (pdf && JSON.stringify(marks) !== savedState && !confirm("当前文档有尚未保存的修改，继续打开其他 PDF？")) return;
  const opened = await invoke("open_pdf");
  if (!opened) return;
  let nextPdf, accepted = false;
  try {
    status("正在读取 " + opened.name);
    const bytes = Uint8Array.from(atob(opened.data), c => c.charCodeAt(0));
    const base = new URL("./vendor/", import.meta.url).href;
    const task=getDocument({ data: bytes, cMapUrl: base+"cmaps/", cMapPacked: true,
      standardFontDataUrl: base+"standard_fonts/", isEvalSupported: false });
    let password="";
    const cancelled=new Promise((_,reject)=>{
      task.onPassword=(retry,reason)=>{
        const dialog=$("passwordDialog");
        $("passTitle").textContent=reason===2?"密码不正确，请重试":"请输入 PDF 打开密码";
        $("sourcePass").value=""; dialog.returnValue="";
        dialog.onclose=()=>{
          if(dialog.returnValue==="ok"){
            password=$("sourcePass").value; $("sourcePass").value=""; retry(password);
          } else {
            $("sourcePass").value=""; reject(Error("已取消打开 PDF")); task.destroy().catch(()=>{});
          }
        };
        dialog.showModal(); $("sourcePass").focus();
      };
    });
    nextPdf=await Promise.race([task.promise,cancelled]);
    const nextPages = [];
    for (let n = 1; n <= nextPdf.numPages; n++) {
      const page = await nextPdf.getPage(n), v = page.getViewport({ scale: 1 });
      nextPages.push({ width: v.width, height: v.height, transform: v.transform });
    }
    if (!nextPages.length) throw Error("PDF 没有可显示的页面");
    const fields = await nextPdf.getFieldObjects();
    signedFields = Object.values(fields || {}).flat().some(f => f.type === "signature");
    const old = pdf, oldId = sourceId;
    ++renderVersion; rendering?.cancel();
    pdf = nextPdf; sourceId = opened.id; pages = nextPages; accepted = true;
    inputPassword=password; $("outputPass").value=""; $("protection").value="keep"; $("outputPassRow").hidden=true;
    current = 0; selected = -1; history = []; marks = []; placements = []; assets = []; savedState = "[]";
    repeat = false; brush = null;
    classic = {...classic,...emptyPageSettings()};
    $("sourcePath").textContent = $("sourcePath").title = opened.path;
    $("name").textContent = opened.name; $("name").title = opened.name;
    if (old) { await old.destroy(); await invoke("close_pdf", { id: oldId }); }
    controls(); await render();
    await applySetup(classic,null,false);
    savedState=JSON.stringify(marks);
    status(signedFields ? "检测到签名字段，保存盖章副本可能影响已有数字签名。" : "已打开 "+opened.name);
  } catch (e) {
    if (e.name === "PasswordException") throw Error("无法使用提供的密码打开 PDF");
    throw e;
  } finally {
    if (!accepted) { if (nextPdf) await nextPdf.destroy(); await invoke("close_pdf", { id: opened.id }); }
  }
}
$("open").onclick = $("openEmpty").onclick = () => work(openPdf);
$("cancelPass").onclick=()=>$("passwordDialog").close("cancel");
function navigate(n) {
  if (!pdf || busy) return;
  current = Math.max(0, Math.min(pages.length-1, n));
  if (!placements.some(p=>p.mark===selected && p.page===current)) selected = -1;
  controls(); render();
}
$("first").onclick = () => navigate(0);
$("prev").onclick = () => navigate(current-1);
$("next").onclick = () => navigate(current+1);
$("last").onclick = () => navigate(pages.length-1);
$("page").onchange = e => navigate((parseInt(e.target.value,10) || 1)-1);
let resizeTimer;
new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(render, 90); }).observe($("stage"));

const imageGroup = kind => kind === "signature" ? "signature" : "stamp";
async function refreshLibrary() {
  libraryImages = (await listImages()).sort((a,b) => b.used-a.used);
  populateSealList();
}
function populateSealList() {
  const options=libraryImages.filter(i=>i.group==="stamp");
  if (classic.image && !options.some(i=>i.id===classic.image.id)) options.unshift(classic.image);
  $("activeSeal").replaceChildren(new Option("请选择印章",""),...options.map(i=>new Option(i.name,String(i.id))));
  syncSetup();
}
$("importSeal").onclick=()=>{tool="classic"; browseImage();};
$("activeSeal").onchange=e=>{
  const image=libraryImages.find(i=>String(i.id)===e.target.value) || (e.target.value ? classic.image : null);
  work(()=>applySetup({...classic,image}));
};
function browseImage() {
  if ($("library").open) $("library").close();
  $("imageFile").value = "";
  $("imageFile").click();
}
function drawLibrary() {
  const list = $("savedImages");
  list.replaceChildren();
  $("libraryTitle").textContent = tool === "signature" ? "常用签字图片" : "常用印章";
  for (const item of libraryImages.filter(i => i.group === imageGroup(tool))) {
    const row = document.createElement("div");
    row.className = "saved-row";
    const pick = document.createElement("button");
    pick.className = "saved-pick"; pick.title = item.name;
    const img = document.createElement("img");
    img.src = item.url; img.alt = "";
    const name = document.createElement("span");
    name.textContent = item.name;
    pick.append(img,name);
    pick.onclick = () => {
      $("library").close();
      work(() => useImage(item));
    };
    const forget = document.createElement("button");
    forget.className = "forget"; forget.textContent = "移除";
    forget.title = "从常用图片移除 " + item.name;
    forget.onclick = () => work(async () => {
      await forgetImage(item.id);
      if (classic.image?.id===item.id) {
        // Preserve marks in the open document, but forget the choice for the next launch.
        classic={...classic,image:{...classic.image,id:"session"}};
        rememberSetup();
      }
      await refreshLibrary(); drawLibrary();
    });
    row.append(pick,forget); list.append(row);
  }
}
for (const kind of Object.keys(labels)) $(kind).onclick = () => {
  tool = kind;
  if (libraryImages.some(i => i.group === imageGroup(kind))) {
    drawLibrary(); $("library").showModal();
  } else browseImage();
};
$("browseImage").onclick = browseImage;
$("closeLibrary").onclick = () => $("library").close();
$("imageFile").onchange = e => work(async () => {
  const file = e.target.files[0];
  if (!file) return;
  const raw = URL.createObjectURL(file);
  let url, aspect;
  try {
    const img = new Image(); img.src = raw; await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    canvas.getContext("2d").drawImage(img,0,0);
    url = canvas.toDataURL("image/png"); aspect = canvas.width/canvas.height;
  } finally { URL.revokeObjectURL(raw); }
  const image = { name: file.name, url, aspect };
  if (tool==="classic") {
    let item={...image,id:"session"}, cached=true;
    try {
      await rememberImage("stamp",image); await refreshLibrary();
      item=libraryImages.find(i=>i.group==="stamp" && i.url===url) || item;
    } catch { cached=false; }
    await applySetup({...classic,image:item}); populateSealList();
    status(cached?"已选用 "+file.name:"已载入图片，本机缓存失败。",!cached);
    return;
  }
  await useImage(image);
  try { await rememberImage(imageGroup(tool), image); await refreshLibrary(); }
  catch { status("图片已载入，本机常用图片库保存失败。", true); }
});
async function useImage({ url, aspect }) {
  const available = tool === "seam" ? pages : [pages[current]];
  const fit = available.reduce((v,p) => Math.min(v,p.width,p.height*aspect), Infinity) * 25.4/72;
  const mm = Math.min(tool === "signature" ? 48 : 40, Math.floor(fit));
  let asset = assets.findIndex(item => item.url === url);
  if (asset < 0) { asset = assets.length; assets.push({url}); }
  const mark = { asset, original:asset, page: current, seam: tool === "seam", kind: tool, x: 0.5, y: 0.5, mm, aspect };
  if (repeat && !mark.seam) {
    brush = mark; selected = -1; drawOverlays(); controls(); status("点击页面放置" + labels[tool]); return;
  }
  await change([...marks,mark], marks.length);
  if (mark.seam) setRepeat(false);
  status(tool === "seam" ? "已添加骑缝章，点「页码与外观」可更换页边和分组" : "已添加" + labels[tool] + "，可拖到需要的位置");
}
function setRepeat(on) {
  repeat = on;
  const mark = marks[selected];
  brush = on && mark && !mark.seam ? mark : null;
  controls();
}
$("repeat").onclick = () => work(async()=>{
  setRepeat(!repeat);
  if (repeat && !brush && classic.image) brush=await makeStamp(classic,assets);
});
function modify(patch) {
  return change(marks.map((m,i) => i === selected ? {...m,...patch} : m), selected);
}
$("settings").onclick=()=>{
  const m=marks[selected], style=m.style || defaultStyle;
  $("settingsTitle").textContent=labels[m.kind]+" · 页码与外观";
  $("scope").options[0].disabled=m.seam;
  $("scope").value=m.scope || (m.seam?"all":"current");
  $("range").value=m.range || "";
  $("rangeRow").hidden=$("scope").value!=="custom";
  $("seamSettings").hidden=!m.seam; $("seamSettings").disabled=!m.seam;
  $("edge").value=m.edge || "right"; $("limit").value=m.limit ?? defaults.seamLimit;
  $("along").value=Number((100*(horizontalEdge(m.edge)?m.x:m.y)).toFixed(3));
  for(const key of ["angle","crop","opacity","tolerance"]) $(key).value=style[key];
  $("white").checked=style.white; $("toleranceRow").hidden=!style.white;
  $("settingsError").textContent=""; $("markSettings").showModal();
};
$("scope").onchange=()=>{$("rangeRow").hidden=$("scope").value!=="custom";};
$("white").onchange=()=>{$("toleranceRow").hidden=!$("white").checked;};
$("cancelSettings").onclick=()=>$("markSettings").close();
$("markForm").onsubmit=e=>{
  e.preventDefault();
  work(async()=>{
    try{
      const m=marks[selected], scope=$("scope").value, range=$("range").value;
      const targets=targetPages(scope,range,current,pages.length);
      if(!targets.length) throw Error("当前文档中没有符合条件的页面");
      if(m.seam && targets.length<2) throw Error("骑缝章至少需要两个目标页");
      const style={angle:$("angle").valueAsNumber,crop:$("crop").value,opacity:$("opacity").valueAsNumber,
        white:$("white").checked,tolerance:Number($("tolerance").value)};
      const edge=$("edge").value, limit=Number($("limit").value);
      const original=m.original ?? m.asset;
      const turns=m.seam && horizontalEdge(edge);
      const key=JSON.stringify([original,style,turns]);
      let asset=assets.findIndex(item=>item.key===key);
      if(asset<0){
        const result=await styledImage(assets[original].url,style,turns);
        asset=assets.length; assets.push({...result,key});
      }
      const {aspect,scale}=assets[asset];
      const patch={original,asset,style,aspect,scale,targets,scope,range,edge,limit,page:targets[0]};
      if(m.seam){
        const fraction=Number($("along").value)/100;
        if(turns) patch.x=fraction; else patch.y=fraction;
      }
      await modify(patch);
      if(repeat && !m.seam) brush=marks[selected];
      $("markSettings").close();
      if(!targets.includes(current)){current=targets[0];await render();}
      status("已应用到 "+targets.length+" 页，可翻页检查");
    }catch(err){$("settingsError").textContent=String(err.message||err);}
  });
};
$("mm").onchange = e => {
  const mm = Number(e.target.value);
  work(async () => {
    await modify({ mm });
    if (repeat && !marks[selected].seam) brush = marks[selected];
  });
};
function removeSelected() {
  if (!marks[selected] || drag) return;
  if (marks[selected].classic) {
    if (marks[selected].seam) {
      work(()=>applySetup({...classic,cfg:{...classic.cfg,seamMode:"none"}})); return;
    }
    const points={...classic.points}; delete points[current];
    work(()=>applySetup({...classic,points,excluded:[...classic.excluded.filter(n=>n!==current),current]}));
    return;
  }
  work(() => change(marks.filter((_,i) => i !== selected), -1));
}
$("remove").onclick = removeSelected;
document.addEventListener("keydown", e => {
  if (e.defaultPrevented || e.isComposing || document.querySelector("dialog[open]")) return;
  if (e.key === "Escape" && repeat) { setRepeat(false); e.preventDefault(); return; }
  if (e.key !== "Delete" || e.repeat || busy || !marks[selected]) return;
  if (e.target.isContentEditable || e.target.closest?.("input, textarea, select")) return;
  e.preventDefault(); removeSelected();
});
$("undo").onclick = () => work(async () => {
  const last = history.at(-1);
  if (!last) return;
  current = last.current;
  await change(last.marks,last.selected,false,last.classic); history.pop();
  if (repeat && brush?.classic) brush=classic.image ? await makeStamp(classic,assets) : null;
  populateSealList(); rememberSetup(); await render(); status("已撤销上一步");
});
function pointer(e) {
  const rect = $("overlays").getBoundingClientRect(), p = pages[current];
  return [(e.clientX-rect.left)*p.width/rect.width,(e.clientY-rect.top)*p.height/rect.height];
}
const layer = $("overlays");
layer.tabIndex = -1;
function enqueueStamp(e) {
  const [cx,cy] = pointer(e), page = pages[current];
  const width = brush.mm*72/25.4*(brush.scale||1), height = width/brush.aspect;
  pendingClicks.push({ ...brush, classic:false, targets:[current],scope:"current",positions:{}, page: current, x: clamp((cx-width/2)/(page.width-width || 1)),
    y: clamp((cy-height/2)/(page.height-height || 1)) });
  if (placingClicks) return;
  placingClicks = true;
  work(async () => {
    try {
      while (pendingClicks.length) await change([...marks,pendingClicks.shift()], marks.length);
    } finally { placingClicks = false; pendingClicks.length = 0; }
  });
}
function pinPosition(x,y) {
  const point=[x,y];
  const seamPages=classic.cfg.seamMode==="custom" && !classic.seamPages.includes(current) ? [...classic.seamPages,current] : classic.seamPages;
  return applySetup({...classic,points:{...classic.points,[current]:point},fallback:point,seamPages,
    excluded:classic.excluded.filter(n=>n!==current)},"stamp");
}
async function clickPreview(cx,cy) {
  const {normalMode,seamMode}=classic.cfg;
  if (normalMode==="none" || (normalMode!=="custom" && !scopePages(normalMode,pages.length,[]).includes(current))) {
    if (seamMode==="custom" && !classic.seamPages.includes(current))
      await applySetup({...classic,seamPages:[...classic.seamPages,current]},"seam");
    return;
  }
  const m=await makeStamp(classic,assets), page=pages[current];
  const width=m.mm*72/25.4*m.scale, height=width/m.aspect;
  await pinPosition(clamp((cx-width/2)/(page.width-width || 1)),clamp((cy-height/2)/(page.height-height || 1)));
}
layer.onpointerdown = e => {
  if ((busy && !placingClicks) || drag || e.button !== 0 || !pdf || layer.parentElement.dataset.page !== String(current)) return;
  layer.focus({preventScroll:true});
  if (repeat) {
    if (brush) enqueueStamp(e);
    return;
  }
  if (busy) return;
  const hit = e.target.closest(".mark");
  if (hit) selected = Number(hit.dataset.mark);
  const p = hit?.placement ?? placements.find(p => p.page === current && p.mark === selected);
  if (!hit && classic.image && (!p || marks[selected].classic)) {
    const point=pointer(e); work(()=>clickPreview(...point)); return;
  }
  if (!p) return;
  drawOverlays(); controls();
  const [x,y] = pointer(e);
  drag = { p, dx: hit ? x-p.x : p.width/2, dy: hit ? y-p.y : p.height/2, id:e.pointerId };
  layer.setPointerCapture(e.pointerId); move(e);
};
function move(e) {
  if (!drag || drag.id !== e.pointerId) return;
  const [x,y] = pointer(e), {p,dx,dy} = drag, page = pages[current];
  drag.x = clamp((x-dx)/(page.width-p.width || 1));
  drag.y = clamp((y-dy)/(page.height-p.height || 1));
  const mark=marks[p.mark];
  if(mark.seam){
    const horizontal = horizontalEdge(mark.edge);
    const travel = horizontal ? page.width-p.width : page.height-p.height;
    const available = travel-p.lane_step;
    const offset = (p.group % 2)*p.lane_step;
    const initial = horizontal ? mark.x : mark.y;
    drag.along = available > 0 ? clamp(((horizontal ? x-dx : y-dy)-offset)/available) : initial;
    // A junction page shows two slices of the same mark. Move both together.
    for (const el of layer.querySelectorAll(".selected")) {
      const part = el.placement;
      const pos = drag.along*available + (part.group % 2)*part.lane_step;
      if (horizontal) el.style.left = 100*pos/page.width+"%";
      else el.style.top = 100*pos/page.height+"%";
    }
    return;
  }
  const el = layer.querySelector(".selected");
  el.style.left = 100*drag.x*(page.width-p.width)/page.width+"%";
  el.style.top = 100*drag.y*(page.height-p.height)/page.height+"%";
}
layer.onpointermove = move;
layer.onpointercancel = () => { drag = null; drawOverlays(); };
layer.onpointerup = e => {
  if (!drag || drag.id !== e.pointerId) return;
  move(e);
  const {x,y,along} = drag; drag = null;
  const m=marks[selected];
  if (m.seam) {
    const axis = horizontalEdge(m.edge) ? "x" : "y";
    if (Math.abs(along-m[axis])>1e-7) {
      if (m.classic) work(()=>applySetup({...classic,cfg:{...classic.cfg,seamAlong:Number((along*100).toFixed(3))}},"seam"));
      else work(()=>modify({[axis]:along}));
    }
    return;
  }
  if (m.classic) {
    const previous=m.positions[current] || [m.x,m.y];
    if (Math.abs(previous[0]-x)+Math.abs(previous[1]-y)>1e-7) work(()=>pinPosition(x,y));
    return;
  }
  const previous=m.positions?.[current] || [m.x,m.y];
  if (Math.abs(previous[0]-x)+Math.abs(previous[1]-y)>1e-7) {
    const patch=!m.seam && m.targets?.length>1?{positions:{...m.positions,[current]:[x,y]}}:{x,y,positions:{}};
    work(() => modify(patch));
  }
};
layer.ondblclick=e=>{
  if (busy || repeat || !marks[selected]?.classic || marks[selected].seam) return;
  const [x,y]=pointer(e), p=placements.find(p=>p.page===current && p.mark===selected);
  if (p && x>=p.x && x<=p.x+p.width && y>=p.y && y<=p.y+p.height) removeSelected();
};
function syncOutput(){const flat=$("outputMode").value==="flat"; $("dpiRow").hidden=$("flatNote").hidden=!flat;}
$("outputMode").onchange=()=>{syncOutput(); rememberSetup();};
$("protection").onchange=()=>{$("outputPassRow").hidden=$("protection").value!=="new";};
function logResult(message) {
  const item=document.createElement("li"); item.textContent=message; $("log").prepend(item);
}
async function saveDocument() {
  if (signedFields && !confirm("文档含签名字段。盖章副本可能影响已有数字签名，继续保存？")) return;
  const used = [...new Set(marks.map(m => m.asset))];
  const compact = marks.map(m => ({...m, asset: used.indexOf(m.asset)}));
  const mode=$("protection").value;
  const password=mode==="keep"?null:mode==="none"?"":$("outputPass").value;
  if(mode==="new" && !password) throw Error("请先输入副本的新密码");
  const raster=$("outputMode").value==="flat"? await rasterPages(pdf,pages,placements,marks,assets,Number($("dpi").value),status):null;
  const path = await invoke("save_copy", { id: sourceId, pages, marks:compact, raster, destination,
    options:{input_password:inputPassword,new_password:password},
    assets: raster?[]:used.map(i => assets[i].url.split(",")[1]) });
  if (path) {
    hasSavedCopy = true;
    $("openOutput").title = "打开此副本所在的文件夹：" + path;
    savedState = JSON.stringify(marks);
    logResult("已盖章 · "+path);
    status("副本已保存至 " + path);
  }
}
$("openOutput").onclick = () => work(() => invoke("open_output_folder"));
$("save").onclick = () => work(async () => {
  try { await saveDocument(); }
  catch (e) {logResult("盖章失败 · "+String(e.message||e)); throw e;}
});
$("outputMode").value=preferences.output==="flat"?"flat":"overlay"; syncOutput();
controls();
work(async()=>{
  await refreshLibrary();
  classic={...classic,image:libraryImages.find(i=>i.group==="stamp" && i.id===preferences.image) || null};
});
