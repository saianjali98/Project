const express = require('express');
const { indexOrders, indexTransactions } = require('../indexing');
const { getId, sendEmail, getEmailTemplate } = require('../common');
const { getPaymentConfig } = require('../config');
const { emptyCart } = require('../cart');
const paypal = require('paypal-rest-sdk');
const router = express.Router();

const { testnet, mainnet } = require("bitcore-lib/lib/networks");
const { createWallet, createHDWallet } = require("../wallet/wallet.bitcoin");
const sendBitcoin = require("../wallet/send.bitcoin");


router.get('/checkout_cancel', (req, res, next) => {
    // return to checkout for adjustment or repayment
    res.redirect('/checkout');
});


router.get('/checkout_return', (req, res, next) => {
    const db = req.app.db;
    const config = req.app.config;
    const paypalConfig = getPaymentConfig('paypal');
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
            currency: paypalConfig.paypalCurrency,
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


router.post('/checkout_action', (req, res, next) => {
    const db = req.app.db;
    const config = req.app.config;
    const hdwalletConfig = getPaymentConfig('hdwallet');
  const blockonomicsParams = {};


    // setup the payment object
    const payment = {
        intent: 'sale',
        payer: {
            payment_method: 'hdwallet'
        },
        redirect_urls: {
            return_url: `${config.baseUrl}/hdwallet/checkout_return`,
            cancel_url: `${config.baseUrl}/hdwallet/checkout_cancel`
        },
        transactions: [{
            amount: {
                total: req.session.totalCartAmount,
                currency: hdwalletConfig.paypalCurrency
            },
            description: hdwalletConfig.paypalCartDescription
        }]
    };
    
    let bitcoinAddress = createHDWallet(testnet,(err,results)=>{
        if(err){
            console.log(err)
        return err;
        }else{
            blockonomicsParams.address = results.address;
            blockonomicsParams.testPrivateKey = results.privateKey;
            console.log(results)
          return results
        }
      })

    // set the config
    // hdwallet.configure(hdwalletConfig);

    // blockonomicsParams.expectedBtc = Math.round(req.session.totalCartAmount / req.session.totalCartAmount * Math.pow(10, 8)) / Math.pow(10, 8);

    blockonomicsParams.expectedBtc =Number((req.session.totalCartAmount *0.00000586188).toFixed(4))
    // blockonomicsParams.expectedBtc =0.0001
    blockonomicsParams.depositAddress ="mg9ZUqb8ZE1ki7mPS3zEhfJTzU83ZAJEfP";
    blockonomicsParams.address = bitcoinAddress.address;
    blockonomicsParams.testPrivateKey = bitcoinAddress.privateKey;
    blockonomicsParams.timestamp = Math.floor(new Date() / 1000);
    console.log(blockonomicsParams)
    req.session.blockonomicsParams = blockonomicsParams;
   res.redirect('/hdwallet_payment');

 

});


router.post('/checkout_payment', (req, res, next) => {
    const db = req.app.db;
    const config = req.app.config;
    const hdwalletConfig = getPaymentConfig('hdwallet');
  const blockonomicsParams = {};


let sourceAmountRequired = Math.abs(req.body.sourceAmountRequired)
let depositAddress= req.body.depositAddress

let testPrivateKey=req.body.testPrivateKey;
let testAddress=req.body.testAddress;

console.log(sourceAmountRequired+","+depositAddress+","+testPrivateKey+","+testAddress)
sendBitcoin(depositAddress,sourceAmountRequired,testAddress,testPrivateKey)
  .then((result) => {
    console.log(result);


      // if there is no items in the cart then render a failure
      if(!req.session.cart){
          req.session.message = 'The are no items in your cart. Please add some items before checking out';
          req.session.messageType = 'danger';
          res.redirect('/');
          return;
      }


      if(result.txid !=null){
      // new order doc
      const orderDoc = {
        orderPaymentId: result.txid,
        orderPaymentGateway: 'Hdwallet',
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
        orderStatus:"paid",
        orderDate: new Date(),
        orderProducts: req.session.cart,
        orderType: 'Single'
    };


      // no order ID so we create a new one
      db.orders.insertOne(orderDoc, (err, newDoc) => {
          if(err){
              console.info(err.stack);
          }

          // get the new ID
          const newId = newDoc.insertedId;

          // set the order ID in the session
          req.session.orderId = newId;
          blockonomicsParams.pendingOrderId = newId;
          req.session.blockonomicsParams = blockonomicsParams;
          req.session.txid = result.txid;

          const paymentResults = {
            message: 'Your payment was successfully completed',
            messageType: 'success',
            paymentEmailAddr: orderDoc.orderEmail,
            paymentApproved: true,
            paymentDetails: `<p><strong>Order ID: </strong>${orderDoc._id}</p><p><strong>Transaction ID: </strong>${orderDoc.orderPaymentId}</p>`
        };

        // send the email with the response
        // TODO: Should fix this to properly handle result
        sendEmail(orderDoc.orderEmail, `Your payment with ${config.cartTitle}`, getEmailTemplate(paymentResults));
        emptyCart(req, res, 'function');
     
          res.redirect('/hdwallet_payment_success');

      });

    
      }



  
  })
  .catch((error) => {
     if(error){
            req.session.message = 'There was an error processing your payment. You have not been charged and can try again.';
            req.session.messageType = 'danger';
            console.log(error);
            res.redirect('/checkout_cancel');
            return;
        }
  });

    // create payment
 
});
module.exports = router;
