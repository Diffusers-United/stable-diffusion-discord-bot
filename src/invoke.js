// All functions that directly touch invoke should be handled and/or exported from here
// Abstract and simplify external interface as much as possible

const {config,log,debugLog,getUUID,validUUID,urlToBuffer,sleep,shuffle,tidyNumber}=require('./utils')
const {random}=require('./random')
//const {exif}=require('./exif')
const io = require('socket.io-client')
const axios = require('axios')
const FormData = require('form-data')
require('colors') // no var needed
const { isString, isObject } = require('lodash')
const parseArgs = require('minimist')
const {imageEdit} = require('./imageEdit')
const {progress}=require('./discord/progress')
const {resultCache}=require('./resultCache')
const {aspectRatio}=require('./discord/aspectRatio')
const {credits}=require('./credits')
const {exif}=require('./exif')
var cluster=config.cluster

const init=async()=>{
    // Setup cluster of invoke ai backends starting with primary
    let initmsg=''
    for (const d in cluster){
        let c=cluster[d]
        try{
            if(!c.online){break}
            initHost(c)
        } catch(err) {
            c.online=false
            initmsg+='Failed to initialize invoke server '+c.name+' at '+c.url+'\n'+err
        }
    }
    return initmsg
}

const initHost=async(host)=>{
    try{
        // on connect, get all the backend info we can in parallel
        //host.online=false // do not disable during sync or jobs will fail
        const [version, models, lora, ti, vae, controlnet, ip_adapter, t2i_adapter, cfg] = await Promise.all(
            [
                getVersion(host),
                getModels(host,'main'),
                getModels(host,'lora'),
                getModels(host,'embedding'),
                getModels(host,'vae'),
                getModels(host,'controlnet'),
                getModels(host,'ip_adapter'),
                getModels(host,'t2i_adapter'),
                getConfig(host)
            ])
        host.version = version
        host.models = models
        host.lora = lora
        host.ti = ti
        host.vae = vae
        host.controlnet = controlnet
        host.ip_adapter = ip_adapter
        host.t2i_adapter = t2i_adapter
        host.config = cfg
        host.activeJob = null // unused
        if(host.socket){host.socket.close();host.socket=null}// Close the existing socket connection, if any
        host.socket = io(host.url,{path: '/ws/socket.io'})
        host.jobs = [] // unused
        let now = Date.now()
        host.online = true
        if(now-360000>host.lastInit||!host.lastInit){ // if its been 6+ minutes since we were last online
            log('Connected to '.bgGreen.black+host.name.bgGreen+' with InvokeAI Version: '+host.version+'\nModels: '+host.models.length+', Loras: '+host.lora.length+', Embeddings: '+host.ti.length+', Vaes: '+host.vae.length+', Controlnets: '+host.controlnet.length+', Ip Adapters: '+host.ip_adapter.length+', T2i Adapters: '+host.t2i_adapter.length+' , OwnerId:'+host.ownerid)
        }
        host.lastInit = now
        queueStatus(host) // connect, prune old jobs from queue
        // console.log("Host from InitHost", host);
        if(host.socket.connected===false){subscribeQueue(host,host.name)}
    } catch (err) {
        if(host.online===true||!host.lastFail){
            log('Failed to init host '.bgRed.black+host.name.bgRed+' : '+err.code)
        }
        host.lastFail = Date.now()
        host.online = false
        //host.disabled = true // disable after failing?
    }
}

buildWorkflowFromJob = (job)=>{
    let essentials = {}
    let keys = Object.keys(job)
    for (const i in keys){
        let key = keys[i]
        if(['prompt','strength','control','controlstart','controlend','controlweight','ipamodel','facemask','lscale','invert','width','height','hrf','hrfwidth','hrfheight','cost'].includes(key)){essentials[key] = job[key]}
        if(['creator'].includes(key)){essentials[key] = JSON.stringify(job[key])}
    }
    return JSON.stringify(essentials)
}

buildGraphFromJob = async(job)=>{ // Build new nodes graph based on job details
    let graph = {
        id: getUUID(),
        nodes:{},
        edges:[],
    }
    let data = []
    let lastid={unet:null,clip:null,vae:null,latents:null,noise:null,image:null,width:null,height:null,controlnet:null,mask:null,denoise_mask:null,width:null,height:null,metadata:null,merge_metadata:null,core_metadata:null,metadata_item:null,ip_adapter:null,t2i_adapter:null,collect:null,string:null}
    let pipe = (fromnode,fromfield,tonode,tofield)=>{return {source:{node_id:fromnode,field:fromfield},destination:{node_id:tonode,field:tofield}}}
    let node = (type,params,edges)=>{
        let newid=getUUID()
        graph.nodes[newid]={}
        graph.nodes[newid].type=type
        graph.nodes[newid].id=newid
        if(type==='l2i'){
            graph.nodes[newid].workflow=null
        }
        Object.keys(params)?.forEach((k)=>{graph.nodes[newid][k]=params[k]})
        // by tracking and updating most recent used ids we can break the job into components easier
        if(['main_model_loader','sdxl_model_loader','sdxl_model_refiner_loader','lora_loader','sdxl_lora_loader','seamless','freeu'].includes(type)){lastid.unet=newid}
        if(['main_model_loader','sdxl_model_loader','clip_skip','lora_loader','sdxl_lora_loader'].includes(type)){lastid.clip=newid}
        if(['sdxl_model_loader','sdxl_refiner_model_loader','sdxl_lora_loader'].includes(type)){lastid.clip2=newid}
        if(['sdxl_model_loader','main_model_loader','vae_loader','seamless'].includes(type)){lastid.vae=newid}
        if(['t2l','ttl','lscale','l2l','i2l','denoise_latents','lresize'].includes(type)){lastid.latents=newid}
        if(['noise'].includes(type)){lastid.noise=newid}
        if(['controlnet'].includes(type)){lastid.control=newid}
        if(['openpose_image_processor','l2i','face_mask_detection'].includes(type)){lastid.image=newid}
        if(['face_mask_detection'].includes(type)){lastid.mask=newid,lastid.width=newid;lastid.height=newid}
        if(['create_denoise_mask'].includes(type)){lastid.denoise_mask=newid}
        if(['core_metadata'].includes(type)){lastid.core_metadata=newid}
        if(['metadata_item'].includes(type)){lastid.metadata_item=newid}
        if(['metadata'].includes(type)){lastid.metadata=newid}
        if(['merge_metadata'].includes(type)){lastid.merge_metadata=newid}
        if(['collect'].includes(type)){lastid.collect=newid}
        if(['string'].includes(type)){lastid.string=newid}
        if(['ip_adapter'].includes(type)){lastid.ip_adapter=newid}
        if(['t2i_adapter'].includes(type)){lastid.t2i_adapter=newid}
        edges?.forEach(e=>{
            if(!validUUID(e.destination.node_id)){ // not already plumbed with a valid UUID
                if(e.destination.node_id==='SELF'){ e.destination.node_id=newid
                }else{
                    let nodenumber=e.destination.node_id.split('-')[1]?e.destination.node_id.split('-')[1]:0
                    let nodetype=e.destination.node_id.split('-')[0]
                    let i=0
                    Object.keys(graph.nodes).forEach(n=>{
                        if(graph.nodes[n].type===nodetype){
                            if(i===nodenumber){e.destination.node_id=graph.nodes[n].node_id}
                            i++
                        }
                    })
                }
            }
            if(!validUUID(e.source.node_id)){ // not already plumbed with a valid UUID
                if(e.source.node_id==='SELF'){ e.source.node_id=newid
                }else{
                    let nodenumber=e.source.node_id.split('-')[1]?parseInt(e.source.node_id.split('-')[1]):0
                    let nodetype=e.source.node_id.split('-')[0]
                    let i=0
                    Object.keys(graph.nodes).forEach(n=>{
                        if(graph.nodes[n].type===nodetype){
                            if(i===(Math.max(nodenumber-1,0))){e.source.node_id=graph.nodes[n].id}
                            i++
                        }
                    })
                }
            }
            graph.edges.push(e)
        })
    }

    // Actual graph building starts here
    //      node(type,{parameters},[pipes])
    //      pipes flow backwards only to already created nodes eg
    //      pipe(from id, from field, to id, to field)
    //      id can either be actual id, or a type (type-number for multiples) or reference lastid.clip etc for most recent id's
    var p=[] // 
    // Metadata accumulator
    // todo vae object , controlnets array , ipAdapters array should be properly populated
    let fp32 = true // get black boxes if false without enabling fp16 vae fix on all sdxl models in invoke
    let metaObject = {
        is_intermediate:false,
        generation_mode:job.initimg?'img2img':'txt2img',
        cfg_scale:job.scale,
        clip_skip:job.clipskip,
        //cfg_rescale_multiplier: 0,
        height:job.height,
        width:job.width,
        positive_prompt:job.positive_prompt,
        negative_prompt:job.negative_prompt,
        rand_device:'cpu', // cpu only for reproducibility
        scheduler:job.scheduler,
        steps:job.steps,
        model:job.model,
        loras:[], // loras array is legitimately populated below
        controlnets:[],
        ipAdapters:[],// invoke 3.2+
        t2iAdapters:[],// invoke 3.3rc1+
        positive_style_prompt:job.style??'', // todo apparently you're supposed to append your main prompt to the style prompt
        negative_style_prompt:job.negstyle??'', // ^^
        hrf_height:job.hrfheight??null,
        hrf_width:job.hrfwidth??null,
        hrf_strength:job.hrf_strength??job.strength??null,
        seamless_x:job.seamlessx===true?true:false,
        seamless_y:job.seamlessy===true?true:false
    }
    // Reformat lora array for metadata object
    if(job.loras?.length>0){for (const l in job.loras){metaObject.loras.push({lora:{model_name:job.loras[l].model.model_name,base_model:job.loras[l].model.base_model},weight:job.loras[l].weight})}}
    if(job.control&&job.initimgObject){
        //metaObject.controlnets.push({controlnet:{model_name:job.control}})
    }
    if(['sd-1','sd-2'].includes(job.model.base_model)){
        node('main_model_loader',{model:job.model,is_intermediate:true},[])
        //node('vae_loader',{vae_model:{model_name:'sd-vae-ft-mse',base_model:'sd-1'},is_intermediate:true},[])
        if(job.loras?.length>0){for (const l in job.loras) {node('lora_loader',{is_intermediate:true,lora:{base_model:job.loras[l].model.base_model,model_name:job.loras[l].model.model_name},weight:job.loras[l].weight},[pipe(lastid.clip,'clip','SELF','clip'),pipe(lastid.unet,'unet','SELF','unet')])}} // lora loader, chain multiple loras with clip and unet into each other
    } else {
        node('sdxl_model_loader',{model:job.model,is_intermediate:true},[])
        if(job.loras?.length>0){
            debugLog('Before lora node, unet id is '+lastid.unet)
            for (const l in job.loras) {
                node('sdxl_lora_loader',{is_intermediate:true,lora:{base_model:job.loras[l].model.base_model,model_name:job.loras[l].model.model_name},weight:job.loras[l].weight},
                [
                    pipe(lastid.clip,'clip','SELF','clip'),
                    pipe(lastid.clip2,'clip2','SELF','clip2'),
                    pipe(lastid.unet,'unet','SELF','unet')
                ])
                debugLog('Added lora node, unet id is '+lastid.unet)
            }
            }
    }
    // Add freeu node https://stable-diffusion-art.com/freeu/
    // current default settings :
    // sd1 b1:1.2,b2:1.4,s1:0.9,s2:0.2
    // sd2 b1:1.1,b2:1.2,s1:0.9,s2:0.2
    // sdxl b1:1.1,b2:1.2,s1:0.6,s2:0.4
    // todo make optional in config and per job option
    // DO NOT USE WITH LORAS, it breaks them
    /*
    if(job.model.base_model==='sd-1'){node('freeu',{is_intermediate:true,b1:1.2,b2:1.4,s1:0.9,s2:0.2,use_cache:true},[pipe('main_model_loader','unet','SELF','unet')])}
    if(job.model.base_model==='sd-2'){node('freeu',{is_intermediate:true,b1:1.1,b2:1.2,s1:0.9,s2:0.2,use_cache:true},[pipe('main_model_loader','unet','SELF','unet')])}
    if(job.model.base_model==='sdxl'){node('freeu',{is_intermediate:true,b1:1.1,b2:1.2,s1:0.6,s2:0.4,use_cache:true},[pipe('sdxl_model_loader','unet','SELF','unet')])}
    */

    // Tamper with unet and vae if using seamless mode
    if(job.seamlessx===true||job.seamlessy===true){
        node('seamless',{is_intermediate:false,use_cache:false,seamless_x:job.seamlessx===true?true:false,seamless_y:job.seamlessy===true?true:false},[pipe(lastid.unet,'unet','SELF','unet'),pipe(lastid.vae,'vae','SELF','vae')])
    }

    if(job.initimgObject){
        debugLog('Adding init img to graph')
        if(job.control==='ipa'){ // todo rework so it can be used independantly of controlnet or i2l , allow model selection
            let ipamodel=(job.model.base_model==='sdxl')?'ip_adapter_sdxl':'ip_adapter_sd15'
            if(job.ipamodel){ipamodel=job.ipamodel}
            debugLog('Using ip_adapter with input image, model '+ipamodel)
            node('ip_adapter',{ip_adapter_model:{base_model:job.model.base_model,model_name:ipamodel},begin_step_percent:job.controlstart?job.controlstart:0,end_step_percent:job.controlend?job.controlend:1,is_intermediate:true,image:{image_name:job.initimgObject.image_name},weight:job.controlweight?job.controlweight:1},[])
        // todo need to incorporate t2i as well, copy ipamodel syntax, add a --t2imodel param
        // } else if (job.control==='t2i') {
        //      let t2imodel=(job.model.base_model==='sdxl')?'canny-sdxl':'canny-sd15'
        //      if(job.t2imodel){t2imodel=job.t2imodel}
        //      debugLog('Using t2i_adapter with input image, model '+t2imodel)
        //      node('t2i_adapter',{t2i_adapter_model:{base_model:job.model.base_model,model_name:t2imodel},begin_step_percent:job.controlstart?job.controlstart:0,end_step_percent:job.controlend?job.controlend:1,is_intermediate:true,image:{image_name:job.initimgObject.image_name},weight:job.controlweight?job.controlweight:1},[])
        } else if(job.facemask){
            debugLog('Using face mask detection')
            node('face_mask_detection',{is_intermediate:true,face_ids:'0',minimum_confidence:0.5,x_offset:0,y_offset:0,chunk:false,invert_mask:job.invert??false,image:{image_name:job.initimgObject.image_name}})
            node('i2l',{is_intermediate:false,fp32:fp32},[pipe(lastid.vae,'vae','SELF','vae'),pipe(lastid.image,'image','SELF','image')])
            node('create_denoise_mask',{is_intermediate:false,fp32:fp32,tiled:false},[pipe(lastid.image,'image','SELF','image'),pipe(lastid.mask,'mask','SELF','mask'),pipe(lastid.vae,'vae','SELF','vae')])
        } else if(job.control==='i2l'){
            node('i2l',{is_intermediate:false,fp32:fp32,image:{image_name:job.initimgObject.image_name}},[pipe(lastid.vae,'vae','SELF','vae')])
            // todo do we resize the image first instead of resizing latents ?
            node('lresize',{model:'bilinear',antialias:false,width:job.width,height:job.height},[pipe(lastid.latents,'latents','SELF','latents')])
        } else {
            debugLog('Using controlnet '+job.control||'depth')
            node('controlnet',{image:{image_name:job.initimgObject.image_name},
                    control_model:{model_name:job.control?job.control:'depth',base_model:job.model.base_model},
                    control_weight:job.controlweight?job.controlweight:1,
                    begin_step_percent:job.controlstart?job.controlstart:0,
                    end_step_percent:job.controlend?job.controlend:1,
                    control_mode:job.controlmode?job.controlmode:'balanced',
                    resize_mode:job.controlresize?job.controlresize:'just_resize',
                    is_intermediate:true
                    },[])
        }
    }

    node('clip_skip',{skipped_layers:job.clipskip??0,is_intermediate:true},[pipe(lastid.clip,'clip','SELF','clip')])
    if(lastid.width&&lastid.height){
        node('noise',{use_cpu:true},[pipe(lastid.width,'width','SELF','width'),pipe(lastid.height,'height','SELF','height')])
    }else{
        if(job.hrf&&job.hrfheight&&job.hrfwidth){
            node('noise',{width:job.hrfwidth,height:job.hrfheight,use_cpu:true},[])
        } else {
            node('noise',{width:job.width,height:job.height,use_cpu:true},[])
        }
    }
    // insert job metadata into string, pipe to metadata_item, pipe to metadata , pipe to collect alongside core_metadata output, into merge_metadata as final meta output
    node('string',{value:buildWorkflowFromJob(job)},[])
    /** Someday I will put a bullet in all arties' heads. SOMEDAY */
    node('metadata_item',{label:'arty'},[pipe(lastid.string,'value','SELF','value')])
    node('metadata',{},[pipe(lastid.metadata_item,'item','SELF','items')]) // fails with no error when uncommented
    node('core_metadata',metaObject,[])
    node('collect',{},[pipe(lastid.metadata,'metadata','SELF','item'),pipe(lastid.core_metadata,'metadata','SELF','item')])
    node('merge_metadata',{},[pipe(lastid.collect,'collection','SELF','collection')])

    if(['sd-1','sd-2'].includes(job.model.base_model)){
        node('compel',{prompt:job.positive_prompt},[pipe(lastid.clip,'clip','SELF','clip')])
        node('compel',{prompt:job.negative_prompt},[pipe(lastid.clip,'clip','SELF','clip')])
        p = [
            pipe('compel','conditioning','SELF','positive_conditioning'),
            pipe('compel-2','conditioning','SELF','negative_conditioning'),
            pipe(lastid.noise,'noise','SELF','noise'),
            pipe(lastid.unet,'unet','SELF','unet')
        ]
    } else {
        node('sdxl_compel_prompt',{prompt:job.positive_prompt,original_width:job.width??1024,original_height:job.height??1024,crop_top:0,crop_left:0,target_width:job.width??1024,target_height:job.height??1024,style:job.style??'',is_intermediate:true},[pipe(lastid.clip,'clip','SELF','clip'),pipe(lastid.clip2,'clip2','SELF','clip2')])
        node('sdxl_compel_prompt',{prompt:job.negative_prompt,original_width:job.width??1024,original_height:job.height??1024,crop_top:0,crop_left:0,target_width:job.width??1024,target_height:job.height??1024,style:job.negstyle??'',is_intermediate:true},[pipe(lastid.clip,'clip','SELF','clip'),pipe(lastid.clip2,'clip2','SELF','clip2')])
        p = [
            pipe('sdxl_compel_prompt','conditioning','SELF','positive_conditioning'),
            pipe('sdxl_compel_prompt-2','conditioning','SELF','negative_conditioning'),
            pipe(lastid.noise,'noise','SELF','noise'),
            pipe(lastid.unet,'unet','SELF','unet')
        ]
    }
    if(lastid.control){p.push(pipe(lastid.control,'control','SELF','control'))}
    if(lastid.ip_adapter){p.push(pipe(lastid.ip_adapter,'ip_adapter','SELF','ip_adapter'))}
    if(lastid.denoise_mask){p.push(pipe(lastid.denoise_mask,'denoise_mask','SELF','denoise_mask'))}
    if(lastid.latents){p.push(pipe(lastid.latents,'latents','SELF','latents'))}
    let denoising_start = 0.0
    if(job.strength&&job.initimgObject&&job.control==='i2l'){denoising_start=1.0-job.strength}
    node('denoise_latents',{is_intermediate:true,noise:null,steps:job.steps,cfg_scale:job.scale,denoising_start:denoising_start,denoising_end:1.0,scheduler:job.scheduler},p)
    // new Hires fix implementation
    // do initial render at basemodel default pixellimit in correct aspect ratio
    // l2i , img_resize to full res , noise at full res , i2l , denoise latents at start 0.55 , l2i
    if(job.hrf&&job.hrfwidth&&job.hrfheight){
        debugLog('Applying hires fix, init width:'+job.hrfwidth+', height:'+job.hrfheight)
        denoising_start = 0.55//1.0 - job.strength??0.55
        debugLog('denoising start is '+denoising_start)
        node('l2i',{fp32:fp32,is_intermediate:true},[pipe(lastid.latents,'latents','SELF','latents'),pipe('main_model_loader','vae','SELF','vae')])
        node('img_resize',{width:job.width,height:job.height,is_intermediate:true},[pipe('l2i','image','SELF','image')])
        node('noise',{seed:job.seed,width:job.width,height:job.height},[])
        if(['sd-1','sd-2'].includes(job.model.base_model)){
            debugLog(lastid.vae)
            node('i2l',{is_intermediate:true},[pipe('img_resize','image','SELF','image'),pipe('main_model_loader','vae','SELF','vae')])
            p = [pipe('compel','conditioning','SELF','positive_conditioning'),pipe('compel-2','conditioning','SELF','negative_conditioning')]
        } else { // sdxl
            node('i2l',{is_intermediate:true},[pipe('img_resize','image','SELF','image'),pipe('sdxl_model_loader','vae','SELF','vae')])
            p = [pipe('sdxl_compel_prompt','conditioning','SELF','positive_conditioning'),pipe('sdxl_compel_prompt-2','conditioning','SELF','negative_conditioning')]
        }
        p.push(pipe(lastid.noise,'noise','SELF','noise'))
        p.push(pipe(lastid.unet,'unet','SELF','unet'))
        if(lastid.control){p.push(pipe(lastid.control,'control','SELF','control'))}
        if(lastid.ip_adapter){p.push(pipe(lastid.ip_adapter,'ip_adapter','SELF','ip_adapter'))}
        if(lastid.denoise_mask){p.push(pipe(lastid.denoise_mask,'denoise_mask','SELF','denoise_mask'))}
        if(lastid.latents){p.push(pipe(lastid.latents,'latents','SELF','latents'))}
        node('denoise_latents',{is_intermediate:true,steps:job.steps,cfg_scale:job.scale,scheduler:job.scheduler,denoising_start:denoising_start,denoising_end:1.0},p)
    }
    // final output
    if(['sd-1','sd-2'].includes(job.model.base_model)){
        node('l2i',{tiled:true,fp32:fp32,is_intermediate:false},[pipe(lastid.vae,'vae','SELF','vae'),pipe(lastid.latents,'latents','SELF','latents'),pipe('merge_metadata','metadata','SELF','metadata')])
    } else {
        node('l2i',{tiled:true,fp32:fp32,is_intermediate:false},[pipe(lastid.vae,'vae','SELF','vae'),pipe(lastid.latents,'latents','SELF','latents'),pipe('merge_metadata','metadata','SELF','metadata')])
    }

    //if(job.upscale&&job.upscale===2){node('esrgan',{model_name:'RealESRGAN_x2plus.pth'},[pipe(lastid.image,'image','SELF','image')])}
    let dataitems = [job.seed]
    while(dataitems.length<job.number){dataitems.push(random.seed())}
    data.push([
        {node_path:lastid.core_metadata,field_name:'seed',items:dataitems}
    ])
    // Make sure the seed is changing for all noise generations, not just the most recent, when using iterator/multiples
    let noiseIds = Object.values(graph.nodes).filter(i=>i.type==='noise').map(i=>i.id)
    for (const id in noiseIds){data[0].push({node_path:noiseIds[id],field_name:'seed',items:dataitems})}
    // Tada! Graph built
    return {
        batch:{
            data:data,
            graph:graph,
            runs:1,
        },
        prepend:false
    }
}

const getJobCost = (job) =>{
    // calculate and return a cost float based on job properties
    let cost = 1
    let pixelStepsBase = 7864320 // based on 512x512x30 default sd-1 render
    let width = job.width??512
    let height = job.height??512
    let steps = job.steps??30
    let pixelSteps = width*height*steps
    let number = job.number??1
    cost=(pixelSteps/pixelStepsBase)*cost
    cost=cost*number
    if(job.control==='i2l'&&job.strength){cost=cost*job.strength} // account for reduced steps with img2img
    if(job.hrf&&job.hrfwidth&&job.hrfheight&&job.strength){
        cost=cost*(job.hrfwidth*job.hrfheight*(steps*job.strength))/pixelStepsBase // account for 2 pass hiresfix
    }
    if(job.loras&&job.loras.length>0){cost=cost+(job.loras.length*0.25)} // 0.25 for each lora
    // todo charge for loras, ipa, controlnet
    return parseFloat(cost.toFixed(2))
}

const enqueueBatch = async (host, graph, name='arty') => {
    // console.log("Host enqueueBatch", host);
    // new in invoke 3.2.0rc1
    try {
        const response = await axios.post(host.url + '/api/v1/queue/'+host.name+'/enqueue_batch',graph)
        return response.data.batch.batch_id
    } catch (err) {
        console.error('Error queueing batch',err.data)
        return{error:'Error queueing batch '+err.code}
    }
}

const batchStatus = async (host,batch_id,name='arty')=>{
    // console.log("Host batchStatus", host);
    try {
        const response = await axios.get(host.url + '/api/v1/queue/'+host.name+'/b/'+batch_id+'/status')
        return response.data
    } catch (err) {
        log(err)
        throw(err.code)
    }
}

const queueStatus = async (host,name='arty')=>{
    // console.log("Host queueStatus", host);
    try {
        const response = await axios.get(host.url + '/api/v1/queue/'+host.name+'/status')
        if(response.data.queue.pending===0&&response.data.queue.in_progress===0&&response.data.queue.total>10){queuePrune(host,name)}
        return response.data
    } catch (err) {
        log(err)
        throw(err.code)
    }
}

const queueList = async (host,name='arty')=>{
    // console.log("Host queueList", host);
    try {
        const response = await axios.get(host.url + '/api/v1/queue/'+host.name+'/list')
        return response.data
    } catch (err) {
        log(err)
        throw(err.code)
    }
}

const queuePrune = async (host,name='arty')=>{
    // console.log("Host queuePrune", host);
    try {
        const response = await axios.put(host.url + '/api/v1/queue/'+host.name+'/prune')
        log('Pruning queue "'+name+'" on host '+host.name+'; deleted '+response.data?.deleted+' completed or failed jobs.')
        return response.data
    } catch (err) {
        log(err)
        throw(err.code)
    }
}

const cancelBatch = async(batchid,host=null,name='arty')=>{
    // console.log("Host cancelBatch", host);
    log('cancelbatch started with batchid '+batchid)
    // if host not specified, discover from batchid
    try {
        if(host===null){
            let result = resultCache.get(batchid)
            // find host by hostname from cluster array
            host = cluster.find(h=>{return h.name===result?.hostname})
            if(!host.url){
                log('Unable to find active job to cancel')
                return
            }
        }
        const response = await axios.put(host.url+'/api/v1/queue/'+host.name+'/cancel_by_batch_ids',{batch_ids:[batchid]})
        if(response.status===200){
            log('Batch cancelled')
            resultCache.edit(batchid,'status','cancelled')
        }
    } catch (err) {
        log(err)
        throw(err.code)
    }
}

const isLoraMatch = (lora,loras)=>{return loras.some(jobLora => jobLora.name === lora.model_name)}
function findHostsWithJobLoras(hosts, job) {
  // Filter the hosts array based on the loras
    return hosts.filter(host => {
    // Check if host.loras and job.loras are defined and not empty
        if (host.lora && host.lora.length > 0) {
            // Check if all of the job's loras are present in the host's loras
            return job.loras.every(jobLora => host.lora.some(lora => isLoraMatch(lora, [jobLora])))
        } else {
            return false
        }
    })
}

const findHost = async (job = null) => {
    // find host with the required models, embeds, etc that isn't currently busy
    let availableHosts = cluster.filter(h => {
      return h.online && !h.disabled;
    });
  
    if (job === null && availableHosts.length > 0) {
      debugLog('No job info supplied, returning random available host');
      return availableHosts[Math.floor(Math.random() * availableHosts.length)];
    }
  
    if (isString(job?.model)) {
      try {
        job.model = await modelnameToObject(job.model);
      } catch (err) {
        throw err;
      }
    }
  
    // filter available hosts: check correct model is installed
    let filteredHosts = availableHosts.filter(host => {
      return host.models.some(model => model.name === job.model.name);
    });
  
    // todo more host qualifications if needed for job (controlnets, ipa, etc.)
    if (filteredHosts.length === 0) {
      throw 'No host with required model found';
    }
  
    // filter for hosts with the required loras
    if (job.loras.length > 0) {
      filteredHosts = findHostsWithJobLoras(filteredHosts, job);
      if (filteredHosts.length === 0) {
        throw 'No host with required loras found';
      }
    }
  
    // get qualified hosts that are idle right now (if any, based on result cache)
    let rc = resultCache.get();
    let filteredHostsIdle = filteredHosts.filter(h => {
      return !Object.values(rc).some(job => job.hostname === h.name);
    });
  
    // return a random idle qualified host if available
    if (filteredHostsIdle.length > 0) {
      return filteredHostsIdle[Math.floor(Math.random() * filteredHostsIdle.length)];
    }
  
    // otherwise, find the least busy host
    let hostCounts = {};
    Object.values(rc).forEach(job => {
      if (hostCounts[job.hostname] === undefined) {
        hostCounts[job.hostname] = 1;
      } else {
        hostCounts[job.hostname]++;
      }
    });
  
    let sortedHosts = Object.keys(hostCounts).sort((a, b) => {
      return hostCounts[a] - hostCounts[b];
    });
  
    return sortedHosts[0];
  };
  
const subscribeQueue = async(host,name='arty')=>{
    // console.log("Host subscribeQueue", host);
    let socket = host.socket
    // console.log("Whats inside of a host", host)
    name = host.name;
    try{
        socket.on('connect',()=>{
            socket.emit('subscribe_queue',{"queue_id":name})
        })
        socket.on('batch_enqueued', msg => {
            // queue_id str, batch_id str, enqueued int, timestamp
            debugLog(host.name+' batch enqueued: '+msg.batch_id.dim)
            resultCache.set(msg.batch_id, {
                batch_id:msg.batch_id,
                status:'pending',
                results:[],
                progress:{},
                hostname:host.name
            })
        })
        socket.on('queue_item_status_changed', msg => {
            // queue_id str, queue_item_id int, status str, batch_id uuid, session_id uuid, error, created_at str, updated_at str, started_at str, completed at null, timestamp
            debugLog(host.name+' '+msg.queue_item?.batch_id?.dim+' '+msg.queue_item?.status)
            // resultCache.edit(msg.batch_id,'status',msg.status) // invoke 3.2
            resultCache.edit(msg.queue_item?.batch_id,'status',msg.queue_item?.status) // invoke 3.3
        })
        socket.on('invocation_started', msg => {debugLog(host.name+' '+msg.queue_batch_id.dim+' started '+msg.node.type)})
        socket.on('invocation_complete', msg => {
            debugLog(host.name+' '+msg.queue_batch_id.dim+' finished '+msg.node.type)
            if(msg.result?.type==='image_output'&&msg.node.is_intermediate){
                debugLog('ignore intermediate image')
            } else {
                resultCache.addResult(msg.queue_batch_id,msg.result)
            }            
        })
        socket.on('generator_progress', msg => {
            log(host.name+' '+msg.queue_batch_id.dim+' '+msg.order+' : '+msg.step+' / '.dim+msg.total_steps)
            let buf=null
            // decode progress images
            if(msg.progress_image?.dataURL) {
                buf = Buffer.from(msg.progress_image.dataURL.split(','[1], 'base64'))
            }
            resultCache.edit(msg.queue_batch_id,'progress',{
                step:msg.step,
                total_steps:msg.total_steps,
                order:msg.order,
                progress_image:buf,
                timestamp:msg.timestamp
            })
        })
        socket.on('model_load_started', msg => {
            let t = msg.base_model+'/'+msg.model_name
            if(msg.submodel){t= t+'/'+msg.submodel}
            debugLog(host.name+' loading '+t)
            resultCache.addResult(msg.queue_batch_id,{type:t})
        })
        socket.on('model_load_completed', msg => {
            debugLog(host.name+' loaded: '+msg.model_name)
        })
        socket.on('graph_execution_state_complete', msg => {
            // queue_id str, queue_item_id int, queue_batch_id uuid, graph_execution_state_id uuid, timestamp
            debugLog(host.name+' graph done '.bgGreen+msg.queue_batch_id.dim)
        })
    } catch(err) {
        log('Error with websocket for host '+host.name)
    }
}

batchToResult = async(host,batchid)=>{
    // Take a batch id, return results array from completed session
    let err=null
    let result=null
    while(!err){
        let job = resultCache.get(batchid)
        if(job?.status==='completed'){
            debugLog('Job completed:')
            debugLog(job)
            return job.results
        }
        if(job?.status==='failed'){
            err=true;
            console.log('batchToResult FAILED', job);
            return {error:'Job failed'}
        }
        await sleep(1000)
    }
}

batchToImages = async(host,batchid)=>{
    // Take a batch id, return images from completed session
    let err=null
    let images=null
    while(!err){
        let job = resultCache.get(batchid)
        if(job?.status==='completed'){
            images = await getBatchImages(host,batchid)
            return images
        }
        
        if(job?.status==='failed'){
            err=true;
            console.log('batchToImages  FAILED', job);
            return {error:'Job failed'}
        }
        await sleep(500)
    }
}



getBatchImages = async(host,batchid)=>{
    // Get image results from our host result cache for a given batch id we know has completed execution
    // Turn image names into image buffers
    // Return array of image buffers
    let result = []
    try{
        for (const r in resultCache.get(batchid)?.results){
            let res = resultCache.get(batchid)?.results[r]
            if(res.type==='image_output'){
                res.buffer=await getImageBuffer(host,res?.image?.image_name)
                res.name=res?.image?.image_name
                if(res.buffer?.error){return{error:res.buffer.error}}
                if(host.deleteAfterRender){deleteImage(host,res?.image?.image_name)}
                result.push(res)
            }
        }
        return result
    } catch(err) {
        log('Error in getBatchImages')
        log(err)
        return {error:'Error in getBatchImages'}
    }
}

const deleteImage = async(host,name)=>{
    try{
        u = host.url+'/api/v1/images/i/'+name
        debugLog('Deleting image '+name+' from '+host.name)
        await axios.delete(u)
    } catch (err) {
        host.online = false
        throw(err)
    }
}

const getVersion = async(host)=>{
    try{
        let u = host.url+'/api/v1/app/version'
        let response = await axios.get(u)
        return response.data.version
    } catch (err){
        host.online = false
        throw(err)
    }
}

const getConfig = async(host)=>{
    try{
        let u = host.url+'/api/v1/app/config'
        let response = await axios.get(u)
        return response.data
    } catch (err){
        host.online = false
        throw(err)
    }
}

const getModels = async(host,type='main')=>{
    // type can be embedding , main , vae , controlnet , lora
    try {
        let u = host.url+'/api/v1/models/?model_type='+type
        let response = await axios.get(u)
        return response.data?.models
    } catch (err) {
        host.online = false
        throw(err)
    }
}

const getImages = async(host)=>{
    try {
        let u = host.url+'/api/v1/images/?board_id=none&categories=control&categories=mask&categories=user&categories=other&is_intermediate=false&limit=0&offset=0'
        let r = axios.get(u)
        return r.data?.items
    } catch (err) {
        host.online = false
        throw(err)
    }
}

const getImageBuffer = async(host,name)=>{
    try {
        let u = host.url+'/api/v1/images/i/'+name+'/full'
        let buf = urlToBuffer(u,true)
        return buf
    } catch (err) {
        host.online = false
        throw(err)
    }
}

const getHeaders = async (form) => {
    const length = await new Promise((resolve, reject) => {form.getLength((err, length) => {if (err) {reject(err)} else {resolve(length)}})})
    return Object.assign({ 'Content-Length': length }, form.getHeaders())
}

uploadInitImage=async(host,buf,id)=>{
    try{
        let url=host.url+'/api/v1/images/upload?image_category=user&is_intermediate=false'
        let form = new FormData()
        form.append('data',JSON.stringify({kind:'init'}))
        form.append('file',buf,{contentType:'image/png',filename:id+'.png'})
        let headers = await getHeaders(form)
        debugLog('Uploading init img to '+host.name+' with id '+id)
        let response = await axios.post(url,form,{headers:headers})
        return response.data
    } catch (err) {
        host.online = false
        throw(err.code)
    }
}

const auto2invoke = (text)=>{
    // convert lora syntax eg <lora:add_detail:1> to withLora(add_detail,1)
    text = text.replaceAll(/<lora:([^:]+):([^>]+)>/g, 'withLora($1,$2)')
    // convert weight syntax
    text = text.replaceAll(/\(([^)]+):([^)]+)\)/g, '($1)$2')
    return text
}

const jobFromDream = async(cmd,images=null,tracking=null)=>{
    // input oldschool !dream format, output job object
    var job = parseArgs(cmd,{boolean:['facemask','invert','hrf','seamlessx','seamlessy','seamless']})//string: ['sampler','text_mask'],boolean: ['seamless','hires_fix']}) // parse arguments //
    // set argument aliases
    if(job.seamless){job.seamlessy=true;job.seamlessx=true}
    if(job.s){job.steps=job.s;delete job.s}
    if(job.S){job.seed=job.S;delete job.S}
    if(job.W){job.width=job.W;delete job.W}
    if(job.H){job.height=job.H;delete job.H}
    if(job.C){job.scale=job.C;delete job.C}
    if(job.A){job.sampler=job.A;delete job.A}
    if(job.f){job.strength=job.f;delete job.f}
    if(job.n){job.number=job.n;delete job.n}
    if(job.sampler){job.scheduler=job.sampler;delete job.sampler}
    if(tracking){job.tracking=tracking}
    // take prompt from what's left
    job.prompt=job._.join(' ')
    if(images){job.initimg=images}
    return validateJob(job)
}

const jobFromMeta = async(meta,img=null,tracking=null)=>{
    let job = {}
    if(meta.invoke?.prompt){
        job.prompt=meta.invoke?.prompt
    }else if(meta.invoke?.positive_prompt && meta.invoke?.negative_prompt){
        job.prompt = meta.invoke.positive_prompt+'['+meta.invoke.negative_prompt+']'
    }
    if(meta.invoke?.style){job.style=meta.invoke.style}
    if(meta.invoke?.negstyle){job.style=meta.invoke.negstyle}
    if(img){job.initimg=img}
    if(meta.invoke?.inputImageUrl){job.initimg=await urlToBuffer(meta.invoke?.inputImageUrl)}else{job.initimg=null}
    if(meta.invoke?.control){job.control=meta.invoke.control}
    if(meta.invoke.controlstart !== null && meta.invoke.controlstart !== undefined){job.controlstart=meta.invoke.controlstart}
    if(meta.invoke.controlend !== null && meta.invoke.controlend !== undefined){job.controlend=meta.invoke.controlend}
    if(meta.invoke.controlweight !== null && meta.invoke.controlweight !== undefined){job.controlweight=meta.invoke.controlweight}
    if(meta.invoke?.ipamodel){job.ipamodel=meta.invoke.ipamodel}
    if(meta.invoke?.facemask){job.facemask=meta.invoke.facemask;job.control='i2l'}
    if(meta.invoke?.invert){job.facemask=meta.invoke.invert}
    if(meta.invoke.strength !== null && meta.invoke.strength !== undefined){job.strength=meta.invoke.strength}  
    if(meta.invoke?.lscale){job.lscale=meta.invoke.lscale}
    if(meta.invoke?.hrf){
        job.hrf=meta.invoke.hrf
        if(meta.invoke?.hrfwidth)job.hrf=meta.invoke.hrfwidth
        if(meta.invoke?.hrfheight)job.hrf=meta.invoke.hrfheight
    }
    if(meta.invoke?.seed){job.seed=meta.invoke.seed} // Bugfix, actually listen to seed from image and change seed within "refresh" functions
    if(meta.invoke?.seamlessx){job.seamlessx=meta.invoke.seamlessx}
    if(meta.invoke?.seamlessy){job.seamlessy=meta.invoke.seamlessy}
    job.steps = meta.invoke?.steps??config.default.steps
    // todo need to look at job.model.base_model and use sdxl width/height defaults if not already in meta.invoke
    job.width = meta.invoke?.width ? meta.invoke.width : config.default.width ?? config.default.size
    job.height = meta.invoke?.height ? meta.invoke.height : config.default.height ?? config.default.size
    job.scheduler = meta.invoke?.scheduler ? meta.invoke.scheduler : config.default.scheduler
    job.loras = meta.invoke?.loras ? meta.invoke.loras : []
    if(meta.invoke.scale !== null && meta.invoke.scale !== undefined){
        job.scale=meta.invoke.scale
    }else{job.scale=config.default.scale}
    job.model = meta.invoke?.model ? meta.invoke.model : config.default.model
    if(tracking){job.tracking = tracking}
    return validateJob(job)
}

const getDiffusionResolution = (number,smallestResStep=8)=>{
    // Diffusion resolution needs to be divisible by a specific number
    // invoke2 = 64 , invoke3 = 8
    //let smallestResStep = 8
    const quotient = Math.floor(number / smallestResStep)  // Get the quotient of the division
    const closestNumber = quotient * smallestResStep  // Multiply the quotient by res step to get the closest number
    return closestNumber
}

const extractLoras = async (inputString) => {
    const loraRegex = /withLora\s*\(([^,]+?)(?:,(\d+(?:\.\d+)?))?\)/gi
    const matches = [...inputString.matchAll(loraRegex)]
    //if(!matches.length) {return {error: "No loras found"}}
    const loras = matches.map(match => {
        const name = match[1]
        let weight
        let m=match[0]
        if(match[2]) {weight = match[2]} else {weight = 0.85}
        return {
            name, 
            weight,
            m
        }
    })
    let stripped = inputString
    let newloras = []
    for (const lora of loras){
        lora.model = await loranameToObject(lora.name)
        if(!lora.model) break
        stripped = inputString.replace(lora.m, '')
        newloras.push({name:lora.name,model:lora.model,weight:lora.weight})
    }
    return {
        loras: newloras,
        stripped: stripped,
        inputString: inputString
    }
}
const allUniqueModelsAvailable = async () => {
    // Return an array with all available main models, across all connected & online hosts with no repeats
    let availableHosts = cluster.filter(h => h.online && !h.disabled)
    let uniqueModelsMap = new Map()
    for (const host of availableHosts) {
        for (const model of host.models) {
            const key = `${model.model_name}-${model.base_model}-${model.model_type}`
            if (!uniqueModelsMap.has(key)) {
                uniqueModelsMap.set(key, {
                    model_name: model.model_name,
                    base_model: model.base_model,
                    model_type: model.model_type,
                    description: model.description
                })
            }
        }
    }
    return Array.from(uniqueModelsMap.values())
}
const allUniqueLorasAvailable = async () => {
    // Return an array with all available lora models, across all connected & online hosts with no repeats
    let availableHosts = cluster.filter(h => h.online && !h.disabled)
    let uniqueLorasMap = new Map()
    for (const host of availableHosts) {
        for (const model of host.lora) {
            const key = `${model.model_name}-${model.base_model}-${model.model_type}`
            if (!uniqueLorasMap.has(key)) {
                uniqueLorasMap.set(key, {
                    model_name: model.model_name,
                    base_model: model.base_model,
                    model_type: model.model_type,
                    description: model.description
                })
            }
        }
    }
    return Array.from(uniqueLorasMap.values())
}

const allUniqueControlnetsAvailable = async()=>{
    // Return an object with all available controlnet models, across all connected & online hosts //todo : no repeats
    let availableHosts=cluster.filter(h=>{return h.online&&!h.disabled})
    let allModels=[]
    for (const h in availableHosts){
        let host=cluster[h]
        for (const m in host.controlnet){
            let model = host.controlnet[m]
            allModels.push({model_name:model.model_name,base_model:model.base_model,model_type:model.model_type,description:model.description})
        }
    }
    return allModels
}

const allUniqueIpAdaptersAvailable = async()=>{
    // Return an object with all available ip adapter models, across all connected & online hosts //todo : no repeats
    let availableHosts=cluster.filter(h=>{return h.online&&!h.disabled})
    let allModels=[]
    for (const h in availableHosts){
        let host=cluster[h]
        for (const m in host.ip_adapter){
            let model = host.ip_adapter[m]
            allModels.push({model_name:model.model_name,base_model:model.base_model,model_type:model.model_type,description:model.description})
        }
    }
    return allModels
}

const allUniqueT2iAdaptersAvailable = async()=>{
    // Return an object with all available t2i adapter models, across all connected & online hosts //todo : no repeats
    let availableHosts=cluster.filter(h=>{return h.online&&!h.disabled})
    let allModels=[]
    for (const h in availableHosts){
        let host=cluster[h]
        for (const m in host.t2i_adapter){
            let model = host.t2i_adapter[m]
            allModels.push({model_name:model.model_name,base_model:model.base_model,model_type:model.model_type,description:model.description})
        }
    }
    return allModels
}

const validateJob = async(job)=>{
    // examine job object, reject on invalid parameters, add defaults as required
    try{
        // if no prompt, get a random one
        if(!job.prompt||job.prompt.length===0) job.prompt=random.get('prompt')
        // replace randomisers
        job.prompt=random.parse(job.prompt)
        // convert prompt weighting from auto1111 format to invoke/compel
        job.prompt=auto2invoke(job.prompt)
        // extract Loras in withLora(name,weight) format into job.loras
        let el = await extractLoras(job.prompt)
        if(el.error){return {error:el.error}}
        job.loras = el.loras
        // Set default model if not selected
        if(!job.model){
            // todo maybe set default model based on member tier or saved settings ?
            job.model=await modelnameToObject(config.default.model)
        }
        // Upgrade from model string to model object
        if(!isObject(job.model)){job.model=await modelnameToObject(job.model)}
        // split into positive/negative prompts
        const npromptregex = /\[(.*?)\]/g // match content of [square brackets]
        const npromptmatches = job.prompt?.match(npromptregex)
        if(npromptmatches?.length>0){
            job.negative_prompt=npromptmatches.join(' ').replace('[','').replace(']','')
        }else{
            // default negative prompt
            if(job.model?.base_model==='sdxl'){
                job.negative_prompt=config.default.sdxlnegprompt||''
            } else {
                job.negative_prompt=config.default.negprompt||''
            }
            debugLog('negative prompt: '+job.negative_prompt)
        }
        job.positive_prompt=job.prompt?.replace(npromptregex,'')
        // set defaults if not already set
        if(!job.style){job.style=''}
        if(!job.negstyle){job.negstyle=''}
        if(!job.number){job.number=1}else if(job.number>1&&job.seed){delete job.seed} // cannot feed a seed into the iterator afaik
        if(!job.seed&&job.number!==1||!Number.isInteger(job.seed)||job.seed<1||job.seed>4294967295){job.seed=random.seed()}
        if(!job.steps){job.steps=config.default.steps??30}
        if(!job.strength&&job.initimg){job.strength=config.default.strength||0.75}
        if(job.steps>config.maximum.steps){return{error:'Steps `'+job.steps+'` is above the current maximum step count `'+config.maximum.steps+'`'}}
        if(job.model?.base_model==='sdxl'){
            if(!job.width){job.width=config.default.sdxlwidth??1024}
            if(!job.height){job.height=config.default.sdxlheight??1024}
        } else {
            if(!job.width){job.width=config.default.width??512}
            if(!job.height){job.height=config.default.height??512}
        }
        job.height=getDiffusionResolution(job.height)
        job.width=getDiffusionResolution(job.width)
        if(config.maximum.pixels&&(job.width*job.height)>config.maximum.pixels){
            let error = 'Width `'+job.width+'` x Height `'+job.height+'` = `'+tidyNumber(job.width*job.height)+'` , above the current maximum pixel count of `'+tidyNumber(config.maximum.pixels)+'`'
            debugLog(error)
            return {error:error}
            //job.width=config.default.size?config.default.size:512
            //job.height=config.default.size?config.default.size:512
        }
        if(job.scale===undefined||job.scale===null){
            job.scale=config.default.scale? config.default.scale : 0.7
            //debugLog('Validating job: No cfg-scale, adding default scale of '+job.scale)
        }
        // scheduler must be one of these
        let validSchedulers=config.schedulers||['ddim','ddpm','deis','lms','lms_k','pndm','heun','heun_k','euler','euler_k','euler_a','kdpm_2','kdpm_2_a','dpmpp_2s','dpmpp_2s_k','dpmpp_2m','dpmpp_2m_k','dpmpp_2m_sde','dpmpp_2m_sde_k','dpmpp_sde','dpmpp_sde_k','unipc','lcm']
        if(!job.scheduler){job.scheduler=config.default.scheduler? config.default.scheduler.toLowerCase() : 'dpmpp_2m_sde_k'}
        // lscale min 1 max 3 default 1
        //if(!job.lscale||job.lscale<1||job.lscale>3){job.lscale=1}
        if(!job.clipskip){job.clipskip=0}
        if(!job.upscale){job.upscale=0}
        // set default init img mode
        // todo support multiple controlnet modes and images
        if(job.initimg||job.images?.length>0){
            // if no controlmode is set, set one from config default, same for controlresize and controlmode
            if(!job.control){job.control=config.default.controlmode||'i2l'}
            if(job.control!=='i2l'){
                if(!job.controlresize||['just_resize','crop_resize','fill_resize'].includes(job.controlresize)===false){job.controlresize='just_resize'}//else{job.controlresize='just_resize'}
                if(!job.controlmode||['balanced','more_prompt','more_control','unbalanced'].includes(job.controlmode)===false){job.controlmode='balanced'}
                if(!job.controlweight){job.controlweight=1}
                if(!job.controlstart){job.controlstart=0}
                if(!job.controlend){job.controlend=1}
            }
            if(job.control==='ipa'&&!job.ipamodel){
                job.ipamodel=(job.model.base_model==='sdxl')?'ip_adapter_sdxl':'ip_adapter_sd15'
            }
        }
        if(job.hrf){
            // set default res for hires fix based on base model and aspect ratio
            let hrfpixellimit=604*604 // sd1
            if(job.model?.base_model==='sdxl'){hrfpixellimit=1024*1024}
            let curpixels=job.width*job.height
            if(curpixels>hrfpixellimit){
                //debugLog('res too big, calc aspect ratio for hi res fix')
                let aspect = await aspectRatio.resToRatio(job.width,job.height)
                let newres = await aspectRatio.ratioToRes(aspect,hrfpixellimit)
                if(!job.hrfheight){job.hrfheight=getDiffusionResolution(newres.height)}
                if(!job.hrfwidth){job.hrfwidth=getDiffusionResolution(newres.width)}
            } else {
                if(!job.hrfheight){job.hrfheight=getDiffusionResolution(job.height)}
                if(!job.hrfwidth){job.hrfwidth=getDiffusionResolution(job.width)}
            }
        }
        job.cost = getJobCost(job)
        return job
        //return cast(job)
    } catch(err){
        if(err?.error){return {error: err.error}} else {return {error:err}}
    }
}

const hostHasModel = async(host,model)=>{
    if(host?.models?.includes(model)){ return true
    } else { return false}
}

const textFontImage = async(options,host) => {
    // uses/requires textfontimage community node from mickr777
    // https://github.com/mickr777/textfontimage/tree/main
    try {
        // todo need to be sure the host has the node installed
        if(!host)host=await findHost()
        let graph = {nodes:{
            Text_Font_to_Image:{
                id:'Text_Font_to_Image',
                type:'Text_Font_to_Image',
                text_input:options.text_input,
                font_url:options.font_url,
                image_width:options.image_width,
                image_height:options.image_height,
                padding:options.padding,
                row_gap:options.row_gap,
                text_input_second_row:options.text_input_second_row,
                local_font_path:options.local_font_path
            }
        }}
        let batch = {prepend:false,batch:{data:[],graph:graph,runs:1}}
        let batchId = await enqueueBatch(host,batch)
        let images = await batchToImages(host,batchId)
        if(images.error){return {error:images.error}}
        if(!images||images.length===0){return{error:'Error in textFontImage'}}
        deleteImage(host,images[0].name)
        return {images:images}
    } catch (err) {
        log('Error in textFontImage')
        log('uses/requires textfontimage community node from mickr777')
        log('https://github.com/mickr777/textfontimage/tree/main')
        debugLog(err)
        return {error:err}
    }
}

const processImage = async(img,host,type,options,tracking) => {
    try {
        // todo this should check availability of the chosen preprocessor type on the host
        if(!host) host=await findHost()
        let imgid = getUUID()
        let graph = null
        let initimg = await uploadInitImage(host,img,imgid)
        switch(type){
            case 'esrgan':{
                let resolution = await imageEdit.getResolution(img)
                let width = resolution?.width
                let height = resolution?.width
                let totalPixels = width * height
                let maxPixels = config.maximum.upscaledPixels ?? 4194304
                if(totalPixels>=maxPixels){return {error: 'Image dimensions are too large! Max upscaled pixels = '+maxPixels}}
                let model_name = options.model_name||RealESRGAN_x2plus.pth
                graph = {nodes:{esrgan:{'id':'esrgan','type':'esrgan','model_name':model_name,'image':{'image_name':initimg.image_name}}}}
                break
            }
            case 'openpose':{
                let draw_body = options.draw_body||true
                let draw_face = options.draw_face||true
                let draw_hands = options.draw_hands||true
                let image_resolution = options.image_resolution||512
                graph = {nodes:{dw_openpose_image_processor:{'id':'dw_openpose_image_processor','type':'dw_openpose_image_processor','image_resolution':image_resolution,'draw_body':draw_body,'draw_face':draw_face,'draw_hands':draw_hands,'is_intermediate':false,'image':{'image_name':initimg.image_name}}}}
                break
            }
            case 'canny':{
                let low_threshold = options.low_threshold||100
                let high_threshold = options.high_threshold||200
                graph = {nodes:{canny_image_processor:{'id':'canny_image_processor','type':'canny_image_processor','low_threshold':low_threshold,'high_threshold':high_threshold,'is_intermediate':false,'image':{'image_name':initimg.image_name}}}}
                break
            }
            case 'depthmap':{
                let a_mult = options.a_mult||2
                let bg_th = options.bg_th||0.1
                graph = {nodes:{midas_depth_image_processor:{'id':'midas_depth_image_processor','type':'midas_depth_image_processor','a_mult':a_mult,'bg_th':bg_th,'is_intermediate':false,'image':{'image_name':initimg.image_name}}}}
                break
            }
            case 'depthanything':{
                // new default depth model, auto downloaded by invoke on first use in invokeai from v3.6.1 onwards
                // https://github.com/LiheYoung/Depth-Anything
                let resolution = 1024
                let offload = false
                let model_size = 'large' // small, medium, large 
                graph = {nodes:{depth_anything_image_processor:{'id':'depth_anything_image_processor','type':'depth_anything_image_processor','resolution':resolution,'offload':offload,'model_size':model_size,'is_intermediate':false,'image':{'image_name':initimg.image_name}}}}
                break
            }
            case 'lineart':{
                let detect_resolution = options.detect_resolution||512
                let image_resolution = options.image_resolution||512
                let coarse = options.coarse||false
                graph = {nodes:{lineart_image_processor:{'id':'lineart_image_processor','type':'lineart_image_processor','coarse':coarse,'detect_resolution':detect_resolution,'image_resolution':image_resolution,'is_intermediate':false,'image':{'image_name':initimg.image_name}}}}
                break
            }
            case 'lineartanime':{
                let detect_resolution = options.detect_resolution||512
                let image_resolution = options.image_resolution||512
                graph = {nodes:{lineart_anime_image_processor:{'id':'lineart_anime_image_processor','type':'lineart_image_processor','detect_resolution':detect_resolution,'image_resolution':image_resolution,'is_intermediate':false,'image':{'image_name':initimg.image_name}}}}
                break
            }
            case 'colormap':{
                let tile_size = options.tile_size||64
                graph = {nodes:{color_map_image_processor:{'id':'color_map_image_processor','type':'color_map_image_processor','color_map_tile_size':tile_size,'is_intermediate':false,'image':{'image_name':initimg.image_name}}}}
                break
            }
            case 'removebg':{
                // uses custom invokeai node https://github.com/blessedcoolant/invoke_bria_rmbg
                // to install go to invokeai\nodes and git clone https://github.com/blessedcoolant/invoke_bria_rmbg
                // would be real nice if we could transplant meta from source image to new image
                graph = {nodes:{bria_bg_remove:{'id':'bria_bg_remove','type':'bria_bg_remove','is_intermediate':false,'image':{'image_name':initimg.image_name}}}}
                break
            }
            case 'face':{
                graph = {nodes:{'faceoff':{'id':'faceoff','type':'face_off','face_id':0,'minimum_confidence':0.5,'x_offset':0,'y_offset':0,'padding':0,'chunk':false,'is_intermediate':false,'image':{'image_name':initimg.image_name}}}}
                break
            }
        }
        let batch = {
            prepend:false,
            batch:{
                data:[],
                graph:graph,
                runs:1
            }
        }
        let batchId = await enqueueBatch(host,batch)
        if(tracking?.type==='discord'){progress.update(tracking.msg,batchId)}
        let images = await batchToImages(host,batchId)
        await deleteImage(host,initimg.image_name)
        if(images.error){return {error:images.error}}
        return {images:images}
    } catch (err) {
        log(err)
        return {error: err}
    }
}

const faceCrop = async(img,host,options={face_id:0,minimum_confidence:0.5,x_offset:0,y_offset:0,padding:0,chunk:false},tracking)=>{
    if(!host){host=await findHost()}
    let imgid = getUUID()
    let initimg = await uploadInitImage(host,img,imgid)
    let graph = {nodes:{'faceoff':{'id':'faceoff','type':'face_off','face_id':options.face_id,'minimum_confidence':options.minimum_confidence,'x_offset':options.x_offset,'y_offset':options.y_offset,'padding':options.padding,'chunk':options.chunk,'is_intermediate':false,'image':{'image_name':initimg.image_name}}}}
    let batch = {prepend:false,batch:{data:[],graph:graph,runs:1}}
    let batchId = await enqueueBatch(host,batch)
    if(tracking?.type==='discord'){progress.update(tracking.msg,batchId)}
    let res = await batchToResult(host,batchId)
    let buf = await getImageBuffer(host,res[0].image.image_name)
    let images =[{name:res[0].image.image_name,file:buf}]
    //images[0].file=await getImageBuffer(host,res.image[0].image_name)
    await deleteImage(host,initimg.image_name)
    if(images.error){return {error:images.error}}
    return {images:images,options:options,width:res[0].width,height:res[0].height,x:res[0].x,y:res[0].y}
}

const handfix = async(img,host,options={resolution:512,mask_padding:30,offload:true,steps:50,scale:7,numtiles:1,model:null,scheduler:'euler_k'},tracking)=>{
    // uses custom invokeai node https://github.com/blessedcoolant/invoke_meshgraphormer
    // to install go to invokeai\nodes and git clone https://github.com/blessedcoolant/invoke_meshgraphormer
    // you may have to manually install extra dependancies inside your invokeai venv
    // pip install trimesh rtree yacs
    // input - 1 image with crap hands
    // output - 2 images : a corrected depth map of the hands, and an image mask
    // final output - 1 image generated using the above image and mask + original image prompt
    if(!host){host=await findHost()}
    let imgid = getUUID()
    let initimg = await uploadInitImage(host,img,imgid)
    if(!options.model){options.model=await modelnameToObject(config.default.model)}
    // todo extract prompt and settings from metadata ourselves to inject prompts and bypass some extra invoke custom nodes
    let batch={
        prepend:false,
        batch:{
            data:[],
            runs:1,
            graph:{
                id:"handfix",
                nodes:{
                        "numtiles":{"type":"integer","id":"numtiles","value":options.numtiles,"use_cache":true,"is_intermediate":true},
                        "maskimg":{"type":"image","id":"maskimg","use_cache":true,"is_intermediate":false},
                        "metatostring":{"type":"metadata_to_string","id":"metatostring","label":"negative_prompt","custom_label":"","default_value":"","use_cache":true,"is_intermediate":true},
                        "negativeprompt":{"type":"compel","id":"negativeprompt","use_cache":true,"is_intermediate":true},
                        "latentstoimage":{"type":"l2i","id":"latentstoimage","tiled":false,"fp32":false,"use_cache":true,"is_intermediate":true},
                        "denoise":{"type":"denoise_latents","id":"denoise","steps":options.steps,"cfg_scale":options.scale,"denoising_start":0.25,"denoising_end":1,"scheduler":options.scheduler,"cfg_rescale_multiplier":0,"use_cache":true,"is_intermediate":true},
                        "positivepromptclip":{"type":"main_model_loader","id":"positivepromptclip","model":{"model_name":options.model.model_name,"base_model":options.model.base_model,"model_type":"main"},"use_cache":true,"is_intermediate":true},
                        "positiveprompt":{"type":"compel","id":"positiveprompt","use_cache":true,"is_intermediate":true},
                        "depthcontrolnet":{"type":"controlnet","id":"depthcontrolnet","control_model":{"model_name":"depth","base_model":"sd-1"},"control_weight":1,"begin_step_percent":0,"end_step_percent":1,"control_mode":"balanced","resize_mode":"just_resize","use_cache":true,"is_intermediate":true},
                        "createdenoisemask":{"type":"create_denoise_mask","id":"createdenoisemask","tiled":false,"fp32":false,"use_cache":true,"is_intermediate":true},
                        "meshgraphormer":{"type":"hand_depth_mesh_graphormer_image_processor","id":"meshgraphormer","resolution":options.resolution,"mask_padding":options.mask_padding,"offload":options.offload,"use_cache":true,"is_intermediate":true},
                        "inputimg":{"type":"image","id":"inputimg","image":{"image_name":initimg.image_name},"use_cache":true,"is_intermediate":true},
                        "metafromimg":{"type":"metadata_from_image","id":"metafromimg","use_cache":true,"is_intermediate":true},
                        "metatostring2":{"type":"metadata_to_string","id":"metatostring2","label":"positive_prompt","custom_label":"","default_value":"","use_cache":true,"is_intermediate":true},
                        "noise":{"type":"noise","id":"noise","seed":random.seed(),"use_cpu":true,"use_cache":true,"is_intermediate":true},
                        "imagetolatents":{"type":"i2l","id":"imagetolatents","tiled":false,"fp32":true,"use_cache":true,"is_intermediate":true},
                        "iterator":{"type":"iterate","id":"iterator","use_cache":true,"is_intermediate":true},
                        "tiletoprops":{"type":"tile_to_properties","id":"tiletoprops","use_cache":true,"is_intermediate":true},
                        "imgcropper":{"type":"img_crop","id":"imgcropper","use_cache":true,"is_intermediate":true},
                        "pairtiledimages":{"type":"pair_tile_image","id":"pairtiledimages","use_cache":true,"is_intermediate":true},
                        "collector":{"type":"collect","id":"collector","use_cache":true,"is_intermediate":true},
                        "mergetiles":{"type":"merge_tiles_to_image","id":"mergetiles","blend_mode":"Seam","blend_amount":32,"use_cache":true,"is_intermediate":true},
                        "saveimg":{"type":"save_image","id":"saveimg","use_cache":false,"is_intermediate":false},
                        "calculatetilesplit":{"type":"calculate_image_tiles_even_split","id":"calculatetilesplit","use_cache":true,"is_intermediate":true},
                        "tileoverlap":{"type":"integer","id":"tileoverlap","value":128,"use_cache":true,"is_intermediate":true}
                    },
                    edges:[
                        {"source":{"node_id":"positivepromptclip","field":"clip"},"destination":{"node_id":"positiveprompt","field":"clip"}},
                        {"source":{"node_id":"positiveprompt","field":"conditioning"},"destination":{"node_id":"denoise","field":"positive_conditioning"}},
                        {"source":{"node_id":"positivepromptclip","field":"unet"},"destination":{"node_id":"denoise","field":"unet"}},
                        {"source":{"node_id":"depthcontrolnet","field":"control"},"destination":{"node_id":"denoise","field":"control"}},
                        {"source":{"node_id":"createdenoisemask","field":"denoise_mask"},"destination":{"node_id":"denoise","field":"denoise_mask"}},
                        {"source":{"node_id":"denoise","field":"latents"},"destination":{"node_id":"latentstoimage","field":"latents"}},
                        {"source":{"node_id":"positivepromptclip","field":"vae"},"destination":{"node_id":"latentstoimage","field":"vae"}},
                        {"source":{"node_id":"positivepromptclip","field":"vae"},"destination":{"node_id":"createdenoisemask","field":"vae"}},
                        {"source":{"node_id":"meshgraphormer","field":"mask"},"destination":{"node_id":"createdenoisemask","field":"mask"}},
                        {"source":{"node_id":"meshgraphormer","field":"image"},"destination":{"node_id":"depthcontrolnet","field":"image"}},
                        {"source":{"node_id":"positivepromptclip","field":"clip"},"destination":{"node_id":"negativeprompt","field":"clip"}},
                        {"source":{"node_id":"negativeprompt","field":"conditioning"},"destination":{"node_id":"denoise","field":"negative_conditioning"}},
                        {"source":{"node_id":"inputimg","field":"image"},"destination":{"node_id":"metafromimg","field":"image"}},
                        {"source":{"node_id":"metafromimg","field":"metadata"},"destination":{"node_id":"metatostring2","field":"metadata"}},
                        {"source":{"node_id":"metatostring2","field":"value"},"destination":{"node_id":"positiveprompt","field":"prompt"}},
                        {"source":{"node_id":"metatostring","field":"value"},"destination":{"node_id":"negativeprompt","field":"prompt"}},
                        {"source":{"node_id":"metafromimg","field":"metadata"},"destination":{"node_id":"metatostring","field":"metadata"}},
                        {"source":{"node_id":"noise","field":"noise"},"destination":{"node_id":"denoise","field":"noise"}},
                        {"source":{"node_id":"positivepromptclip","field":"vae"},"destination":{"node_id":"imagetolatents","field":"vae"}},
                        {"source":{"node_id":"imagetolatents","field":"latents"},"destination":{"node_id":"denoise","field":"latents"}},
                        {"source":{"node_id":"maskimg","field":"image"},"destination":{"node_id":"createdenoisemask","field":"image"}},
                        {"source":{"node_id":"maskimg","field":"image"},"destination":{"node_id":"meshgraphormer","field":"image"}},
                        {"source":{"node_id":"maskimg","field":"width"},"destination":{"node_id":"noise","field":"width"}},
                        {"source":{"node_id":"maskimg","field":"height"},"destination":{"node_id":"noise","field":"height"}},
                        {"source":{"node_id":"maskimg","field":"image"},"destination":{"node_id":"imagetolatents","field":"image"}},
                        {"source":{"node_id":"iterator","field":"item"},"destination":{"node_id":"tiletoprops","field":"tile"}},
                        {"source":{"node_id":"tiletoprops","field":"coords_left"},"destination":{"node_id":"imgcropper","field":"x"}},
                        {"source":{"node_id":"tiletoprops","field":"coords_top"},"destination":{"node_id":"imgcropper","field":"y"}},
                        {"source":{"node_id":"tiletoprops","field":"width"},"destination":{"node_id":"imgcropper","field":"width"}},
                        {"source":{"node_id":"tiletoprops","field":"height"},"destination":{"node_id":"imgcropper","field":"height"}},
                        {"source":{"node_id":"imgcropper","field":"image"},"destination":{"node_id":"maskimg","field":"image"}},
                        {"source":{"node_id":"inputimg","field":"image"},"destination":{"node_id":"imgcropper","field":"image"}},
                        {"source":{"node_id":"latentstoimage","field":"image"},"destination":{"node_id":"pairtiledimages","field":"image"}},
                        {"source":{"node_id":"iterator","field":"item"},"destination":{"node_id":"pairtiledimages","field":"tile"}},
                        {"source":{"node_id":"pairtiledimages","field":"tile_with_image"},"destination":{"node_id":"collector","field":"item"}},
                        {"source":{"node_id":"collector","field":"collection"},"destination":{"node_id":"mergetiles","field":"tiles_with_images"}},
                        {"source":{"node_id":"mergetiles","field":"image"},"destination":{"node_id":"saveimg","field":"image"}},
                        {"source":{"node_id":"metafromimg","field":"metadata"},"destination":{"node_id":"saveimg","field":"metadata"}},
                        {"source":{"node_id":"inputimg","field":"width"},"destination":{"node_id":"calculatetilesplit","field":"image_width"}},
                        {"source":{"node_id":"inputimg","field":"height"},"destination":{"node_id":"calculatetilesplit","field":"image_height"}},
                        {"source":{"node_id":"calculatetilesplit","field":"tiles"},"destination":{"node_id":"iterator","field":"collection"}},
                        {"source":{"node_id":"numtiles","field":"value"},"destination":{"node_id":"calculatetilesplit","field":"num_tiles_x"}},
                        {"source":{"node_id":"tileoverlap","field":"value"},"destination":{"node_id":"calculatetilesplit","field":"overlap"}},
                        {"source":{"node_id":"numtiles","field":"value"},"destination":{"node_id":"calculatetilesplit","field":"num_tiles_y"}}
                    ]
                }
            }
        }
    let batchId = await enqueueBatch(host,batch)
    if(tracking?.type==='discord'){progress.update(tracking.msg,batchId)}
    let images = await batchToImages(host,batchId)
    await deleteImage(host,initimg.image_name)
    if(images.error){return {error:images.error}}
    return {images:images}
}

const interrogate = async(img,host,options={best_max_flavors:32,mode:'fast',clip_model:'ViT-L-14/openai',caption_model:'blip-large',low_vram:true})=>{
    // uses custom invokeai node https://github.com/helix4u/interrogate_node
    // to install go to invokeai\nodes and git clone https://github.com/helix4u/interrogate_node
    // enter invoke developer console / python venv and pip install clip-interrogator
    // clip models: ViT-L-14/openai , ViT-H-14/laion2b_s32b_b79k , ViT-bigG-14/laion2b_s39b_b160k
    // caption models: blip-base , blip-large, blip2-2.7b , blip2-flan-t5-xl , git-large-coco
    let imgid = getUUID()
    if(!host){host=await findHost()}
    let initimg = await uploadInitImage(host,img,imgid)
    let graph = {
        id:getUUID(),
        nodes:{
            "bab744b4-26c3-4e4f-8c5b-b3a9822032b0":{
                type:'clip_interrogator_node',
                id:'bab744b4-26c3-4e4f-8c5b-b3a9822032b0',
                best_max_flavors:options.best_max_flavors,
                mode:options.mode,
                clip_model:options.clip_model,
                caption_model:options.caption_model,
                low_vram:options.low_vram,
                image:{
                    image_name:initimg.image_name
                },
                is_intermediate:false,
                use_cache:true
            }
        },
        edges:[]
    }
    let batch = {prepend:false,batch:{graph:graph,runs:1}}
    let batchId = await enqueueBatch(host,batch)
    let results = await batchToResult(host,batchId)
    await deleteImage(host,initimg.image_name)
    return {result:results[0].value,options:options}
}

const nightmarePromptGen = async(host,options={temp:1.8,top_k:40,top_p:0.9,repo_id:'cactusfriend/nightmare-invokeai-prompts',prompt:'arty',split_prompt:false,typical_p:1,instruct_mode:false,max_new_tokens:300,min_new_tokens:30,max_time:10,repetition_penalty:1},tracking,creator)=>{
    if(!host) host=await findHost()
    let graph = {nodes:{nightmare_promptgen:{'id':'nightmare_promptgen','is_intermediate':false,'prompt':options.prompt,'repo_id':options.repo_id,'temp':options.temp,'top_k':options.top_k,'top_p':options.top_p,type:'nightmare_promptgen',use_cache:false,typical_p:options.typical_p,instruct_mode:options.instruct_mode,max_new_tokens:options.max_new_tokens,min_new_tokens:options.min_new_tokens,max_time:options.max_time,repetition_penalty:options.repetition_penalty}}}
    let batch = {prepend:false,batch:{data:[],graph:graph,runs:1}}
    try {
        let batchId = await enqueueBatch(host,batch)
        let result = await batchToResult(host,batchId)
        if(tracking?.type==='discord'){progress.update(tracking.msg,batchId)}
        return result
    } catch(err) {
        debugLog('Nightmare prompt generator failed to execute');debugLog(err)
        return {error:'Nightmare prompt generator failed to execute'}
    }
}

const modelnameToObject = async(modelname)=>{
    // look up models available on hosts
    let availableHosts=cluster.filter(h=>{return h.online&&!h.disabled})
    for (const h in availableHosts){
        let host=cluster[h]
        let model=host.models.find(m=>{return m.model_name===modelname})
        if(isObject(model)){
            return {
                model_name: model.model_name,
                base_model: model.base_model,
                model_type: model.model_type,
                description: model.description
            }
        }else{
            log('No model with name '+modelname+' on host '+host.name)
        }
    }
    debugLog('Unable to find online host with model: '+modelname)
    throw({error:'Unable to find online host with model: `'+modelname+'`'})
}

const loranameToObject = async(loraname)=>{
    // look up loras available on hosts
    //if(!loraname){throw('loranameToObject ')}
    let availableHosts=cluster.filter(h=>{return h.online&&!h.disabled})
    for (const h in availableHosts){
        let host=cluster[h]
        let lora=host.lora.find(m=>{return m.model_name===loraname})
        if(isObject(lora)){
            return {model_name: lora.model_name,base_model: lora.base_model}
        }else{log('Error: No lora with name '+loraname+' on host '+host.name)}
    }
    throw {error:'Unable to find online host with lora: `'+loraname+'`'}
}

const controlnetnameToObject = async(controlnetname) => {
    // Look up controlnets available on hosts
    let availableHosts = cluster.filter(host => {
        return host.online && !host.disabled  
    })
    for(let host of availableHosts) {
        let controlnet = host.controlnets.find(c => {return c.model_name === controlnetname})
        if(controlnet) {return {model_name: controlnet.model_name, base_model: controlnet.base_model,model_type: controlnet.model_type}
        } else {log(`Controlnet ${controlnetname} not found on host ${host.name}`)}
    }
    throw {error:'Unable to find online host with controlnet: `'+controlnetname+'`'}
}

getHostById = (id)=>{return cluster.find(h=>{h.id===id})}
getHostByName = (name)=>{return cluster.find(h=>{h.name===name})}
getHostByJobId = (id)=>{return cluster.find(h=>{h.jobs.includes(id)})}
getHostOnlineCount = ()=>{return cluster.filter(h=>{return h.online&&!h.disabled}).length}
getJobStats = ()=>{
    let rc = resultCache.get()
    let completed=0, pending=0, progress=0
    for (const i in rc){
        let r = rc[i]
        if(r.status==='completed')completed++
        if(r.status==='pending')pending++
        if(r.status==='in_progress')progress++
    }
    return {
        completed,
        pending,
        progress
    }
}
cast = async(job)=>{
    // easy mode, submit job, receive results
    const context = {
        job,
        host:null,
        batchId:null,
        images:[]
    }
    try{
        try{context.host=await findHost(context.job)}catch(err){return {error:err}}
        if(context.job.initimg){
            // todo allow for multiple init images, upload them all, return array of objects
            // loop through array of initimg's
            // generate id for each
            // upload to host
            // get uploaded image id from host, save back into original id with hostname
            // { url:url,buf:buf,uploads:[{hostname:hostname,id:id}]}
            // 
            initimgid = getUUID()
            context.job.initimgObject = await uploadInitImage(context.host,context.job.initimg,initimgid)
            if(!context.job.control){context.job.control=config.default.controlmode||'i2l'}
        }
        let graph = await buildGraphFromJob(context.job)
        context.batchId = await enqueueBatch(context.host,graph)
        if(!context.batchId||context.batchId?.error){return {error:'Error queuing job '}}
        // Trigger progress update reporting if enabled
        if(context.job.tracking){
            if(context.job.tracking?.type==='discord'){progress.update(job.tracking.msg,context.batchId)}
        }
        context.images = await batchToImages(context.host,context.batchId)
        resultCache.remove(context.batchId)
        if(context.images?.error){return {error:context.images?.error}}
        // // Charge user here
        // if(config.credits.enabled&&job.cost>0&&context.job.creator.discordid&&context.host.ownerid){
        //     if(context.job.creator.discordid===context.host.ownerid){
        //         // user rendering on own backend, no charge
        //     } else {
        //         // charge the creator, credit the backend provider
        //         await credits.transfer(context.job.creator.discordid,context.host.ownerid,job.cost)
        //     }
        // } else {
        //     debugLog('No charge')
        // }
        if(context.job.initimgObject)deleteImage(context.host,context.job.initimgObject.image_name) // remove uploaded image after use
        let result = {
            job:context.job,
            host:context.host,
            images:context.images
        }
        return result
    }catch(err){
        return {error:err}
    }
}

init().then(()=>{}).catch(e=>{log('init error:');log(e)})

module.exports = {
    cluster,
    invoke:{
        init,
        cast,
        jobFromDream,
        jobFromMeta,
        validateJob,
        findHost,
        allUniqueModelsAvailable,
        allUniqueControlnetsAvailable,
        allUniqueIpAdaptersAvailable,
        allUniqueT2iAdaptersAvailable,
        allUniqueLorasAvailable,
        processImage,
        getJobCost,
        hostCount:getHostOnlineCount,
        jobStats:getJobStats,
        textFontImage,
        cancelBatch,
        nightmarePromptGen,
        interrogate,
        handfix,
        faceCrop
    }
}
