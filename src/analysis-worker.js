import {analyze} from './core/analysis.js';
self.onmessage=event=>{
  const {id,model,options}=event.data;
  try {
    const result=analyze(model,options,progress=>self.postMessage({type:'progress',id,progress}));
    const buffers=new Set();
    function collect(v){if(ArrayBuffer.isView(v))buffers.add(v.buffer);else if(v&&typeof v==='object')for(const value of Object.values(v))collect(value);}
    collect(result);self.postMessage({type:'result',id,result},[...buffers]);
  }catch(error){self.postMessage({type:'error',id,error:{message:error.message,details:error.details,stack:error.stack}});}
};
