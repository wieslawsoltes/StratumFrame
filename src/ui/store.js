import {validateModel,parseProject} from '../core/model.js';
function storageOrNull(){try{return globalThis.localStorage;}catch{return null;}}
export class ProjectStore extends EventTarget {
  constructor(model,{storage=storageOrNull(),maxHistory=60,maxHistoryBytes=24_000_000}={}) {
    super();validateModel(model);this.model=structuredClone(model);this.storage=storage;this.revision=0;this.past=[];this.future=[];this.maxHistory=maxHistory;this.maxHistoryBytes=maxHistoryBytes;this.saved=!!storage;
  }
  snapshot(){return JSON.stringify(this.model);}
  transact(label,edit){
    const before=this.snapshot(),next=structuredClone(this.model);edit(next);validateModel(next);
    const after=JSON.stringify(next);if(before===after)return false;
    this.past.push({label,json:before});this.future.length=0;this.trimHistory();this.model=next;this.changed(label);return true;
  }
  trimHistory(){let bytes=this.past.reduce((s,x)=>s+x.json.length*2,0);while(this.past.length>this.maxHistory||bytes>this.maxHistoryBytes){const removed=this.past.shift();bytes-=removed.json.length*2;}}
  replace(model,label='Open project'){validateModel(model);this.past.push({label,json:this.snapshot()});this.trimHistory();this.future=[];this.model=structuredClone(model);this.changed(label);}
  undo(){if(!this.past.length)return false;const previous=this.past.pop();this.future.push({label:previous.label,json:this.snapshot()});this.model=JSON.parse(previous.json);this.changed('Undo · '+previous.label);return true;}
  redo(){if(!this.future.length)return false;const next=this.future.pop();this.past.push({label:next.label,json:this.snapshot()});this.model=JSON.parse(next.json);this.changed('Redo · '+next.label);return true;}
  changed(label){this.revision++;this.saved=false;let persistenceError=null;try{if(this.storage){this.storage.setItem('stratum-frame-project-v1',this.snapshot());this.saved=true;}else{persistenceError='Browser storage is unavailable. Export the project to retain edits.';}}catch(e){persistenceError=e.message;}this.dispatchEvent(new CustomEvent('change',{detail:{label,revision:this.revision,persistenceError}}));}
  static restore(storage=storageOrNull()){try{const json=storage?.getItem('stratum-frame-project-v1');return json?parseProject(json):null;}catch{return null;}}
}
