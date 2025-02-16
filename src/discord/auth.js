const {config,log,debugLog}=require('../utils.js')
const {db,User}=require('../db.js')
const {credits}=require('../credits.js')

// true/false for if a user,guild,channel is authorised
let allowedUsers=config.authentication.allowed.users
let bannedUsers=config.authentication.banned.users
let allowedGuilds=config.authentication.allowed.guilds
let bannedGuilds=config.authentication.banned.guilds
let allowedChannels=config.authentication.allowed.channels
let bannedChannels=config.authentication.banned.channels

userAllowed=(user)=>{
    if(allowedUsers.length>0&&allowedUsers.includes(user)===false){
        debugLog('Auth fail, default deny if allowedUsers are defined but this user isn\'t on the list: '+user)
        return false} // default deny if allowedUsers are defined but this user isn't on the list
    if(bannedUsers.includes(user)){
        debugLog('Auth fail, deny banned user '+user)
        return false} // deny banned user
    return true // else allow
}
guildAllowed=(guild)=>{
    if(allowedGuilds.length>0&&allowedGuilds?.includes(guild)){return true} // allow if this is a whitelisted guild
    if(allowedGuilds.length>0&&!guild){
        debugLog('Auth fail, default deny if allowedGuilds are defined but no guild supplied (stops direct message use)')
        return false} // default deny if allowedGuilds are defined but no guild supplied (stops direct message use)
    if(bannedGuilds.includes(guild)){
        debugLog('Auth fail, deny banned guild '+guild)
        return false} // deny banned guild
    return true // else allow
}
channelAllowed=(channel)=>{
    if(allowedChannels.length>0&&allowedChannels.includes(channel))return true // allow if this is a whitelisted channel
    if(allowedChannels.length>0&&!channel){
        debugLog('Auth fail, default deny if allowedChannels are defined but no channel supplied (stops direct message use)')
        return false} // default deny if allowedChannels are defined but no channel supplied (stops direct message use)
    if(bannedChannels.includes(channel)){
        debugLog('Auth fail, deny banned channel '+channel)
        return false} // deny banned channel
    return true // else allow
}
check=(userid,guildid,channelid,username)=>{
    if(guildid!=='DM'){guildid=parseInt(guildid)}
    if(userAllowed(parseInt(userid))&&
        guildAllowed(guildid)&&
        channelAllowed(parseInt(channelid))
        ){ return true
    }else{
        debugLog('auth fail for userid '+userid+' in channelid '+channelid+' and guildid '+guildid)
        return false
    }
}
userHasCredit=async(user)=>{
    // Check if a user exists in database, create new user if it doesnt, return true/false if the user has credit > 0
    if(user===config.adminID){return true} // always allow admin
    if(config.credits.enabled){
        let balance = await credits.balance(user)
        if(balance>0){
            return true
        } else { return false }
    } else {
        // return true if credits are disabled
        return true
    }
}
userAllowedFeature=async(user,feature)=>{
    // if credits are disabled, bypass completely
    if(!config.credits.enabled){return true}
    debugLog('userAllowedFeature check for '+user.discordid+' feature '+feature)
    let [usr,created] = await User.findOrCreate({where:{discordID: String(user.discordid)},defaults:{username:user.username,credits:config.credits?.default??100}})
    if(!created&&!usr.username){usr.username=user.username}
    switch(feature) {
        case 'any':
        case 'sd-1':// always allow sd1
        case 'sdxl':// sdxl is members only
        case 'llm':// llm is members only
            return true
        case 'sd-2':// sd2 is members only
      
            return usr.tier >= 1
    }
}
userAllowedJob=async(job, user=null, jobCost=null)=>{
    if(job.error){return job}// is job errored already

    let userBalance = 0;
    if (user) {
        userBalance = user.credits;
    }
    
    console.log("userAllowedJob user ", user);
    console.log("userAllowedJob userBalance", userBalance, "B - JC < 0", (userBalance - jobCost) < 0, "jobCost", jobCost);

    if(user && (userBalance - jobCost) < 0){
        job.error = 'Insufficient :coin:';
        console.log("job must error, jub most errour", job);
        return job;
    }
    let modelAllowed = await userAllowedFeature(job.creator,job.model.base_model) // check model type allowed
    if(!modelAllowed){job.error=job.model.base_model+' is for members only'}
    return job
}


module.exports = {
    auth:{
        user:userAllowed,
        guild:guildAllowed,
        channel:channelAllowed,
        check,
        userAllowedFeature,
        userAllowedJob
    }
}
