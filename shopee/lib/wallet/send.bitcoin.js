// sending bitcoin
const axios = require("axios");
const bitcore = require("bitcore-lib");

module.exports = sendBitcoin = async (depositAddress, sourceAmountRequired,testAddress,testPrivateKey) => {

  try {
    const sochain_network = "BTCTEST";
    // const testPrivateKey =
    //   "fc4ad3d0c112e6282f809abf040ba37b27be78d55f155a7148d4abe74ed20906";
    // const testAddress = "mwZnnnnirxt1d1sRZFVTnJd8xN9M3Kgcjr";
    const satoshiToSend = sourceAmountRequired * 100000000;
    let fee = 0;
    let inputCount = 0;
    let outputCount = 2;

    const response = await axios.get(
      `https://sochain.com/api/v2/get_tx_unspent/${sochain_network}/${testAddress}`
    );

    const recommendedFee = await axios.get(
      "https://bitcoinfees.earn.com/api/v1/fees/recommended"
    );

    const transaction = new bitcore.Transaction();
    let totalAmountAvailable = 0;

    let inputs = [];
    let utxos = response.data.data.txs;

    for (const element of utxos) {
      let utxo = {};
      utxo.satoshis = Math.floor(Number(element.value) * 100000000);
      utxo.script = element.script_hex;
      utxo.address = response.data.data.address;
      utxo.txId = element.txid;
      utxo.outputIndex = element.output_no;
      totalAmountAvailable += utxo.satoshis;
      inputCount += 1;
      inputs.push(utxo);
    }

    /**
     * In a bitcoin transaction, the inputs contribute 180 bytes each to the transaction,
     * while the output contributes 34 bytes each to the transaction. Then there is an extra 10 bytes you add or subtract
     * from the transaction as well.
     * */

    const transactionSize =
      inputCount * 180 + outputCount * 34 + 10 - inputCount;

    fee = transactionSize * recommendedFee.data.hourFee/3; // satoshi per byte
    if (totalAmountAvailable - satoshiToSend - fee < 0) {
      throw new Error("Balance is too low for this transaction");
    }
    //Set transaction input
    transaction.from(inputs);

    // set the recieving address and the amount to send
    transaction.to(depositAddress, satoshiToSend);

    // Set change address - Address to receive the left over funds after transfer
    transaction.change(testAddress);

    //manually set transaction fees: 20 satoshis per byte
    transaction.fee(Math.round(fee));

    // Sign transaction with your private key
    transaction.sign(testPrivateKey);

    // serialize Transactions
    const serializedTransaction = transaction.serialize();
    
    // Send transaction
    const result = await axios({
      method: "POST",
      url: `https://sochain.com/api/v2/send_tx/${sochain_network}`,
      data: {
        tx_hex: serializedTransaction,
      },
    });
    return result.data.data;
  } catch (error) {
    return error;
  }
};