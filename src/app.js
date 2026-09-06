import {createBuilding,emptyModel,uniqueId,position,parseProject,validateModel} from './core/model.js';
import {quantity,formatValue,displaySystems,unitFactor} from './core/units.js';
import {DOFS,localAxes,localToGlobal} from './core/elements.js';
import {norm,sub} from './core/linalg.js';
import {ProjectStore} from './ui/store.js';
import {Viewport} from './ui/renderer.js';
import {Dialogs,esc} from './ui/dialogs.js';
import {icon,hydrateIcons} from './ui/icons.js';
const $=s=>document.querySelector(s);
const menus={
  File:[['new','New model','new','Ctrl N'],['open','Open project…','open','Ctrl O'],['save','Save project…','save','Ctrl S'],null,['report','Export analysis report','report'],['csv','Export current table','download'],['json','Model JSON editor','code']],
  Edit:[['undo','Undo','undo','Ctrl Z'],['redo','Redo','redo','Ctrl Y'],null,['delete','Delete selected objects','trash','Del'],['split','Split selected frames at midpoint','split'],['clear-selection','Clear selection','close','Esc']],
  View:[['fit','Fit both views','fit','F'],['3d','3D model view','cube'],['elevation','XZ elevation','grid'],['plan','Plan in main view','grid'],null,['view-options','Display settings…','settings']],
  Define:[['stories','Stories…','story'],['grids','Grid systems…','grid'],['materials','Materials…','material'],['sections','Frame sections…','section'],['rectangle','Rectangular section…','section'],null,['cases','Load cases…','load'],['combinations','Load combinations…','table'],['diaphragms','Rigid diaphragms…','diaphragm']],
  Draw:[['tool:beam','Draw beam in plan','beam','B'],['tool:column','Draw column in plan','column','C'],['tool:joint','Draw joint in plan','joint','J'],['tool:move','Move joint in plan','move','M'],null,['connect','Connect two selected joints','beam'],['split','Split selected frames','split']],
  Select:[['select-all','All frames','select','Ctrl A'],['select-beams','Beams','beam'],['select-columns','Columns','column'],['select-story','Active-story joints','joint'],['clear-selection','Clear selection','close']],
  Assign:[['section-assign','Frame section…','section'],['supports','Joint restraints…','support'],['releases','Frame end releases…','release'],['load','Joint / member loads…','load'],['load-table','View / edit assigned loads…','table'],['diaphragms','Rigid diaphragms…','diaphragm']],
  Analyze:[['validate','Check model…','check'],['run','Run static + modal analysis','play','F5'],['cancel','Cancel analysis','stop'],['view-options','Analysis settings…','settings']],
  Display:[['model-view','Undeformed model','cube'],['loads-view','Applied loads','load'],['deformed','Deformed shape','deform'],['forces','Member-force diagrams','chart'],['reactions','Support reactions','support'],['modes','Mode shapes','mode']],
  Help:[['help','Analysis assumptions & guide','info'],['benchmarks','Run analytical benchmarks','check']]
};
function download(name,content,type='application/json') {const blob=new Blob([content],{type}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
const safeName=s=>String(s).replace(/[^a-z0-9_-]+/gi,'-').replace(/^-|-$/g,'').slice(0,70)||'stratum-model';

class Workbench {
  constructor(){
    let restored=null;try{restored=ProjectStore.restore();}catch{}
    this.store=new ProjectStore(restored||createBuilding());
    this.state={selection:new Set(),storyZ:Math.max(...this.model.stories.map(s=>s.z)),units:'SI',tool:'select',display:'model',caseId:this.model.combinations[0]?.id||this.model.cases[0]?.id,modeIndex:0,
      results:null,grids:true,extrude:true,labels:false,joints:false,supports:true,snap:true,animate:false,time:0,deformationScale:0,table:'stories',explorer:'model',drawPreview:null,snapPoint:null};
    this.dialogs=new Dialogs(this);this.logs=[];this.worker=null;this.workerBlobURL=null;this.runId=0;this.running=false;this.drawStart=null;this.pointers=new Map();
    this.main=new Viewport($('#main-canvas'),$('#main-overlay'),'3d',m=>this.log(m,'warning'));
    this.plan=new Viewport($('#plan-canvas'),$('#plan-overlay'),'plan',m=>this.log(m,'warning'));this.views=[this.main,this.plan];
    this.store.addEventListener('change',e=>{
      this.cancelAnalysis(false);this.state.results=null;this.state.animate=false;this.drawStart=null;this.state.drawPreview=null;
      this.state.selection=new Set([...this.state.selection].filter(key=>{const[type,id]=key.split(':');return(type==='n'?this.model.nodes:this.model.elements).some(n=>n.id===id);}));
      if(!this.model.stories.some(s=>Math.abs(s.z-this.state.storyZ)<1e-7))this.state.storyZ=Math.max(0,...this.model.stories.map(s=>s.z));
      this.log(e.detail.label);if(e.detail.persistenceError)this.log('Autosave failed: '+e.detail.persistenceError,'warning');
      this.refresh();this.status(e.detail.label+' · results invalidated');
    });
    this.installEvents();this.refresh(true);this.log(restored?'Restored locally saved project.':'Loaded the editable six-story example.');
    this.log('SI model storage · Float64 sparse frame analysis · consistent mass.');
    this.tick=this.tick.bind(this);requestAnimationFrame(this.tick);
  }
  get model(){return this.store.model;}
  get units(){return displaySystems[this.state.units];}
  get result(){return this.state.display==='mode'?this.state.results?.modes[this.state.modeIndex]:this.state.results?.static[this.state.caseId];}
  get staticResult(){return this.state.results?.static[this.state.caseId];}
  get displacementUnit(){return this.state.units==='US'?'in':'mm';}
  fmt(v,dim,digits=3){return formatValue(v,dim,this.state.units,digits);}
  disp(v,digits=3){return Number.isFinite(v)?(v/unitFactor(this.displacementUnit)).toLocaleString('en-US',{maximumFractionDigits:digits,minimumFractionDigits:digits}):'—';}
  selectedElements(){return this.model.elements.filter(e=>this.state.selection.has('e:'+e.id));}
  selectedNodes(){return this.model.nodes.filter(e=>this.state.selection.has('n:'+e.id));}
  log(message,level='info'){
    this.logs.push({time:new Date().toLocaleTimeString('en-GB'),message,level});if(this.logs.length>250)this.logs.shift();
    $('#log-count').textContent=this.logs.length;if(this.state.table==='diagnostics')this.renderTable();
  }
  status(message){$('#status-message').innerHTML='<span class="live-dot"></span>'+esc(message);}
  toast(message,error=false){const t=$('#toast');t.textContent=message;t.classList.remove('hidden');t.classList.toggle('error',error);clearTimeout(this.toastTimer);this.toastTimer=setTimeout(()=>t.classList.add('hidden'),error?6500:3500);}
  guard(fn){try{return fn();}catch(e){this.toast(e.message,true);this.log(e.message,'error');return null;}}
  async init(){const backends=await Promise.all(this.views.map(v=>v.init()));$('#gpu-status').innerHTML=icon('bolt',12)+' '+(backends.every(b=>b==='WebGPU')?'WebGPU · instanced':'Canvas fallback');this.refresh(true);this.runAnalysis();}
  refresh(fit=false){
    const s=this.state,m=this.model;if(!m.cases.some(c=>c.id===s.caseId)&&!m.combinations.some(c=>c.id===s.caseId))s.caseId=m.combinations[0]?.id||m.cases[0]?.id;
    $('#document-name').textContent=m.name;document.title=m.name+' — Stratum Frame';
    $('#case-select').innerHTML=[['Load cases',m.cases],['Combinations',m.combinations]].map(([label,items])=>`<optgroup label="${label}">${items.map(c=>`<option value="${esc(c.id)}" ${c.id===s.caseId?'selected':''}>${esc(c.id)} · ${esc(c.name)}</option>`).join('')}</optgroup>`).join('');
    const storyOptions=[...m.stories].sort((a,b)=>b.z-a.z).map(st=>`<option value="${st.z}" ${Math.abs(st.z-s.storyZ)<1e-7?'selected':''}>${esc(st.name)}</option>`).join('');
    $('#story-select').innerHTML=storyOptions;$('#main-story-select').innerHTML=storyOptions;$('#main-story-select').classList.toggle('hidden',this.main.kind!=='plan');
    $('#display-select').value=s.display;$('#unit-select').value=s.units;
    const st=m.stories.find(t=>Math.abs(t.z-s.storyZ)<1e-7);$('#plan-info').textContent=(st?.name||'Level')+' · '+this.fmt(s.storyZ,'length')+' '+this.units.length;
    $('#mode-select').innerHTML=(s.results?.modes||[]).map((mode,i)=>`<option value="${i}" ${s.modeIndex===i?'selected':''}>${i+1} · ${mode.frequency.toFixed(3)} Hz</option>`).join('');$('.mode-control').classList.toggle('hidden',s.display!=='mode');
    $('#model-counts').textContent=`${m.nodes.length} joints · ${m.elements.length} frames`;
    $('#dof-status').textContent=s.results?`${s.results.stats.activeDOFs} active DOF · Float64`:`${m.nodes.length*6} physical DOF · Float64`;
    $('#selection-count').textContent=s.selection.size+' selected';$('#snap-toggle').textContent=s.snap?'Grid snap on':'Grid snap off';
    $('#analysis-state').classList.toggle('pending',!s.results);$('#analysis-state').classList.toggle('progress-pulse',this.running);
    $('#analysis-state').innerHTML='<span class="live-dot"></span>'+(this.running?'Analyzing…':s.results?s.results.modalError?'Static solved · modal warning':'Analysis current':'Model modified · run analysis');
    document.querySelectorAll('[data-toggle]').forEach(b=>b.classList.toggle('toggled',!!s[b.dataset.toggle]));document.querySelectorAll('[data-tool]').forEach(b=>b.classList.toggle('active',s.tool===b.dataset.tool));
    document.querySelectorAll('[data-explorer]').forEach(b=>b.classList.toggle('selected',s.explorer===b.dataset.explorer));document.querySelectorAll('[data-table]').forEach(b=>b.classList.toggle('active',s.table===b.dataset.table));
    document.querySelectorAll('[data-action="undo"]').forEach(b=>b.disabled=!this.store.past.length);document.querySelectorAll('[data-action="redo"]').forEach(b=>b.disabled=!this.store.future.length);
    const mode=this.result;let chip='Section assignments';if(s.display==='loads')chip=s.caseId+' · Applied loads (excluding self-weight arrows)';else if(s.display==='mode'&&mode)chip=`Mode ${s.modeIndex+1} · ${mode.frequency.toFixed(3)} Hz · ${mode.period.toFixed(3)} s`;else if(s.display==='deformed'&&mode)chip=`${s.caseId} · Max |u| ${this.disp(mode.maxDisplacement)} ${this.displacementUnit}`;else if(s.display!=='model')chip=s.caseId+' · '+$('#display-select').selectedOptions[0]?.textContent;
    $('#result-chip').innerHTML='<span class="chip-dot"></span>'+esc(chip);
    $('#main-legend').innerHTML=['deformed','mode'].includes(s.display)?'<span><i style="background:#8060d2"></i>Computed deformation</span><span><i style="background:#c4cdd8"></i>Undeformed</span>':s.display==='model'?'<span><i class="column-color"></i>Columns</span><span><i class="beam-color"></i>Beams</span><span><i class="support-color"></i>Restraints</span>':['axial','v2','v3','torsion','m2','m3'].includes(s.display)?'<span><i style="background:#14969e"></i>Positive</span><span><i style="background:#d65766"></i>Negative</span>':'';
    $('#main-hint').textContent=s.tool==='select'?'Drag to orbit · scroll to zoom · Shift-drag to box select':s.tool==='beam'?(this.drawStart?'Click the second endpoint in Plan View':'Click the first endpoint in Plan View'):s.tool==='column'?'Click a plan point to connect this story to the one below':s.tool==='joint'?'Click in Plan View to add a joint':'Drag a joint in Plan View; coordinates snap to the grid';
    for(const v of this.views){v.setState(m,s);if(fit)v.fit();}
    $('#main-view-title').textContent=this.main.kind==='3d'?'3D View':this.main.kind==='plan'?'Plan View':'XZ Elevation';
    $('#animate-button').innerHTML=icon(s.animate?'pause':'play');$('#animate-button').classList.toggle('toggled',s.animate);
    this.renderTree();this.renderInspector();this.renderTable();
  }
  renderTree(){
    const m=this.model,s=this.state,q=$('#tree-search').value.toLowerCase(),rows=[];
    rows.push(`<div class="tree-header">${icon('down',10)}${icon('folder',15)}<span>${esc(m.name.split(' · ')[0])}</span></div>`);
    const row=(id,name,type,count='',active=false)=>`<button class="tree-row ${active?'active':''}" data-${type}="${esc(id)}">${icon(type==='story'?'story':type==='case'?'load':'beam',14)}<span>${esc(name)}</span>${count!==''?`<small>${esc(count)}</small>`:''}</button>`;
    if(q){
      for(const n of m.nodes)if(n.id.toLowerCase().includes(q))rows.push(row('n:'+n.id,n.id,'object',`${this.fmt(n.z,'length')} ${this.units.length}`,s.selection.has('n:'+n.id)));
      for(const e of m.elements)if((e.id+' '+e.section).toLowerCase().includes(q))rows.push(row('e:'+e.id,e.id,'object',e.section,s.selection.has('e:'+e.id)));
    }else if(s.explorer==='model'){
      rows.push('<div class="tree-group"><div class="tree-group-label">STORIES & FRAMING<span>'+m.stories.length+' LEVELS</span></div>');
      for(const st of [...m.stories].sort((a,b)=>b.z-a.z))rows.push(row(st.z,st.name,'story',this.fmt(st.z,'length')+' '+this.units.length,Math.abs(st.z-s.storyZ)<1e-7));
      rows.push('</div><div class="tree-group"><div class="tree-group-label">DEFINITIONS</div>');
      for(const[action,label,ic,count]of[['grids','Grid systems','grid',m.grids.x.length+' × '+m.grids.y.length],['materials','Materials','material',m.materials.length],['sections','Frame sections','section',m.sections.length],['diaphragms','Diaphragms','diaphragm',m.diaphragms.length],['cases','Load cases','load',m.cases.length],['combinations','Load combinations','table',m.combinations.length]])rows.push(`<button class="tree-row definition" data-action="${action}">${icon(ic,14)}<span>${label}</span><small class="count">${count}</small></button>`);
      rows.push('</div>');
      if(s.selection.size)rows.push(`<div class="tree-group-label" style="margin-top:13px">SELECTION · ${s.selection.size}</div>`,...[...s.selection].slice(0,20).map(k=>row(k,k.slice(2),'object','',true)));
    }else if(s.explorer==='loads'){
      rows.push('<div class="tree-group-label">STATIC LOAD CASES</div>');for(const c of m.cases)rows.push(row(c.id,c.name,'case',m.loads.filter(l=>l.case===c.id).length,s.caseId===c.id));
      rows.push('<div class="tree-group-label">LINEAR COMBINATIONS</div>');for(const c of m.combinations)rows.push(row(c.id,c.name,'case','',s.caseId===c.id));
      rows.push(`<button class="tree-row definition" data-action="load-table">${icon('table',14)}Assigned loads table</button>`);
    }else{
      rows.push('<div class="tree-group-label">STATIC RESULTS</div>');for(const c of [...m.cases,...m.combinations])rows.push(row(c.id,c.id,'resultcase',s.results?'Solved':'Not run',s.caseId===c.id));
      rows.push('<div class="tree-group-label">MODAL RESULTS</div>');for(const mode of s.results?.modes||[])rows.push(`<button class="tree-row" data-mode="${mode.number-1}">${icon('mode',14)}<span>Mode ${mode.number}</span><small>${mode.frequency.toFixed(3)} Hz</small></button>`);
    }
    $('#model-tree').innerHTML=rows.join('');
  }
  propertyRow(label,value){return `<div class="property-row"><label>${label}</label><span>${value}</span></div>`;}
  propertyInput(label,key,value,kind='node',extra=''){return `<div class="property-row"><label>${label}</label><input data-property="${key}" data-kind="${kind}" value="${esc(value)}" ${extra}></div>`;}
  inspectorHTML(){
    const s=this.state,m=this.model,r=this.staticResult,es=this.selectedElements(),ns=this.selectedNodes();
    let html='';
    const head=(ic,name,sub)=>`<div class="property-title"><div class="property-symbol">${icon(ic,20)}</div><div><strong>${esc(name)}</strong><small>${esc(sub)}</small></div></div>`;
    if(es.length===1&&!ns.length){
      const e=es[0],sec=m.sections.find(sec=>sec.id===e.section),mat=m.materials.find(mat=>mat.id===sec.material),a=m.nodes.find(n=>n.id===e.i),b=m.nodes.find(n=>n.id===e.j),L=norm(sub(position(a),position(b)));
      html+=head('beam',e.id+' · Frame object',Math.abs(a.z-b.z)>1e-6?'Column / inclined frame':'Beam / horizontal frame');
      html+=`<div class="property-section"><h3>GEOMETRY & SECTION</h3>${this.propertyRow('End I',esc(e.i))}${this.propertyRow('End J',esc(e.j))}${this.propertyRow('Length',this.fmt(L,'length')+' '+this.units.length)}<div class="property-row"><label>Section</label><select data-property="section" data-kind="element">${m.sections.map(sec=>`<option value="${esc(sec.id)}" ${e.section===sec.id?'selected':''}>${esc(sec.name)}</option>`).join('')}</select></div>${this.propertyRow('Material',esc(String(mat.name||mat.id).split(' · ')[0]))}${this.propertyInput('Local-axis roll (deg)','roll',((e.roll||0)*180/Math.PI).toFixed(2),'element')}<div class="mini-section"><div class="section-rectangle" style="width:${Math.max(10,45*(sec.b||.3)/(sec.h||.6))}px;height:50px"></div></div>${this.propertyRow('Area',this.fmt(sec.A,'area',6)+' '+this.units.area)}<button class="inspector-button" data-action="releases">${icon('release',14)} End releases (${e.releases?.filter(Boolean).length||0})</button><button class="inspector-button" data-action="load">${icon('load',14)} Assign member loads</button></div>`;
      if(r){const data=r.members[e.id];html+=`<div class="property-section"><h3>END I FORCES · ${esc(s.caseId)}</h3>${['P','V2','V3','T','M2','M3'].map((name,i)=>this.propertyRow(name,this.fmt(data.endForces[i],i<3?'force':'moment')+' '+this.units[i<3?'force':'moment'])).join('')}<p class="property-description">Local element resisting forces, before cut-face sign conversion.</p>${this.memberChart(data)}</div>`;}
      html+=`<div class="property-section"><h3>OBJECT ACTIONS</h3><button class="inspector-button" data-action="split">${icon('split',13)}Split at midpoint</button><button class="inspector-button" data-action="delete">${icon('trash',13)}Delete frame</button></div>`;
    }else if(ns.length===1&&!es.length){
      const n=ns[0],index=m.nodes.indexOf(n);html+=head('joint',n.id+' · Joint object','Global coordinates');
      html+=`<div class="property-section"><h3>COORDINATES</h3>${['x','y','z'].map(k=>this.propertyInput(k.toUpperCase()+' ('+this.units.length+')',k,n[k]/unitFactor(this.units.length))).join('')}${this.propertyInput('Added mass ('+this.units.mass+')','mass',(n.mass||0)/unitFactor(this.units.mass))}<p class="property-description">Added mass acts in X, Y and Z. It does not add a gravity load.</p></div>`;
      html+=`<div class="property-section"><h3>JOINT RESTRAINTS</h3><div class="support-flags">${DOFS.map((d,k)=>`<label><input type="checkbox" data-property="support:${k}" data-kind="node" ${n.support[k]?'checked':''}>${d}</label>`).join('')}</div><button class="inspector-button" data-action="load">${icon('load',13)}Assign joint load</button></div>`;
      const d=m.diaphragms.find(d=>d.nodes.includes(n.id));html+=`<div class="property-section"><h3>ASSIGNMENTS</h3>${this.propertyRow('Diaphragm',esc(d?.name||'None'))}${this.propertyRow('Attached frames',m.elements.filter(e=>e.i===n.id||e.j===n.id).length)}</div>`;
      if(r)html+=`<div class="property-section"><h3>DISPLACEMENTS · ${esc(s.caseId)}</h3>${DOFS.map((d,k)=>this.propertyRow(d,k<3?this.disp(r.u[index*6+k])+' '+this.displacementUnit:r.u[index*6+k].toExponential(3)+' rad')).join('')}</div>`;
    }else if(s.selection.size){
      html+=head('select',s.selection.size+' objects selected',`${ns.length} joints · ${es.length} frames`)+`<div class="property-section"><h3>MULTI-OBJECT ASSIGNMENTS</h3><button class="inspector-button" data-action="section-assign">${icon('section',14)}Assign frame section</button><button class="inspector-button" data-action="supports">${icon('support',14)}Assign joint restraints</button><button class="inspector-button" data-action="load">${icon('load',14)}Assign loads</button><button class="inspector-button" data-action="releases">${icon('release',14)}Assign end releases</button><button class="inspector-button" data-action="connect">${icon('beam',14)}Connect two selected joints</button><button class="inspector-button" data-action="delete">${icon('trash',14)}Delete selection</button></div>`;
    }else{
      html+=head('cube','Model overview','Linear elastic · 3D frame');
      html+=`<div class="property-section"><h3>STRUCTURE</h3>${this.propertyRow('Stories',Math.max(0,m.stories.length-1))}${this.propertyRow('Frame objects',m.elements.length)}${this.propertyRow('Joints',m.nodes.length)}${this.propertyRow('Restraints',m.nodes.filter(n=>n.support.some(Boolean)).length+' joints')}${this.propertyRow('Diaphragms',m.diaphragms.length+' rigid')}<div class="property-tags"><span class="property-tag">SI STORAGE</span><span class="property-tag">6 DOF / JOINT</span><span class="property-tag">FLOAT64</span></div></div>`;
      html+=`<div class="property-section"><h3>ANALYSIS SUMMARY</h3><div class="metric-grid"><div class="metric-card"><label>MAX. SAMPLED |u|</label><strong>${r?this.disp(r.maxDisplacement,2):'—'}</strong><small>${this.displacementUnit}</small></div><div class="metric-card"><label>FUNDAMENTAL MODE</label><strong>${s.results?.modes[0]?.frequency.toFixed(2)||'—'}</strong><small>Hz</small></div></div>${this.propertyRow('Active case',esc(s.caseId||'None'))}${s.results?this.propertyRow('Active unknowns',s.results.stats.activeDOFs)+this.propertyRow('Assembled K nonzeros',s.results.stats.nonzeros?.toLocaleString()||'0')+this.propertyRow('Solver time',s.results.stats.elapsedMs.toFixed(1)+' ms'):''}<p class="property-description">Values are computed from the current model. Edit any analysis input to invalidate this snapshot.</p></div>`;
      html+=`<div class="property-section"><h3>ANALYSIS SETTINGS</h3>${this.propertyRow('Static solver','Skyline LDLᵀ')}${this.propertyRow('Element mass','Consistent')}${this.propertyRow('Geometric behavior','First order')}${this.propertyInput('Number of modes','modes',m.settings.modes,'settings','type="number" min="1" max="24"')}<div class="property-row"><label>Include modal analysis</label><input type="checkbox" data-property="modal" data-kind="settings" ${m.settings.modal?'checked':''}></div><button class="inspector-button" data-action="view-options">${icon('settings',13)}Analysis & display settings</button></div>`;
    }
    html+='<div class="analysis-note"><b>Frame model, not a slab model.</b><br>Rigid diaphragms provide in-plane compatibility only. No gravity floor stiffness or floor mass is generated automatically.<br><button data-action="help" style="padding:4px 0;font-size:8px;color:#728aaf">Read analysis assumptions →</button></div>';return html;
  }
  renderInspector(){$('#inspector-content').innerHTML=this.inspectorHTML();}
  memberChart(data){const index={axial:0,v2:1,v3:2,torsion:3,m2:4,m3:5}[this.state.display]??4,pts=[];let max=1;for(let i=index+1;i<data.diagram.length;i+=7)max=Math.max(max,Math.abs(data.diagram[i]));for(let i=0;i<data.diagram.length/7;i++)pts.push(`${12+data.diagram[i*7]*188},${37-data.diagram[i*7+index+1]/max*26}`);return `<svg class="mini-chart" viewBox="0 0 212 75" aria-label="Computed ${['P','V2','V3','T','M2','M3'][index]} diagram"><path d="M12 37H200" stroke="#d8e1ee" stroke-width="1"/><polyline points="${pts.join(' ')}" fill="none" stroke="#578fbb" stroke-width="1.4"/><text x="12" y="70" font-family="system-ui" font-size="8" fill="#96a5b9">${['P','V2','V3','T','M2','M3'][index]} · local cut-face resultants</text></svg>`;}
  tableData(){
    const m=this.model,s=this.state,r=this.staticResult,u=this.units,du=this.displacementUnit;const rows=[];let headers=[];
    if(s.table==='modes'){
      headers=['Mode','Frequency (Hz)','Period (s)','UX mass (%)','UY mass (%)','UZ mass (%)','Residual'];
      for(const mode of s.results?.modes||[])rows.push({key:'mode:'+String(mode.number-1),values:[mode.number,mode.frequency.toFixed(5),mode.period.toFixed(5),...mode.participation.map(p=>(p*100).toFixed(3)),mode.residual.toExponential(2)]});return{headers,rows};
    }
    if(!r)return{headers,rows};
    if(s.table==='stories'){
      headers=['Story',`Elevation (${u.length})`,`Max |UX| (${du})`,`Max |UY| (${du})`,`Max |UZ| (${du})`,'Max drift X (%)','Max drift Y (%)'];
      const stories=[...m.stories].sort((a,b)=>a.z-b.z);
      for(let si=stories.length-1;si>=0;si--){const st=stories[si],ids=m.nodes.map((n,i)=>({n,i})).filter(({n})=>Math.abs(n.z-st.z)<1e-6),max=[0,0,0],drift=[0,0];
        for(const {n,i}of ids){for(let k=0;k<3;k++)max[k]=Math.max(max[k],Math.abs(r.u[i*6+k]));if(si>0){const below=m.nodes.findIndex(b=>Math.abs(b.z-stories[si-1].z)<1e-6&&Math.abs(b.x-n.x)<1e-6&&Math.abs(b.y-n.y)<1e-6);if(below>=0)for(let k=0;k<2;k++)drift[k]=Math.max(drift[k],Math.abs(r.u[i*6+k]-r.u[below*6+k])/(st.z-stories[si-1].z));}}
        rows.push({key:'story:'+st.z,values:[st.name,this.fmt(st.z,'length'),...max.map(v=>this.disp(v)),...drift.map(v=>(v*100).toFixed(4))]});}
    }else if(s.table==='joints'){
      headers=['Joint',...DOFS.map((d,k)=>d+' ('+(k<3?du:'rad')+')')];m.nodes.forEach((n,i)=>rows.push({key:'n:'+n.id,values:[n.id,...DOFS.map((_,k)=>k<3?this.disp(r.u[i*6+k]):r.u[i*6+k].toExponential(4))]}));
    }else if(s.table==='reactions'){
      headers=['Joint',...['FX','FY','FZ','MX','MY','MZ'].map((d,k)=>d+' ('+(k<3?u.force:u.moment)+')')];m.nodes.forEach((n,i)=>{if(n.support.some(Boolean))rows.push({key:'n:'+n.id,values:[n.id,...DOFS.map((_,k)=>this.fmt(r.reactions[i*6+k],k<3?'force':'moment'))]});});
    }else if(s.table==='members'){
      headers=['Frame','Section',`Pᵢ (${u.force})`,`V2ᵢ (${u.force})`,`V3ᵢ (${u.force})`,`Tᵢ (${u.moment})`,`M2ᵢ (${u.moment})`,`M3ᵢ (${u.moment})`];for(const e of m.elements){const d=r.members[e.id];rows.push({key:'e:'+e.id,values:[e.id,e.section,...Array.from(d.endForces.slice(0,6),(v,k)=>this.fmt(v,k<3?'force':'moment'))]});}
    }
    return {headers,rows};
  }
  renderTable(){
    if(this.state.table==='diagnostics'){$('#result-table').innerHTML=this.logs.map(l=>`<div class="log-entry ${l.level}"><time>${l.time}</time><span class="log-label">${l.level.toUpperCase()}</span><span>${esc(l.message)}</span></div>`).join('');return;}
    const {headers,rows}=this.tableData();if(!rows.length){$('#result-table').innerHTML=`<div class="table-empty">${icon(this.running?'settings':'chart',24)}<span>${this.running?'Solving the current structural model…':this.state.results?.modalError&&this.state.table==='modes'?esc(this.state.results.modalError):'Run analysis to compute results for this model.'}</span></div>`;return;}
    $('#result-table').innerHTML=`<table class="data-table"><thead><tr>${headers.map(h=>`<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr data-result-row="${esc(row.key)}" class="${this.state.selection.has(row.key)?'selected':''}">${row.values.map((v,i)=>`<td ${i===0?'class="table-accent"':''}>${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  }
  select(key,additive=false){if(!additive)this.state.selection.clear();if(key){if(additive&&this.state.selection.has(key))this.state.selection.delete(key);else this.state.selection.add(key);}this.refresh();}
  setTool(tool){this.state.tool=tool;this.drawStart=null;this.state.drawPreview=null;this.state.snapPoint=null;if(tool!=='select'&&window.innerWidth<590){this.main.kind='plan';this.main.camera.center[2]=this.state.storyZ;this.main.fit();}this.refresh();}
  setDisplay(display){
    if(!['model','loads'].includes(display)&&!this.state.results){this.toast('Run analysis first; results are invalidated by model changes.');$('#display-select').value=this.state.display;return;}
    if(display==='mode'&&!this.state.results?.modes.length){this.toast(this.state.results?.modalError||'No converged modes are available.',true);return;}
    this.state.display=display;this.state.animate=false;if(display==='mode')this.state.table='modes';if(['m2','m3','v2','v3','axial','torsion'].includes(display))this.state.table='members';if(display==='reactions'){this.state.table='reactions';this.state.storyZ=Math.min(...this.model.stories.map(st=>st.z));}this.refresh();
  }
  action(action){
    if(action.startsWith('tool:')){this.setTool(action.slice(5));return;}
    const direct={new:'newModel',materials:'materials',sections:'sections',rectangle:'rectangle',stories:'stories',grids:'grids',cases:'cases',combinations:'combinations',diaphragms:'diaphragms',supports:'supports',releases:'releases',load:'load','load-table':'loadTable',json:'json','view-options':'viewOptions',validate:'validate',help:'help',benchmarks:'benchmarks'};
    if(direct[action]){this.dialogs[direct[action]]();return;}
    switch(action){
      case'open':$('#file-input').click();break;
      case'save':download(safeName(this.model.name)+'.stratum.json',JSON.stringify(this.model,null,2));this.toast('Project exported with canonical SI units.');break;
      case'undo':this.store.undo();break;case'redo':this.store.redo();break;
      case'run':if(this.running)this.cancelAnalysis();else this.runAnalysis();break;case'cancel':this.cancelAnalysis();break;
      case'fit':this.views.forEach(v=>v.fit());break;case'fit-main':this.main.fit();break;case'fit-plan':this.plan.fit();break;
      case'3d':case'elevation':case'plan':this.main.kind=action;this.main.fit();this.refresh();break;
      case'model-view':this.setDisplay('model');break;case'deformed':this.setDisplay('deformed');break;case'forces':this.setDisplay('m2');break;case'modes':this.setDisplay('mode');break;case'reactions':this.setDisplay('reactions');break;case'loads-view':this.setDisplay('loads');break;
      case'animate':if(!['deformed','mode'].includes(this.state.display)){this.toast('Choose a deformed shape or mode before animating.');break;}this.state.animate=!this.state.animate;this.refresh();break;
      case'clear-selection':this.select(null);break;
      case'select-all':this.state.selection=new Set(this.model.elements.map(e=>'e:'+e.id));this.refresh();break;
      case'select-beams':case'select-columns':{const nodes=new Map(this.model.nodes.map(n=>[n.id,n]));this.state.selection=new Set(this.model.elements.filter(e=>(Math.abs(nodes.get(e.i).z-nodes.get(e.j).z)>1e-6)===(action==='select-columns')).map(e=>'e:'+e.id));this.refresh();break;}
      case'select-story':this.state.selection=new Set(this.model.nodes.filter(n=>Math.abs(n.z-this.state.storyZ)<1e-6).map(n=>'n:'+n.id));this.refresh();break;
      case'delete':this.deleteSelection();break;case'split':this.splitFrames();break;case'connect':this.connectSelection();break;case'section-assign':this.assignSection();break;
      case'csv':this.exportCSV();break;case'report':this.exportReport();break;case'inspect':this.dialogs.open('Object properties',this.inspectorHTML(),null,{note:'Property edits apply immediately and are undoable.'});break;
      default:this.toast('Unknown command: '+action,true);
    }
  }
  runAnalysis(){
    if(!this.model.elements.length){this.toast('Add frame elements before analysis.',true);return;}
    this.cancelAnalysis(false);const id=++this.runId,revision=this.store.revision;this.running=true;this.state.results=null;this.state.animate=false;
    this.log(`Analysis started: ${this.model.nodes.length} joints, ${this.model.elements.length} frames, revision ${revision}.`);
    try{
      if(globalThis.STRATUM_WORKER_SOURCE){this.workerBlobURL=URL.createObjectURL(new Blob([globalThis.STRATUM_WORKER_SOURCE],{type:'text/javascript'}));this.worker=new Worker(this.workerBlobURL);}else this.worker=new Worker(new URL('./analysis-worker.js',import.meta.url),{type:'module'});
    }catch(e){this.cancelAnalysis(false);this.log(e.message,'error');this.toast('Worker initialization failed. Serve the application over localhost or HTTPS.',true);this.refresh();return;}
    $('#run-button').innerHTML=icon('stop',19)+'<span>Cancel analysis<small>WORKER IS RUNNING</small></span>';
    this.worker.onmessage=event=>{
      const data=event.data;if(data.id!==id||revision!==this.store.revision)return;
      if(data.type==='progress'){this.status(data.progress.stage);if(!data.progress.iteration)this.log(data.progress.stage);return;}
      this.running=false;this.worker?.terminate();this.worker=null;if(this.workerBlobURL){URL.revokeObjectURL(this.workerBlobURL);this.workerBlobURL=null;}
      $('#run-button').innerHTML=icon('play',20)+'<span>Run analysis<small>LINEAR STATIC + MODAL</small></span>';
      if(data.type==='error'){this.state.results=null;this.state.table='diagnostics';this.log(data.error.message,'error');this.toast(data.error.message,true);this.status('Analysis failed · inspect diagnostics');}
      else{
        this.state.results=data.result;this.state.modeIndex=Math.min(this.state.modeIndex,Math.max(0,data.result.modes.length-1));
        const result=data.result,stats=result.stats;this.log(`Solved ${Object.keys(result.static).length} static cases/combinations and ${result.modes.length} modes in ${stats.elapsedMs.toFixed(1)} ms. ${stats.activeDOFs} active DOFs, ${stats.nonzeros||0} K coefficients, minimum scaled pivot ${stats.minPivot?.toExponential(3)||'n/a'}.`);
        for(const warning of result.warnings)this.log(warning,'warning');
        const maxResidual=Math.max(0,...Object.values(result.static).map(r=>r.residual));this.log(`Maximum static relative residual: ${maxResidual.toExponential(3)}. Results are tied to model revision ${revision}.`);
        this.status(result.modalError?'Static solved · modal analysis needs review':'Analysis complete · equilibrium checked');
      }
      this.refresh();
    };
    this.worker.onerror=event=>{this.log('Worker error: '+event.message,'error');this.toast('Analysis worker failed: '+event.message,true);this.cancelAnalysis(false);this.state.table='diagnostics';this.refresh();};
    this.worker.postMessage({id,model:structuredClone(this.model),options:{modal:this.model.settings.modal,modes:this.model.settings.modes}});this.refresh();
  }
  cancelAnalysis(notify=true){if(this.worker){this.worker.terminate();this.worker=null;this.runId++;if(notify){this.log('Analysis cancelled; no partial results accepted.','warning');this.status('Analysis cancelled');}}if(this.workerBlobURL){URL.revokeObjectURL(this.workerBlobURL);this.workerBlobURL=null;}this.running=false;$('#run-button').innerHTML=icon('play',20)+'<span>Run analysis<small>LINEAR STATIC + MODAL</small></span>';if(notify)this.refresh();}
  assignSection(){const es=this.selectedElements();this.dialogs.open('Assign frame section',`<p>${es.length} frames selected. Existing element orientation and release assignments are preserved.</p><div class="dialog-grid"><label class="full">Frame IDs<input id="assign-targets" value="${esc(es.map(e=>e.id).join(', '))}" placeholder="F1, F2"></label><label class="full">Section<select id="assign-section">${this.model.sections.map(s=>`<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select></label></div>`,()=>{const ids=this.dialogs.val('assign-targets').split(',').map(s=>s.trim()).filter(Boolean);if(!ids.length)throw new Error('Select or enter frame IDs.');this.store.transact('Assign section',m=>{for(const id of ids){const e=m.elements.find(e=>e.id===id);if(!e)throw new Error('Unknown frame '+id);e.section=this.dialogs.val('assign-section');}});});}
  deleteSelection(){
    if(!this.state.selection.size){this.toast('Select joints or frames to delete.');return;}
    const nodeIds=new Set(this.selectedNodes().map(n=>n.id)),frameIds=new Set(this.selectedElements().map(e=>e.id));
    this.store.transact('Delete selection',m=>{
      for(const e of m.elements)if(nodeIds.has(e.i)||nodeIds.has(e.j))frameIds.add(e.id);
      m.nodes=m.nodes.filter(n=>!nodeIds.has(n.id));m.elements=m.elements.filter(e=>!frameIds.has(e.id));m.loads=m.loads.filter(l=>!nodeIds.has(l.node)&&!frameIds.has(l.element));
      for(const d of m.diaphragms)d.nodes=d.nodes.filter(id=>!nodeIds.has(id));m.diaphragms=m.diaphragms.filter(d=>d.nodes.length>=2);
    });
  }
  getOrCreateNode(m,p){let n=m.nodes.find(n=>norm(sub(position(n),p))<1e-7);if(!n){n={id:uniqueId(m,'nodes','J'),x:p[0],y:p[1],z:p[2],support:Array(6).fill(false),mass:0};m.nodes.push(n);}return n;}
  addFrame(m,i,j,section){if(i===j)throw new Error('Choose two distinct endpoints.');if(m.elements.some(e=>(e.i===i&&e.j===j)||(e.i===j&&e.j===i)))throw new Error('A frame already connects those joints.');const e={id:uniqueId(m,'elements','F'),i,j,section,roll:0,releases:Array(12).fill(false)};m.elements.push(e);return e;}
  connectSelection(){const ns=this.selectedNodes();if(ns.length!==2)throw new Error('Select exactly two joints to connect.');let id;this.store.transact('Connect selected joints',m=>id=this.addFrame(m,ns[0].id,ns[1].id,m.sections.find(s=>s.id==='B300')?.id||m.sections[0].id).id);this.select('e:'+id);}
  splitFrames(){
    const ids=this.selectedElements().map(e=>e.id);if(!ids.length)throw new Error('Select at least one frame to split.');const selected=[];
    this.store.transact('Split selected frames',m=>{
      for(const id of ids){const e=m.elements.find(e=>e.id===id),a=m.nodes.find(n=>n.id===e.i),b=m.nodes.find(n=>n.id===e.j),p=position(a).map((v,k)=>(v+position(b)[k])/2),mid=this.getOrCreateNode(m,p);
        const children=[];for(const[i,j,end]of[[e.i,mid.id,0],[mid.id,e.j,1]]){const child=this.addFrame(m,i,j,e.section);child.roll=e.roll;child.releases=Array(12).fill(false);for(let k=0;k<6;k++)child.releases[end*6+k]=e.releases?.[end*6+k]||false;children.push(child);selected.push('e:'+child.id);}
        for(const d of m.diaphragms)if(d.nodes.includes(e.i)&&d.nodes.includes(e.j)&&!d.nodes.includes(mid.id))d.nodes.push(mid.id);
        const loads=m.loads.filter(l=>l.element===id);m.loads=m.loads.filter(l=>l.element!==id);
        for(const load of loads){if(load.type==='udl'){for(const child of children)m.loads.push({...structuredClone(load),id:uniqueId(m,'loads','L'),element:child.id});}
          else if(Math.abs(load.position-.5)<1e-9){const v=load.system==='global'?load.value:localToGlobal(localAxes(position(a),position(b),e.roll).R,load.value);m.loads.push({id:uniqueId(m,'loads','L'),case:load.case,type:'nodal',node:mid.id,value:[...v,0,0,0]});}
          else{const end=load.position<.5?0:1;m.loads.push({...load,id:uniqueId(m,'loads','L'),element:children[end].id,position:end?(load.position-.5)*2:load.position*2});}}
        m.elements=m.elements.filter(x=>x.id!==id);
      }
    });this.state.selection=new Set(selected);this.refresh();
  }
  snap(view,x,y){
    let p=view.worldAt(x,y,this.state.storyZ);if(!p)return null;p[2]=this.state.storyZ;
    if(this.state.snap){let best=null,dist=12;for(const n of this.model.nodes)if(Math.abs(n.z-p[2])<1e-7){const sp=view.project(position(n)),d=Math.hypot(x-sp.x,y-sp.y);if(d<dist){dist=d;best=n;}}if(best)return position(best);
      const threshold=view.camera.span/view.height*12;
      for(const [k,axis]of[[0,'x'],[1,'y']]){const nearest=this.model.grids[axis].reduce((a,b)=>Math.abs(b-p[k])<Math.abs(a-p[k])?b:a,Infinity);p[k]=Math.abs(nearest-p[k])<threshold?nearest:Math.round(p[k]*4)/4;}
    }return p;
  }
  drawClick(view,x,y){
    if(view.kind!=='plan'){this.toast('Use Plan View for drawing; View → Plan switches the main viewport.');return;}
    const p=this.snap(view,x,y);if(!p)return;const tool=this.state.tool;
    if(tool==='joint'){let id;this.store.transact('Add joint',m=>id=this.getOrCreateNode(m,p).id);this.select('n:'+id);}
    else if(tool==='column'){
      const below=[...this.model.stories].filter(s=>s.z<this.state.storyZ-1e-7).sort((a,b)=>b.z-a.z)[0];if(!below)throw new Error('Choose a story above the base for a column.');let id;
      this.store.transact('Draw column',m=>{const i=this.getOrCreateNode(m,[p[0],p[1],below.z]),j=this.getOrCreateNode(m,p);id=this.addFrame(m,i.id,j.id,m.sections.find(s=>s.id==='C500')?.id||m.sections[0].id).id;});this.select('e:'+id);
    }else if(tool==='beam'){
      if(!this.drawStart){this.drawStart=[...p];this.state.drawPreview=[p,p];this.refresh();return;}
      const start=[...this.drawStart];let id;
      this.store.transact('Draw beam',m=>{const i=this.getOrCreateNode(m,start),j=this.getOrCreateNode(m,p);id=this.addFrame(m,i.id,j.id,m.sections.find(s=>s.id==='B300')?.id||m.sections[0].id).id;});this.drawStart=null;this.state.drawPreview=null;this.select('e:'+id);
    }
  }
  bindViewport(view){
    const el=view.overlay;let down=null;const pointers=new Map();let pinch=null;
    const point=e=>{const r=el.getBoundingClientRect();return{x:e.clientX-r.left,y:e.clientY-r.top};};
    el.oncontextmenu=e=>{e.preventDefault();if(down?.moved)return;const p=point(e),hit=view.pick(p.x,p.y);if(hit&&!this.state.selection.has(hit.type+':'+hit.id))this.select(hit.type+':'+hit.id);this.popup([['inspect','Object properties','settings'],['load','Assign loads…','load'],['supports','Assign restraints…','support'],['releases','End releases…','release'],['section-assign','Assign section…','section'],null,['split','Split selected frames','split'],['delete','Delete selection','trash']],e.clientX,e.clientY);};
    el.onpointerdown=e=>{
      el.focus({preventScroll:true});const p=point(e);pointers.set(e.pointerId,p);el.setPointerCapture(e.pointerId);
      if(pointers.size===2){const ps=[...pointers.values()];pinch={distance:Math.hypot(ps[0].x-ps[1].x,ps[0].y-ps[1].y),x:(ps[0].x+ps[1].x)/2,y:(ps[0].y+ps[1].y)/2};if(down)down.gesture=true;return;}
      const hit=view.pick(p.x,p.y,this.state.tool==='move');down={x:p.x,y:p.y,lastX:p.x,lastY:p.y,hit,button:e.button,shift:e.shiftKey,moved:false,gesture:false};
      if(this.state.tool==='move'&&hit?.type==='n'&&view.kind==='plan')down.moveNode=hit.id;
    };
    el.onpointermove=e=>{
      const p=point(e);if(pointers.has(e.pointerId))pointers.set(e.pointerId,p);
      if(pointers.size===2&&pinch){const ps=[...pointers.values()],d=Math.hypot(ps[0].x-ps[1].x,ps[0].y-ps[1].y),x=(ps[0].x+ps[1].x)/2,y=(ps[0].y+ps[1].y)/2;view.zoom(Math.log(pinch.distance/Math.max(d,1))*1000,x,y);view.pan(x-pinch.x,y-pinch.y);pinch={distance:d,x,y};return;}
      if(view.kind==='plan'){
        const wp=this.snap(view,p.x,p.y);if(wp){$('#coordinates').textContent=`X ${this.fmt(wp[0],'length')}  Y ${this.fmt(wp[1],'length')}`;if(this.state.tool!=='select')this.state.snapPoint=wp;if(this.drawStart)this.state.drawPreview=[this.drawStart,wp];}
        if(this.drawStart||this.state.tool!=='select')for(const v of this.views)v.invalidate(true);
      }
      if(!down)return;const dx=p.x-down.lastX,dy=p.y-down.lastY;if(Math.hypot(p.x-down.x,p.y-down.y)>4)down.moved=true;
      if(down.moved){
        if(down.moveNode){this.state.snapPoint=this.snap(view,p.x,p.y);view.invalidate();}
        else if(down.shift&&down.button===0&&this.state.tool==='select'){this.state.boxSelection={viewport:view,x:Math.min(down.x,p.x),y:Math.min(down.y,p.y),w:Math.abs(p.x-down.x),h:Math.abs(p.y-down.y)};view.invalidate();}
        else if(down.button===1||down.button===2||view.kind!=='3d')view.pan(dx,dy);
        else if(this.state.tool==='select')view.orbit(dx,dy);
      }
      down.lastX=p.x;down.lastY=p.y;
    };
    const up=e=>{
      const p=point(e),gesture=pointers.size>1||down?.gesture;pointers.delete(e.pointerId);if(pointers.size<2)pinch=null;if(!down)return;const d=down;down=null;
      if(gesture){this.state.boxSelection=null;return;}
      this.guard(()=>{
        if(d.moveNode&&d.moved){const point=this.snap(view,p.x,p.y);this.store.transact('Move joint',m=>{const n=m.nodes.find(n=>n.id===d.moveNode);[n.x,n.y,n.z]=point;});this.select('n:'+d.moveNode);}
        else if(this.state.boxSelection){const b=this.state.boxSelection;for(const o of view.objects){const a=o.screenA,c=o.screenB;if(a.x>=b.x&&a.x<=b.x+b.w&&a.y>=b.y&&a.y<=b.y+b.h&&c.x>=b.x&&c.x<=b.x+b.w&&c.y>=b.y&&c.y<=b.y+b.h)this.state.selection.add(o.type+':'+o.id);}this.state.boxSelection=null;this.refresh();}
        else if(!d.moved&&d.button===0){if(['beam','column','joint'].includes(this.state.tool))this.drawClick(view,p.x,p.y);else this.select(d.hit?d.hit.type+':'+d.hit.id:null,e.shiftKey||e.ctrlKey||e.metaKey);}
      });
    };
    el.onpointerup=up;el.onpointercancel=e=>{pointers.delete(e.pointerId);down=null;pinch=null;this.state.boxSelection=null;view.invalidate();};
    el.addEventListener('wheel',e=>{e.preventDefault();const p=point(e);view.zoom(e.deltaY,p.x,p.y);},{passive:false});
    el.ondblclick=e=>{const p=point(e),hit=view.pick(p.x,p.y);if(hit){this.select(hit.type+':'+hit.id);this.action('inspect');}};
    el.onpointerleave=()=>{if(!down){this.state.snapPoint=null;view.invalidate();}};
  }
  popup(items,x,y){const popup=$('#popup-menu');popup.innerHTML=items.map(item=>item?`<button data-action="${esc(item[0])}">${icon(item[2]||'cube',15)}${esc(item[1])}${item[3]?`<small>${esc(item[3])}</small>`:''}</button>`:'<hr>').join('');popup.classList.remove('hidden');popup.style.left=Math.min(x,window.innerWidth-240)+'px';popup.style.top=Math.min(y,window.innerHeight-popup.offsetHeight-12)+'px';}
  installEvents(){
    hydrateIcons();$('#menus').innerHTML=Object.keys(menus).map(name=>`<button data-menu="${name}">${name}</button>`).join('');
    document.addEventListener('click',e=>{
      const menu=e.target.closest('[data-menu]');if(menu){const r=menu.getBoundingClientRect();this.popup(menus[menu.dataset.menu],r.left,r.bottom);return;}
      const action=e.target.closest('[data-action]');if(action){$('#popup-menu').classList.add('hidden');this.guard(()=>this.action(action.dataset.action));return;}
      if(!e.target.closest('#popup-menu'))$('#popup-menu').classList.add('hidden');
      const tool=e.target.closest('[data-tool]');if(tool){this.setTool(tool.dataset.tool);return;}
      const toggle=e.target.closest('[data-toggle]');if(toggle){const key=toggle.dataset.toggle;this.state[key]=!this.state[key];this.refresh();return;}
      const story=e.target.closest('[data-story]');if(story){this.state.storyZ=Number(story.dataset.story);this.refresh();return;}
      const obj=e.target.closest('[data-object]');if(obj){this.select(obj.dataset.object,e.shiftKey);return;}
      const cases=e.target.closest('[data-case],[data-resultcase]');if(cases){this.state.caseId=cases.dataset.case||cases.dataset.resultcase;this.setDisplay(cases.dataset.resultcase?'deformed':'loads');return;}
      const mode=e.target.closest('[data-mode]');if(mode){this.state.modeIndex=Number(mode.dataset.mode);this.setDisplay('mode');return;}
      const table=e.target.closest('[data-table]');if(table){this.state.table=table.dataset.table;this.refresh();return;}
      const explorer=e.target.closest('[data-explorer]');if(explorer){this.state.explorer=explorer.dataset.explorer;this.refresh();return;}
      const row=e.target.closest('[data-result-row]');if(row){const key=row.dataset.resultRow;if(key.startsWith('story:')){this.state.storyZ=Number(key.slice(6));this.refresh();}else if(key.startsWith('mode:')){this.state.modeIndex=Number(key.slice(5));this.setDisplay('mode');}else this.select(key,e.shiftKey);}
    });
    document.addEventListener('change',e=>{
      const el=e.target;
      if(el.dataset.property)this.guard(()=>{
        const key=el.dataset.property,kind=el.dataset.kind;
        this.store.transact('Edit '+key,m=>{
          if(kind==='settings'){m.settings[key]=key==='modal'?el.checked:Number(el.value);return;}
          if(kind==='element'){for(const selected of this.selectedElements()){const target=m.elements.find(x=>x.id===selected.id);target[key]=key==='roll'?quantity(el.value,'angle','deg'):el.value;}return;}
          for(const selected of this.selectedNodes()){const n=m.nodes.find(n=>n.id===selected.id);if(key.startsWith('support:'))n.support[Number(key.split(':')[1])]=el.checked;else n[key]=quantity(el.value,key==='mass'?'mass':'length',key==='mass'?this.units.mass:this.units.length);}
        });
      });
    });
    $('#display-select').onchange=e=>this.setDisplay(e.target.value);
    $('#case-select').onchange=e=>{this.state.caseId=e.target.value;this.refresh();};
    for(const selector of ['#story-select','#main-story-select'])$(selector).onchange=e=>{this.state.storyZ=Number(e.target.value);this.drawStart=null;this.state.drawPreview=null;this.refresh();};
    $('#mode-select').onchange=e=>{this.state.modeIndex=Number(e.target.value);this.refresh();};
    $('#unit-select').onchange=e=>{this.state.units=e.target.value;this.refresh();};
    $('#tree-search').oninput=()=>this.renderTree();
    $('#file-input').onchange=async e=>{const file=e.target.files[0];if(!file)return;try{const model=parseProject(await file.text());this.store.replace(model,'Open project');this.refresh(true);this.toast('Project loaded. Run analysis to regenerate its results.');}catch(error){this.toast(error.message,true);}e.target.value='';};
    document.addEventListener('keydown',e=>{
      if(this.dialogs.root.open)return;const edit=['INPUT','SELECT','TEXTAREA'].includes(e.target.tagName);if(edit)return;
      const ctrl=e.ctrlKey||e.metaKey,key=e.key.toLowerCase();let action=null;
      if(ctrl)action=({s:'save',o:'open',n:'new',z:e.shiftKey?'redo':'undo',y:'redo',a:'select-all'})[key];
      else if(key==='f5')action='run';else if(key==='f')action='fit';else if(key==='delete'||key==='backspace')action='delete';else if(key==='escape'){this.setTool('select');this.select(null);$('#popup-menu').classList.add('hidden');e.preventDefault();return;}
      else if(['b','c','j','m','v'].includes(key)){this.setTool({b:'beam',c:'column',j:'joint',m:'move',v:'select'}[key]);e.preventDefault();return;}
      else if(key===' '){action='animate';}else if(key==='/'){$('#tree-search').focus();e.preventDefault();return;}
      if(action){e.preventDefault();this.guard(()=>this.action(action));}
    });
    for(const view of this.views)this.bindViewport(view);
    const splitter=$('#viewport-splitter');splitter.onpointerdown=e=>{splitter.setPointerCapture(e.pointerId);const wrap=$('#viewports').getBoundingClientRect();splitter.onpointermove=ev=>{const t=Math.max(.2,Math.min(.8,(ev.clientX-wrap.left)/wrap.width));$('.main-viewport').style.flex=t;$('.plan-viewport').style.flex=1-t;};splitter.onpointerup=()=>splitter.onpointermove=null;};
    const resize=$('#results-splitter');resize.onpointerdown=e=>{resize.setPointerCapture(e.pointerId);const rect=$('.main-workspace').getBoundingClientRect();resize.onpointermove=ev=>document.documentElement.style.setProperty('--results',Math.max(90,Math.min(rect.height*.6,rect.bottom-ev.clientY))+'px');resize.onpointerup=()=>resize.onpointermove=null;};
    window.addEventListener('beforeunload',()=>{try{localStorage.setItem('stratum-frame-project-v1',this.store.snapshot());}catch{}});
  }
  exportCSV(){
    if(this.state.table==='diagnostics'){download('stratum-analysis-log.csv','Time,Level,Message\r\n'+this.logs.map(l=>[l.time,l.level,l.message].map(csvCell).join(',')).join('\r\n'),'text/csv');return;}
    const {headers,rows}=this.tableData();if(!rows.length){this.toast('There are no computed table rows to export.');return;}
    download(`${safeName(this.model.name)}-${this.state.caseId}-${this.state.table}.csv`,[headers,...rows.map(r=>r.values)].map(r=>r.map(csvCell).join(',')).join('\r\n'),'text/csv');
  }
  exportReport(){
    if(!this.state.results){this.toast('Run analysis before exporting a report.');return;}
    const original=this.state.table,tables=[];
    for(const key of['stories','joints','reactions','members','modes']){this.state.table=key;const t=this.tableData();tables.push(`<h2>${{stories:'Story response',joints:'Joint displacements',reactions:'Support reactions',members:'Frame end-I resisting forces',modes:'Modal results'}[key]}</h2><table><thead><tr>${t.headers.map(h=>`<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${t.rows.map(r=>`<tr>${r.values.map(v=>`<td>${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);}this.state.table=original;
    const r=this.state.results,html=`<!doctype html><html lang="en"><meta charset="utf-8"><title>${esc(this.model.name)} — Analysis report</title><style>body{font:12px/1.6 system-ui,sans-serif;margin:40px;color:#34435a}h1{font-size:26px}h2{font-size:17px;margin-top:28px}table{border-collapse:collapse;width:100%;font-size:10px}th,td{padding:6px 8px;text-align:right;border-bottom:1px solid #dde3ed}th:first-child,td:first-child{text-align:left}th{background:#eef2f8}aside{padding:16px;background:#fff7e8;border:1px solid #e7dbbd;font-size:11px}small{color:#8293a8}@media print{body{margin:10mm}thead{display:table-header-group}tr{break-inside:avoid}}</style><h1>Stratum Frame / ${esc(this.model.name)}</h1><p>Computed ${esc(r.completedAt)} · Case/combination: <b>${esc(this.state.caseId)}</b> · Display units: ${esc(this.units.name)} · Model revision ${this.store.revision}</p><aside><b>RESEARCH RESULTS — NOT FOR DESIGN APPROVAL.</b> Linear, small-displacement, prismatic 3D Euler–Bernoulli frames with exact support/diaphragm constraints, independent release DOFs and consistent mass. No slabs, shells, shear deformation, P–Δ, buckling, nonlinear behavior, dynamic seismic loading, design code checks or automatic joint-mass gravity load. Modal values are undamped free-vibration eigenpairs. Example load combinations are illustrative. Verify independently before engineering use.</aside><h2>Solver diagnostics</h2><p>${r.stats.activeDOFs} active DOFs · ${r.stats.nonzeros||0} stiffness coefficients · ${r.stats.elapsedMs.toFixed(2)} ms · min. scaled pivot ${r.stats.minPivot?.toExponential(4)||'n/a'}</p><p>${r.warnings.map(esc).join('<br>')||'No solver warnings for this run.'}</p>${tables.join('')}<h2>Global equilibrium</h2><p>Applied + support resultant [FX,FY,FZ,MX,MY,MZ], in SI N/Nm: ${this.staticResult.equilibrium.map(v=>v.toExponential(4)).join(', ')}.</p><p>Frame tables give end-I element resisting forces; cut-face diagram signs differ at end I. Drift is calculated only between joints aligned in X/Y on adjacent reference stories. No drift adequacy check is performed. Sampled maxima may miss between-sample extrema.</p><h2>Model definition (canonical SI)</h2><details><summary>Reproducibility snapshot</summary><pre>${esc(JSON.stringify(this.model,null,2))}</pre></details><small>Independent implementation. Not affiliated with Computers and Structures, Inc. See the bundled analysis assumptions and benchmark report.</small></html>`;
    download(safeName(this.model.name)+'-analysis-report.html',html,'text/html');
  }
  tick(time){
    this.state.time=time/1000;if(this.state.animate)for(const view of this.views)view.invalidate(true);
    for(const view of this.views)if(view.canvas.parentElement.clientWidth>0)view.render();requestAnimationFrame(this.tick);
  }
}
function csvCell(value){let s=String(value??'');if(/^[=+@]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';}
const app=new Workbench();globalThis.stratum=app;app.init().catch(e=>{console.error(e);app.toast(e.message,true);});
