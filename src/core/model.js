import { AnalysisError, norm, sub } from './linalg.js';
export const GRAVITY=9.80665;
export function rectangularSection(id,name,b,h,material) {
  const a=Math.max(b,h),c=Math.min(b,h);
  return {id,name,material,b,h,A:b*h,Iy:b*h**3/12,Iz:h*b**3/12,J:a*c**3*(1/3-0.21*(c/a)*(1-c**4/(12*a**4))),shape:'rectangle'};
}
export function emptyModel() {
  return {schema:'stratum-frame',version:1,units:'SI',name:'Untitled structure',
    grids:{x:[0,6,12,18],y:[0,6,12]},stories:[{id:'S0',name:'Base',z:0}],
    materials:[{id:'C30',name:'Concrete C30 · elastic',E:30e9,nu:0.2,density:2500},{id:'S355',name:'Steel S355 · elastic',E:200e9,nu:0.3,density:7850}],
    sections:[rectangularSection('C500','C500 × 500',0.5,0.5,'C30'),rectangularSection('B300','B300 × 600',0.3,0.6,'C30'),rectangularSection('B400','B400 × 700',0.4,0.7,'C30')],
    nodes:[],elements:[],diaphragms:[],
    cases:[{id:'DEAD',name:'Dead',selfWeight:1},{id:'LIVE',name:'Live',selfWeight:0},{id:'WINDX',name:'Wind X',selfWeight:0}],
    combinations:[{id:'SERVICE',name:'Service · D + L',factors:{DEAD:1,LIVE:1}},{id:'ULS',name:'Illustrative · 1.2D + 1.6L',factors:{DEAD:1.2,LIVE:1.6}},{id:'LATERAL',name:'Illustrative · D + 0.5L + W',factors:{DEAD:1,LIVE:0.5,WINDX:1}}],
    loads:[],settings:{modes:6,modal:true},notes:'Independent research workbench. Example combinations are illustrative, not code-approved.'};
}
export function createBuilding({name='Atrium Office · 6-story frame',stories=6,baysX=3,baysY=2,bayX=6,bayY=6,height=3.4,diaphragms=true}={}) {
  if(!Number.isInteger(stories)||stories<1||stories>16||!Number.isInteger(baysX)||baysX<1||baysX>8||!Number.isInteger(baysY)||baysY<1||baysY>8||Math.min(bayX,bayY,height)<=0)throw new Error('Template dimensions are outside the supported limits (1–16 stories, 1–8 bays).');
  const m=emptyModel();m.name=name;m.grids={x:Array.from({length:baysX+1},(_,i)=>i*bayX),y:Array.from({length:baysY+1},(_,i)=>i*bayY)};
  m.stories=Array.from({length:stories+1},(_,i)=>({id:'S'+i,name:i?'Story '+String(i).padStart(2,'0'):'Base',z:i*height}));
  const ids=new Map();let ni=0,ei=0,li=0;
  const node=(s,x,y)=>ids.get(`${s}/${x}/${y}`);
  for(let s=0;s<=stories;s++)for(let y=0;y<=baysY;y++)for(let x=0;x<=baysX;x++) {
    const id='J'+(++ni);ids.set(`${s}/${x}/${y}`,id);
    m.nodes.push({id,x:x*bayX,y:y*bayY,z:s*height,support:Array(6).fill(s===0),mass:s?1800:0});
  }
  const beam=(a,b,sec)=>{const id='F'+(++ei);m.elements.push({id,i:a,j:b,section:sec,roll:0,releases:Array(12).fill(false)});return id;};
  for(let s=1;s<=stories;s++) {
    const members=[];
    for(let y=0;y<=baysY;y++)for(let x=0;x<=baysX;x++) {
      beam(node(s-1,x,y),node(s,x,y),'C500');
      if(x<baysX)members.push(beam(node(s,x,y),node(s,x+1,y),'B300'));
      if(y<baysY)members.push(beam(node(s,x,y),node(s,x,y+1),'B300'));
      m.loads.push({id:'L'+(++li),case:'WINDX',type:'nodal',node:node(s,x,y),value:[2400*(s/stories),0,0,0,0,0]});
    }
    for(const id of members) for(const [loadCase,value]of [['DEAD',-8000],['LIVE',-5000]])m.loads.push({id:'L'+(++li),case:loadCase,type:'udl',element:id,system:'global',value:[0,0,value]});
    if(diaphragms)m.diaphragms.push({id:'D'+s,name:'D'+s+' · rigid',nodes:m.nodes.filter(n=>Math.abs(n.z-s*height)<1e-8).map(n=>n.id)});
  }
  validateModel(m);return m;
}
export const position=n=>[n.x,n.y,n.z];
export function uniqueId(model,key,prefix) {const ids=new Set(model[key].map(x=>x.id));let i=1;while(ids.has(prefix+i))i++;return prefix+i;}
const finite=(v,label)=>{if(typeof v!=='number'||!Number.isFinite(v))throw new AnalysisError(`${label} must be a finite number.`);};
function unique(items,label){const set=new Set();for(const item of items){if(!item||typeof item.id!=='string'||!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(item.id)||['__proto__','constructor','prototype'].includes(item.id)||set.has(item.id))throw new AnalysisError(`${label} IDs must be unique identifiers (letters, digits, underscore, dot, hyphen; no reserved names).`);if(item.name!==undefined&&typeof item.name!=='string')throw new AnalysisError(`${label} names must be strings.`);set.add(item.id);}return set;}
export function validateModel(m) {
  if(!m||m.schema!=='stratum-frame'||m.version!==1||m.units!=='SI')throw new AnalysisError('Unsupported project schema/version or non-SI storage units. Expected stratum-frame v1 with SI values.');
  for(const key of ['nodes','elements','materials','sections','stories','cases','combinations','loads','diaphragms'])if(!Array.isArray(m[key]))throw new AnalysisError(`Missing ${key} collection.`);
  for(const key of ['materials','sections','stories','cases'])if(!m[key].length)throw new AnalysisError(`At least one ${key} definition is required.`);
  if(!m.settings||typeof m.settings.modal!=='boolean')throw new AnalysisError('Analysis settings must include a boolean modal flag.');
  if(m.nodes.length>2000||m.elements.length>6000)throw new AnalysisError('This build accepts up to 2,000 joints and 6,000 frame elements; skyline storage has a separate memory limit.');
  const ns=unique(m.nodes,'Joint'),es=unique(m.elements,'Frame'),ms=unique(m.materials,'Material'),ss=unique(m.sections,'Section'),cs=unique(m.cases,'Load case');
  const combs=unique(m.combinations,'Combination');unique(m.loads,'Load');unique(m.stories,'Story');unique(m.diaphragms,'Diaphragm');
  for(const id of combs)if(cs.has(id))throw new AnalysisError('Load case and combination IDs must be distinct.');
  for(const mat of m.materials) {finite(mat.E,'E');finite(mat.nu,'Poisson ratio');finite(mat.density,'Density');if(mat.E<=0||mat.nu<=-1||mat.nu>=0.5||mat.density<0)throw new AnalysisError(`Invalid elastic material ${mat.id}. E > 0, −1 < nu < 0.5, density ≥ 0 required.`);}
  for(const sec of m.sections){if(!ms.has(sec.material))throw new AnalysisError(`Section ${sec.id} references an unknown material.`);for(const k of ['A','Iy','Iz','J']){finite(sec[k],`${sec.id}.${k}`);if(sec[k]<=0)throw new AnalysisError(`Section ${sec.id}: ${k} must be positive.`);}if(sec.b!==undefined&&(!Number.isFinite(sec.b)||!Number.isFinite(sec.h)||!(sec.b>0)||!(sec.h>0)))throw new AnalysisError('Display section dimensions must be positive.');}
  const coords=new Map();const warnings=[];
  for(const n of m.nodes){for(const k of ['x','y','z'])finite(n[k],`${n.id}.${k}`);if(!Array.isArray(n.support)||n.support.length!==6||n.support.some(v=>typeof v!=='boolean'))throw new AnalysisError(`Joint ${n.id} needs six boolean support flags.`);finite(n.mass??0,`${n.id}.mass`);if(n.mass<0)throw new AnalysisError('Joint mass cannot be negative.');
    if(n.massInertia!==undefined){if(!Array.isArray(n.massInertia)||n.massInertia.length!==3)throw new AnalysisError('Joint rotational inertia must have three values.');for(const v of n.massInertia){finite(v,'Rotational inertia');if(v<0)throw new AnalysisError('Rotational inertia cannot be negative.');}}
    const k=[n.x,n.y,n.z].map(x=>x.toFixed(8)).join('/');if(coords.has(k))warnings.push(`Coincident joints ${coords.get(k)} and ${n.id} are not automatically merged.`);coords.set(k,n.id);
  }
  const nm=new Map(m.nodes.map(n=>[n.id,n])),connections=new Map();
  for(const e of m.elements){if(!ns.has(e.i)||!ns.has(e.j)||!ss.has(e.section))throw new AnalysisError(`Frame ${e.id} has a missing joint or section.`);if(norm(sub(position(nm.get(e.i)),position(nm.get(e.j))))<1e-8)throw new AnalysisError(`Frame ${e.id} has zero length.`);finite(e.roll??0,`${e.id}.roll`);if(e.releases&&(!Array.isArray(e.releases)||e.releases.length!==12||e.releases.some(v=>typeof v!=='boolean')))throw new AnalysisError(`Frame ${e.id} requires 12 boolean release flags.`);const key=[e.i,e.j].sort().join('/');if(connections.has(key))warnings.push(`Overlapping frames ${connections.get(key)} and ${e.id} both contribute stiffness and mass.`);connections.set(key,e.id);}
  for(const c of m.cases)finite(c.selfWeight??0,`${c.id}.selfWeight`);
  for(const c of m.combinations){if(!c.factors||Array.isArray(c.factors)||typeof c.factors!=='object')throw new AnalysisError('A combination needs a case-to-factor object.');for(const [id,f]of Object.entries(c.factors)){if(!cs.has(id))throw new AnalysisError(`Combination ${c.id} references unknown case ${id}. Nested combinations are not supported.`);finite(f,`${c.id}.${id}`);}}
  for(const l of m.loads){if(!cs.has(l.case))throw new AnalysisError(`Load ${l.id} has an unknown case.`);if(!['nodal','udl','point'].includes(l.type))throw new AnalysisError(`Unsupported load type ${l.type}.`);if(!Array.isArray(l.value)||l.value.length!==(l.type==='nodal'?6:3))throw new AnalysisError(`Load ${l.id} has an invalid vector.`);for(const v of l.value)finite(v,`Load ${l.id}`);if(l.type==='nodal'){if(l.system!==undefined&&l.system!=='global')throw new AnalysisError('Joint loads must be expressed in global axes.');if(!ns.has(l.node))throw new AnalysisError(`Load ${l.id} references an unknown joint.`);}else{if(!es.has(l.element))throw new AnalysisError(`Load ${l.id} references an unknown frame.`);if(!['global','local'].includes(l.system))throw new AnalysisError(`Load ${l.id} must specify global or local axes.`);if(l.type==='point'){finite(l.position,'Point-load position');if(l.position<=0||l.position>=1)throw new AnalysisError('Member point loads must lie strictly inside 0 < a/L < 1. Use joint loads at endpoints.');}}}
  const claimed=new Set();
  for(const d of m.diaphragms){if(!Array.isArray(d.nodes)||d.nodes.length<2||new Set(d.nodes).size!==d.nodes.length)throw new AnalysisError(`Diaphragm ${d.id} needs at least two distinct joints.`);let z=null;let spread=0;let first=null;for(const id of d.nodes){const n=nm.get(id);if(!n||claimed.has(id))throw new AnalysisError(`Diaphragm ${d.id} has a missing or multiply-assigned joint.`);if(n.support[0]||n.support[1]||n.support[5])throw new AnalysisError(`Diaphragm ${d.id}: horizontal or RZ restraints on diaphragm joints are not supported. Remove that assignment or support.`);if(z!==null&&Math.abs(z-n.z)>1e-6)throw new AnalysisError(`Diaphragm ${d.id} must be horizontal and coplanar within 1e-6 m.`);z=n.z;claimed.add(id);if(!first)first=n;spread=Math.max(spread,Math.hypot(n.x-first.x,n.y-first.y));}if(spread<1e-8)throw new AnalysisError(`Diaphragm ${d.id} has no in-plane extent.`);}
  const elevations=new Set();for(const s of m.stories){finite(s.z,`${s.id}.elevation`);if(elevations.has(s.z))throw new AnalysisError('Story elevations must be distinct.');elevations.add(s.z);}
  if(!m.grids||!Array.isArray(m.grids.x)||!Array.isArray(m.grids.y))throw new AnalysisError('Grid coordinates are required.');for(const dir of ['x','y']){let last=-Infinity;for(const x of m.grids[dir]){finite(x,'Grid coordinate');if(x<=last)throw new AnalysisError('Grid coordinates must be strictly increasing.');last=x;}}
  if(m.settings?.modes!==undefined&&(!Number.isInteger(m.settings.modes)||m.settings.modes<1||m.settings.modes>24))throw new AnalysisError('Request between 1 and 24 modes.');
  return warnings;
}
export function parseProject(text){if(text.length>25_000_000)throw new Error('Project file exceeds 25 MB.');const m=JSON.parse(text);validateModel(m);return m;}
