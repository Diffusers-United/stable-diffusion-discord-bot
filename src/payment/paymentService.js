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
    const [user, isCreated] = await fetchUserByDiscord(username, userId);
    const paymentLinkObject = await StripeIntegration.createPaymentLink(user.id, StripeIntegration.getDefaultPricing());
    const paymentLink = paymentLinkObject.url; // Extract the payment link from the object
    return paymentLink;
  };
  
  

module.exports = {
    discordBalancePrompt,
    discordRechargePrompt
}