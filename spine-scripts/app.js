(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const API = {
    studio: 'https://spine-studio.spine-animator-f8692224.workers.dev',
    planner: 'https://spine-plan-api.spine-animator-f8692224.workers.dev',
    exporter: 'https://spine-generator.spine-animator-f8692224.workers.dev'
  };
  const state = { file:null, kind:null, psd:null, layers:[], selected:new Set(), composite:null, prepared:false, busy:false, timer:null, objectUrl:null };
  let contourModelPromise=null;
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
    const rows=[],flat=[],sourceLayers=[],names=new Set(),unsupported=[];
    const ignoreHidden=$('ignoreHidden').checked,ignoreBg=$('ignoreBackground').checked;
    const scale=Number($('scale').value)/100,padding=Number($('padding').value),trim=$('trimWhitespace').checked;
    let sourceIndex=0;
    const hasData=value=>!!value&&(Array.isArray(value)?value.length>0:typeof value==='object'?Object.keys(value).length>0:true);
    const safeId=value=>String(value||'layer').replace(/[^\w.-]/g,'_').slice(0,70)||'layer';
    function addUnsupported(name,reason){unsupported.push(name+': '+reason);}
    function inspectFeatures(layer,name){
      const reasons=[];
      const blend=String(layer.blendMode||'normal').toLowerCase();
      if(layer.adjustment)addUnsupported(name,'adjustment layers are not supported');
      if(hasData(layer.text)||hasData(layer.textData)||hasData(layer.typeTool))addUnsupported(name,'text layers are not supported');
      if(hasData(layer.smartObject)||hasData(layer.placedLayer)||hasData(layer.linkedLayer))addUnsupported(name,'smart or linked objects are not supported');
      if(hasData(layer.mask)||hasData(layer.userMask)||hasData(layer.realMask)||hasData(layer.layerMask))addUnsupported(name,'layer masks are not supported');
      if(hasData(layer.vectorMask)||hasData(layer.vectorFill)||hasData(layer.shape))addUnsupported(name,'vector layers or vector masks are not supported');
      if(hasData(layer.effects)||hasData(layer.layerEffects)||hasData(layer.filterMask))addUnsupported(name,'layer effects and filter masks are not supported');
      if(layer.clipping)addUnsupported(name,'clipping masks are not supported');
      if(blend&&!['normal','pass through','passthrough'].includes(blend))addUnsupported(name,'blend mode '+blend+' is not supported');
      const opacity=layer.opacity===undefined?255:Number(layer.opacity);
      if(!Number.isFinite(opacity)||opacity!==255)addUnsupported(name,'layer opacity other than 100% is not supported');
      const fillOpacity=layer.fillOpacity===undefined?255:Number(layer.fillOpacity);
      if(!Number.isFinite(fillOpacity)||fillOpacity!==255)addUnsupported(name,'fill opacity other than 100% is not supported');
      if(layer.knockout)addUnsupported(name,'knockout compositing is not supported');
      return reasons;
    }
    function walk(group,depth=0,parentVisible=true,groupPath=[]){
      const children=(group.children||[]).slice().reverse();
      for(const layer of children){
        const index=sourceIndex++;
        const sourceName=typeof layer.name==='string'?layer.name:'Layer '+index;
        const visible=parentVisible&&layer.hidden!==true;
        if(ignoreHidden&&!visible)continue;
        if(ignoreBg&&((sourceName||'').toLowerCase()==='background'||layer.isBackground))continue;
        let id=safeId(sourceName);
        if(names.has(id))id=id+'__record_'+index;
        let suffix=1;while(names.has(id))id=safeId(sourceName)+'__record_'+index+'_'+suffix++;
        names.add(id);
        const sourceRecordId=layer.layerId??layer.id??null;
        const opacity=layer.opacity===undefined?255:Number(layer.opacity);
        const isGroup=Array.isArray(layer.children)&&layer.children.length>0;
        const left=Number(layer.left||0),top=Number(layer.top||0);
        const rawCanvas=isGroup?null:canvasOf(layer.imageData||layer.canvas||layer);
        const sourceBounds={x:left,y:top,width:rawCanvas?.width||Math.max(0,Number(layer.right||left)-left),height:rawCanvas?.height||Math.max(0,Number(layer.bottom||top)-top)};
        const record={id,sourceName,sourceIndex:index,sourceRecordId:sourceRecordId===null?null:String(sourceRecordId),
          kind:isGroup?'group':'raster',visible,opacity,depth,groupPath:[...groupPath],bounds:sourceBounds,selected:false};
        if(/\[ignore\]/i.test(sourceName)){
          record.kind='ignored';record.excludedReason='ignore-tag';sourceLayers.push(record);continue;
        }
        sourceLayers.push(record);
        const tagMatch=sourceName.match(/\[(bone|slot|skin|mesh|linkedmesh|clip|overlay|merge|draworder|event)\]/i);
        if(tagMatch)addUnsupported(sourceName,'PhotoshopToSpine tag ['+tagMatch[1]+'] is not mapped by the browser exporter');
        inspectFeatures(layer,sourceName);
        if(isGroup){
          rows.push({type:'group',name:sourceName,depth,visible,sourceIndex:index});
          walk(layer,depth+1,visible,[...groupPath,sourceName]);continue;
        }
        if(!rawCanvas){
          if(layer.adjustment||hasData(layer.text)||hasData(layer.smartObject)||hasData(layer.vectorMask))record.kind='unsupported';
          else record.kind='empty';
          continue;
        }
        const attachment=makeAttachment(rawCanvas,scale,padding,trim);
        const x=left+attachment.offset.x,y=top+attachment.offset.y;
        const item={...record,canvas:attachment.canvas,selected:true,sourceBounds,
          bounds:{x:Math.round(x*scale-padding*scale),y:Math.round(y*scale-padding*scale),
            width:attachment.bounds.width,height:attachment.bounds.height}};
        record.selected=true;record.exportId=id;
        flat.push(item);rows.push({type:'layer',item,depth});
      }
    }
    walk(psd);
    if(!flat.length)throw Error('No supported raster layers found.');
    if(flat.length>250)throw Error('This web pipeline currently accepts up to 250 raster layers.');
    const outWidth=Math.round(psd.width*scale),outHeight=Math.round(psd.height*scale);
    const rendered=document.createElement('canvas');rendered.width=outWidth;rendered.height=outHeight;
    const renderContext=rendered.getContext('2d');
    for(const layer of flat.slice().reverse())if(layer.visible)renderContext.drawImage(layer.canvas,layer.bounds.x,layer.bounds.y);
    let compositeAudit={status:'not-checked',reason:'Scaling, trimming or padding changes source geometry.'};
    if(scale===1&&!trim&&padding===0){
      const original=composite.getContext('2d',{willReadFrequently:true}).getImageData(0,0,psd.width,psd.height).data;
      const rebuilt=rendered.getContext('2d',{willReadFrequently:true}).getImageData(0,0,psd.width,psd.height).data;
      let mismatchPixels=0,maxChannelDelta=0;
      for(let p=0;p<original.length;p+=4){
        let changed=false;
        for(let k=0;k<4;k++){const delta=Math.abs(original[p+k]-rebuilt[p+k]);if(delta){changed=true;if(delta>maxChannelDelta)maxChannelDelta=delta;}}
        if(changed)mismatchPixels++;
      }
      compositeAudit={status:mismatchPixels===0?'exact':'mismatch',mismatchPixels,maxChannelDelta,
        width:psd.width,height:psd.height,comparison:'ag-psd merged composite vs visible raster-layer reconstruction'};
      if(mismatchPixels)addUnsupported('PSD composite','visible raster layers differ from the embedded merged image at '+mismatchPixels+' pixels; export is locked');
    }
    return{width:outWidth,height:outHeight,originalWidth:psd.width,originalHeight:psd.height,
      composite:rendered,layers:flat,rows,sourceLayers,compositeAudit,unsupported};
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
    state.file=file;state.kind=ext;state.psd=null;state.layers=[];state.selected.clear();state.prepared=false;$('downloadPsd').disabled=true;
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

  // PNG-to-Spine is deliberately fail-closed until semantic anatomy and mask QA are integrated.
  function downloadLayeredPsd(){
    throw Error('PNG-to-PSD export is disabled until the anatomical decomposition pipeline passes its quality gates.');
  }

  async function prepare(){
    if(!state.file||state.busy)return;
    setBusy(true,state.kind==='png'?'PNG':'PSD');
    try{
      if(state.kind==='png'){
        const image=await canvasFromImage(state.file);drawPreview(image);
        state.psd={width:image.width,height:image.height,composite:image,layers:[],unsupported:['PNG requires semantic anatomical decomposition']};
        state.layers=[];state.selected.clear();state.prepared=false;
        renderLayers([]);
        $('downloadPsd').disabled=true;
        $('layerWarning').textContent='PNG preview only. Production segmentation is locked: the system must identify named anatomical parts, infer joints and occlusion, create source-aligned transparent masks, minimize the part count for the requested motion, and pass independent geometry/art review. No generic visual regions or unnamed layers will be exported.';
        $('layerWarning').classList.add('show');
        $('previewState').textContent='ANATOMY PIPELINE REQUIRED';
        status('leftStatus','Image loaded at original dimensions. High-quality anatomical decomposition is not yet connected; no layers were fabricated.','error');
        status('agentStatus','Blocked before animation. Connect A2 semantic decomposition, A3 rig feasibility and A5 independent mask/art review in the SA operation graph.','error');
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
    if((state.psd.unsupported||[]).length){status('agentStatus','Resolve unsupported Photoshop operations before export. This source is fail-closed.','error');return;}
    state.busy=true;$('animate').disabled=true;$('previewState').textContent='AI + SPINE EXPORT';
    $('processingTitle').textContent='AI ANIMATION';$('processingSub').textContent='Sending source artwork to the animation agent network.';$('processingOverlay').classList.add('show');
    try{
      const sceneCanvas=document.createElement('canvas');sceneCanvas.width=state.psd.width;sceneCanvas.height=state.psd.height;
      const sceneContext=sceneCanvas.getContext('2d');
      for(const layer of selected.slice().reverse())sceneContext.drawImage(layer.canvas,layer.bounds.x,layer.bounds.y);
      const composite=sceneCanvas.toDataURL('image/png');
      const layers=selected.map(x=>({id:x.id,image:x.canvas.toDataURL('image/png'),bounds:x.bounds}));
      const body=JSON.stringify({image:composite,canvas:{width:state.psd.width,height:state.psd.height},layers,description,
        instructions:state.kind==='png'?'The source is one flattened PNG partitioned into disjoint AI-generated pixel masks. There is no original layer order or hidden anatomy to infer. Preserve the supplied region order and exact source composite at frame zero; treat mask regions as visual cutouts, not anatomical labels. Keep every supplied source mask exactly once. Create genuinely animated Spine scene clips with different numeric poses at distinct timestamps. Do not emit static fallback motion, empty clips, duplicate keys, or invented source layers.':'Preserve original Photoshop draw order and every source pixel. Keep frame-zero setup pose identical. Create genuinely animated Spine scene clips with different numeric poses at distinct timestamps. Do not emit static fallback motion, empty clips, duplicate keys, or invented source layers. Preserve all supplied source layer IDs and bounds.'});
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
    $('downloadPsd').disabled=true;
    Object.assign(state,{file:null,kind:null,psd:null,layers:[],selected:new Set(),composite:null,prepared:false,busy:false,objectUrl:null});
    $('sourceFile').value='';$('workspace').classList.remove('has-file');$('fileInfo').classList.remove('show');
    $('previewCanvas').hidden=true;$('previewEmpty').hidden=false;$('previewDimensions').textContent='No image';$('previewName').textContent='No source loaded';$('previewState').textContent='IDLE';
    $('layerList').innerHTML='<div class="preview-empty">Your PSD layer structure will appear here.</div>';$('layerCount').textContent='0 layers';$('layerWarning').classList.remove('show');
    $('prepare').disabled=true;$('reset').disabled=true;$('animate').disabled=true;$('downloadPsd').disabled=true;$('motion').value='';
    status('leftStatus','Waiting for a source file.');status('agentStatus','PNG requires approved anatomical decomposition; PSD source layers can be inspected.');
  }
  $('sourceFile').addEventListener('change',e=>selectFile(e.target.files?.[0]));
  $('dropzone').addEventListener('dragover',e=>{e.preventDefault();$('dropzone').classList.add('drag');});
  $('dropzone').addEventListener('dragleave',()=> $('dropzone').classList.remove('drag'));
  $('dropzone').addEventListener('drop',e=>{e.preventDefault();$('dropzone').classList.remove('drag');selectFile(e.dataTransfer.files?.[0]);});
  $('prepare').addEventListener('click',prepare);$('animate').addEventListener('click',animate);$('reset').addEventListener('click',reset);$('downloadPsd').addEventListener('click',()=>{try{downloadLayeredPsd();}catch(error){status('leftStatus',error.message||String(error),'error');}});
  $('selectAll').addEventListener('click',()=>{state.layers.forEach(x=>x.selected=true);state.selected=new Set(state.layers.map(x=>x.id));$('layerList').querySelectorAll('input[type=checkbox]').forEach(x=>x.checked=true);$('animate').disabled=!state.prepared;});
  $('scale').addEventListener('input',()=>{$('scaleValue').textContent=$('scale').value+'%';if(state.file)state.prepared=false;$('animate').disabled=true;});
  $('padding').addEventListener('input',()=>{$('paddingValue').textContent=$('padding').value+' px';if(state.file)state.prepared=false;$('animate').disabled=true;});
  ['ignoreHidden','ignoreBackground','trimWhitespace','selectionOnly'].forEach(id=>$(id).addEventListener('change',()=>{if(state.file){state.prepared=false;$('animate').disabled=true;status('leftStatus','Settings changed. Prepare the source again to apply them.');}}));
  reset();
})();