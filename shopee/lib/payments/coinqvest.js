const express = require('express');
const { indexOrders, indexTransactions } = require('../indexing');
const { getId, sendEmail, getEmailTemplate } = require('../common');
const { getPaymentConfig } = require('../config');
const { emptyCart } = require('../cart');
const paypal = require('paypal-rest-sdk');
const router = express.Router();

const CoinqvestClient =require('coinqvest-merchant-sdk');

const client = new CoinqvestClient(
    '2c8cafb39723',
   'qUM4-z4vx-7emr-%*8v-4HN7-bSKC'
   );

router.get('/checkout_cancel', (req, res, next) => {
    // return to checkout for adjustment or repayment
    res.redirect('/checkout');
});

router.get('/checkout_return', (req, res, next) => {
    const db = req.app.db;
    const config = req.app.config;
    const coinqvestConfig = getPaymentConfig('paypal');
    const paymentId = req.session.paymentId;
    const payerId = req.query.PayerID;

    const details = { payer_id: payerId };
    paypal.payment.execute(paymentId, details, async(error, payment) => {
        let paymentApproved = false;
        let paymentMessage = '';
        let paymentDetails = '';
        if(error){
            paymentApproved = false;

            if(error.response.name === 'PAYMENT_ALREADY_DONE'){
                paymentApproved = false;
                paymentMessage = error.response.message;
            }else{
                paymentApproved = false;
                paymentDetails = error.response.error_description;
            }

            // set the error
            req.session.messageType = 'danger';
            req.session.message = error.response.error_description;
            req.session.paymentApproved = paymentApproved;
            req.session.paymentDetails = paymentDetails;

            res.redirect(`/payment/${req.session.orderId}`);
            return;
        }

        const paymentOrderId = req.session.orderId;
        let paymentStatus = 'Approved';

        // fully approved
        if(payment.state === 'approved'){
            paymentApproved = true;
            paymentStatus = 'Paid';
            paymentMessage = 'Succeeded';
            paymentDetails = `<p><strong>Order ID: </strong>${paymentOrderId}</p><p><strong>Transaction ID: </strong>${payment.id}</p>`;

            // clear the cart
            if(req.session.cart){
                emptyCart(req, res, 'function');
            }
        }

        // failed
        if(payment.failureReason){
            paymentApproved = false;
            paymentMessage = `Declined: ${payment.failureReason}`;
            paymentStatus = 'Declined';
        }

        // Create our transaction
        const transaction = await db.transactions.insertOne({
            gateway: 'paypal',
            gatewayReference: payment.id,
            gatewayMessage: paymentMessage,
            approved: paymentApproved,
            amount: req.session.totalCartAmount,
            currency: coinqvestConfig.paypalCurrency,
            customer: getId(req.session.customerId),
            created: new Date(),
            order: getId(paymentOrderId)
        });

        const transactionId = transaction.insertedId;

        // Index transactios
        await indexTransactions(req.app);

        // update the order status
        db.orders.updateOne({ _id: getId(paymentOrderId) }, { $set: { orderStatus: paymentStatus, transaction: transactionId } }, { multi: false }, (err, numReplaced) => {
            if(err){
                console.info(err.stack);
            }
            db.orders.findOne({ _id: getId(paymentOrderId) }, async (err, order) => {
                if(err){
                    console.info(err.stack);
                }

                // add to lunr index
                indexOrders(req.app)
                .then(() => {
                    // set the results
                    req.session.messageType = 'success';
                    req.session.message = paymentMessage;
                    req.session.paymentEmailAddr = order.orderEmail;
                    req.session.paymentApproved = paymentApproved;
                    req.session.paymentDetails = paymentDetails;

                    const paymentResults = {
                        message: req.session.message,
                        messageType: req.session.messageType,
                        paymentEmailAddr: req.session.paymentEmailAddr,
                        paymentApproved: req.session.paymentApproved,
                        paymentDetails: req.session.paymentDetails
                    };

                    // send the email with the response
                    // TODO: Should fix this to properly handle result
                    sendEmail(req.session.paymentEmailAddr, `Your payment with ${config.cartTitle}`, getEmailTemplate(paymentResults));

                    res.redirect(`/payment/${order._id}`);
                });
            });
        });
    });
});

// The homepage of the site
router.post('/checkout_action',async (req, res, next) => {
    const db = req.app.db;
    const config = req.app.config;
    const coinqvestConfig = getPaymentConfig('coinqvest');

    // setup the payment object
    const payment = {
        intent: 'sale',
        payer: {
            payment_method: 'coinqvest'
        },
        redirect_urls: {
            return_url: `${config.baseUrl}/coinqvest/checkout_return`,
            cancel_url: `${config.baseUrl}/coinqvest/checkout_cancel`
        },
        transactions: [{
            amount: {
                total: req.session.totalCartAmount,
                currency: coinqvestConfig.paypalCurrency
            },
            description: coinqvestConfig.paypalCartDescription
        }]
    };

    // set the config
    // paypal.configure(coinqvestConfig);

    try{
        let response = await client.post('/customer', {
            customer:{
                email: req.session.customerEmail,
                firstname: req.session.customerFirstname,
                lastname: req.session.customerLastname,
                company: req.session.customerCompany,
                adr1: req.session.customerAddress1,
                adr2: req.session.customerAddress2,
                zip: req.session.customerPostcode,
            }
        });
        
        console.log(response.status);
        console.log(response.data);
        
        if (response.status !== 200) {
            // something went wrong, let's abort and debug by looking at our log file
            console.log('Could not create customer. Inspect above log entry.');
                  
            req.session.message = 'Could not create customer. Inspect above log entry.';
            req.session.messageType = 'danger';
            res.redirect('/checkout/payment');
            return;
        }
        
        let customerId = response.data['customerId']; 
        console.log(customerId)



        
            // if there is no items in the cart then render a failure
            if(!req.session.cart){
                req.session.message = 'The are no items in your cart. Please add some items before checking out';
                req.session.messageType = 'danger';
                res.redirect('/');
                return;
            }

            // new order doc
            const orderDoc = {
                orderPaymentId: payment.id,
                orderPaymentGateway: 'Coinqvest',
                orderTotal: req.session.totalCartAmount,
                orderShipping: req.session.totalCartShipping,
                orderItemCount: req.session.totalCartItems,
                orderProductCount: req.session.totalCartProducts,
                orderCustomer: getId(req.session.customerId),
                orderEmail: req.session.customerEmail,
                orderCompany: req.session.customerCompany,
                orderFirstname: req.session.customerFirstname,
                orderLastname: req.session.customerLastname,
                orderAddr1: req.session.customerAddress1,
                orderAddr2: req.session.customerAddress2,
                orderCountry: req.session.customerCountry,
                orderState: req.session.customerState,
                orderPostcode: req.session.customerPostcode,
                orderPhoneNumber: req.session.customerPhone,
                orderComment: req.session.orderComment,
                orderStatus: payment.state,
                orderDate: new Date(),
                orderProducts: req.session.cart,
                orderType: 'Single'
            };

           
                let billingResponse = await client.post('/checkout/hosted', {
                    charge:{
                        customerId: customerId, // associates this charge with a customer
                        billingCurrency: 'USD', // specifies the billing currency
                        lineItems: [{ // a list of line items included in this charge
                            description: 'SHOPEE CART PRODUCTS',
                            netAmount: req.session.totalCartAmount,
                            quantity: 1
                        }],
                        discountItems: [{ // an optional list of discounts
                            description: 'Loyalty Discount',
                            netAmount: 0.5
                        }],
                        shippingCostItems: [{ // an optional list of shipping and handling costs
                            description: 'Shipping and Handling',
                            netAmount:  req.session.totalCartShipping,
                            taxable: false // sometimes shipping costs are taxable
                        }],
                        taxItems: [{
                            name: 'CA Sales Tax',
                            percent: 0.08 // 8.25% CA sales tax
                        }]
                    },
                    settlementAsset: 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN' // your settlement asset as given by GET /assets (or ORIGIN to omit conversion)
                });
                
                console.log(billingResponse.status);
                console.log(billingResponse.data);
                
                if (billingResponse.status !== 200) {
                    // something went wrong, let's abort and debug by looking at our log file
                    console.log('Could not create checkout.');
                  
                    req.session.message = 'Could not create checkout.';
                    req.session.messageType = 'danger';
                    res.redirect('/checkout/payment');
                    return;
                }
                
               
                let checkoutId = billingResponse.data['checkoutId']; 
                let url = billingResponse.data['url'];
                console.log(checkoutId)
                console.log(url)
                // no order ID so we create a new one
                db.orders.insertOne(orderDoc, (err, newDoc) => {
                    if(err){
                        console.info(err.stack);
                    }

                    // get the new ID
                    const newId = newDoc.insertedId;

                    // set the order ID in the session
                    req.session.orderId = newId;

                    // send the order to Paypal
                    res.redirect(url);
                });
            
    
    
      }catch(error){
        console.log(error)
        req.session.message = 'There was an error processing your payment. You have not been charged and can try again.';
        req.session.messageType = 'danger';
        console.log(error);
        res.redirect('/checkout/payment');
        return;
    
      }

});

module.exports = router;
