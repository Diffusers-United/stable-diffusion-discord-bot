/**
 * This is an upper layer on top of DB.js, decoupling some logic from the database implementation
 */
const {User}=require("./db")
const {config}=require('./utils')

/**
 * 
 * @param {*} discordUsername 
 * @param {*} discordUserId 
 * @returns {[User, boolean]}
 */
const fetchUserByDiscord = async (discordUsername, discordUserId) => {
    return await User.findOrCreate({where:{discordID: String(discordUserId)},defaults:{username:discordUsername,credits:config.credits?.default??100}})
}

module.exports = {
    fetchUserByDiscord
}