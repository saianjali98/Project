const { testnet, mainnet } = require("bitcore-lib/lib/networks");
const { createWallet, createHDWallet } = require("./wallet.bitcoin");
const sendBitcoin = require("./send.bitcoin");


// sendBitcoin("1EBsZRi15LsqEV5zr8MSH4LVQbcwjxLcLf", 0.0009085)
//   .then((result) => {
//     console.log(result);
//   })
//   .catch((error) => {
//     console.log(error);
//   });



  let response = createHDWallet(testnet,(err,results)=>{
    if(err){
    return err;
    }else{
      return results
    }
  })
console.log(response)

// console.log(createHDWallet(testnet))
