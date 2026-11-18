export function targetPages(scope, range, current, count) {
  if (scope === "current") return [current];
  if (scope === "custom") {
    const found = new Set();
    for (const token of range.trim().replace(/\s*([-–至])\s*/g,"$1").split(/[,，、;；\s]+/)) {
      const match = /^(\d+)(?:[-–至](\d+))?$/.exec(token);
      if (!match) throw Error("请用 1,3-6 这样的格式填写页码");
      const first = Number(match[1]), last = Number(match[2] || match[1]);
      if (first < 1 || first > last || last > count) throw Error("页码范围应在 1 至 " + count + " 之间");
      for (let n=first; n<=last; n++) found.add(n-1);
    }
    return [...found].sort((a,b) => a-b);
  }
  return Array.from({length:count},(_,i)=>i).filter(i => {
    switch(scope) {
      case "all": return true;
      case "exceptFirst": return i>0;
      case "exceptLast": return i<count-1;
      case "odd": return i%2===0;
      case "even": return i%2===1;
      default: throw Error("未知页码范围");
    }
  });
}

export const horizontalEdge = edge => edge === "top" || edge === "bottom";
export const defaultStyle = {angle:0, crop:"expand", opacity:100, white:false, tolerance:10};

export async function decodeImage(url) {
  const img=new Image();
  img.src=url; await img.decode(); return img;
}

// Always rederive the display/export image from the original pixels.
export async function styledImage(url, style, turnForEdge) {
  const img=await decodeImage(url);
  const w=img.naturalWidth, h=img.naturalHeight;
  const input=document.createElement("canvas");
  input.width=w; input.height=h;
  const ctx=input.getContext("2d");
  ctx.drawImage(img,0,0);
  if (style.white) {
    const pixels=ctx.getImageData(0,0,w,h), data=pixels.data, cutoff=255-style.tolerance;
    for(let i=0;i<data.length;i+=4) {
      if(Math.min(data[i],data[i+1],data[i+2])>=cutoff) data[i+3]=0;
    }
    ctx.putImageData(pixels,0,0);
  }
  const rad=style.angle*Math.PI/180, c=Math.abs(Math.cos(rad)), s=Math.abs(Math.sin(rad));
  const expand=style.crop==="expand";
  const rw=expand?Math.max(1,Math.ceil(w*c+h*s-1e-8)):w;
  const rh=expand?Math.max(1,Math.ceil(w*s+h*c-1e-8)):h;
  const canvas=document.createElement("canvas");
  canvas.width=turnForEdge?rh:rw; canvas.height=turnForEdge?rw:rh;
  const out=canvas.getContext("2d");
  out.translate(canvas.width/2,canvas.height/2);
  out.rotate(rad+(turnForEdge?Math.PI/2:0));
  out.globalAlpha=style.opacity/100;
  out.drawImage(input,-w/2,-h/2);
  const result=canvas.toDataURL("image/png");
  if (!result.startsWith("data:image/png")) throw Error("图片过大，无法生成印章");
  return {url:result,aspect:canvas.width/canvas.height,scale:canvas.width/w};
}

export async function rasterPages(pdf, pages, placements, marks, assets, dpi, report) {
  const results=[], images=new Map(), perPage=pages.map(()=>[]);
  for(const p of placements) perPage[p.page].push(p);
  for(let i=0;i<pages.length;i++){
    report("正在生成图片页 " + (i+1) + " / " + pages.length);
    const page=await pdf.getPage(i+1), view=page.getViewport({scale:dpi/72});
    const canvas=document.createElement("canvas");
    if(view.width*view.height>64_000_000) throw Error("第 "+(i+1)+" 页在此 DPI 下过大，请降低图片分辨率");
    canvas.width=Math.ceil(view.width); canvas.height=Math.ceil(view.height);
    const ctx=canvas.getContext("2d");
    try {
      const meta=pages[i];
      await page.render({canvasContext:ctx, viewport:view, intent:"print",background:"#fff",
        transform:[canvas.width/view.width,0,0,canvas.height/view.height,0,0]}).promise;
      ctx.setTransform(canvas.width/meta.width,0,0,canvas.height/meta.height,0,0);
      for(const p of perPage[i]){
        const asset=marks[p.mark].asset;
        if(!images.has(asset)) images.set(asset,await decodeImage(assets[asset].url));
        const img=images.get(asset), w=img.naturalWidth,h=img.naturalHeight, span=p.end-p.start;
        const source=p.vertical_slice?[0,h*p.start,w,h*span]:[w*p.start,0,w*span,h];
        ctx.drawImage(img,...source,p.x,p.y,p.width,p.height);
      }
      const encoded=canvas.toDataURL("image/jpeg",0.95);
      if(!encoded.startsWith("data:image/jpeg")) throw Error("此分辨率无法生成图片页，请降低 DPI");
      results.push(encoded.split(",")[1]);
    } finally { canvas.width=canvas.height=1; }
  }
  return results;
}
