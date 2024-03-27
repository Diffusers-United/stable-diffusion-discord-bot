const {CommandInteraction} = require('eris')
const {User} = require('../db')
const {fetchUserByDiscord} = require('../repository')
const StripeIntegration = require('../payment/stripeIntegration')
const {config} = require('../utils')

/**
 * @param {CommandInteraction} discordInteraction 
 * @returns {Promise<number>}
*/
const discordBalancePrompt = async (discordInteraction) => {
    const userId = discordInteraction.user.id;
    const username = discordInteraction.user.username;
    /** @type {User} */
    const [user,isCreated] = await fetchUserByDiscord(username, userId);
    return user.credits;
}

const discordRechargePrompt = async (discordInteraction) => {
    const userId = discordInteraction.user.id;
    const username = discordInteraction.user.username;
    const [user,isCreated] = await fetchUserByDiscord(username, userId);
    const paymentLink = await StripeIntegration.createPaymentLink(user.id, StripeIntegration.getDefaultPricing());
    console.log(paymentLink);
}

module.exports = {
    discordBalancePrompt,
    discordRechargePrompt
}