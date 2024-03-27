const { Stripe } = require('stripe');
const { config } = require('../utils');
const { Payment, User } = require('../db');

const { bot }=require('../discord/bot');


/** @type {Stripe} */
let stripeConnection = null;


const initializeStripeConnection = (token) => {
    stripeConnection = Stripe(token);
};

const createCustomer = async (username, source) => {
    const customer = await stripeConnection.customers.create({
        metadata: {
            online_username: username,
            username_from: source
        }
    })

    return customer.id;
}

const createPaymentLink = async (user_id, price_id, customer_id = null) => {
    const paymentLink = await stripeConnection.paymentLinks.create({
        line_items: [
            {
                price: `${price_id}`,
                quantity: 1,
            },
        ],
        metadata: {
            user_id: user_id,
            customer_id: customer_id
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

const getCreditAmountPerPriceID = async (priceId) => {
    const priceObject = await stripeConnection.prices.retrieve(priceId);
    /** We assume all amounts from this part are USD */
    const usdAmount = priceObject.unit_amount;
    return getTotalCreditAmount(usdAmount);
}

const getTotalCreditAmount = (usdAmount) => {
    return usdAmount * getCreditPerUSD();
}

/**
 * TO-DO move job to its own file and simplify method.
 */
const verifyPaymentLinksJob = async (discordInstance) => {
    console.log("INSTANCCCCE", bot);

    /** @type {Payment[]} */
    const unconfirmedPayments = await Payment.findAll({where: {confirmedAt: null, type: 'stripe_payment_link'}})
    const unconfirmedLinks = unconfirmedPayments.map((payment) => {
        return payment.txid;
    })

    console.log(`Collected ${unconfirmedPayments.length} unconfirmed payments`);

    const todayTimestamp = Math.floor(Date.now() / 1000);
    const events = await stripeConnection.events.list();

    console.log(`Collected ${events.data.length} events to verify`);

    const linkRequests = [];

    events.data.forEach((e) => {
        console.log(`Verifying event ${e.id} ${e.type}`);
        if ( e.type !== "checkout.session.completed") {
            return;
        }

        eventId = e.id;
        const paymentLink = e?.data?.object?.payment_link
        console.log(`Event ${e.id} has payment link "${paymentLink}"`)
        if (paymentLink && unconfirmedLinks.includes(paymentLink)) {
            linkRequests.push(stripeConnection.paymentLinks.retrieve(paymentLink).then(async (link) => {
                const user_id = link.metadata?.user_id
                const totalUSD = e?.data?.object?.amount_total / 100;
                const credits = getTotalCreditAmount(totalUSD);
                /** @type {User} */
                const user = await User.findOne({where:{id:user_id}});

                const paymentToConfirm = unconfirmedPayments.find((p) => p.txid == paymentLink);

                console.log(`user_id ${user_id} totalUSD ${totalUSD} credits ${credits}`, user, paymentToConfirm);
                if (paymentToConfirm) {
                    user.credits = user.credits + credits;
                    await user.save();

                    paymentToConfirm.set({
                        confirmedAt: Date.now()
                    });
                    await paymentToConfirm.save();

                    const discordID = user.discordID;
                    await (await bot.getDMChannel(discordID)).createMessage(`${credits} credits added.`);
                }
            }))
        }
    });

    await Promise.all(linkRequests);
}

console.log("Initializing stripe connection with ", config.credits.stripe.key);
initializeStripeConnection(config.credits.stripe.key);

module.exports = {
    createPaymentLink,
    getDefaultPricing,
    createCustomer,
    verifyPaymentLinksJob
}