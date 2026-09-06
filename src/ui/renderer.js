import {localAxes,localToGlobal} from '../core/elements.js';
import {position} from '../core/model.js';
import {unitFactor,displaySystems} from '../core/units.js';
import {sub,add,scale,norm,cross,dot,unit} from '../core/linalg.js';

const COLORS={beam:[.24,.40,.70,1],column:[.09,.53,.55,1],selected:[.99,.60,.16,1],support:[.12,.57,.36,1],grid:[.77,.81,.85,.7],ghost:[.76,.8,.84,.45],deformed:[.45,.32,.87,1],positive:[.05,.58,.62,1],negative:[.88,.31,.37,1],load:[.83,.36,.18,1]};
function mul(a,b){const out=new Float32Array(16);for(let c=0;c<4;c++)for(let r=0;r<4;r++)for(let k=0;k<4;k++)out[c*4+r]+=a[k*4+r]*b[c*4+k];return out;}
function viewMatrix(eye,target,up){const z=unit(sub(eye,target)),x=unit(cross(up,z)),y=cross(z,x);return new Float32Array([x[0],y[0],z[0],0,x[1],y[1],z[1],0,x[2],y[2],z[2],0,-dot(x,eye),-dot(y,eye),-dot(z,eye),1]);}
function ortho(w,h,near,far){return new Float32Array([2/w,0,0,0,0,2/h,0,0,0,0,1/(near-far),0,0,0,near/(near-far),1]);}
function transform(m,p){const out=[];for(let r=0;r<4;r++)out[r]=m[r]*p[0]+m[4+r]*p[1]+m[8+r]*p[2]+m[12+r];return out;}
function boxVertices(){
  const data=[],faces=[[[1,0,0],[[.5,-.5,-.5],[.5,.5,-.5],[.5,.5,.5],[.5,-.5,.5]]],[[-1,0,0],[[-.5,.5,-.5],[-.5,-.5,-.5],[-.5,-.5,.5],[-.5,.5,.5]]],[[0,1,0],[[.5,.5,-.5],[-.5,.5,-.5],[-.5,.5,.5],[.5,.5,.5]]],[[0,-1,0],[[-.5,-.5,-.5],[.5,-.5,-.5],[.5,-.5,.5],[-.5,-.5,.5]]],[[0,0,1],[[-.5,-.5,.5],[.5,-.5,.5],[.5,.5,.5],[-.5,.5,.5]]],[[0,0,-1],[[-.5,.5,-.5],[.5,.5,-.5],[.5,-.5,-.5],[-.5,-.5,-.5]]]];
  for(const [n,ps]of faces)for(const i of[0,1,2,0,2,3])data.push(...ps[i],...n);return new Float32Array(data);
}
const shader=`
struct Camera { vp: mat4x4<f32> };
@group(0) @binding(0) var<uniform> camera: Camera;
struct Out { @builtin(position) position:vec4<f32>, @location(0) color:vec4<f32>, @location(1) normal:vec3<f32> };
@vertex fn vs(@location(0) p:vec3<f32>, @location(1) n:vec3<f32>, @location(2) c0:vec4<f32>, @location(3) c1:vec4<f32>, @location(4) c2:vec4<f32>, @location(5) c3:vec4<f32>, @location(6) color:vec4<f32>) -> Out {
  var out:Out;
  out.position=camera.vp*mat4x4<f32>(c0,c1,c2,c3)*vec4<f32>(p,1.0);
  out.normal=normalize(c0.xyz)*n.x+normalize(c1.xyz)*n.y+normalize(c2.xyz)*n.z;
  out.color=color;return out;
}
@fragment fn fs(input:Out)->@location(0) vec4<f32> {
  let light=0.68+0.32*abs(dot(normalize(input.normal),normalize(vec3<f32>(0.45,-0.5,0.8))));
  return vec4<f32>(input.color.rgb*light,input.color.a);
}
struct LineOut { @builtin(position) position:vec4<f32>, @location(0) color:vec4<f32> };
@vertex fn lineVS(@location(0) p:vec3<f32>, @location(1) color:vec4<f32>)->LineOut {
  var out:LineOut;out.position=camera.vp*vec4<f32>(p,1.0);out.color=color;return out;
}
@fragment fn lineFS(input:LineOut)->@location(0) vec4<f32> { return input.color; }
`;
let sharedDevicePromise;
async function getGPU(){
  if(!sharedDevicePromise)sharedDevicePromise=(async()=>{
    if(!navigator.gpu)throw new Error('WebGPU API not available');
    const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});if(!adapter)throw new Error('No WebGPU adapter');
    const device=await adapter.requestDevice(),format=navigator.gpu.getPreferredCanvasFormat();
    const module=device.createShaderModule({code:shader});const compilation=await module.getCompilationInfo();
    const errors=compilation.messages.filter(m=>m.type==='error');if(errors.length)throw new Error(errors.map(e=>e.message).join('\n'));
    const bindLayout=device.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.VERTEX,buffer:{type:'uniform'}}]});
    const layout=device.createPipelineLayout({bindGroupLayouts:[bindLayout]});
    const blend={color:{srcFactor:'src-alpha',dstFactor:'one-minus-src-alpha',operation:'add'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha',operation:'add'}};
    const pipeline=await device.createRenderPipelineAsync({layout,vertex:{module,entryPoint:'vs',buffers:[{arrayStride:24,attributes:[{shaderLocation:0,offset:0,format:'float32x3'},{shaderLocation:1,offset:12,format:'float32x3'}]},{arrayStride:80,stepMode:'instance',attributes:[0,1,2,3,4].map((i)=>({shaderLocation:i+2,offset:i*16,format:'float32x4'}))}]},fragment:{module,entryPoint:'fs',targets:[{format,blend}]},primitive:{topology:'triangle-list',cullMode:'none'},depthStencil:{format:'depth24plus',depthWriteEnabled:true,depthCompare:'less-equal'},multisample:{count:4}});
    const lines=await device.createRenderPipelineAsync({layout,vertex:{module,entryPoint:'lineVS',buffers:[{arrayStride:28,attributes:[{shaderLocation:0,offset:0,format:'float32x3'},{shaderLocation:1,offset:12,format:'float32x4'}]}]},fragment:{module,entryPoint:'lineFS',targets:[{format,blend}]},primitive:{topology:'line-list'},depthStencil:{format:'depth24plus',depthWriteEnabled:false,depthCompare:'less-equal'},multisample:{count:4}});
    const vertices=boxVertices(),box=device.createBuffer({size:vertices.byteLength,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST});device.queue.writeBuffer(box,0,vertices);
    return {device,format,pipeline,lines,box,bindLayout,adapter};
  })();return sharedDevicePromise;
}
export class Viewport {
  constructor(canvas,overlay,kind,notify=()=>{}) {
    this.canvas=canvas;this.overlay=overlay;this.ctx=overlay.getContext('2d');this.kind=kind;this.notify=notify;
    this.camera={azimuth:-.95,elevation:.43,center:[9,6,10],span:31,pan:[0,0]};this.backend='initializing';this.dirty=true;this.geometryDirty=true;this.draws=0;this.objects=[];this.picking=new Map();
    this.resizeObserver=new ResizeObserver(()=>{this.resize();this.invalidate();});this.resizeObserver.observe(canvas.parentElement);
  }
  async init(){
    try {
      this.gpu=await getGPU();const {device,format,bindLayout}=this.gpu;
      this.context=this.canvas.getContext('webgpu');if(!this.context)throw new Error('WebGPU canvas context unavailable');
      this.context.configure({device,format,alphaMode:'opaque'});
      this.uniform=device.createBuffer({size:64,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
      this.bind=device.createBindGroup({layout:bindLayout,entries:[{binding:0,resource:{buffer:this.uniform}}]});
      device.addEventListener('uncapturederror',e=>{console.error('WebGPU validation:',e.error.message);this.notify('WebGPU validation: '+e.error.message);});
      device.lost.then(info=>{this.backend='Canvas fallback';this.notify('WebGPU device lost: '+info.message);this.gpu=null;this.invalidate();});
      this.backend='WebGPU';
    }catch(e){this.gpu=null;this.backend='Canvas fallback';this.notify('Canvas fallback · '+e.message);}
    this.resize();this.invalidate();return this.backend;
  }
  resize(){
    const r=this.canvas.parentElement.getBoundingClientRect();this.width=Math.max(1,r.width);this.height=Math.max(1,r.height);this.dpr=Math.min(devicePixelRatio||1,2);
    const w=Math.max(1,Math.round(this.width*this.dpr)),h=Math.max(1,Math.round(this.height*this.dpr));
    for(const c of[this.canvas,this.overlay])if(c.width!==w||c.height!==h){c.width=w;c.height=h;}
    if(this.gpu&&(!this.msaa||this.tw!==w||this.th!==h)) {
      this.msaa?.destroy();this.depth?.destroy();this.tw=w;this.th=h;
      const {device,format}=this.gpu;this.msaa=device.createTexture({size:[w,h],sampleCount:4,format,usage:GPUTextureUsage.RENDER_ATTACHMENT});
      this.depth=device.createTexture({size:[w,h],sampleCount:4,format:'depth24plus',usage:GPUTextureUsage.RENDER_ATTACHMENT});
    }
  }
  setState(model,state){this.model=model;this.state=state;this.invalidate(true);}
  invalidate(geometry=false){this.dirty=true;this.geometryDirty||=geometry;}
  fit(){
    if(!this.model)return;const points=this.model.nodes.length?this.model.nodes.map(position):[[0,0,0],[18,12,20]];
    const min=[0,1,2].map(k=>Math.min(...points.map(p=>p[k]))),max=[0,1,2].map(k=>Math.max(...points.map(p=>p[k])));
    this.camera.center=min.map((v,k)=>(v+max[k])/2);if(this.kind==='plan')this.camera.center[2]=this.state?.storyZ||0;this.camera.pan=[0,0];this.updateMatrix();
    let xmin=Infinity,xmax=-Infinity,ymin=Infinity,ymax=-Infinity;
    for(const p of points){const d=sub(p,this.camera.center),x=dot(d,this.right),y=dot(d,this.up);xmin=Math.min(xmin,x);xmax=Math.max(xmax,x);ymin=Math.min(ymin,y);ymax=Math.max(ymax,y);}
    this.camera.span=Math.max((ymax-ymin)*1.42,(xmax-xmin)*1.42/(this.width/this.height),5);this.invalidate();
  }
  updateMatrix(){
    const c=this.camera;let back,up;
    if(this.kind==='plan'){back=[0,0,1];up=[0,1,0];}
    else if(this.kind==='elevation'){back=[0,-1,0];up=[0,0,1];}
    else {back=[Math.cos(c.azimuth)*Math.cos(c.elevation),Math.sin(c.azimuth)*Math.cos(c.elevation),Math.sin(c.elevation)];up=[0,0,1];}
    this.right=unit(cross(up,back));this.up=unit(cross(back,this.right));this.back=back;
    this.target=add(add(c.center,scale(this.right,c.pan[0])),scale(this.up,c.pan[1]));
    const eye=add(this.target,scale(back,1000));this.matrix=mul(ortho(c.span*this.width/this.height,c.span,.01,2500),viewMatrix(eye,this.target,this.up));
  }
  project(p){const v=transform(this.matrix,p);return {x:(v[0]/v[3]+1)*this.width/2,y:(1-v[1]/v[3])*this.height/2,z:v[2]/v[3]};}
  worldAt(x,y,z=this.state.storyZ){this.updateMatrix();const p=add(add(this.target,scale(this.right,(x/this.width-.5)*this.camera.span*this.width/this.height)),scale(this.up,(.5-y/this.height)*this.camera.span));if(Math.abs(this.back[2])<1e-8)return null;return sub(p,scale(this.back,(p[2]-z)/this.back[2]));}
  zoom(delta,x=this.width/2,y=this.height/2){const before=this.worldAt(x,y,this.target?.[2]??0);this.camera.span=Math.max(.1,Math.min(1e5,this.camera.span*Math.exp(delta*.001)));const after=this.worldAt(x,y,this.target?.[2]??0);if(before&&after){const d=sub(before,after);this.camera.pan[0]+=dot(d,this.right);this.camera.pan[1]+=dot(d,this.up);}this.invalidate();}
  pan(dx,dy){this.camera.pan[0]-=dx*this.camera.span/this.height;this.camera.pan[1]+=dy*this.camera.span/this.height;this.invalidate();}
  orbit(dx,dy){if(this.kind!=='3d')return;this.camera.azimuth-=dx*.007;this.camera.elevation=Math.max(.05,Math.min(1.51,this.camera.elevation+dy*.005));this.invalidate();}
  upload(name,data,usage){
    if(!this.gpu||!data.length)return;const {device}=this.gpu;const bytes=data.byteLength;
    if(!this[name]||this[name+'Capacity']<bytes){this[name]?.destroy();this[name+'Capacity']=2**Math.ceil(Math.log2(Math.max(256,bytes)));this[name]=device.createBuffer({size:this[name+'Capacity'],usage:usage|GPUBufferUsage.COPY_DST});}
    device.queue.writeBuffer(this[name],0,data);
  }
  buildGeometry(){
    const m=this.model,s=this.state;if(!m||!s)return;const instances=[],lines=[],objects=[],nodes=new Map(m.nodes.map(n=>[n.id,n])),sections=new Map(m.sections.map(n=>[n.id,n]));
    const ext=Math.max(10,...m.nodes.map(n=>Math.abs(n.z))),plan=this.kind==='plan',z=s.storyZ;
    const result=s.display==='mode'?s.results?.modes[s.modeIndex||0]:s.results?.static[s.caseId];
    const deform=['deformed','mode'].includes(s.display)&&result;
    const factor=deform?(s.deformationScale>0?s.deformationScale:ext*.075/Math.max(result.maxDisplacement,1e-12))*(s.animate?Math.sin(s.time*2.5):1):0;
    const diagramIndex={axial:0,v2:1,v3:2,torsion:3,m2:4,m3:5}[s.display];
    let maxForce=1;if(diagramIndex!==undefined&&result)for(const v of Object.values(result.members))for(let i=1+diagramIndex;i<v.diagram.length;i+=7)maxForce=Math.max(maxForce,Math.abs(v.diagram[i]));
    const line=(a,b,color)=>lines.push(...a,...color,...b,...color);
    const box=(a,b,width,height,color,roll=0)=>{
      if(norm(sub(b,a))<1e-9)return;const {L,R}=localAxes(a,b,roll),c=scale(add(a,b),.5);
      instances.push(...scale(R[0],L),0,...scale(R[1],width),0,...scale(R[2],height),0,...c,1,...color);
    };
    const visible=e=>!plan||(Math.abs(nodes.get(e.i).z-z)<1e-6&&Math.abs(nodes.get(e.j).z-z)<1e-6);
    const dotBox=(p,size,color)=>box(sub(p,[size/2,0,0]),add(p,[size/2,0,0]),size,size,color);
    const minX=Math.min(0,...m.grids.x)-1.4,maxX=Math.max(1,...m.grids.x)+1.4,minY=Math.min(0,...m.grids.y)-1.4,maxY=Math.max(1,...m.grids.y)+1.4;
    const levels=plan?[z]:(s.grids?m.stories.map(st=>st.z):[0]);
    if(s.grids)for(const h of levels){for(const x of m.grids.x)line([x,minY,h],[x,maxY,h],COLORS.grid);for(const y of m.grids.y)line([minX,y,h],[maxX,y,h],COLORS.grid);}
    if(!plan&&s.grids)for(const [x,y]of[[minX,minY],[maxX,maxY]])line([x,y,0],[x,y,Math.max(0,...m.stories.map(t=>t.z))],COLORS.grid);
    for(const e of m.elements) {
      const ni=nodes.get(e.i),nj=nodes.get(e.j),a=position(ni),b=position(nj),sec=sections.get(e.section),isCol=Math.abs(ni.z-nj.z)>1e-6,selected=s.selection.has('e:'+e.id);
      if(!visible(e)) {
        if(plan&&isCol&&Math.min(ni.z,nj.z)<=z+1e-6&&Math.max(ni.z,nj.z)>=z-1e-6){const t=(z-ni.z)/(nj.z-ni.z),p=a.map((v,k)=>v+(b[k]-v)*t);dotBox(p,sec.b||.25,selected?COLORS.selected:COLORS.column);objects.push({type:'e',id:e.id,a:p,b:p});}
        continue;
      }
      const color=selected?COLORS.selected:isCol?COLORS.column:COLORS.beam,w=sec.b||Math.sqrt(sec.A),h=sec.h||Math.sqrt(sec.A);
      objects.push({type:'e',id:e.id,a,b});
      if(deform&&result.members[e.id]) {
        line(a,b,COLORS.ghost);const curve=result.members[e.id].curve;
        for(let k=0;k<20;k++) {
          const start=a.map((v,d)=>v+(b[d]-v)*k/20+curve[k*3+d]*factor),end=a.map((v,d)=>v+(b[d]-v)*(k+1)/20+curve[(k+1)*3+d]*factor);
          box(start,end,w*.55,h*.55,selected?COLORS.selected:COLORS.deformed,e.roll);
        }
      }else if(diagramIndex!==undefined&&result) {
        box(a,b,w*.35,h*.35,COLORS.ghost,e.roll);const data=result.members[e.id].diagram,{R}=localAxes(a,b,e.roll),dir=R[[2,4].includes(diagramIndex)?2:1];let last=null;
        for(let k=0;k<data.length/7;k++) {
          const t=data[k*7],value=data[k*7+1+diagramIndex],p=a.map((v,d)=>v+(b[d]-v)*t),q=add(p,scale(dir,value/maxForce*ext*.08)),col=value>=0?COLORS.positive:COLORS.negative;
          if(last)line(last,q,col);if(k%2===0)line(p,q,[...col.slice(0,3),.45]);last=q;
        }
      }else if(s.extrude)box(a,b,w,h,color,e.roll);else {line(a,b,color);if(selected)box(a,b,.12,.12,color,e.roll);}
      if(e.releases?.some(Boolean))for(const end of[0,1])if(e.releases.slice(end*6,end*6+6).some(Boolean)){const t=end?.96:.04,p=a.map((v,k)=>v+(b[k]-v)*t);dotBox(p,.18,[.92,.35,.21,1]);}
    }
    m.nodes.forEach((n,index)=>{
      if(plan&&Math.abs(n.z-z)>1e-6)return;const p=position(n),selected=s.selection.has('n:'+n.id);objects.push({type:'n',id:n.id,a:p,b:p});
      if(selected||s.joints)dotBox(p,selected?.23:.11,selected?COLORS.selected:[.29,.39,.50,1]);
      if(n.support.some(Boolean)&&s.supports){const p0=sub(p,[0,0,.15]);box(sub(p0,[.48,0,0]),add(p0,[.48,0,0]),.8,.12,COLORS.support);line(p,add(p,[-.33,0,-.45]),COLORS.support);line(p,add(p,[.33,0,-.45]),COLORS.support);}
      if(s.display==='reactions'&&result&&n.support.some(Boolean)) {
        const f=Array.from(result.reactions.slice(index*6,index*6+3)),mag=norm(f);if(mag>1e-5)this.arrow(line,p,add(p,scale(f,ext*.09/mag)),COLORS.positive);
      }
    });
    if(s.display==='loads') {
      const cases=s.results?.static[s.caseId]?s.caseId:s.caseId;
      const factors=m.combinations.find(c=>c.id===cases)?.factors||{[cases]:1};
      for(const load of m.loads)if(factors[load.case]) {
        const f=factors[load.case];if(load.type==='nodal') {const n=nodes.get(load.node);if(plan&&Math.abs(n.z-z)>1e-6)continue;const v=scale(load.value.slice(0,3),f),mag=norm(v);if(mag>0){const p=position(n);this.arrow(line,sub(p,scale(v,1.6/mag)),p,COLORS.load);}}
        else {const e=m.elements.find(e=>e.id===load.element);if(!visible(e))continue;const a=position(nodes.get(e.i)),b=position(nodes.get(e.j));const v=scale(load.system==='global'?load.value:localToGlobal(localAxes(a,b,e.roll).R,load.value),f),mag=norm(v);if(!mag)continue;for(const t of load.type==='point'?[load.position]:[.12,.32,.52,.72,.92]){const p=a.map((v,k)=>v+(b[k]-v)*t);this.arrow(line,sub(p,scale(v,1.1/mag)),p,COLORS.load);}}
      }
    }
    if(s.drawPreview?.length===2)line(s.drawPreview[0],s.drawPreview[1],COLORS.selected);
    this.instances=new Float32Array(instances);this.lines=new Float32Array(lines);this.objects=objects;this.draws=(instances.length?1:0)+(lines.length?1:0);this.displayFactor=factor;
    if(this.gpu){this.upload('instanceBuffer',this.instances,GPUBufferUsage.VERTEX);this.upload('lineBuffer',this.lines,GPUBufferUsage.VERTEX);}
  }
  arrow(line,a,b,color){line(a,b,color);const d=sub(b,a),len=norm(d);if(!len)return;let side=cross(unit(d),[0,0,1]);if(norm(side)<.1)side=[1,0,0];side=scale(unit(side),len*.12);const p=sub(b,scale(d,.2));line(b,add(p,side),color);line(b,sub(p,side),color);}
  rebuildPicking(){
    this.picking.clear();const cell=48;
    for(const o of this.objects){const a=this.project(o.a),b=this.project(o.b);o.screenA=a;o.screenB=b;
      const x0=Math.floor((Math.min(a.x,b.x)-10)/cell),x1=Math.floor((Math.max(a.x,b.x)+10)/cell),y0=Math.floor((Math.min(a.y,b.y)-10)/cell),y1=Math.floor((Math.max(a.y,b.y)+10)/cell);
      for(let y=Math.max(-1,y0);y<=Math.min(Math.ceil(this.height/cell),y1);y++)for(let x=Math.max(-1,x0);x<=Math.min(Math.ceil(this.width/cell),x1);x++){const key=x+','+y;if(!this.picking.has(key))this.picking.set(key,[]);this.picking.get(key).push(o);}
    }
  }
  pick(x,y,nodesOnly=false){
    let found=null,best=12;for(const o of this.picking.get(Math.floor(x/48)+','+Math.floor(y/48))||[]) {
      if(nodesOnly&&o.type!=='n')continue;const a=o.screenA,b=o.screenB,dx=b.x-a.x,dy=b.y-a.y,t=Math.max(0,Math.min(1,((x-a.x)*dx+(y-a.y)*dy)/(dx*dx+dy*dy||1))),dist=Math.hypot(x-a.x-t*dx,y-a.y-t*dy)+(o.type==='e'?2:0);
      if(dist<best){best=dist;found=o;}
    }return found;
  }
  render(){
    if(!this.dirty||!this.model)return;this.dirty=false;this.updateMatrix();
    if(this.geometryDirty){this.buildGeometry();this.geometryDirty=false;}
    if(this.gpu&&this.msaa) {
      const {device,pipeline,lines,box}=this.gpu;device.queue.writeBuffer(this.uniform,0,this.matrix);
      const encoder=device.createCommandEncoder(),pass=encoder.beginRenderPass({colorAttachments:[{view:this.msaa.createView(),resolveTarget:this.context.getCurrentTexture().createView(),loadOp:'clear',clearValue:{r:.98,g:.987,b:.993,a:1},storeOp:'discard'}],depthStencilAttachment:{view:this.depth.createView(),depthLoadOp:'clear',depthClearValue:1,depthStoreOp:'discard'}});
      pass.setBindGroup(0,this.bind);
      if(this.instances?.length){pass.setPipeline(pipeline);pass.setVertexBuffer(0,box);pass.setVertexBuffer(1,this.instanceBuffer);pass.draw(36,this.instances.length/20);}
      if(this.lines?.length){pass.setPipeline(lines);pass.setVertexBuffer(0,this.lineBuffer);pass.draw(this.lines.length/7);}
      pass.end();device.queue.submit([encoder.finish()]);
    }
    this.rebuildPicking();this.drawOverlay();
  }
  drawOverlay(){
    const c=this.ctx;c.setTransform(this.dpr,0,0,this.dpr,0,0);c.clearRect(0,0,this.width,this.height);
    if(!this.gpu){
      c.fillStyle='#f8fafc';c.fillRect(0,0,this.width,this.height);
      if(this.lines)for(let i=0;i<this.lines.length;i+=14){const a=this.project(Array.from(this.lines.slice(i,i+3))),b=this.project(Array.from(this.lines.slice(i+7,i+10)));c.strokeStyle=`rgba(${this.lines[i+3]*255},${this.lines[i+4]*255},${this.lines[i+5]*255},${this.lines[i+6]})`;c.lineWidth=1;c.beginPath();c.moveTo(a.x,a.y);c.lineTo(b.x,b.y);c.stroke();}
      if(this.instances){const ids=Array.from({length:this.instances.length/20},(_,i)=>i).sort((a,b)=>this.project(Array.from(this.instances.slice(a*20+12,a*20+15))).z-this.project(Array.from(this.instances.slice(b*20+12,b*20+15))).z).reverse();
        for(const index of ids){const i=index*20,center=Array.from(this.instances.slice(i+12,i+15)),d=Array.from(this.instances.slice(i,i+3)),a=this.project(sub(center,scale(d,.5))),b=this.project(add(center,scale(d,.5))),rgb=Array.from(this.instances.slice(i+16,i+19),v=>Math.round(v*255));c.strokeStyle=`rgb(${rgb.join(',')})`;c.lineWidth=Math.max(1.2,norm(Array.from(this.instances.slice(i+4,i+7)))*this.height/this.camera.span);c.lineCap='square';c.beginPath();c.moveTo(a.x,a.y);c.lineTo(b.x,b.y);c.stroke();}
      }
    }
    const m=this.model,s=this.state,plan=this.kind==='plan';c.font='10px system-ui';c.textAlign='center';c.textBaseline='middle';
    const label=(text,p,color='#8091a4',bubble=false)=>{const a=this.project(p);if(a.x<5||a.x>this.width-5||a.y<8||a.y>this.height-8)return;if(bubble){c.fillStyle='#fff';c.strokeStyle='#cad3de';c.lineWidth=1;c.beginPath();c.arc(a.x,a.y,9,0,Math.PI*2);c.fill();c.stroke();}c.fillStyle=color;c.fillText(text,a.x,a.y);};
    if(s.grids){const z=plan?s.storyZ:0;for(let i=0;i<m.grids.x.length;i++)label(String.fromCharCode(65+i),[m.grids.x[i],Math.min(...m.grids.y)-1.4,z],'#7d8ba0',true);for(let i=0;i<m.grids.y.length;i++)label(String(i+1),[Math.min(...m.grids.x)-1.4,m.grids.y[i],z],'#7d8ba0',true);}
    if(!plan&&s.grids){c.textAlign='left';for(const story of m.stories){const p=this.project([Math.min(...m.grids.x)-1.4,Math.max(...m.grids.y)+1.4,story.z]);c.fillStyle='#8390a1';c.fillText(story.name,p.x-42,p.y);}c.textAlign='center';}
    if(s.labels)for(const o of this.objects){if(o.type==='e'){const a=o.screenA,b=o.screenB;c.fillStyle='#677991';c.fillText(o.id,(a.x+b.x)/2,(a.y+b.y)/2-7);}else{c.fillStyle='#657b91';c.fillText(o.id,o.screenA.x+12,o.screenA.y-8);}}
    if(s.display==='reactions'){const r=s.results?.static[s.caseId];if(r)for(let i=0;i<m.nodes.length;i++){const n=m.nodes[i];if(n.support.some(Boolean)&&(!plan||Math.abs(n.z-s.storyZ)<1e-6)){const p=this.project(position(n));c.fillStyle='#267a5b';c.fillText((r.reactions[i*6+2]/unitFactor(displaySystems[s.units].force)).toFixed(1)+' '+displaySystems[s.units].force,p.x,p.y+20);}}}
    if(s.selection.size)for(const o of this.objects)if(s.selection.has(o.type+':'+o.id)){const p=o.screenA;c.fillStyle='#a66512';c.font='bold 10px system-ui';c.fillText(o.id,p.x+15,p.y-15);}
    if(s.boxSelection&&s.boxSelection.viewport===this){const b=s.boxSelection;c.fillStyle='rgba(64,103,222,.08)';c.strokeStyle='#5877d3';c.setLineDash([4,3]);c.fillRect(b.x,b.y,b.w,b.h);c.strokeRect(b.x,b.y,b.w,b.h);c.setLineDash([]);}
    if(s.snapPoint&&plan){const p=this.project(s.snapPoint);c.strokeStyle='#dc9629';c.lineWidth=1.5;c.strokeRect(p.x-5,p.y-5,10,10);}
    const ox=44,oy=this.height-39;c.lineWidth=1.5;
    for(const [axis,color,name]of[[[1,0,0],'#c97670','X'],[[0,1,0],'#5f9d7c','Y'],[[0,0,1],'#6d8dcc','Z']]){const dx=dot(axis,this.right)*24,dy=-dot(axis,this.up)*24;if(Math.abs(dx)+Math.abs(dy)<1)continue;c.strokeStyle=color;c.beginPath();c.moveTo(ox,oy);c.lineTo(ox+dx,oy+dy);c.stroke();c.fillStyle=color;c.fillText(name,ox+dx*1.3,oy+dy*1.3);}
    c.textAlign='right';c.font='10px system-ui';c.fillStyle='#98a4b3';c.fillText(this.backend==='WebGPU'?`${this.draws} GPU draws · instanced`:'Canvas 2D compatibility renderer',this.width-14,this.height-16);
  }
  dispose(){this.resizeObserver.disconnect();this.msaa?.destroy();this.depth?.destroy();this.instanceBuffer?.destroy();this.lineBuffer?.destroy();this.uniform?.destroy();}
}
