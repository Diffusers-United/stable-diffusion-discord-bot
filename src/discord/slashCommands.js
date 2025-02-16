const {config,log,debugLog,urlToBuffer,getRandomColorDec,getUUID,timestamp,shuffle}=require('../utils')
const {bot}=require('./bot')
const {invoke}=require('../invoke')
const {messageCommands}=require('./messageCommands')
const {exif}=require('../exif')
const {auth}=require('./auth')
const {llm}=require('../plugins/llm/llm')
const Eris = require("eris")
const stripeIntegration = require("../payment/stripeIntegration.js")
const Collection = Eris.Collection
const {fonturls} = require('../fonturls')
const paymentService = require('../payment/paymentService')
const { credits: { balance, decrement } } = require('../credits.js');
const { discord } = require('./discord.js')
const { User } = require('../db.js')
const { fetchUserByDiscord } = require('../repository.js')
const { constants } = require('crypto')
// Get samplers from config ready for /dream slash command
var samplers=config.schedulers||['euler','deis','ddim','ddpm','dpmpp_2s','dpmpp_2m','dpmpp_2m_sde','dpmpp_sde','heun','kdpm_2','lms','pndm','unipc','euler_k','dpmpp_2s_k','dpmpp_2m_k','dpmpp_2m_sde_k','dpmpp_sde_k','heun_k','lms_k','euler_a','kdpm_2_a','lcm']
var samplersSlash=[]
samplers.forEach((s)=>{samplersSlash.push({name: s, value: s})})
var defaultSampler=config.default.scheduler?config.default.scheduler:'dpmpp_2m_sde_k'
debugLog('Enabled samplers: '+samplers.join(','))
debugLog('Default sampler:'+defaultSampler)

// load our own font list from config
var fonts = ['Arial','Comic Sans MS','Tahoma','Times New Roman','Verdana','Lucida Console']
var fontsSlashCmd = []
fonts.forEach((f)=>{fontsSlashCmd.push({name: f,value: f})})

// slash command setup - beware discord global limitations on the size/amount of slash command options
var slashCommands = [
  {
    name: 'dream',
    description: 'Create a new image from your prompt',
    options: [
      {type: 3, name: 'prompt', description: 'what you want to see ?', required: true, min_length: 1, max_length:1500 },
      {type: 3, name: 'negative', description: 'what dont you want to see ?', required: false, min_length: 1, max_length:1500 },
      {type: 3, name: 'style', description: 'Positive style prompt (sdxl only)', required: false, min_length: 1, max_length:1500 },
      {type: 3, name: 'negstyle', description: 'Negative style prompt (sdxl only)', required: false, min_length: 1, max_length:1500 },
      {type: 4, name: 'width', description: 'width of the image in pixels', required: false, min_value: 256, max_value: 2048 },
      {type: 4, name: 'height', description: 'height of the image in pixels', required: false, min_value: 256, max_value: 2048 },
      {type: 4, name: 'steps', description: 'how many steps to render for', required: false, min_value: 5, max_value: config.maximum.steps??100 },
      {type: 4, name: 'seed', description: 'seed (initial noise pattern)', required: false},
      {type: 10, name: 'strength', description: 'how much noise to add to your input image (0.1-0.9)', required: false, min_value:0.01, max_value:0.99},
      {type: 10, name: 'scale', description: 'how important is the prompt (cfg_scale)', required: false, min_value:1, max_value:30},
      {type: 4, name: 'number', description: 'how many would you like', required: false, min_value: 1, max_value: config.maximum.iterations??10},
      {type: 3, name: 'model', description: 'Change the model/checkpoint - see !models for more info', required: false,   min_length: 3, max_length:40},
      {type: 3, name: 'sampler', description: 'which sampler to use (default is '+defaultSampler+')', required: false, choices: samplersSlash},
      {type: 4, name: 'clipskip', description: 'clip skip (0-10)', required: false},
      {type: 11, name: 'attachment', description: 'use template image', required: false},
      {type: 3, name: 'control', description: 'controlnet mode to use with attachment', required: false, min_length: 3, max_length:40},
    ],
    cooldown: 500,
    /**
     * 
     * @param {Eris.CommandInteraction} i 
     * @returns 
     */
    execute: async(i) => {
      let img,imgurl
      let userid=i.member?.id??i.user?.id
      let username=i.member?.username??i.user?.username
      const [databaseUser, isCreated] = await fetchUserByDiscord(username, userid);
      if (i.data.resolved && i.data.resolved.attachments && i.data.resolved.attachments.find(a=>a.contentType.startsWith('image/'))){
        let attachmentOrig=i.data.resolved.attachments.find(a=>a.contentType.startsWith('image/'))
        imgurl = attachmentOrig.url
        img = await urlToBuffer(imgurl)
      }
      log(username+' triggered dream command')
      let job={}
      try {
        let trackingmsg = await i.createMessage({content:':saluting_face: dreaming '+timestamp()})
        job.tracking = {type:'discord',msg:trackingmsg}
      } catch (err) {
        debugLog('Error creating tracking msg')
        debugLog(err)
      }
      
      for (const arg in i.data.options){
        let a = i.data.options[arg]
        switch (a.name){
          case('prompt'):job.prompt=a.value;break
          case('negative'):job.prompt=job.prompt+'['+a.value+']';break
          case('attachment'):break
          default:job[a.name]=a.value;break
        }
      }
      if(img){job.initimg=img}
      job = await invoke.validateJob(job)
      job.creator=await getCreatorInfoFromInteraction(i)
      job = await auth.userAllowedJob(job, databaseUser, invoke.getJobCost(job));
      console.log("Job after UserAllowed", job);
      if(job.error){
          const error = job.error;
          log('Error: '.bgRed+' '+error);
          console.log("job.error after UserAllowedJob");
          await i.createMessage({content:`<@${userid}>` + ':warning: '+ job.error});
          await i.deleteOriginalMessage();
          return
      }
      let dreamresult = await invoke.cast(job)
      if(imgurl && !dreamresult.error && dreamresult.images?.length > 0){dreamresult.images[0].buffer = await exif.modify(dreamresult.images[0].buffer,'arty','inputImageUrl',imgurl)}
      let fakemsg = {member:{id:userid},fake:true}
      let result = await returnMessageResult(fakemsg,dreamresult)
      let messages = result?.messages
      let files = result?.files
      let error = result?.error
      if(error){
          log('Error: '.bgRed+' '+error)
          i.createMessage({content:':warning: '+error})
          return
      }

      // Calculate the cost of the generation based on the job parameters
      let cost = invoke.getJobCost(job);
      console.log("JOB COST", job, cost);
      // Check the user's balance
      const userBalance = databaseUser.credits;
      // Generation successful, deduct the cost from the user's balance
      databaseUser.credits = userBalance - cost;
      await databaseUser.save();
      // ------------------------------------------------------------------

      messages.forEach(message=>{
        debugLog(message)
        if(files.length>0)file=files.shift() // grab the top file
        if(message&&file){
          i.createMessage(message,file) // Send message with attachment
        }else if(message){
          i.createMessage(message) // Send message, no attachment
        }
      })
    }
},
  {
    name: 'background',
    description:'Remove the background from an image',
    cooldown:500,
    options:[
      {type: 11, name: 'image', description: 'image to remove background from', required: true}
    ],
    execute: async(i) => {
      let userid=i.member?.id??i.user?.id
      let username=i.member?.username??i.user?.username
      if (i.data.resolved && i.data.resolved.attachments && i.data.resolved.attachments.find(a=>a.contentType.startsWith('image/'))){
        let attachmentOrig=i.data.resolved.attachments.find(a=>a.contentType.startsWith('image/'))
        let imgurl = attachmentOrig.url
        //let response = await removeBackground(imgurl)
        let img = await urlToBuffer(imgurl)
        if (img){
          let result = await invoke.processImage(img,null,'removebg',{})
          if(result?.images?.length>0){
            let buf = result.images[0]?.buffer
            let reply = {
                content:'',
                embeds:[{description:'<@'+userid+'> removed image background',color:getRandomColorDec()}]
            }
            i.createMessage(reply,{file:buf,name:getUUID()+'.png'})
          }
        }
        //i.createMessage(reply,{file:response.image,name:getUUID()+'.png'})
      } else {
        // Invalid or no image attachment, fail
      }
    }
  },
  {
    name: 'text',
    description: 'Create an image with text',
    cooldown: 500,
    options:[
      {type: 3, name: 'row1', description: 'Text', required: true, min_length: 1, max_length:1000 },
      {type: 3, name: 'row2', description: 'Text row 2', required: false, min_length: 1, max_length:1000 },
      {type: 4, name: 'width', description: 'width of the image in pixels', required: false, min_value: 256, max_value: 1024 },
      {type: 4, name: 'height', description: 'height of the image in pixels', required: false, min_value: 256, max_value: 1024 },
      {type: 4, name: 'padding', description: 'padding around text in pixels', required: false, min_value: 0, max_value: 1000 },
      {type: 4, name: 'gap', description: 'gap between rows in pixels', required: false, min_value: 0, max_value: 1000 },
      {type: 4, name: 'row2size', description: 'row 2 font size', required: false, min_value: 5, max_value: 100 },
    ],
    execute: async(i) => {
      let userid=i.member?.id??i.user?.id
      let username=i.member?.username??i.user?.username
      log(username+' triggered text command')
      let options = {}
      for (const arg in i.data.options){
        let a = i.data.options[arg]
        switch(a.name){
          default:options[a.name]=a.value;break
        }
      }
      let f = fonturls.random()
      let fonturl = f.url
      /*
      if(options.font){
          // convert font name to font url
          fonturl=fonturls.get(options.font)
          if(!fonturl){return {error:'Unable to find font name `'+options.font+'`'}}
      }
      */
      let parsedOptions = {
        text_input:options.row1??'arty',
        text_input_second_row:options.row2??'',
        second_row_font_size:options.row2size??'',
        font_url:fonturl,
        local_font_path:'',
        local_font:'',
        image_width:options.width??1024,
        image_height:options.height??1024,
        padding:options.padding??100,
        row_gap:options.gap??50
      }
      let result = await invoke.textFontImage(parsedOptions)
      if(result.error||result.images.length==0){
        i.createMessage({embeds:[{description:':warning: Failed to create text image',color:getRandomColorDec()}]})
      } else {
        let response = {
            embeds:[
                {description:':tada: textfontimage result for <@'+userid+'>\nText: `'+parsedOptions.text_input+'`, Width:`'+result.images[0].width+'` , Height: `'+result.images[0].height+'`, Font: `'+f.name+'`, Padding: `'+parsedOptions.padding+'`, Gap: `'+parsedOptions.row_gap+'`',color:getRandomColorDec()}
            ]
        }
        i.createMessage(response,{file:result.images[0].buffer,name:result.images[0].name})
      }
    }
  },
  {
    name:'describe',
    description:'Describe an image',
    cooldown:500,
    options:[
      {type: 11, name: 'image', description: 'image to describe', required: true},
      //{type: 3, name: 'clip', description: 'clip model to use', required: false,choices:[{name:'ViT-L-14/openai',value:'ViT-L-14/openai'},{name:'ViT-H-14/laion2b_s32b_b79k',value:'ViT-H-14/laion2b_s32b_b79k'},{name:'ViT-bigG-14/laion2b_s39b_b160k',value:'ViT-bigG-14/laion2b_s39b_b160k'}]},
      //{type: 3, name: 'caption', description: 'caption model to use', required: false,choices:[{name:'blip-base',value:'blip-base'},{name:'blip-large',value:'blip-large'},{name:'blip2-2.7b',value:'blip2-2.7b'},{name:'blip2-flan-t5-xl',value:'blip2-flan-t5-xl'},{name:'git-large-coco',value:'git-large-coco'}]}
    ],
    execute: async(i)=>{
      if (i.data.resolved && i.data.resolved.attachments && i.data.resolved.attachments.find(a=>a.contentType.startsWith('image/'))){
        let attachmentOrig=i.data.resolved.attachments.find(a=>a.contentType.startsWith('image/'))
        let imgurl = attachmentOrig.url
        let img = await urlToBuffer(imgurl)
        let interrogateOptions={best_max_flavors:32,mode:'fast',clip_model:'ViT-L-14/openai',caption_model:'blip-large',low_vram:true}
        /* Removed options, larger models use too much vram for most consumer cards
        for (const arg in i.data.options){
          let a = i.data.options[arg]
          switch (a.name){
            case('clip'):interrogateOptions.clip_model=a.value;break
            case('caption'):interrogateOptions.caption_model=a.value;break
            case('flavors'):interrogateOptions.best_max_flavors=a.value;break
            case('mode'):interrogateOptions.mode=a.value;break
            case('lowvram'):interrogateOptions.low_vram=a.value;break
          }
        }
        */
        let result = await invoke.interrogate(img,undefined,interrogateOptions)
        let options = result.options
        let newMsg = {
            content:':eyes: Image scanned with `'+options.clip_model+'`, captioned by `'+options.caption_model+'`:',
            embeds:[{description:result.result,color:getRandomColorDec(),thumbnail:{url:imgurl}}]
        }
        i.createMessage(newMsg)
      }
    }
  },
  {
    name: 'help',
    description: 'Learn how to use this bot',
    cooldown: 500,
    execute: (i) => {
      let helpTitles=['let\'s get wierd','help me help you','help!','wait, what ?']
      shuffle(helpTitles)
      let m='```diff\n'
      for (const c in slashCommands){
          let cmd=slashCommands[c]
          m+='-| /'+cmd.name+': '
          m+='\n+| '+cmd.description+'\n\n'
      }
      m+='```\n```yaml\nSee these link buttons below for more commands and info. !help for more advanced options```'
      var helpMsgObject={
          content: '',
          embeds: [
              {
                  type:'rich',
                  title:helpTitles[0],
                  description:m,
                  color:getRandomColorDec()
              }
          ],
          components: [
              {type: 1, components:[
                  {type: 2, style: 5, label: "Intro Post", url:'https://peakd.com/@ausbitbank/our-new-stable-diffusion-discord-bot', emoji: { name: 'hive', id: '1110123056501887007'}, disabled: false },
                  {type: 2, style: 5, label: "Github", url:'https://github.com/ausbitbank/stable-diffusion-discord-bot', emoji: { name: 'Github', id: '1110915942856282112'}, disabled: false },
                  {type: 2, style: 5, label: "Commands", url:'https://github.com/ausbitbank/stable-diffusion-discord-bot/blob/main/commands.md', emoji: { name: 'Book_Accessibility', id: '1110916595863269447'}, disabled: false },
                  {type: 2, style: 5, label: "Privacy Policy", url:'https://gist.github.com/ausbitbank/cd8ba9ea6aa09253fcdcdfad36b9bcdd', emoji: { name: '📜', id: null}, disabled: false },
              ]}
          ]
      }
      i.createMessage(helpMsgObject)
    }
  },

]
/*,
  {
    name: 'models',
    description: 'See what models are currently available',
    cooldown: 1000,
    execute: (i) => {
      listModels(i.channel.id)
    }
  },
  {
    name: 'embeds',
    description: 'See what embeddings are currently available',
    cooldown: 1000,
    execute: (i) => {
      listEmbeds(i.channel.id)
    }
  },
  {
    name: 'text',
    description: 'Add text overlays to an image',
    options: [
      {type: 3, name: 'text', description: 'What to write on the image', required: true, min_length: 1, max_length:500 },
      {type: 11, name: 'attachment', description: 'Image to add text to', required: true},
      {type: 3, name: 'position', description: 'Where to position the text',required: false,value: 'south',choices: [{name:'centre',value:'centre'},{name:'north',value:'north'},{name:'northeast',value:'northeast'},{name:'east',value:'east'},{name:'southeast',value:'southeast'},{name:'south',value:'south'},{name:'southwest',value:'southwest'},{name:'west',value:'west'},{name:'northwest',value:'northwest'}]},
      {type: 3, name: 'color', description: 'Text color (name or hex)', required: false, min_length: 1, max_length:50 },
      {type: 3, name: 'blendmode', description: 'How to blend the text layer', required: false,value:'overlay',choices:[{name:'clear',value:'clear'},{name:'over',value:'over'},{name:'out',value:'out'},{name:'atop',value:'atop'},{name:'dest',value:'dest'},{name:'xor',value:'xor'},{name:'add',value:'add'},{name:'saturate',value:'saturate'},{name:'multiply',value:'multiply'},{name:'screen',value:'screen'},{name:'overlay',value:'overlay'},{name:'darken',value:'darken'},{name:'lighten',value:'lighten'},{name:'color-dodge',value:'color-dodge'},{name:'color-burn',value:'color-burn'},{name:'hard-light',value:'hard-light'},{name:'soft-light',value:'soft-light'},{name:'difference',value:'difference'},{name:'exclusion',value:'exclusion'}] }, // should be dropdown
      {type: 3, name: 'width', description: 'How many pixels wide is the text?', required: false, min_length: 1, max_length:5 },
      {type: 3, name: 'height', description: 'How many pixels high is the text?', required: false, min_length: 1, max_length:5 },
      {type: 3, name: 'font', description: 'What font to use', required: false,value:'Arial',choices:fontsSlashCmd},
      {type: 5, name: 'extend', description: 'Extend the image?', required: false},
      {type: 3, name: 'extendcolor', description: 'What color extension?', required: false, min_length: 1, max_length:10 },
    ],
    cooldown: 500,
    execute: (i) => {
      var ops=i.data.options
      var {text='word',position='south',color='white',blendmode='difference',width=false,height=125,font=fonts[0],extend=false,extendcolor='black'}=ops.reduce((acc,o)=>{acc[o.name]=o.value;return acc}, {})
      var userid=i.member ? i.member.id : i.user.id
      if (i.data.resolved && i.data.resolved.attachments && i.data.resolved.attachments.find(a=>a.contentType.startsWith('image/'))){
        var attachmentOrig=i.data.resolved.attachments.find(a=>a.contentType.startsWith('image/'))
      }
      textOverlay(attachmentOrig.proxyUrl,text,position,i.channel.id,userid,color,blendmode,parseInt(width)||false,parseInt(height),font,extend,extendcolor)
    }
  },
  {
    name: 'background',
    description: 'Remove background from an image',
    options: [
      {type:11,name:'attachment',description:'Image to remove background from',required:true},
      {type: 3, name: 'model', description: 'Which masking model to use',required: false,value: 'u2net',choices: [{name:'u2net',value:'u2net'},{name:'u2netp',value:'u2netp'},{name:'u2net_human_seg',value:'u2net_human_seg'},{name:'u2net_cloth_seg',value:'u2net_cloth_seg'},{name:'silueta',value:'silueta'},{name:'isnet-general-use',value:'isnet-general-use'}]},
      {type: 5, name: 'a', description: 'Alpha matting true/false', required: false,default:false},
      {type: 4, name: 'ab', description: 'Background threshold 0-255 default 10', required: false,min_length:1,max_length:3,value:10},
      {type: 4, name: 'af', description: 'Foreground threshold 0-255 default 240', required: false,value:240},
      {type: 4, name: 'ae', description: 'Alpha erode size 0-255 default 10', required: false,value:10},
      {type: 5, name: 'om', description: 'Mask Only true/false default false', required: false,value:false},
      {type: 5, name: 'ppm', description: 'Post Process Mask true/false default false', required: false,value:false},
      {type: 3, name: 'bgc', description: 'Background color R,G,B,A 0-255 default 0,0,0,0', required: false}
    ],
    cooldown: 500,
    execute: (i) => {
      if (i.data.resolved && i.data.resolved.attachments && i.data.resolved.attachments.find(a=>a.contentType.startsWith('image/'))){
        var attachmentOrig=i.data.resolved.attachments.find(a=>a.contentType.startsWith('image/'))
        var userid=i.member ? i.member.id : i.user.id
        var ops=i.data.options
        debugLog(ops)
        var {model='u2net',a=false,ab=10,af=240,ae=10,om=false,ppm=false,bgc='0,0,0,0'}=ops.reduce((acc,o)=>{acc[o.name]=o.value;return acc}, {})
        removeBackground(attachmentOrig.proxyUrl,i.channel.id,userid,model,a,ab,af,ae,om,ppm,bgc)
      }
    }
  }*/

// If credits are active, add /recharge and /balance otherwise don't include them

if(config.credits.enabled)
{

  slashCommands.push({
    name: 'recharge',
    description: 'Recharge your render credits with Hive, HBD or Bitcoin over lightning network',
    cooldown: 500,
    permissionLevel: 'all',
    /**
     * 
     * @param {Eris.CommandInteraction} i 
     */
    execute: async (i) => {
      await i.createMessage({
        content: 'Click on the button below to get your payment link',
        components: [{
          type: 1,
          components: [
            {type:2,style:1,label:'Get Link',custom_id:'generateRechargeLink',disabled:false}
          ]
        }]
      });
    }
  })

  slashCommands.push({
    name: 'balance',
    description: 'Check your credit balance',
    cooldown: 500,
    execute: async (i) => {
      const balance = await paymentService.discordBalancePrompt(i);
      await i.createMessage(`You have ${balance} credits.`);
    }
  })

  slashCommands.push({
    name: 'verify',
    description: 'Runs the payment link verification job',
    cooldown: 500,
    execute: async (i) => {
      await stripeIntegration.verifyPaymentLinksJob(discord);
    }
  })
}

// if llm is enabled in config, add its /chat slash command to the mix
if(config.llm?.enabled){
  let llmpersonas = config.llm?.personas ?? []
  let llmpersonasChoices = []
  for (const llmpersona in llmpersonas){
    llmpersonasChoices.push({name:llmpersonas[llmpersona].name,value:llmpersonas[llmpersona].name})
  }
  slashCommands.push({
    name:'chat',
    description:'Chat with an AI',
    cooldown:2000,
    options:[
      {type: 3,name:'prompt',description:'What do you want to ask?',required:true,min_length:1,max_length:6000},
      {type: 3, name:'persona',description:'Pick a personality type for the bot',required:false,value:'',choices:llmpersonasChoices},
      {type: 3,name:'systemprompt',description:'Customise the system prompt to change how the bot behaves (advanced)',required:false,min_length:1,max_length:6000}
    ],
    execute:async(i)=>{
      let userid=i.member?.id??i.user?.id
      let username=i.member?.username??i.user?.username
      log(username+' triggered chat command')
      let options = {}
      if(!i?.acknowledged){i.acknowledge()}
      let allowed = await auth.userAllowedFeature({discordid:userid,username:username},'llm')
      if(!allowed){return {error:'llm is for members only'}}
      for (const arg in i.data.options){
        let a = i.data.options[arg]
        switch(a.name){
          default:options[a.name]=a.value;break
        }
      }
      let newprompt = options.prompt
      let systemprompt = options.systemprompt ?? undefined
      if(options.persona){systemprompt = llmpersonas.find(persona=>persona.name===options.persona)?.prompt}
      let newMessage
      let color = getRandomColorDec()
      let latestUpdate = null
      let intervalId = null
      let isUpdating = false
      let done = false
      let page = 0
      let pages = 0
      let maxlength = 4000
      // 4096 actual maximum per embed field (for 6k chars total across all embeds), maxlength 4k leaves 2k chars for content and 2k for another embed field
      let initResponse = ':thought_balloon: `'+newprompt.substr(0,1000)+'`'
      if(options.persona){initResponse+=' :brain: `'+options.persona+'`'}
      if(options.systemprompt){initResponse+=' :face_in_clouds:'}
      let modelname = null
      let stream = await llm.chatStream(newprompt,systemprompt)
      if(stream.error){return {error:stream.error}}

      startEditing=()=>{
          intervalId = setInterval(()=>{
              if(!isUpdating&&latestUpdate){
                  const update = latestUpdate
                  latestUpdate=null
                  isUpdating=true
                  let fulltext = update.embeds[0].description
                  let newpage = Math.floor(fulltext.length/maxlength)
                  let pageContentStart = page * maxlength
                  let pageContentEnd = pageContentStart + maxlength
                  let pageContent = fulltext.substr(pageContentStart,pageContentEnd)
                  update.embeds[0].description = pageContent
                  if(page>pages){
                    i.createFollowup(update)
                      .then(async(newmsg)=>{
                        pages++
                        newMessage = newmsg
                        isUpdating=false
                      })
                      .catch((err)=>{isUpdating=false;log(err)})
                  } else {
                    bot.editMessage(newMessage.channel?.id,newMessage.id,update)
                        .then(()=>{
                          isUpdating=false
                          if(newpage>page){page++}
                        })
                        .catch((err)=>{
                          log('Failed to edit message, aborting LLM edit loop')
                          clearInterval(intervalId)
                          log(err)
                          isUpdating=false
                        })
                  }
              }
              if(!isUpdating&&done&&page===pages){clearInterval(intervalId)} // if we're done, shut down the timer
          },1000) // check every 1s
      }
      let lastsnapshot = ''
      let currentMessage = initResponse
      stream.on('content', (delta,snapshot)=>{
          if(snapshot.trim().length>0&&lastsnapshot!==snapshot){
            const newContent = currentMessage + snapshot
            latestUpdate={content:initResponse, embeds:[{description:snapshot,color:color}]}
            if(modelname){
              latestUpdate.embeds.push({description:':floppy_disk: '+modelname})
            }
            currentMessage = newContent
            lastsnapshot = snapshot
          }
      })
      stream.on('finalMessage',(finalmsg)=>{
        done=true
        debugLog(stream)
        if(stream._chatCompletions[0]?.model){
          let modelpath = stream._chatCompletions[0].model
          modelname = modelpath.replace(/^.*[\\\/]\/+(.*?(?:\.[^.\/]*$))/, '$1')
        }
        log('Finished LLM response: '+finalmsg.content)
      })
      stream.on('error', (error)=>{
          log('LLM Stream error:')
          log(error)
      })
      i.createMessage(initResponse)
          .then(async(newmsg)=>{
            newMessage = newmsg
            startEditing()
          })
          .catch((err)=>{log(err)})
    }
  })
}
init = async()=>{
  // check status of command registration
  // register any commands that aren't already registered
  // update any commands that are registered, but modified
  // remove any registered commands from old version that aren't recreated yet
  let currentCommands = await bot.getCommands()
  bot.commands = new Collection()
  for (const c of slashCommands) {
    if(currentCommands.filter(cmd=>cmd.name===c.name).length>0) {
      // Already registered
      bot.commands.set(c.name,c)
      // todo check if command is modified and re-register if so
    } else {
      // Not registered
      log('Slash command '+c.name+' is unregistered, registering now')
      bot.commands.set(c.name,c)
      bot.createCommand({name: c.name,description: c.description,options: c.options ?? [],type: 1})
    }
  }
}

unregister = async()=>{await bot.bulkEditCommands([])}

parseCommand = async(interaction)=>{
      // check if its already been registered, send message only visible to user if it's not valid
      if (!bot.commands?.has(interaction.data.name)){return interaction.createMessage({content:'Command does not exist', flags:64})}
      try{
        await interaction.acknowledge()// acknowledge the interacton
        if(!auth.check(interaction.user?.id,interaction.guild?.id??'DM',interaction.channel?.id)){return} // if not authorised, ignore
        bot.commands.get(interaction.data.name).execute(interaction)// run the stored slash command
      }catch(err){
        log(err)
        await interaction.createMessage({content:'There was an error while executing this command!', flags: 64}).catch((e) => {log(e)})
      }
}

getCreatorInfoFromInteraction = async(interaction)=>{
    let userid = interaction.member?.id||interaction.author?.id||interaction.user?.id
    let username = interaction.user?.username||interaction.member?.username||interaction.author?.username
    let channelid = interaction.channel.id
    let guildid = interaction.guildID||'DM'
    log(userid)
    return {discordid:userid,username:username,channelid:channelid,guildid:guildid}
}

module.exports = {
    slashCommands:{
      init,
      slashCommands,
      unregister,
      parseCommand
    }
}
