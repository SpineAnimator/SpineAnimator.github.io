(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const API = {
    studio: 'https://spine-studio.spine-animator-f8692224.workers.dev',
    planner: 'https://spine-plan-api.spine-animator-f8692224.workers.dev',
    exporter: 'https://spine-generator.spine-animator-f8692224.workers.dev'
  };
  const state = { file:null, kind:null, psd:null, layers:[], selected:new Set(), composite:null, prepared:false, busy:false, timer:null, objectUrl:null };
  const messages = [
    ['PSD PREPARE','Reading the document structure and source canvas.'],
    ['LAYER SCAN','Inspecting visibility, groups and layer bounds.'],
    ['PIXEL CHECK','Checking transparency and attachment boundaries.'],
    ['SOURCE MAP','Mapping layer names and draw order for Spine.'],
    ['AI HANDOFF','Preparing a private request for the animation agents.']
  ];
  function status(id,text,kind=''){const el=$(id);el.textContent=text;el.className='status'+(kind?' '+kind:'');}
  function setBusy(on,kind='PSD'){
    state.busy=on;
    $('processingOverlay').classList.toggle('show',on);
    $('leftProgress').classList.toggle('show',on);
    $('prepare').disabled=on||!state.file;
    $('animate').disabled=on||!state.prepared;
    $('processingTitle').textContent=kind==='PNG'?'AI CONTOUR PREPARE':'PSD PREPARE';
    if(state.timer)clearInterval(state.timer);
    if(on){let i=0;const paint=()=>{$('processingTitle').textContent=messages[i%messages.length][0];$('processingSub').textContent=messages[i%messages.length][1];i++;};paint();state.timer=setInterval(paint,1250);}
  }
  function bytesLabel(n){if(n<1024)return n+' B';if(n<1048576)return (n/1024).toFixed(1)+' KB';return (n/1048576).toFixed(2)+' MB';}
  function canvasOf(value){
    if(!value)return null;
    if(value instanceof HTMLCanvasElement)return value;
    const image=value.imageData||value;
    if(image instanceof ImageData){const c=document.createElement('canvas');c.width=image.width;c.height=image.height;c.getContext('2d').putImageData(image,0,0);return c;}
    if(image.data&&Number.isFinite(image.width)&&Number.isFinite(image.height)){
      const c=document.createElement('canvas');c.width=image.width;c.height=image.height;
      c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(image.data),image.width,image.height),0,0);return c;
    }
    if(image.canvas instanceof HTMLCanvasElement)return image.canvas;
    return null;
  }
  function canvasFromImage(file){return new Promise((resolve,reject)=>{const url=URL.createObjectURL(file),img=new Image();img.onload=()=>{URL.revokeObjectURL(url);const c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;c.getContext('2d').drawImage(img,0,0);resolve(c);};img.onerror=()=>{URL.revokeObjectURL(url);reject(Error('Could not decode PNG image'));};img.src=url;});}
  function alphaBounds(canvas){
    const {width:w,height:h}=canvas,ctx=canvas.getContext('2d',{willReadFrequently:true}),d=ctx.getImageData(0,0,w,h).data;
    let x0=w,y0=h,x1=-1,y1=-1;
    for(let y=0;y<h;y++)for(let x=0;x<w;x++)if(d[(y*w+x)*4+3]>0){if(x<x0)x0=x;if(y<y0)y0=y;if(x>x1)x1=x;if(y>y1)y1=y;}
    if(x1<0)return{x:0,y:0,width:w,height:h};
    return{x:x0,y:y0,width:x1-x0+1,height:y1-y0+1};
  }
  function makeAttachment(source,scale,padding,trim){
    const bounds=trim?alphaBounds(source):{x:0,y:0,width:source.width,height:source.height};
    const pad=Math.max(0,Math.round(padding*scale)),w=Math.max(1,Math.round(bounds.width*scale)+pad*2),h=Math.max(1,Math.round(bounds.height*scale)+pad*2);
    if(w*h>25000000)throw Error('A layer exceeds the 25-megapixel attachment limit.');
    const out=document.createElement('canvas');out.width=w;out.height=h;
    out.getContext('2d').drawImage(source,bounds.x,bounds.y,bounds.width,bounds.height,pad,pad,Math.round(bounds.width*scale),Math.round(bounds.height*scale));
    return{canvas:out,offset:{x:bounds.x,y:bounds.y},bounds:{width:w,height:h}};
  }
  function parsePsd(buffer){
    const sig=new Uint8Array(buffer,0,Math.min(4,buffer.byteLength));
    if(sig.length!==4||String.fromCharCode(...sig)!=='8BPS')throw Error('Invalid PSD / PSB header.');
    const parser=window.agPsd||window['ag-psd'];if(!parser?.readPsd)throw Error('PSD parser failed to load.');
    const psd=parser.readPsd(buffer,{useImageData:true,skipThumbnail:true});
    if(!Number.isInteger(psd.width)||!Number.isInteger(psd.height)||psd.width<1||psd.height<1||psd.width*psd.height>25000000)throw Error('Unsupported PSD canvas dimensions.');
    const candidates=[psd.imageData,psd.canvas,psd].map(canvasOf).filter(Boolean);
    const composite=candidates.find(c=>c.width===psd.width&&c.height===psd.height);
    if(!composite)throw Error('PSD composite is missing or does not match the original canvas.');
    const rows=[],flat=[],names=new Set(),unsupported=[];
    const ignoreHidden=$('ignoreHidden').checked,ignoreBg=$('ignoreBackground').checked;
    const scale=Number($('scale').value)/100,padding=Number($('padding').value),trim=$('trimWhitespace').checked;
    function walk(group,depth=0,parentVisible=true){
      const children=(group.children||[]).slice().reverse();
      for(const layer of children){
        const visible=parentVisible&&layer.hidden!==true;
        if(ignoreHidden&&!visible)continue;
        if(ignoreBg&&((layer.name||'').toLowerCase()==='background'||layer.isBackground))continue;
        if(layer.name&&/\[ignore\]/i.test(layer.name))continue;
        const tagMatch=(layer.name||'').match(/\[(bone|slot|skin|mesh|linkedmesh|clip|overlay|merge|draworder|event)\]/i);
        if(tagMatch)unsupported.push((layer.name||'Unnamed')+': PhotoshopToSpine tag ['+tagMatch[1]+'] is not yet mapped by the web exporter');
        if(layer.children?.length){
          rows.push({type:'group',name:layer.name||'Group',depth,visible});
          walk(layer,depth+1,visible);continue;
        }
        if(layer.adjustment)continue;
        if(layer.clipping||layer.blendMode&& !['normal','pass through'].includes(layer.blendMode)){
          unsupported.push((layer.name||'Unnamed')+': '+(layer.clipping?'clipping layer':'blend mode '+layer.blendMode));continue;
        }
        const original=canvasOf(layer.imageData||layer.canvas||layer);
        if(!original)continue;
        let id=String(layer.name||'layer').replace(/[^\w.-]/g,'_').slice(0,70)||'layer';
        const base=id;let n=1;while(names.has(id))id=base+'_'+n++;names.add(id);
        const attachment=makeAttachment(original,scale,padding,trim);
        const x=Number(layer.left||0)+attachment.offset.x,y=Number(layer.top||0)+attachment.offset.y;
        const item={id,name:layer.name||id,depth,canvas:attachment.canvas,selected:true,
          bounds:{x:Math.round(x*scale-padding*scale),y:Math.round(y*scale-padding*scale),width:attachment.bounds.width,height:attachment.bounds.height}};
        flat.push(item);rows.push({type:'layer',item,depth});
      }
    }
    walk(psd);
    if(!flat.length)throw Error('No supported visible raster layers found.');
    if(flat.length>250)throw Error('This web pipeline currently accepts up to 250 raster layers.');
    const outWidth=Math.round(psd.width*scale),outHeight=Math.round(psd.height*scale);
    const rendered=document.createElement('canvas');rendered.width=outWidth;rendered.height=outHeight;
    const renderContext=rendered.getContext('2d');
    for(const layer of flat.slice().reverse())renderContext.drawImage(layer.canvas,layer.bounds.x,layer.bounds.y);
    return{width:outWidth,height:outHeight,originalWidth:psd.width,originalHeight:psd.height,composite:rendered,layers:flat,rows,unsupported};
  }
  function drawPreview(canvas){
    const target=$('previewCanvas'),area=$('previewArea');
    target.width=canvas.width;target.height=canvas.height;
    target.getContext('2d').clearRect(0,0,target.width,target.height);
    target.getContext('2d').drawImage(canvas,0,0);
    target.hidden=false;$('previewEmpty').hidden=true;
    $('previewDimensions').textContent=canvas.width+' × '+canvas.height+' px';
  }
  function renderLayers(rows){
    const root=$('layerList');root.replaceChildren();
    for(const row of rows){
      if(row.type==='group'){
        const el=document.createElement('div');el.className='layer-item layer-group';el.style.paddingLeft=(8+row.depth*14)+'px';
        const icon=document.createElement('span');icon.className='layer-icon';icon.textContent='▾';
        const name=document.createElement('span');name.className='layer-name';name.textContent=row.name;
        el.append(icon,name);root.append(el);continue;
      }
      const item=row.item,el=document.createElement('label');el.className='layer-item';el.style.paddingLeft=(7+row.depth*14)+'px';
      const cb=document.createElement('input');cb.type='checkbox';cb.checked=item.selected;cb.dataset.layerId=item.id;
      cb.addEventListener('change',()=>{item.selected=cb.checked;state.selected=new Set(state.layers.filter(x=>x.selected).map(x=>x.id));$('animate').disabled=!state.prepared||($('selectionOnly').checked&&state.selected.size===0);});
      const icon=document.createElement('span');icon.className='layer-icon';icon.textContent='▧';
      const name=document.createElement('span');name.className='layer-name';name.textContent=item.name;
      const dims=document.createElement('span');dims.className='layer-dims';dims.textContent=item.bounds.width+'×'+item.bounds.height;
      el.append(cb,icon,name,dims);root.append(el);
    }
    $('layerCount').textContent=state.layers.length+' raster layers';
  }
  function selectFile(file){
    if(!file)return;
    const ext=file.name.split('.').pop().toLowerCase();
    if(!['psd','psb','png'].includes(ext)){status('leftStatus','Choose a PSD, PSB or PNG file.','error');return;}
    if(file.size>180*1024*1024){status('leftStatus','File exceeds the 180 MB browser intake limit.','error');return;}
    state.file=file;state.kind=ext;state.psd=null;state.layers=[];state.selected.clear();state.prepared=false;
    $('workspace').classList.add('has-file');$('fileInfo').classList.add('show');
    $('fileName').textContent=file.name;$('fileType').textContent=ext.toUpperCase();$('fileMeta').textContent=bytesLabel(file.size);
    $('previewName').textContent=file.name;$('previewState').textContent='LOADED';
    $('prepare').disabled=false;$('reset').disabled=false;$('animate').disabled=true;
    $('layerList').innerHTML='<div class="preview-empty">Preparing layer structure…</div>';
    $('layerWarning').classList.remove('show');status('leftStatus','Source selected. Click Prepare source.');status('agentStatus','Waiting for source preparation.');
    $('previewEmpty').hidden=false;$('previewCanvas').hidden=true;
    // Opening a source immediately expands the workspace and starts its preparation.
    prepare();
  }
  async function prepare(){
    if(!state.file||state.busy)return;
    setBusy(true,state.kind==='png'?'PNG':'PSD');
    try{
      if(state.kind==='png'){
        const image=await canvasFromImage(state.file);drawPreview(image);
        $('previewState').textContent='AI CONTOUR ANALYSIS';
        const data=image.toDataURL('image/png');
        const response=await fetch(API.studio+'/api/vision',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({image:data,width:image.width,height:image.height,layers:[],instructions:'Analyse the visible character or subject and identify separate animation parts and articulated chains. Do not invent hidden anatomy. Return conservative visual analysis.'})});
        const payload=await response.json().catch(()=>({}));
        if(!response.ok)throw Error(payload?.error?.message||payload?.error||('AI contour analysis HTTP '+response.status));
        const parts=payload.parts||payload.analysis?.parts||[];
        $('layerList').replaceChildren();
        if(parts.length){for(const part of parts){const el=document.createElement('div');el.className='layer-item';const icon=document.createElement('span');icon.className='layer-icon';icon.textContent='◇';const name=document.createElement('span');name.className='layer-name';name.textContent=part.kind||part.id||'Detected part';const count=document.createElement('span');count.className='layer-dims';count.textContent=(part.chains||[]).length+' chains';el.append(icon,name,count);$('layerList').append(el);}}
        else $('layerList').innerHTML='<div class="preview-empty">AI returned no reliable part map. No masks were fabricated.</div>';
        $('layerCount').textContent=parts.length+' AI part candidates';
        $('layerWarning').textContent='PNG contour analysis is connected to the animation agent, but the mask-to-transparent-layer renderer and layered PSD writer are not yet available in the connected server API. No fake layered PSD was created. The original PNG remains unchanged.';
        $('layerWarning').classList.add('show');
        state.prepared=false;$('animate').disabled=true;
        status('leftStatus','AI analysis completed. Layered PSD creation is blocked until the contour renderer is connected.','error');
        status('agentStatus','AI vision endpoint responded. Awaiting contour-mask renderer and PSD writer.','error');
        $('previewState').textContent='ANALYSIS ONLY';
      }else{
        const buffer=await state.file.arrayBuffer();const parsed=parsePsd(buffer);
        state.psd=parsed;state.layers=parsed.layers;state.selected=new Set(parsed.layers.map(x=>x.id));
        drawPreview(parsed.composite);renderLayers(parsed.rows);
        if(parsed.unsupported.length){$('layerWarning').textContent='Unsupported Photoshop operations were detected. They are not silently discarded: '+parsed.unsupported.slice(0,8).join(' · ');$('layerWarning').classList.add('show');}
        state.prepared=parsed.unsupported.length===0;$('animate').disabled=!state.prepared;
        $('previewState').textContent=state.prepared?'PSD PARSED':'PSD NEEDS REVIEW';
        if(state.prepared){
          status('leftStatus','PSD layer tree parsed. '+parsed.layers.length+' raster layers are available.','success');
          status('agentStatus','Source ready. Describe the motion and send the selected source layers to the animation agents.');
        }else{
          status('leftStatus','PSD parsed, but unsupported Photoshop operations must be resolved before export.','error');
          status('agentStatus','AI export is locked until unsupported Photoshop operations are mapped.','error');
        }
      }
    }catch(error){status('leftStatus',error.message||String(error),'error');$('previewState').textContent='PREPARE FAILED';}
    finally{setBusy(false);$('animate').disabled=!state.prepared||($('selectionOnly').checked&&state.selected.size===0);}
  }
  async function requestPlan(body){
    const id=crypto.randomUUID();
    const start=await fetch(API.planner+'/api/plan-async',{method:'POST',headers:{'content-type':'application/json','x-request-id':id},body});
    const startData=await start.json().catch(()=>({}));
    if(!start.ok||!startData.jobId)throw Error(startData?.error?.message||startData?.error||('AI planner HTTP '+start.status));
    const deadline=Date.now()+20*60*1000;
    while(Date.now()<deadline){
      await new Promise(r=>setTimeout(r,2500));
      const res=await fetch(API.planner+'/api/plan-status?id='+encodeURIComponent(startData.jobId));
      const data=await res.json().catch(()=>({}));
      if(!res.ok)throw Error(data?.error?.message||'AI planner status unavailable');
      if(data.status==='complete'&&data.plan)return data.plan;
      if(data.status==='failed'||data.error)throw Error(data.error?.message||'AI animation planning failed');
      status('agentStatus','AI animation agent: '+(data.status||'working')+' · '+Math.floor((Date.now()- (deadline-20*60*1000))/1000)+'s');
    }
    throw Error('AI animation planning timed out after 20 minutes.');
  }
  async function animate(){
    if(!state.prepared||state.busy)return;
    const description=$('motion').value.trim();if(!description){status('agentStatus','Describe the motion before starting the animation agent.','error');return;}
    const selected=$('selectionOnly').checked?state.layers.filter(x=>x.selected):state.layers;
    if(!selected.length){status('agentStatus','Select at least one source layer.','error');return;}
    if(!$('writeJson').checked||$('writeTemplate').checked){status('agentStatus','The connected server exporter currently requires Spine JSON and does not yet support template-data export. Keep Spine JSON enabled and Template data disabled.','error');return;}
    if(state.psd.unsupported.length){status('agentStatus','Resolve unsupported Photoshop operations before export. This source is fail-closed.','error');return;}
    state.busy=true;$('animate').disabled=true;$('previewState').textContent='AI + SPINE EXPORT';
    $('processingTitle').textContent='AI ANIMATION';$('processingSub').textContent='Sending source artwork to the animation agent network.';$('processingOverlay').classList.add('show');
    try{
      const sceneCanvas=document.createElement('canvas');sceneCanvas.width=state.psd.width;sceneCanvas.height=state.psd.height;
      const sceneContext=sceneCanvas.getContext('2d');
      for(const layer of selected.slice().reverse())sceneContext.drawImage(layer.canvas,layer.bounds.x,layer.bounds.y);
      const composite=sceneCanvas.toDataURL('image/png');
      const layers=selected.map(x=>({id:x.id,image:x.canvas.toDataURL('image/png'),bounds:x.bounds}));
      const body=JSON.stringify({image:composite,canvas:{width:state.psd.width,height:state.psd.height},layers,description,
        instructions:'Preserve original draw order and every source pixel. Keep frame-zero setup pose identical. Create genuinely animated Spine scene clips with different numeric poses at distinct timestamps. Do not emit static fallback motion, empty clips, duplicate keys, or invented source layers. Preserve all supplied source layer IDs and bounds.'});
      if(body.length>19*1024*1024)throw Error('AI request exceeds the planner 19 MiB limit. Reduce source size or layer count.');
      status('agentStatus','Queued with the AI animation planner…');
      const plan=await requestPlan(body);
      if(!plan?.scene||!Array.isArray(plan.scene.clips)||!plan.scene.clips.length)throw Error('AI planner returned no valid animation clips.');
      const exportBody=JSON.stringify({canvas:{width:state.psd.width,height:state.psd.height},scene:plan.scene,layers});
      if(exportBody.length>19*1024*1024)throw Error('Spine export request exceeds the 19 MiB limit.');
      status('agentStatus','AI plan ready. Sending scene and source layers to the Spine ZIP generator…');
      const result=await fetch(API.exporter+'/api/build',{method:'POST',headers:{'content-type':'application/json'},body:exportBody});
      if(!result.ok){const err=await result.json().catch(()=>({}));throw Error(err?.error?.message||err?.error||('Spine generator HTTP '+result.status));}
      const zip=await result.arrayBuffer();if(zip.byteLength<22||new Uint8Array(zip,0,4).some((v,i)=>v!==[80,75,3,4][i]))throw Error('Spine generator returned an invalid ZIP.');
      if(state.objectUrl)URL.revokeObjectURL(state.objectUrl);
      state.objectUrl=URL.createObjectURL(new Blob([zip],{type:'application/zip'}));
      const link=document.createElement('a');link.href=state.objectUrl;link.download=state.file.name.replace(/\.(psd|psb|png)$/i,'')+'_spine43.zip';link.click();
      $('previewState').textContent='ZIP READY';status('agentStatus','Spine ZIP created and downloaded. Verify the result in Spine Editor 4.3.26 before production.','success');
    }catch(error){status('agentStatus',error.message||String(error),'error');$('previewState').textContent='PIPELINE FAILED';}
    finally{$('processingOverlay').classList.remove('show');state.busy=false;$('animate').disabled=!state.prepared||($('selectionOnly').checked&&state.selected.size===0);}
  }
  function reset(){
    if(state.objectUrl)URL.revokeObjectURL(state.objectUrl);
    if(state.timer)clearInterval(state.timer);
    Object.assign(state,{file:null,kind:null,psd:null,layers:[],selected:new Set(),composite:null,prepared:false,busy:false,objectUrl:null});
    $('sourceFile').value='';$('workspace').classList.remove('has-file');$('fileInfo').classList.remove('show');
    $('previewCanvas').hidden=true;$('previewEmpty').hidden=false;$('previewDimensions').textContent='No image';$('previewName').textContent='No source loaded';$('previewState').textContent='IDLE';
    $('layerList').innerHTML='<div class="preview-empty">Your PSD layer structure will appear here.</div>';$('layerCount').textContent='0 layers';$('layerWarning').classList.remove('show');
    $('prepare').disabled=true;$('reset').disabled=true;$('animate').disabled=true;$('motion').value='';
    status('leftStatus','Waiting for a source file.');status('agentStatus','Prepare a PSD source to enable the animation pipeline.');
  }
  $('sourceFile').addEventListener('change',e=>selectFile(e.target.files?.[0]));
  $('dropzone').addEventListener('dragover',e=>{e.preventDefault();$('dropzone').classList.add('drag');});
  $('dropzone').addEventListener('dragleave',()=> $('dropzone').classList.remove('drag'));
  $('dropzone').addEventListener('drop',e=>{e.preventDefault();$('dropzone').classList.remove('drag');selectFile(e.dataTransfer.files?.[0]);});
  $('prepare').addEventListener('click',prepare);$('animate').addEventListener('click',animate);$('reset').addEventListener('click',reset);
  $('selectAll').addEventListener('click',()=>{state.layers.forEach(x=>x.selected=true);state.selected=new Set(state.layers.map(x=>x.id));$('layerList').querySelectorAll('input[type=checkbox]').forEach(x=>x.checked=true);$('animate').disabled=!state.prepared;});
  $('scale').addEventListener('input',()=>{$('scaleValue').textContent=$('scale').value+'%';if(state.file)state.prepared=false;$('animate').disabled=true;});
  $('padding').addEventListener('input',()=>{$('paddingValue').textContent=$('padding').value+' px';if(state.file)state.prepared=false;$('animate').disabled=true;});
  ['ignoreHidden','ignoreBackground','trimWhitespace','selectionOnly'].forEach(id=>$(id).addEventListener('change',()=>{if(state.file){state.prepared=false;$('animate').disabled=true;status('leftStatus','Settings changed. Prepare the source again to apply them.');}}));
  reset();
})();