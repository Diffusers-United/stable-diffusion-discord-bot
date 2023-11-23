// Track progress for a specific job, report to discord on changes
const {log,debugLog,sleep}=require('../utils.js')
const {resultCache}=require('../resultCache')

update = async(msg,batchid)=>{
    // Call once, repetitively update message with results of get(batchid)
    let error=false,done=false,statusmsg=null,cached=null,result=null,interval=500,fails=0
    while(!error&&!done){
        //debugLog('discord tracking progress loop for batch '+batchid)
        try {
            await sleep(interval)
            result = resultCache.get(batchid)
            statusmsg = returnProgressMessage(batchid)
            if(!statusmsg){
                fails++
                if(fails>3){await msg.delete();return}
                continue
            }
            if(statusmsg&&statusmsg!==cached){
                // send message
                cached=statusmsg
                await msg.edit(statusmsg.msg,statusmsg.file)
            }
            if(['completed','failed','cancelled'].includes(result.status)){
                await msg.delete()
                return
            }
        } catch (err) {
            debugLog(err)
            error=true
        }
    }
}

returnProgressMessage = (batchid) =>{
    // Return a formatted discord message tracking progress for a specific batchid
    let err = false
    try {
        let r = resultCache.get(batchid)
        let content= ''//+batchid
        file=null
        if(r){
            switch(r.status){
                case('in_progress'):content=':green_circle: In progress';break
                case('pending'):content=':orange_circle: Pending';break
                case('failed'):content=':red_circle: Failed';break
            }
            content+=' '
            if(r.hostname){content+=' on `'+r.hostname+'`'}
            content+='\n'
            //debugLog(r.results[r.results.length-1])
            if(['in_progress'].includes(r.status)&&r.progress?.step!==undefined){
                let percent = (parseInt(r.progress?.step) / parseInt(r.progress?.total_steps))*100
                content+=emoji(percent/100)+' '+r.progress?.step+' / '+r.progress?.total_steps+' ('+percent.toFixed(0)+'%) '
            } else if(r.results.length>0 && r.results[r.results.length-1].type) {
                content = content + ':floppy_disk: ' + r.results[r.results.length-1].type + '\n'
            }
            /* Cannot edit attachments on an existing message
            /// Can edit image urls if we have public url
            if(r.progress?.progress_image){
                debugLog('progress image')
                debugLog(r.progress.progress_image)
                file=[{file:r.progress.progress_image,name:'preview-'+getUUID()+'.png'}]
            }
            */
        let components = [{type:1,components:[{type:2,style:4,label:'Cancel',custom_id:'cancelBatch-'+batchid,emoji:{name:'🗑️',id:null},disabled:false}]}]
        let msg = {embeds: [{description:content}],components:components}
        return {msg:msg}//,file}
        //return msg
        } else {
            return null
        }
    } catch (err) {
        throw(err)
    }
}


emoji = (percent,emojis=null)=>{
    if(percent===undefined||percent>100||percent===NaN) return ''
    emojiLibrary=[
        [':hourglass_flowing_sand:',':hourglass:'],
        ['🥚','🐣','🐤','🐔','🔥','🍗',':yum:'],
        [':clock12:',':clock1:',':clock2:',':clock3:',':clock4:',':clock5:',':clock6:',':clock7:',':clock8:',':clock9:',':clock10:',':clock11:'],
        [':baby:',':girl:',':woman:',':mirror_ball:',':heart_eyes:',':man_beard:',':kiss_woman_man:',':couple:',':ring:',':wedding:',':kiss_woman_man:',':bouquet:',':dove:',':red_car:',':airplane_departure:',':airplane:',':airplane_arriving:',':hotel:',':bed:',':smirk:',':eggplant:',':astonished:',':cherry_blossom:',':heart_on_fire:',':hushed:',':stuck_out_tongue:',':sweat_drops:',':sweat_smile:',':stuck_out_tongue_closed_eyes:',':stuck_out_tongue_winking_eye:',':sleeping:',':sleeping_accommodation:',':thermometer_face:',':nauseated_face:',':face_vomiting:',':pregnant_woman:',':pregnant_person:',':pregnant_man:',':ambulance:',':hospital:',':cold_sweat:',':face_exhaling:',':face_with_symbols_over_mouth:',':relieved:',':family_mwg:']
    ]
    if (!emojis){emojis=emojiLibrary[1]}
    const numEmojis = emojis.length
    const emojiIndex = Math.floor(percent * numEmojis)
    var emoji = emojis[emojiIndex]
    if(!emoji){emoji=emojis[emojis.length-1]}
    return emoji
}

module.exports = {
    progress:{
        update
    }
}
