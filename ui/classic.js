import {targetPages, horizontalEdge, styledImage} from "./stamp-options.js";

export const defaults = {
  normalMode:"custom", seamMode:"all", stampOpacity:100, stampAngle:0,
  stampCrop:"expand", stampWhite:false, stampTolerance:10, seamEdge:"right", seamAlong:10, seamLimit:8
};
export const emptyPageSettings = () => ({primary:null, points:{}, excluded:[], seamPages:[], fallback:[0.5,0.5]});

export function scopePages(mode, count, picked) {
  if (mode === "none") return [];
  if (mode === "custom") return [...picked].map(Number).sort((a,b)=>a-b);
  if (count === 1 && ["exceptFirst","exceptLast"].includes(mode)) return [0];
  return targetPages(mode,"",0,count);
}

export async function makeStamp(state, assets, seam=false) {
  const {cfg, image} = state;
  let original = assets.findIndex(item => !item.key && item.url === image.url);
  if (original < 0) original = assets.push({url:image.url})-1;
  const style = {angle:cfg.stampAngle, crop:cfg.stampCrop, opacity:cfg.stampOpacity,
    white:cfg.stampWhite, tolerance:cfg.stampTolerance};
  const turn = seam && horizontalEdge(cfg.seamEdge);
  const key = JSON.stringify([original,style,turn]);
  let asset = assets.findIndex(item => item.key === key);
  if (asset < 0) {
    const result = await styledImage(image.url,style,turn);
    asset = assets.push({...result,key})-1;
  }
  const {aspect,scale} = assets[asset];
  return {classic:true, kind:seam?"seam":"stamp", seam, original, asset, aspect, scale, style,
    mm:image.mm, edge:cfg.seamEdge, limit:cfg.seamLimit,
    x:seam?cfg.seamAlong/100:state.fallback[0], y:seam?cfg.seamAlong/100:state.fallback[1]};
}

export async function documentStamps(state, count, assets) {
  const result = [];
  state = {...state, image:state.primary || state.image};
  if (!state.image) return result;
  const {cfg,points,excluded,seamPages} = state;
  const seam = scopePages(cfg.seamMode,count,seamPages);
  const regular = scopePages(cfg.normalMode,count,Object.keys(points)).filter(p=>!excluded.includes(p));
  if (seam.length >= 2)
    result.push({...await makeStamp(state,assets,true), targets:seam, page:seam[0]});
  if (regular.length)
    result.push({...await makeStamp(state,assets), targets:regular, positions:points, page:regular[0]});
  return result;
}
