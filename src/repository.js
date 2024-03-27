/**
 * This is an upper layer on top of DB.js, decoupling some logic from the database implementation
 */
const {User}=require("./db")
const {config}=require('./utils')

const fetchUserByDiscord = async (discordUsername, discordUserId) => {
    return await User.findOrCreate({where:{discordID: discordUserId},defaults:{username:discordUsername,credits:config.credits?.default??100}})
}

module.exports = {
    fetchUserByDiscord
}