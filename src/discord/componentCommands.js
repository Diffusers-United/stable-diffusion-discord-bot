const {config,log,debugLog,getRandomColorDec,shuffle,urlToBuffer, getUUID}=require('../utils')
const {messageCommands}=require('./messageCommands')
const {exif}=require('../exif')
const {invoke}=require('../invoke')
const {auth}=require('./auth')
const {bot}=require('./bot')
const {random}=require('../random')
const imageEdit = require('../imageEdit')
const {removeBackground}=require('../removeBackground')
const {aspectRatio}=require('./aspectRatio')

let commands = [
    {
        name: 'refresh',
        description: 'Regenerate an image with the same settings and a new seed',
        permissionLevel: 'all',
        aliases: ['refresh'],
        command: async (interaction)=>{
            let trackingmsg = null
            try{
                if(!interaction.acknowledged){interaction.acknowledge()}
                //interaction.message.addReaction('🎲')
                trackingmsg = await interaction.channel.createMessage({content:':saluting_face: refreshing'})
            } catch(err){
                log(err)
            }
            let img=null
            let meta = await messageCommands.extractMetadataFromMessage(interaction.message)
            if(meta.invoke?.inputImageUrl){img = await urlToBuffer(meta.invoke.inputImageUrl)}
            let result = await invoke.jobFromMeta(meta,img,{type:'discord',msg:trackingmsg})
            if(meta.invoke?.inputImageUrl && !result.error && result.images?.length > 0){result.images[0].buffer = await exif.modify(result.images[0].buffer,'arty','inputImageUrl',meta.invoke.inputImageUrl)}
            let newmsg = interaction.message
            newmsg.member = interaction.member
            return messageCommands.returnMessageResult(newmsg,result)
        }
    },
    {
        name: 'edit',
        description: 'Capture a modified setting from a modal dialog and apply it to an existing image',
        permissionLevel: 'all',
        aliases: ['edit'],
        command: async (interaction)=>{
            if(!interaction.acknowledged){interaction.acknowledge()}
            let msgid = (interaction.data.custom_id.split('-')[1]==='x')?interaction.message.id : interaction.data.custom_id.split('-')[1]
            let channelid = interaction.channel.id
            let img = null
            //debugLog(interaction.data)
            let key = interaction.data.custom_id.split('-')[2]??interaction.data.components[0].components[0].custom_id
            let value = interaction.data.custom_id.split('-')[2]?interaction.data.values[0]:interaction.data.components[0].components[0].value
            let trackingmsg = null
            trackingmsg = await interaction.channel.createMessage({content:':saluting_face: refreshing with **'+key+'** of `'+value+'`'})
            //interaction.message.addReaction('✏️')
            switch(key){
                case 'scale':{value=parseFloat(value);break}
                case 'steps':{value=parseInt(value);break}
                case 'strength':{value=parseFloat(value);break}
            }
            let sourcemsg = await bot.getMessage(channelid, msgid)
            let meta = await messageCommands.extractMetadataFromMessage(sourcemsg)
            debugLog(interaction.member?.username||interaction.author?.username||interaction.user?.username+' edit '+key+' to: '+value)
            if(meta.invoke){meta.invoke[key] = value}
            if(meta.invoke?.inputImageUrl){img = await urlToBuffer(meta.invoke.inputImageUrl)}
            let result = await invoke.jobFromMeta(meta,img,{type:'discord',msg:trackingmsg})
            if(meta.invoke?.inputImageUrl && !result.error && result.images?.length > 0){result.images[0].buffer = await exif.modify(result.images[0].buffer,'arty','inputImageUrl',meta.invoke.inputImageUrl)}
            let newmsg = sourcemsg
            newmsg.member = interaction.member
            return messageCommands.returnMessageResult(newmsg,result)
        }
    },
    {
        name: 'editResolution',
        description: 'Capture a resolution from a modal dialog and apply it as width and height to an existing image',
        permissionLevel: 'all',
        aliases: ['editResolution'],
        command: async (interaction)=>{
            let msgid = interaction.data.custom_id.split('-')[1]
            let channelid = interaction.channel.id
            let img = null
            let key = interaction.data.components[0].components[0].custom_id
            let value = interaction.data.components[0].components[0].value
            let trackingmsg = null
            trackingmsg = await interaction.channel.createMessage({content:':saluting_face: refreshing with **'+key+'** of `'+value+'`'})
            let sourcemsg = await bot.getMessage(channelid, msgid)
            let meta = await messageCommands.extractMetadataFromMessage(sourcemsg)
            debugLog(interaction.member?.username||interaction.author?.username||interaction.user?.username+' edit '+key+' to: '+value)
            if(meta.invoke){
                let w=value.split('x')[0]
                let h=value.split('x')[0]
                meta.invoke.width = w
                meta.invoke.height = h
            }
            if(meta.invoke?.inputImageUrl){img = await urlToBuffer(meta.invoke.inputImageUrl)}
            let result = await invoke.jobFromMeta(meta,img,{type:'discord',msg:trackingmsg})
            if(meta.invoke?.inputImageUrl && !result.error && result.images?.length > 0){result.images[0].buffer = await exif.modify(result.images[0].buffer,'arty','inputImageUrl',meta.invoke.inputImageUrl)}
            let newmsg = sourcemsg
            newmsg.member = interaction.member
            return messageCommands.returnMessageResult(newmsg,result)
        }
    },
    {
        name: 'editPrompt',
        description: 'Modal dialog to regenerate an image with a new prompt and seed, with the same settings',
        permissionLevel: 'all',
        aliases: ['editPrompt'],
        command: async (interaction)=>{
            if(!interaction.acknowledged){interaction.acknowledge}
            let meta = await messageCommands.extractMetadataFromMessage(interaction.message)
            let prompt = meta.invoke?.positive_prompt+' ['+meta.invoke?.negative_prompt+']'
            return interaction.createModal({
                custom_id:'edit-'+interaction.message.id,
                title:'Edit the random prompt?',
                components:[
                    {type:1,components:[
                        {
                            type:4,
                            custom_id:'prompt',
                            label:'Prompt',
                            style:2,
                            value:prompt,
                            required:true
                        }
                    ]}
                ]
            })
        }
    },
    {
        name: 'editPromptRandom',
        description: 'Modal dialog to regenerate an image with a new random prompt and seed, with the same settings',
        permissionLevel: 'all',
        aliases: ['editPromptRandom'],
        command: async (interaction)=>{
            let prompt = random.get('prompt')
            return interaction.createModal({
                custom_id:'edit-'+interaction.message.id,
                title:'Edit the random prompt?',
                components:[
                    {type:1,components:[
                        {
                            type:4,
                            custom_id:'prompt',
                            label:'Prompt',
                            style:2,
                            value:prompt,
                            required:true
                        }
                    ]}
                ]
            })
        }
    },
    {
        name: 'editScale',
        description: 'Modal dialog to regenerate an image with a new scale and seed, with the same settings',
        permissionLevel: 'all',
        aliases: ['editScale'],
        command: async (interaction)=>{
            if(!interaction.acknowledged){interaction.acknowledge}
            let msgid = interaction.data.custom_id.split('-')[1]
            let channelid = interaction.channel.id
            let sourcemsg = await bot.getMessage(channelid,msgid)
            let meta = await messageCommands.extractMetadataFromMessage(sourcemsg)
            let scale = meta.invoke.scale.toString()
            return interaction.createModal({
                custom_id:'edit-'+sourcemsg.id,
                title:'Edit the scale / cfg_scale',
                components:[
                    {type:1,components:[
                        {
                            type:4,
                            custom_id:'scale',
                            label:'Scale',
                            style:2,
                            value:scale,
                            required:true
                        }
                    ]}
                ]
            })
        }
    },
    {
        name: 'editSteps',
        description: 'Modal dialog to regenerate an image with a new step count and seed, with the same settings',
        permissionLevel: 'all',
        aliases: ['editSteps'],
        command: async (interaction)=>{
            let msgid = interaction.data.custom_id.split('-')[1]
            let channelid = interaction.channel.id
            let sourcemsg = await bot.getMessage(channelid,msgid)
            let meta = await messageCommands.extractMetadataFromMessage(sourcemsg)
            let steps = meta.invoke.steps.toString()
            return interaction.createModal({
                custom_id:'edit-'+sourcemsg.id,
                title:'Edit the step count',
                components:[
                    {type:1,components:[
                        {
                            type:4,
                            custom_id:'steps',
                            label:'Steps',
                            style:2,
                            value:steps,
                            required:true
                        }
                    ]}
                ]
            })
        }
    },
    {
        name: 'editStrength',
        description: 'Modal dialog to regenerate an image with a new strength and seed, with the same settings',
        permissionLevel: 'all',
        aliases: ['editStrength'],
        command: async (interaction)=>{
            if(!interaction.acknowledged){interaction.acknowledge}
            let msgid = interaction.data.custom_id.split('-')[1]
            let channelid = interaction.channel.id
            let sourcemsg = await bot.getMessage(channelid,msgid)
            let meta = await messageCommands.extractMetadataFromMessage(sourcemsg)
            let strength = meta.invoke.strength.toString()
            //let strength = config?.default?.strength?.toString()||'0.7'
            //strength = strength.toString()
            return interaction.createModal({
                custom_id:'edit-'+sourcemsg.id,
                title:'Edit the strength',
                components:[
                    {type:1,components:[
                        {
                            type:4,
                            custom_id:'strength',
                            label:'Strength',
                            style:2,
                            value:strength,
                            required:true
                        }
                    ]}
                ]
            })
        }
    },
    {
        name: 'editResolution',
        description: 'Modal dialog to regenerate an image with a new resolution and seed, with the same settings',
        permissionLevel: 'all',
        aliases: ['editResolution'],
        command: async (interaction)=>{
            let msgid = interaction.data.custom_id.split('-')[1]
            let channelid = interaction.channel.id
            let sourcemsg = await bot.getMessage(channelid,msgid)
            let meta = await messageCommands.extractMetadataFromMessage(sourcemsg)
            let resolution = meta.invoke.width+'x'+meta.invoke.height
            //let strength = config?.default?.strength?.toString()||'0.7'
            //strength = strength.toString()
            return interaction.createModal({
                custom_id:'edit-'+sourcemsg.id,
                title:'Edit the strength',
                components:[
                    {type:1,components:[
                        {
                            type:4,
                            custom_id:'editResolution',
                            label:'Resolution',
                            style:2,
                            value:resolution,
                            required:true
                        }
                    ]}
                ]
            })
        }
    },
    {
        name: 'tweak',
        description: 'Display tweak menu, as a message only visible to the requester',
        permissionLevel: 'all',
        aliases: ['tweak'],
        command: async (interaction)=>{
            let msgid=interaction.message.id
            let tweakmsg = {
                content: ':test_tube: **Tweak Menu**',
                flags: 64,
                components:[
                    {
                        type:1,
                        components:[
                            {type: 2, style: 1, label: 'Aspect Ratio', custom_id: 'chooseAspectRatio-'+msgid, emoji: { name: '📐', id: null}, disabled: false },
                            {type: 2, style: 1, label: 'Models', custom_id: 'chooseModel-'+msgid, emoji: { name: '💾', id: null}, disabled: false },
                            {type: 2, style: 1, label: 'Textual Inversions', custom_id: 'chooseTi-'+msgid, emoji: { name: '💊', id: null}, disabled: true },
                            {type: 2, style: 1, label: 'Loras', custom_id: 'chooseLora-'+msgid, emoji: { name: '💊', id: null}, disabled: true },
                            {type: 2, style: 1, label: 'Control', custom_id: 'chooseControl-'+msgid, emoji: { name: '🎮', id: null}, disabled: true },
                    ]},
                    {
                        type:1,
                        components:[
                            {type: 2, style: 1, label: 'Resolution', custom_id: 'editResolution-'+msgid, emoji: { name: '📏', id: null}, disabled: true },
                            {type: 2, style: 1, label: 'Scale', custom_id: 'editScale-'+msgid, emoji: { name: '⚖️', id: null}, disabled: false },
                            {type: 2, style: 1, label: 'Steps', custom_id: 'editSteps-'+msgid, emoji: { name: '♻️', id: null}, disabled: false },
                            {type: 2, style: 1, label: 'Strength', custom_id: 'editStrength-'+msgid, emoji: { name: '💪', id: null}, disabled: false },
                            {type: 2, style: 1, label: 'Sampler', custom_id: 'chooseSampler-'+msgid, emoji: { name: '👁️', id: null}, disabled: false }
                    ]},
                    {
                        type:1,
                        components:[
                            {type: 2, style: 1, label: 'Remove Background', custom_id: 'removeBackground-'+msgid, emoji: { name: '🪄', id: null}, disabled: false }
                    ]}
                ]
            }
            interaction.createMessage(tweakmsg)
        }
    },
    {
        name: 'chooseModel',
        description: 'Select a model from a dialog and apply it to an image',
        permissionLevel: 'all',
        aliases: ['chooseModel'],
        command: async (interaction)=>{
            // todo make a general purpose function that pages data as needed = 5 dropdowns per page / 25 options per dropdown 
            let msgid = interaction.data.custom_id.split('-')[1]
            let models = await invoke.allUniqueModelsAvailable()
            //debugLog(models) // todo remove after testing
            if(interaction.data.values){
                if(!interaction.acknowledged){interaction.acknowledge()}
                let newmodelname = interaction.data.values[0]
                debugLog('Changing model to '+newmodelname)
                let trackingmsg = await interaction.channel.createMessage({content:':saluting_face: Changing model to '+newmodelname,embeds:[],components:[]})
                let channelid = interaction.channel.id
                let sourcemsg = await bot.getMessage(channelid,msgid)
                let meta = await messageCommands.extractMetadataFromMessage(sourcemsg)
                // todo change resolution when switching between sd1/sdxl models, keep aspect ratio
                // discover base model for old and new selections
                let newmodel = models.find(m=>m.model_name===newmodelname) // undefined ?
                if(meta.invoke?.model?.base_model!==newmodel?.base_model){
                    let ar = await aspectRatio.resToRatio(meta.invoke?.width,meta.invoke?.height)
                    let newpixels = newmodel?.base_model==='sdxl' ? 1048576 : 262144 // 1024x1024 for sdxl, 512x512 for sd1/2
                    let newres = await aspectRatio.ratioToRes(ar,newpixels)
                    if(meta.invoke && newmodel){
                        meta.invoke.width = newres?.width
                        meta.invoke.height = newres?.height
                    }
                }
                if(meta.invoke){meta.invoke.model = newmodelname}
                let img = null
                if(meta.invoke?.inputImageUrl){img = await urlToBuffer(meta.invoke.inputImageUrl)}
                let result = await invoke.jobFromMeta(meta,img,{type:'discord',msg:trackingmsg})
                if(meta.invoke?.inputImageUrl && !result.error && result.images?.length > 0){result.images[0].buffer = await exif.modify(result.images[0].buffer,'arty','inputImageUrl',meta.invoke.inputImageUrl)}
                let newmsg = sourcemsg
                newmsg.member = interaction.member
                return messageCommands.returnMessageResult(newmsg,result)
            }
            let categories=[],sd1=[],sd2=[],sdxl=[],components=[]
            for (const i in models){
                let m = models[i]
                if(m.model_type==='main'){
                    switch(m.base_model){
                        case('sd-1'):{sd1.push(m);break}
                        case('sd-2'):{sd2.push(m);break}
                        case('sdxl'):{sdxl.push(m);break}
                    }
                }
            }
            if(sd1.length>0){categories.push({label:'sd-1',items:sd1})}
            if(sd2.length>0){categories.push({label:'sd-2',items:sd2})}
            if(sdxl.length>0){categories.push({label:'sdxl',items:sdxl})}
            // need a new menu for every 25 options in a category
            let c=0
            for (const i in categories){
                let cat = categories[i]
                let menu = {type:1,components:[{type: 3,custom_id:'chooseModel-'+msgid+'-'+c,placeholder:cat.label+' models',min_values:1,max_values:1,options:[]}]}
                for (m in cat.items){
                    let model = cat.items[m]
                    menu.components[0].options.push({label:model.model_name?.substring(0,50),value:model.model_name,description:model.description?.substring(0,50),emoji:null})
                    // if we hit the limit per dropdown, push the menu into component and ready for new menu
                    if(menu.components[0].options.length===25){debugLog('at limit, pushing menu');components.push(menu);menu.options=[]}
                }
                // If we have any options, push them into component and clear
                if(menu.components[0].options.length>0){
                    components.push(menu)
                    c++
                }
            }
            let dialog = {
                content:':floppy_disk: **Model Menu**\nUse this menu to change the model/checkpoint being used, to give your image a specific style',
                flags:64,
                components:components
            }
            try{
                interaction.editParent(dialog)
            } catch(err) {
                log(err)
                return {error:err}
            }
        }
    },
    {
        name: 'chooseControl',
        description: 'Add, remove and configure control adapters',
        permissionLevel: ['all'],
        aliases: ['chooseControl'],
        command: async (interaction)=>{
            if(!interaction.acknowledged){interaction.acknowledge()}
            let msgid = interaction.data.custom_id.split('-')[1]
            // At first, keep it simple and allow configuring a single control adapter by name
            // need to discover current if base_model is sdxl or not
            // pull image meta
            let channelid = interaction.channel.id
            let sourcemsg = await bot.getMessage(channelid,msgid)
            let meta = await messageCommands.extractMetadataFromMessage(sourcemsg)
            let base = meta?.invoke?.model?.base_model
            debugLog(base)
            debugLog(meta?.invoke?.inputImageUrl)
            debugLog(meta?.invoke?.inputImageUrl)
            // get all controlnet types
            let cnets = await invoke.allUniqueControlnetsAvailable()
            // reduce to simple array of names of relevant models
            cnets = cnets.filter(c=>c.base_model===base).map(c=>c.model_name)
            // get all ip adapter types
            let ipa = await invoke.allUniqueIpAdaptersAvailable()
            ipa = ipa.filter(c=>c.base_model===base).map(c=>c.model_name)
        }
    },
    {
        name: 'remove',
        description: 'Allow either the creator or bot admin to remove a result',
        permissionLevel: ['all'],
        aliases: ['remove'],
        command: async (interaction)=>{
            if(!interaction.acknowledged){interaction.acknowledge()}
            let msgid=interaction.message.id
            let msg=await bot.getMessage(interaction.channel.id,msgid)
            // should immediately delete for admin, creator, guild admin
            // otherwise add 🗑️ emoji if not already existing 
            // and tell user to click it to confirm their vote for removal
            // todo needs more testing for private DM's where we cannot delete
            if(
                (interaction.member?.id===config.adminID)|| // admin
                (msg.mentions.length>0&&interaction.member?.id===msg.mentions[0].id) // creator
                ){
                // admin or owner can delete
                // tag the original request so its obvious what happened
                if(interaction.message.messageReference&&interaction.message.messageReference.messageID!==null){
                    try{
                        let sourcemsg = await bot.getMessage(interaction.channel.id,interaction.message.messageReference.messageID)
                        if(sourcemsg.member.id!==bot.application.id){sourcemsg.addReaction('🗑️')}
                    } catch(err){log(err)}
                }
                try{msg.delete()}catch(err){debugLog('Discord error removing message');debugLog(err)}
            } else {
                // otherwise make them show their vote
                try{
                    msg.addReaction('🗑️')
                    interaction.createMessage({content:'Confirm your vote for removal by clicking the :wastebasket: emoji on the render',flags:64})
                } catch (err) {
                    debugLog('Emoji command remove failed')
                    debugLog(err)
                }
            }
        }
    },
    {
        name: 'removeBackground',
        description: 'Remove the background from an image using rembg',
        permissionLevel: ['all'],
        aliases: ['removeBackground'],
        command: async (interaction)=>{
            interaction.editParent({content:':saluting_face: Removing background',embeds:[],components:[]})
            //interaction.acknowledge()
            let userid = interaction.member?.id||interaction.author?.id||interaction.user?.id
            let channelid = interaction.channel.id
            let msgid=interaction.data.custom_id.split('-')[1]
            let msg=await bot.getMessage(channelid,msgid)
            if(messageCommands.messageHasImageAttachments(msg)){
                let url = await messageCommands.extractImageUrlFromMessage(msg)
                let response = await removeBackground(url)
                reply = {
                    content:'<@'+userid+'> removed image background',
                    embeds:[{description:response.msg}],
                    components:[{type:1,components:[
                        {type: 2, style: 1, label: 'Crop', custom_id: 'crop-'+msgid, emoji: { name: '✂️', id: null}, disabled: false }
                    ]}
                    ]
                }
                interaction.createMessage(reply,{file:response.image,name:getUUID()+'.png'})
                //log(response)
            }
        }
    },
    {
        name: 'crop',
        description: 'Automatically crop the image using jimp',
        permissionLevel: ['all'],
        aliases: ['crop'],
        command: async (interaction)=>{
            if(!interaction.acknowledged){interaction.acknowledge()}
            let userid = interaction.member?.id||interaction.author?.id||interaction.user?.id
            let msgid=interaction.data.custom_id.split('-')[1]
            let msg=await bot.getMessage(interaction.channel.id,msgid)
            if(messageCommands.messageHasImageAttachments(msg)){
                let url = await messageCommands.extractImageUrlFromMessage(msg)
                let response = await removeBackground(url)
                reply = {content:'<@'+userid+'> cropped image (buggy, WIP)',}
                interaction.createMessage(reply,{file:response.image,name:getUUID()+'.png'})
            }
        }
    },
    {
        name:'chooseAspectRatio',
        description: 'Dialog to select an aspect ratio',
        permissionLevel:['all'],
        aliases:['chooseAspectRatio'],
        command: async (interaction)=>{
            if(!interaction.acknowledged){interaction.acknowledge()}
            let msgid = interaction.data.custom_id.split('-')[1]
            let msg=await bot.getMessage(interaction.channel.id,msgid)
            if(messageCommands.messageHasImageAttachments(msg)){
                let meta = await messageCommands.extractMetadataFromMessage(msg)
                if(meta && meta.invoke && meta.invoke.width && meta.invoke.height){
                    let pixels = parseInt(meta.invoke?.height) * parseInt(meta.invoke?.width)
                    if(interaction.data.values){
                        let res = await aspectRatio.ratioToRes(interaction.data.values[0],pixels)
                        let trackingmsg = await interaction.channel.createMessage({content:':saluting_face: '+res.description+' '+res.width+' x '+res.height+' selected',components:[],embeds:[]})
                        meta.invoke.width = res.width
                        meta.invoke.height = res.height
                        let img = null
                        if(meta.invoke?.inputImageUrl){img = await urlToBuffer(meta.invoke.inputImageUrl)}
                        let result = await invoke.jobFromMeta(meta,img,{type:'discord',msg:trackingmsg})
                        if(meta.invoke?.inputImageUrl && !result.error && result.images?.length > 0){result.images[0].buffer = await exif.modify(result.images[0].buffer,'arty','inputImageUrl',meta.invoke.inputImageUrl)}
                        let newmsg = msg
                        newmsg.member = interaction.member
                        return messageCommands.returnMessageResult(newmsg,result)
                    } else {
                        let dialog = await aspectRatio.dialog(msgid,pixels)
                        interaction.editParent(dialog)
                    }
                }
            }
        }
    },
    {
        name:'chooseSampler',
        description:'Collect a scheduler / sampler choice from the user via a dropdown menu',
        permissionLevel: ['all'],
        aliases: ['chooseSampler'],
        command: async (interaction)=>{
            let msgid = interaction.data.custom_id.split('-')[1]
            if(interaction.data.values){
                // capture a response instead of asking for one
                if(!interaction.acknowledged){interaction.acknowledge()}
                let trackingmsg = await interaction.channel.createMessage({content:':saluting_face: refreshing with **Scheduler** of `'+interaction.data.values[0]+'`'})
                let channelid = interaction.channel.id
                let sourcemsg = await bot.getMessage(channelid,msgid)
                let meta = await messageCommands.extractMetadataFromMessage(sourcemsg)
                let img = null
                meta.invoke.scheduler = interaction.data.values[0]
                if(meta.invoke.inputImageUrl){img = await urlToBuffer(meta.invoke.inputImageUrl)}
                let result = await invoke.jobFromMeta(meta,img,{type:'discord',msg:trackingmsg})
                if(meta.invoke.inputImageUrl && !result.error && result.images?.length > 0){result.images[0].buffer = await exif.modify(result.images[0].buffer,'arty','inputImageUrl',meta.invoke.inputImageUrl)}
                let newmsg = interaction.message
                newmsg.member = interaction.member
                newmsg.message_reference=null
                newmsg.messageReference=null
                return messageCommands.returnMessageResult(newmsg,result)    
            }
            var changeSamplerResponse={
                content:':eye: **Sampler / Scheduler Menu**\nUse this menu to change the sampler being used',
                flags:64,
                components:[
                    {
                        type:1,
                        components:[
                            {
                                type: 3,
                                custom_id:'chooseSampler-'+msgid,
                                placeholder:'Choose a sampler / scheduler',
                                min_values:1,
                                max_values:1,
                                options:[]
                            }
                        ]
                    }
                ]
            }
            config.schedulers.forEach((s)=>{
                changeSamplerResponse.components[0].components[0].options.push({label: s,value: s})
            })
            return interaction.editParent(changeSamplerResponse)//.then((r)=>{}).catch((e)=>{console.error(e)})
        }
    }
]

let prefixes=[]
commands.forEach(c=>{c.aliases.forEach(a=>{prefixes.push(a)})})

parseCommand = async(interaction)=>{
    //debugLog(interaction)
    // normalise values between responses in channel and DM
    let userid = interaction.member?.id||interaction.author?.id||interaction.user?.id
    let username = interaction.user?.username||interaction.member?.username||interaction.author?.username
    let channelid = interaction.channel.id
    let guildid = interaction.guildID||'DM'
    if(!auth.check(userid,guildid,channelid)){return} // if not authorised, ignore
    let command = interaction.data.custom_id.split('-')[0]
    if(prefixes.includes(command)){
        commands.forEach(c=>{
            c.aliases.forEach(async a=>{
                if(command===a){
                    try{
                        // todo multi-tier permissions system
                        switch(c.permissionLevel){
                            case 'all':{break} // k fine
                            case 'admin':{
                                if(parseInt(userid)!==config.adminID){
                                    log('Denied admin command for '+username)
                                    return
                                }
                                break
                            }
                            case 'creator':{
                                // todo need creator discord id
                                break
                            }
                        }
                        //log(interaction)
                        log(c.name+' triggered by '+username+' in '+interaction.channel?.name||interaction.channel?.id+' ('+interaction.member?.guild?.name||'DM'+')')
                        let result = await c.command(interaction)
                        let messages = result?.messages
                        let files = result?.files
                        let error = result?.error
                        if(error){
                            log('Error: '.bgRed+' '+error)
                            interaction.createMessage({content:':warning: '+error,flags:64})
                            return
                        }
                        if(!Array.isArray(messages)){messages=[messages]}
                        if(!Array.isArray(files)){files=[files]}
                        // unpack messages array and send each msg seperately
                        // if we have a file for each message, pair them up
                        // if we have multi messages and 1 file, attach to first message only
                        // todo If there are more files then there are messages attempt to bundle all files on first message
                        messages.forEach(message=>{
                            if(files.length>0)file=files.shift() // grab the top file
                            if(message&&file){
                            chat(channelid,message,file) // Send message with attachment
                            }else if(message){
                            chat(channelid,message) // Send message, no attachment
                            }
                        })
                    }catch(e){log('error in componentCommands\\parseCmd');log(e)}
                }
            })
        })
    } else {
        return interaction.createMessage({content:'Command does not exist', flags:64}).catch((e) => {
            log('command does not exist'.bgRed)
            log(e)
        })
    }
}

module.exports = {
    componentCommands:{
        commands,
        prefixes,
        parseCommand
    }
}
