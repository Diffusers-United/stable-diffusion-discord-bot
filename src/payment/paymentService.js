const {CommandInteraction} = require('eris')
const {User, Payment} = require('../db')
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

/**
 * 
 * @param {User} user 
 * @returns {Promise<string>}
 */
const ensureStripeCustomerExists = async (user, source) => {
    let customer_id = '';
    if (!user.stripeID) {
        customer_id = await StripeIntegration.createCustomer(user.username, source);
        await user.update({stripeID: customer_id});
        return customer_id;
    } else {
        return user.stripeID;
    }
}

/**
 * 
 * @param {CommandInteraction} discordInteraction 
 */
const discordRechargePrompt = async (discordInteraction) => {
    const userId = discordInteraction.user.id;
    const username = discordInteraction.user.username;
    const [user,isCreated] = await fetchUserByDiscord(username, userId);

    const stripe_customer_id = await ensureStripeCustomerExists(user, 'discord');

    const paymentLink = await StripeIntegration.createPaymentLink(user.id, StripeIntegration.getDefaultPricing(), stripe_customer_id);
    const pendingPayment = await Payment.create({
        user_id: user.id,
        type: 'stripe_payment_link',
        timestamp: Date.now(),
        txid: paymentLink.id
    });

    return paymentLink.url;
}

module.exports = {
    discordBalancePrompt,
    discordRechargePrompt
}