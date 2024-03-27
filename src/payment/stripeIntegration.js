const { Stripe } = require('stripe');
const { config } = require('../utils')

/** @type {Stripe} */
let stripeConnection = null;


const initializeStripeConnection = (token) => {
    stripeConnection = Stripe(token);
};

const createPaymentLink = async (user_id, price_id) => {
    const paymentLink = await stripeConnection.paymentLinks.create({
        line_items: [
            {
                price: `${price_id}`,
                quantity: 1,
            },
        ],
        metadata: {
            user_id: user_id
        }
    });
    return paymentLink;
}

const getDefaultPricing = () => {
    return config.credits.stripe.priceId;
}

const getCreditPerUSD = () => {
    return config.credits.stripe.credits_per_dollar;
}

const getCreditAmount = async (priceId) => {
    const priceObject = await stripeConnection.prices.retrieve(priceId);
    /** We assume all amounts from this part are USD */
    const usdAmount = priceObject.unit_amount;
    return usdAmount * getCreditPerUSD();
}

console.log("Initializing stripe connection with ", config.credits.stripe.key);
initializeStripeConnection(config.credits.stripe.key);

module.exports = {
    createPaymentLink,
    getDefaultPricing,
    getCreditAmount
}